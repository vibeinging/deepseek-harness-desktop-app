import { posix } from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import JSZip from "jszip";
import XLSX from "xlsx";

import { ApiError } from "../../errors.js";
import {
  attributeByLocalName,
  childrenNamed,
  createElement,
  descendantsNamed,
  elementChildren,
  insertElementSorted,
  localName,
  parseOfficeXml,
  removeChildrenNamed,
  serializeOfficeXml,
  setAttributeByLocalName,
} from "./office_xml.js";

const SHEET_NAMESPACE = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_REL_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";
const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const WORKBOOK_PATH = "xl/workbook.xml";
const WORKBOOK_RELS_PATH = "xl/_rels/workbook.xml.rels";
const CONTENT_TYPES_PATH = "[Content_Types].xml";
const WORKSHEET_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet";
const WORKSHEET_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
const MAX_INSPECT_CELLS = 5_000;
const MAX_SHEETS = 100;

function encoded(value) {
  return encodeURIComponent(String(value || ""));
}

function normalizeSheetTarget(target) {
  const value = String(target || "").replace(/^\/+/, "");
  const resolved = value.startsWith("xl/") ? posix.normalize(value) : posix.normalize(posix.join("xl", value));
  if (!resolved.startsWith("xl/") || resolved.includes("../")) throw new ApiError("XLSX 工作表关系无效", 400);
  return resolved;
}

async function openXlsx(input) {
  const buffer = Buffer.isBuffer(input) ? input : await readFile(input);
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer);
  } catch {
    throw new ApiError("XLSX 文件已损坏", 400);
  }
  const workbookPart = archive.file(WORKBOOK_PATH);
  const relationshipsPart = archive.file(WORKBOOK_RELS_PATH);
  const contentTypesPart = archive.file(CONTENT_TYPES_PATH);
  if (!(workbookPart && relationshipsPart && contentTypesPart)) throw new ApiError("XLSX 缺少工作簿结构", 400);
  const workbookDocument = parseOfficeXml(await workbookPart.async("string"), "XLSX 工作簿");
  const relationshipsDocument = parseOfficeXml(await relationshipsPart.async("string"), "XLSX 关系");
  const contentTypesDocument = parseOfficeXml(await contentTypesPart.async("string"), "XLSX 内容类型");
  const relationships = new Map();
  for (const relationship of descendantsNamed(relationshipsDocument.documentElement, "Relationship")) {
    if (String(attributeByLocalName(relationship, "TargetMode")).toLowerCase() === "external") continue;
    const id = attributeByLocalName(relationship, "Id");
    const target = attributeByLocalName(relationship, "Target");
    if (id && target) relationships.set(id, normalizeSheetTarget(target));
  }
  const sheets = new Map();
  for (const sheet of descendantsNamed(workbookDocument.documentElement, "sheet")) {
    const name = attributeByLocalName(sheet, "name");
    const relationshipId = attributeByLocalName(sheet, "id");
    const path = relationships.get(relationshipId);
    if (name && path && archive.file(path)) sheets.set(name, { name, path, node: sheet, relationshipId });
  }
  if (!sheets.size) throw new ApiError("XLSX 没有可读取的工作表", 400);
  return { buffer, archive, workbookDocument, relationshipsDocument, contentTypesDocument, sheets };
}

function cellModel(sheetName, address, cell) {
  return {
    anchor: `xlsx:cell:${encoded(sheetName)}:${address}`,
    address,
    value: cell?.v ?? null,
    display: String(cell?.w ?? cell?.v ?? ""),
    formula: cell?.f ? `=${cell.f}` : null,
    value_type: cell?.t || null,
    style_id: cell?.s ?? null,
  };
}

export async function inspectXlsxFile(filePath) {
  const buffer = await readFile(filePath);
  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true, cellFormula: true, cellDates: true });
  } catch {
    throw new ApiError("XLSX 文件无法解析", 400);
  }
  const sections = [];
  for (const sheetName of workbook.SheetNames || []) {
    const sheet = workbook.Sheets[sheetName];
    const reference = String(sheet?.["!ref"] || "A1:A1");
    let range;
    try { range = XLSX.utils.decode_range(reference); } catch { range = XLSX.utils.decode_range("A1:A1"); }
    const cells = [];
    let visited = 0;
    for (let row = range.s.r; row <= range.e.r && visited < MAX_INSPECT_CELLS; row += 1) {
      for (let column = range.s.c; column <= range.e.c && visited < MAX_INSPECT_CELLS; column += 1) {
        visited += 1;
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const cell = sheet?.[address];
        if (cell) cells.push(cellModel(sheetName, address, cell));
      }
    }
    const total = Math.max(1, range.e.r - range.s.r + 1) * Math.max(1, range.e.c - range.s.c + 1);
    sections.push({
      anchor: `xlsx:sheet:${encoded(sheetName)}`,
      kind: "sheet",
      name: sheetName,
      range: reference,
      row_count: Math.max(1, range.e.r - range.s.r + 1),
      column_count: Math.max(1, range.e.c - range.s.c + 1),
      cells,
      truncated: total > MAX_INSPECT_CELLS,
    });
  }
  return {
    format: "xlsx",
    sections,
    capabilities: {
      create: true,
      set_cell: true,
      set_formula: true,
      clear_cell: true,
      set_range: true,
      add_sheet: true,
      rename_sheet: true,
      delete_sheet: true,
      move_sheet: true,
      charts: "preserved",
    },
    warnings: sections.some((section) => section.truncated) ? ["大型工作表只显示前 5000 个位置，修改时仍可使用准确的 A1 地址。"] : [],
  };
}

function parseCellTarget(operation) {
  let sheetName = String(operation?.sheet || "");
  let address = String(operation?.address || "").replace(/\$/g, "").toUpperCase();
  const anchor = String(operation?.anchor || "");
  if (anchor.startsWith("xlsx:cell:")) {
    const body = anchor.slice("xlsx:cell:".length);
    const split = body.lastIndexOf(":");
    if (split > 0) {
      try { sheetName = decodeURIComponent(body.slice(0, split)); } catch { sheetName = ""; }
      address = body.slice(split + 1).replace(/\$/g, "").toUpperCase();
    }
  }
  if (!sheetName || !/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(address)) throw new ApiError("XLSX 单元格地址无效", 400);
  return { sheetName, address };
}

function cellColumn(address) {
  let value = 0;
  for (const char of String(address).match(/^[A-Z]+/)?.[0] || "") value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

function ensureSheetData(document) {
  const root = document.documentElement;
  let sheetData = childrenNamed(root, "sheetData")[0];
  if (sheetData) return sheetData;
  sheetData = createElement(document, SHEET_NAMESPACE, "sheetData");
  const rank = new Map([
    ["sheetPr", 1], ["dimension", 2], ["sheetViews", 3], ["sheetFormatPr", 4], ["cols", 5],
    ["sheetData", 6], ["sheetCalcPr", 7], ["sheetProtection", 8], ["protectedRanges", 9],
    ["scenarios", 10], ["autoFilter", 11], ["sortState", 12], ["dataConsolidate", 13],
    ["customSheetViews", 14], ["mergeCells", 15], ["phoneticPr", 16], ["conditionalFormatting", 17],
    ["dataValidations", 18], ["hyperlinks", 19], ["printOptions", 20], ["pageMargins", 21],
    ["pageSetup", 22], ["headerFooter", 23], ["rowBreaks", 24], ["colBreaks", 25],
    ["customProperties", 26], ["cellWatches", 27], ["ignoredErrors", 28], ["smartTags", 29],
    ["drawing", 30], ["legacyDrawing", 31], ["legacyDrawingHF", 32], ["picture", 33], ["oleObjects", 34],
    ["controls", 35], ["webPublishItems", 36], ["tableParts", 37], ["extLst", 38],
  ]);
  return insertElementSorted(root, sheetData, (left, right) => (rank.get(localName(left)) || 999) - (rank.get(localName(right)) || 999));
}

function ensureCell(sheetDocument, address) {
  const sheetData = ensureSheetData(sheetDocument);
  const rowNumber = Number(address.match(/\d+$/)?.[0] || 0);
  let row = childrenNamed(sheetData, "row").find((item) => Number(attributeByLocalName(item, "r")) === rowNumber);
  if (!row) {
    row = createElement(sheetDocument, SHEET_NAMESPACE, "row");
    row.setAttribute("r", String(rowNumber));
    insertElementSorted(sheetData, row, (left, right) => Number(attributeByLocalName(left, "r")) - Number(attributeByLocalName(right, "r")));
  }
  let cell = childrenNamed(row, "c").find((item) => String(attributeByLocalName(item, "r")).toUpperCase() === address);
  if (!cell) {
    cell = createElement(sheetDocument, SHEET_NAMESPACE, "c");
    cell.setAttribute("r", address);
    insertElementSorted(row, cell, (left, right) => cellColumn(attributeByLocalName(left, "r")) - cellColumn(attributeByLocalName(right, "r")));
  }
  return cell;
}

function expandSheetDimension(sheetDocument, address) {
  const root = sheetDocument.documentElement;
  let dimension = childrenNamed(root, "dimension")[0];
  if (!dimension) {
    dimension = createElement(sheetDocument, SHEET_NAMESPACE, "dimension");
    const firstAfterDimension = elementChildren(root).find((item) => !["sheetPr"].includes(localName(item)));
    if (firstAfterDimension) root.insertBefore(dimension, firstAfterDimension);
    else root.appendChild(dimension);
  }
  let range;
  try { range = XLSX.utils.decode_range(attributeByLocalName(dimension, "ref") || address); }
  catch { range = { s: XLSX.utils.decode_cell(address), e: XLSX.utils.decode_cell(address) }; }
  const cell = XLSX.utils.decode_cell(address);
  range.s.r = Math.min(range.s.r, cell.r);
  range.s.c = Math.min(range.s.c, cell.c);
  range.e.r = Math.max(range.e.r, cell.r);
  range.e.c = Math.max(range.e.c, cell.c);
  setAttributeByLocalName(dimension, "ref", XLSX.utils.encode_range(range));
}

function currentCellValue(cell) {
  const formula = childrenNamed(cell, "f")[0];
  const value = childrenNamed(cell, "v")[0];
  const inline = childrenNamed(cell, "is")[0];
  return {
    formula: formula ? `=${String(formula.textContent || "")}` : null,
    value: inline ? descendantsNamed(inline, "t").map((item) => String(item.textContent || "")).join("") : (value?.textContent ?? null),
    type: attributeByLocalName(cell, "t") || null,
  };
}

function writeCell(cell, operation) {
  const before = currentCellValue(cell);
  removeChildrenNamed(cell, ["f", "v", "is"]);
  if (operation.type === "clear_cell" || operation.value === null) {
    cell.removeAttribute("t");
    return { before, after: { value: null, formula: null, type: null } };
  }
  const document = cell.ownerDocument;
  const formula = String(operation.formula || "").trim();
  if (formula) {
    cell.removeAttribute("t");
    cell.appendChild(createElement(document, SHEET_NAMESPACE, "f", formula.replace(/^=/, "")));
    if (typeof operation.cached_value === "number" && Number.isFinite(operation.cached_value)) {
      cell.appendChild(createElement(document, SHEET_NAMESPACE, "v", operation.cached_value));
    }
    return { before, after: { value: operation.cached_value ?? null, formula: formula.startsWith("=") ? formula : `=${formula}`, type: "formula" } };
  }
  const value = operation.value;
  if (typeof value === "number" && Number.isFinite(value)) {
    cell.removeAttribute("t");
    cell.appendChild(createElement(document, SHEET_NAMESPACE, "v", value));
    return { before, after: { value, formula: null, type: "number" } };
  }
  if (typeof value === "boolean") {
    cell.setAttribute("t", "b");
    cell.appendChild(createElement(document, SHEET_NAMESPACE, "v", value ? "1" : "0"));
    return { before, after: { value, formula: null, type: "boolean" } };
  }
  cell.setAttribute("t", "inlineStr");
  const inline = createElement(document, SHEET_NAMESPACE, "is");
  const text = createElement(document, SHEET_NAMESPACE, "t", String(value ?? ""));
  if (/^\s|\s$/.test(String(value ?? ""))) text.setAttribute("xml:space", "preserve");
  inline.appendChild(text);
  cell.appendChild(inline);
  return { before, after: { value: String(value ?? ""), formula: null, type: "string" } };
}

function markWorkbookForRecalculation(workbookDocument) {
  const root = workbookDocument.documentElement;
  let calc = childrenNamed(root, "calcPr")[0];
  if (!calc) {
    calc = createElement(workbookDocument, SHEET_NAMESPACE, "calcPr");
    root.appendChild(calc);
  }
  setAttributeByLocalName(calc, "calcMode", "auto");
  setAttributeByLocalName(calc, "fullCalcOnLoad", "1");
  setAttributeByLocalName(calc, "forceFullCalc", "1");
}

function workbookSheetsElement(workbookDocument) {
  const sheets = childrenNamed(workbookDocument.documentElement, "sheets")[0];
  if (!sheets) throw new ApiError("XLSX 缺少工作表目录", 400);
  return sheets;
}

function workbookSheetNames(opened) {
  return childrenNamed(workbookSheetsElement(opened.workbookDocument), "sheet")
    .map((node) => attributeByLocalName(node, "name"));
}

function validateSheetName(value, existingNames = [], ignoredName = "") {
  const name = String(value ?? "");
  if (!name.trim()) throw new ApiError("工作表名称不能为空", 400);
  if (name.length > 31) throw new ApiError("工作表名称最多 31 个字符", 400);
  if (/[\\/?*:[\]\u0000-\u001f]/.test(name)) throw new ApiError("工作表名称包含 Excel 不允许的字符", 400);
  if (name.startsWith("'") || name.endsWith("'")) throw new ApiError("工作表名称不能以单引号开头或结尾", 400);
  const normalized = name.toLocaleLowerCase();
  const ignored = String(ignoredName || "").toLocaleLowerCase();
  if (existingNames.some((item) => {
    const current = String(item || "").toLocaleLowerCase();
    return current === normalized && current !== ignored;
  })) throw new ApiError(`工作表已存在：${name}`, 409);
  return name;
}

function sheetPosition(operation, maximum, { allowAppend = false } = {}) {
  if (operation?.position === undefined || operation?.position === null) return allowAppend ? maximum : null;
  const position = Number(operation.position);
  if (!Number.isInteger(position) || position < 1 || position > maximum) {
    throw new ApiError(`工作表位置必须是 1 到 ${maximum} 的整数`, 400);
  }
  return position;
}

function nextNumber(values) {
  const used = new Set(values.filter((value) => Number.isInteger(value) && value > 0));
  let value = 1;
  while (used.has(value)) value += 1;
  return value;
}

function allocateSheetIdentity(opened) {
  const sheetIds = childrenNamed(workbookSheetsElement(opened.workbookDocument), "sheet")
    .map((node) => Number(attributeByLocalName(node, "sheetId")));
  const relationshipIds = descendantsNamed(opened.relationshipsDocument.documentElement, "Relationship")
    .map((node) => Number(String(attributeByLocalName(node, "Id")).match(/^rId(\d+)$/)?.[1] || 0));
  const sheetPaths = Object.keys(opened.archive.files)
    .map((path) => Number(path.match(/^xl\/worksheets\/sheet(\d+)\.xml$/)?.[1] || 0));
  return {
    sheetId: nextNumber(sheetIds),
    relationshipId: `rId${nextNumber(relationshipIds)}`,
    path: `xl/worksheets/sheet${nextNumber(sheetPaths)}.xml`,
  };
}

function emptySheetDocument() {
  return parseOfficeXml(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${SHEET_NAMESPACE}"><dimension ref="A1"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData/></worksheet>`,
    "XLSX 新工作表",
  );
}

async function loadSheetDocument(opened, sheetDocuments, sheet) {
  let document = sheetDocuments.get(sheet.path);
  if (document) return document;
  const part = opened.archive.file(sheet.path);
  if (!part) throw new ApiError(`工作表内容不存在：${sheet.name}`, 400);
  document = parseOfficeXml(await part.async("string"), `XLSX 工作表 ${sheet.name}`);
  sheetDocuments.set(sheet.path, document);
  return document;
}

function insertSheetNode(parent, node, position) {
  const sheets = childrenNamed(parent, "sheet");
  const next = sheets[position - 1];
  if (next) parent.insertBefore(node, next);
  else parent.appendChild(node);
}

function appendWorksheetRelationship(opened, identity) {
  const relationship = createElement(opened.relationshipsDocument, PACKAGE_REL_NAMESPACE, "Relationship");
  relationship.setAttribute("Id", identity.relationshipId);
  relationship.setAttribute("Type", WORKSHEET_REL_TYPE);
  relationship.setAttribute("Target", identity.path.replace(/^xl\//, ""));
  opened.relationshipsDocument.documentElement.appendChild(relationship);
}

function appendWorksheetContentType(opened, path) {
  const override = createElement(opened.contentTypesDocument, CONTENT_TYPES_NAMESPACE, "Override");
  override.setAttribute("PartName", `/${path}`);
  override.setAttribute("ContentType", WORKSHEET_CONTENT_TYPE);
  opened.contentTypesDocument.documentElement.appendChild(override);
}

function removeWorksheetPackageEntries(opened, sheet) {
  sheet.node.parentNode.removeChild(sheet.node);
  for (const relationship of descendantsNamed(opened.relationshipsDocument.documentElement, "Relationship")) {
    if (attributeByLocalName(relationship, "Id") === sheet.relationshipId) relationship.parentNode.removeChild(relationship);
  }
  for (const override of descendantsNamed(opened.contentTypesDocument.documentElement, "Override")) {
    if (attributeByLocalName(override, "PartName").replace(/^\//, "") === sheet.path) override.parentNode.removeChild(override);
  }
  opened.archive.remove(sheet.path);
  opened.archive.remove(posix.join(posix.dirname(sheet.path), "_rels", `${posix.basename(sheet.path)}.rels`));
}

function remapSheetIndexes(workbookDocument, beforeNames, afterNames) {
  for (const name of descendantsNamed(workbookDocument.documentElement, "definedName")) {
    const raw = attributeByLocalName(name, "localSheetId");
    if (raw === "") continue;
    const previous = Number(raw);
    const sheetName = beforeNames[previous];
    const next = afterNames.indexOf(sheetName);
    if (!sheetName || next < 0) name.parentNode.removeChild(name);
    else setAttributeByLocalName(name, "localSheetId", next);
  }
  for (const view of descendantsNamed(workbookDocument.documentElement, "workbookView")) {
    for (const attribute of ["activeTab", "firstSheet"]) {
      const raw = attributeByLocalName(view, attribute);
      if (raw === "") continue;
      const previous = Math.max(0, Math.min(beforeNames.length - 1, Number(raw) || 0));
      const sheetName = beforeNames[previous];
      let next = afterNames.indexOf(sheetName);
      if (next < 0) next = Math.min(previous, Math.max(0, afterNames.length - 1));
      setAttributeByLocalName(view, attribute, next);
    }
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quotedSheetToken(name) {
  return `'${String(name).replace(/'/g, "''")}'!`;
}

function rewriteFormulaSegment(segment, oldName, newName) {
  const replacement = newName === null ? "#REF!" : quotedSheetToken(newName);
  const quoted = new RegExp(escapeRegex(quotedSheetToken(oldName)), "gi");
  let rewritten = segment.replace(quoted, replacement);
  const unquoted = new RegExp(`(^|[^A-Za-z0-9_.'"\\]])${escapeRegex(oldName)}!`, "gi");
  rewritten = rewritten.replace(unquoted, (_match, prefix) => `${prefix}${replacement}`);
  return rewritten;
}

function rewriteFormulaText(value, oldName, newName) {
  const text = String(value || "");
  let rewritten = "";
  let segment = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== '"') {
      segment += character;
      continue;
    }
    if (inString && text[index + 1] === '"') {
      segment += '""';
      index += 1;
      continue;
    }
    rewritten += inString ? segment : rewriteFormulaSegment(segment, oldName, newName);
    rewritten += character;
    segment = "";
    inString = !inString;
  }
  rewritten += inString ? segment : rewriteFormulaSegment(segment, oldName, newName);
  return rewritten;
}

function rewriteFormulaNodes(document, oldName, newName, names) {
  let count = 0;
  for (const name of names) {
    for (const node of descendantsNamed(document.documentElement, name)) {
      const before = String(node.textContent || "");
      const after = rewriteFormulaText(before, oldName, newName);
      if (after === before) continue;
      node.textContent = after;
      count += 1;
    }
  }
  return count;
}

async function rewriteWorkbookReferences(opened, sheetDocuments, oldName, newName) {
  let count = rewriteFormulaNodes(opened.workbookDocument, oldName, newName, ["definedName"]);
  for (const sheet of opened.sheets.values()) {
    const document = await loadSheetDocument(opened, sheetDocuments, sheet);
    count += rewriteFormulaNodes(document, oldName, newName, ["f", "formula", "formula1", "formula2"]);
  }
  for (const path of Object.keys(opened.archive.files).filter((item) => /^xl\/charts\/[^/]+\.xml$/.test(item))) {
    const part = opened.archive.file(path);
    if (!part) continue;
    const document = parseOfficeXml(await part.async("string"), "XLSX 图表");
    const changed = rewriteFormulaNodes(document, oldName, newName, ["f"]);
    if (changed) opened.archive.file(path, serializeOfficeXml(document));
    count += changed;
  }
  return count;
}

function expandOperations(operations) {
  const expanded = [];
  let cellCount = 0;
  const addCell = (operation) => {
    expanded.push(operation);
    cellCount += 1;
    if (cellCount > 5_000) throw new ApiError("一次最多修改 5000 个单元格", 400);
  };
  for (const operation of operations) {
    if (operation?.type === "add_sheet") {
      const name = String(operation.name || "");
      expanded.push({ ...operation, rows: undefined });
      const rows = operation.rows === undefined ? [] : operation.rows;
      if (!Array.isArray(rows)) throw new ApiError("新工作表内容必须是二维数组", 400);
      for (let row = 0; row < rows.length; row += 1) {
        if (!Array.isArray(rows[row])) throw new ApiError("新工作表内容必须是二维数组", 400);
        for (let column = 0; column < rows[row].length; column += 1) {
          if (rows[row][column] === null || rows[row][column] === undefined) continue;
          addCell({ type: "set_cell", sheet: name, address: XLSX.utils.encode_cell({ r: row, c: column }), value: rows[row][column] });
        }
      }
      continue;
    }
    if (operation?.type !== "set_range") {
      if (["set_cell", "clear_cell"].includes(operation?.type)) addCell(operation);
      else expanded.push(operation);
      continue;
    }
    const sheet = String(operation.sheet || "");
    const start = String(operation.start || "").toUpperCase();
    const values = Array.isArray(operation.values) ? operation.values : [];
    let origin;
    try { origin = XLSX.utils.decode_cell(start); } catch { throw new ApiError("XLSX 范围起点无效", 400); }
    for (let row = 0; row < values.length; row += 1) {
      if (!Array.isArray(values[row])) throw new ApiError("XLSX 范围值必须是二维数组", 400);
      for (let column = 0; column < values[row].length; column += 1) {
        const value = values[row][column];
        addCell({ type: value === null ? "clear_cell" : "set_cell", sheet, address: XLSX.utils.encode_cell({ r: origin.r + row, c: origin.c + column }), value });
      }
    }
  }
  return expanded;
}

export async function editXlsxFile(inputPath, outputPath, operations = []) {
  const opened = await openXlsx(inputPath);
  const sheetDocuments = new Map();
  const changes = [];
  const warnings = [];
  let structureChanged = false;
  let formulaReferencesChanged = false;
  for (const operation of expandOperations(operations)) {
    if (operation?.type === "add_sheet") {
      if (opened.sheets.size >= MAX_SHEETS) throw new ApiError(`一个工作簿最多支持 ${MAX_SHEETS} 个工作表`, 400);
      const beforeNames = workbookSheetNames(opened);
      const name = validateSheetName(operation.name, beforeNames);
      const position = sheetPosition(operation, beforeNames.length + 1, { allowAppend: true });
      const identity = allocateSheetIdentity(opened);
      const node = createElement(opened.workbookDocument, SHEET_NAMESPACE, "sheet");
      node.setAttribute("name", name);
      node.setAttribute("sheetId", String(identity.sheetId));
      setAttributeByLocalName(node, "id", identity.relationshipId, REL_NAMESPACE, "r");
      insertSheetNode(workbookSheetsElement(opened.workbookDocument), node, position);
      appendWorksheetRelationship(opened, identity);
      appendWorksheetContentType(opened, identity.path);
      const document = emptySheetDocument();
      sheetDocuments.set(identity.path, document);
      opened.sheets.set(name, { name, path: identity.path, node, relationshipId: identity.relationshipId });
      remapSheetIndexes(opened.workbookDocument, beforeNames, workbookSheetNames(opened));
      structureChanged = true;
      changes.push({
        operation: "add_sheet",
        anchor: `xlsx:sheet:${encoded(name)}`,
        before: null,
        after: { name, position },
      });
      continue;
    }
    if (operation?.type === "rename_sheet") {
      const oldName = String(operation.sheet || "");
      const sheet = opened.sheets.get(oldName);
      if (!sheet) throw new ApiError(`工作表不存在：${oldName}`, 404);
      const name = validateSheetName(operation.name, workbookSheetNames(opened), oldName);
      const rewrittenReferences = oldName === name ? 0 : await rewriteWorkbookReferences(opened, sheetDocuments, oldName, name);
      sheet.node.setAttribute("name", name);
      opened.sheets.delete(oldName);
      sheet.name = name;
      opened.sheets.set(name, sheet);
      structureChanged = true;
      formulaReferencesChanged ||= rewrittenReferences > 0;
      changes.push({
        operation: "rename_sheet",
        anchor: `xlsx:sheet:${encoded(name)}`,
        previous_anchor: `xlsx:sheet:${encoded(oldName)}`,
        before: { name: oldName },
        after: { name },
        rewritten_references: rewrittenReferences,
      });
      if (oldName !== name) warnings.push("已更新常见的工作表公式、定义名称、验证、条件格式和图表引用；外部链接或少见扩展中的引用请重新打开核对。");
      continue;
    }
    if (operation?.type === "delete_sheet") {
      const name = String(operation.sheet || "");
      const sheet = opened.sheets.get(name);
      if (!sheet) throw new ApiError(`工作表不存在：${name}`, 404);
      if (opened.sheets.size <= 1) throw new ApiError("工作簿至少要保留一个工作表", 409);
      const beforeNames = workbookSheetNames(opened);
      const position = beforeNames.indexOf(name) + 1;
      const rewrittenReferences = await rewriteWorkbookReferences(opened, sheetDocuments, name, null);
      removeWorksheetPackageEntries(opened, sheet);
      sheetDocuments.delete(sheet.path);
      opened.sheets.delete(name);
      remapSheetIndexes(opened.workbookDocument, beforeNames, workbookSheetNames(opened));
      structureChanged = true;
      formulaReferencesChanged ||= rewrittenReferences > 0;
      changes.push({
        operation: "delete_sheet",
        anchor: `xlsx:sheet:${encoded(name)}`,
        before: { name, position },
        after: null,
        rewritten_references: rewrittenReferences,
      });
      warnings.push("删除工作表后，指向它的常见公式引用已改为 #REF!；外部链接或少见扩展中的引用请重新打开核对。");
      continue;
    }
    if (operation?.type === "move_sheet") {
      const name = String(operation.sheet || "");
      const sheet = opened.sheets.get(name);
      if (!sheet) throw new ApiError(`工作表不存在：${name}`, 404);
      const beforeNames = workbookSheetNames(opened);
      const beforePosition = beforeNames.indexOf(name) + 1;
      const position = sheetPosition(operation, beforeNames.length);
      if (position === null) throw new ApiError("移动工作表时必须提供位置", 400);
      const parent = workbookSheetsElement(opened.workbookDocument);
      parent.removeChild(sheet.node);
      insertSheetNode(parent, sheet.node, position);
      remapSheetIndexes(opened.workbookDocument, beforeNames, workbookSheetNames(opened));
      structureChanged = true;
      changes.push({
        operation: "move_sheet",
        anchor: `xlsx:sheet:${encoded(name)}`,
        before: { name, position: beforePosition },
        after: { name, position },
      });
      continue;
    }
    if (!(["set_cell", "clear_cell"].includes(operation?.type))) throw new ApiError("XLSX 不支持这个修改动作", 400);
    const { sheetName, address } = parseCellTarget(operation);
    const sheet = opened.sheets.get(sheetName);
    if (!sheet) throw new ApiError(`工作表不存在：${sheetName}`, 404);
    const sheetDocument = await loadSheetDocument(opened, sheetDocuments, sheet);
    const change = writeCell(ensureCell(sheetDocument, address), operation);
    expandSheetDimension(sheetDocument, address);
    changes.push({ anchor: `xlsx:cell:${encoded(sheetName)}:${address}`, sheet: sheetName, address, ...change });
  }
  for (const [path, document] of sheetDocuments) opened.archive.file(path, serializeOfficeXml(document));
  if (changes.some((change) => change.after?.formula) || formulaReferencesChanged) markWorkbookForRecalculation(opened.workbookDocument);
  opened.archive.file(WORKBOOK_PATH, serializeOfficeXml(opened.workbookDocument));
  if (structureChanged) {
    opened.archive.file(WORKBOOK_RELS_PATH, serializeOfficeXml(opened.relationshipsDocument));
    opened.archive.file(CONTENT_TYPES_PATH, serializeOfficeXml(opened.contentTypesDocument));
  }
  const output = await opened.archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFile(outputPath, output, { mode: 0o600, flag: "wx" });
  return { changes, warnings: [...new Set(warnings)] };
}

function defaultRows({ title = "", content = "" } = {}) {
  const rows = [];
  if (String(title || "").trim()) rows.push([String(title).trim()]);
  for (const line of String(content || "").replace(/\r\n?/g, "\n").split("\n")) {
    if (line || rows.length) rows.push([line]);
  }
  return rows.length ? rows : [[""]];
}

export async function createXlsxFile(outputPath, specification = {}) {
  const workbook = XLSX.utils.book_new();
  const sheets = Array.isArray(specification.sheets) && specification.sheets.length
    ? specification.sheets
    : [{ name: "Sheet1", rows: defaultRows(specification) }];
  for (const item of sheets.slice(0, MAX_SHEETS)) {
    const name = validateSheetName(item?.name || `Sheet${workbook.SheetNames.length + 1}`, workbook.SheetNames);
    const rows = Array.isArray(item?.rows) ? item.rows : [[""]];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx", compression: true });
  await writeFile(outputPath, buffer, { mode: 0o600, flag: "wx" });
  return inspectXlsxFile(outputPath);
}

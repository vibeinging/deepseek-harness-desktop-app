import { readFile, writeFile } from "node:fs/promises";

import JSZip from "jszip";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

import { ApiError } from "../../errors.js";
import {
  attributeByLocalName,
  childrenNamed,
  createElement,
  descendantsNamed,
  elementChildren,
  firstDescendant,
  localName,
  parseOfficeXml,
  replaceTextNodes,
  serializeOfficeXml,
  visibleText,
} from "./office_xml.js";

const WORD_NAMESPACE = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const DOCUMENT_PATH = "word/document.xml";

function encoded(value) {
  return encodeURIComponent(String(value || ""));
}

function paragraphStyle(paragraph) {
  const properties = childrenNamed(paragraph, "pPr")[0];
  const style = properties ? childrenNamed(properties, "pStyle")[0] : null;
  return attributeByLocalName(style, "val") || "";
}

function ensureParagraphText(paragraph) {
  let textNodes = descendantsNamed(paragraph, "t");
  if (textNodes.length) return textNodes;
  const document = paragraph.ownerDocument;
  const run = createElement(document, WORD_NAMESPACE, "w:r");
  const text = createElement(document, WORD_NAMESPACE, "w:t", "");
  run.appendChild(text);
  paragraph.appendChild(run);
  textNodes = [text];
  return textNodes;
}

function replaceWholeContainer(container, text) {
  let nodes = descendantsNamed(container, "t");
  if (!nodes.length) {
    let paragraph = descendantsNamed(container, "p")[0];
    if (!paragraph && localName(container) === "p") paragraph = container;
    if (!paragraph) {
      paragraph = createElement(container.ownerDocument, WORD_NAMESPACE, "w:p");
      container.appendChild(paragraph);
    }
    nodes = ensureParagraphText(paragraph);
  }
  const before = nodes.map((node) => String(node.textContent || "")).join("");
  nodes[0].textContent = String(text ?? "");
  if (/^\s|\s$/.test(nodes[0].textContent)) nodes[0].setAttribute("xml:space", "preserve");
  else nodes[0].removeAttribute("xml:space");
  for (const node of nodes.slice(1)) node.textContent = "";
  return { before, after: String(text ?? "") };
}

async function openDocx(input) {
  const buffer = Buffer.isBuffer(input) ? input : await readFile(input);
  let archive;
  try {
    archive = await JSZip.loadAsync(buffer);
  } catch {
    throw new ApiError("DOCX 文件已损坏", 400);
  }
  const part = archive.file(DOCUMENT_PATH);
  if (!part) throw new ApiError("DOCX 缺少正文内容", 400);
  const document = parseOfficeXml(await part.async("string"), "DOCX");
  const body = firstDescendant(document.documentElement, "body");
  if (!body) throw new ApiError("DOCX 缺少正文结构", 400);
  return { archive, document, body };
}

function documentModel(body) {
  const sections = [];
  const targets = new Map();
  let paragraphIndex = 0;
  let tableIndex = 0;
  for (const child of elementChildren(body)) {
    if (localName(child) === "p") {
      paragraphIndex += 1;
      const paraId = attributeByLocalName(child, "paraId") || String(paragraphIndex);
      const anchor = `docx:p:${encoded(paraId)}:${paragraphIndex}`;
      const section = {
        anchor,
        kind: "paragraph",
        text: visibleText(child),
        style: paragraphStyle(child),
        index: paragraphIndex,
        can_replace_range: true,
      };
      sections.push(section);
      targets.set(anchor, { kind: "paragraph", node: child });
      continue;
    }
    if (localName(child) !== "tbl") continue;
    tableIndex += 1;
    const rows = [];
    const rowNodes = childrenNamed(child, "tr");
    for (let rowIndex = 0; rowIndex < rowNodes.length; rowIndex += 1) {
      const cells = [];
      const cellNodes = childrenNamed(rowNodes[rowIndex], "tc");
      for (let cellIndex = 0; cellIndex < cellNodes.length; cellIndex += 1) {
        const anchor = `docx:table:${tableIndex}:cell:${rowIndex + 1}:${cellIndex + 1}`;
        const paragraphs = childrenNamed(cellNodes[cellIndex], "p");
        const text = paragraphs.map((paragraph) => visibleText(paragraph)).join("\n");
        cells.push({ anchor, kind: "cell", text, row: rowIndex + 1, column: cellIndex + 1, can_replace_range: false });
        targets.set(anchor, { kind: "cell", node: cellNodes[cellIndex] });
      }
      rows.push({ index: rowIndex + 1, cells });
    }
    sections.push({
      anchor: `docx:table:${tableIndex}`,
      kind: "table",
      index: tableIndex,
      rows,
    });
  }
  return { sections, targets };
}

export async function inspectDocxFile(filePath) {
  const { body } = await openDocx(filePath);
  const { sections } = documentModel(body);
  return {
    format: "docx",
    sections,
    capabilities: { create: true, replace_text: true, replace_range: true, tables: true, tracked_changes: false },
    warnings: ["修改只作用于选中的段落或单元格；修订模式和 Word 批注暂不自动生成。"],
  };
}

export async function editDocxFile(inputPath, outputPath, operations = []) {
  const { archive, document, body } = await openDocx(inputPath);
  const changes = [];
  for (const operation of operations) {
    const { targets } = documentModel(body);
    const target = targets.get(String(operation?.anchor || ""));
    if (!target) throw new ApiError("DOCX 选区已失效，请重新打开当前版本", 409);
    if (operation?.type !== "replace_text" && operation?.type !== "replace_range") {
      throw new ApiError("DOCX 不支持这个修改动作", 400);
    }
    if (target.kind === "cell") {
      if (operation.type === "replace_range") throw new ApiError("表格单元格目前只支持整格替换", 400);
      changes.push({ anchor: operation.anchor, ...replaceWholeContainer(target.node, operation.text) });
      continue;
    }
    const nodes = ensureParagraphText(target.node);
    const change = operation.type === "replace_range"
      ? replaceTextNodes(nodes, operation.text, { start: operation.start, end: operation.end })
      : replaceTextNodes(nodes, operation.text);
    changes.push({ anchor: operation.anchor, ...change });
  }
  archive.file(DOCUMENT_PATH, serializeOfficeXml(document));
  const output = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFile(outputPath, output, { mode: 0o600, flag: "wx" });
  return { changes };
}

function contentParagraphs(content) {
  return String(content || "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => new Paragraph({ children: [new TextRun(text)] }));
}

export async function createDocxFile(outputPath, { title = "", content = "" } = {}) {
  const children = [];
  if (String(title || "").trim()) {
    children.push(new Paragraph({ text: String(title).trim(), heading: HeadingLevel.TITLE }));
  }
  children.push(...contentParagraphs(content));
  if (!children.length) children.push(new Paragraph({ children: [new TextRun("")] }));
  const document = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(document);
  await writeFile(outputPath, buffer, { mode: 0o600, flag: "wx" });
  return inspectDocxFile(outputPath);
}

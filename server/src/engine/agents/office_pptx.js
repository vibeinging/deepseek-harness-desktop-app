import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import PptxGenJS from "pptxgenjs";
import { PptxHandler, SvgExporter } from "pptx-viewer-core";

import { ApiError } from "../../errors.js";

const MAX_SLIDES = 300;
const MAX_PREVIEW_SVG_BYTES = 8 * 1024 * 1024;
const MAX_SINGLE_PREVIEW_SVG_BYTES = 1024 * 1024;
const MAX_TABLE_ROWS = 80;
const MAX_TABLE_COLUMNS = 30;
const MAX_CHART_CATEGORIES = 200;
const MAX_CHART_SERIES = 30;
const TEXT_ELEMENT_TYPES = new Set(["text", "shape", "connector"]);
const POSITION_FIELDS = Object.freeze(["x", "y", "width", "height", "rotation", "opacity"]);

function encoded(value) {
  return encodeURIComponent(String(value || ""));
}

function arrayBufferFor(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function finiteNumber(value, label, { min = -1_000_000, max = 1_000_000 } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new ApiError(`${label}无效`, 400);
  return number;
}

function optionalColor(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const color = String(value).trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new ApiError(`${label}必须是 #RRGGBB 颜色`, 400);
  return color.toUpperCase();
}

function safeText(value, maxLength = 200_000) {
  const text = String(value ?? "");
  if (text.length > maxLength) throw new ApiError("PPTX 文字内容过长", 400);
  return text;
}

function elementAnchor(slideNumber, element) {
  return `pptx:slide:${slideNumber}:element:${encoded(element?.shapeId || element?.id)}`;
}

function notesAnchor(slideNumber) {
  return `pptx:slide:${slideNumber}:notes`;
}

function visibleNotes(slide) {
  const raw = String(slide?.notes || "");
  if (/^\d{1,3}$/.test(raw.trim())) return "";
  const lines = raw.split("\n");
  while (lines.length > 1 && /^\d{1,3}$/.test(lines.at(-1).trim())) lines.pop();
  return lines.join("\n").trimEnd();
}

function slideAnchor(slideNumber) {
  return `pptx:slide:${slideNumber}`;
}

function elementText(element) {
  if (typeof element?.text === "string") return element.text;
  if (element?.type === "table") {
    return (element.tableData?.rows || [])
      .map((row) => (row.cells || []).map((cell) => String(cell?.text || "")).join("\t"))
      .join("\n");
  }
  if (element?.type === "chart") {
    return [element.chartData?.title, ...(element.chartData?.series || []).map((series) => series?.name)]
      .filter(Boolean)
      .join(" · ");
  }
  return "";
}

function tableDataForClient(element) {
  if (element?.type !== "table" || !element.tableData) return null;
  const sourceRows = element.tableData.rows || [];
  const rows = sourceRows.slice(0, MAX_TABLE_ROWS).map((row) => ({
    cells: (row.cells || []).slice(0, MAX_TABLE_COLUMNS).map((cell) => ({ text: String(cell?.text || "") })),
  }));
  return {
    rows,
    row_count: sourceRows.length,
    column_count: Math.max(0, ...sourceRows.map((row) => row.cells?.length || 0)),
    truncated: sourceRows.length > rows.length || sourceRows.some((row) => (row.cells?.length || 0) > MAX_TABLE_COLUMNS),
  };
}

function chartDataForClient(element) {
  if (element?.type !== "chart" || !element.chartData) return null;
  const categories = (element.chartData.categories || []).slice(0, MAX_CHART_CATEGORIES).map(String);
  const series = (element.chartData.series || []).slice(0, MAX_CHART_SERIES).map((item) => ({
    name: String(item?.name || ""),
    values: (item?.values || []).slice(0, MAX_CHART_CATEGORIES).map((value) => Number(value) || 0),
    color: item?.color || null,
  }));
  return {
    title: element.chartData.title || "",
    chart_type: element.chartData.chartType || "",
    categories,
    series,
    truncated: (element.chartData.categories?.length || 0) > categories.length
      || (element.chartData.series?.length || 0) > series.length,
  };
}

function clientStyle(element) {
  const textStyle = element?.textStyle || {};
  const shapeStyle = element?.shapeStyle || {};
  return {
    fill_color: shapeStyle.fillColor || null,
    fill_mode: shapeStyle.fillMode || null,
    stroke_color: shapeStyle.strokeColor || null,
    stroke_width: Number.isFinite(shapeStyle.strokeWidth) ? shapeStyle.strokeWidth : null,
    text_color: textStyle.color || null,
    font_family: textStyle.fontFamily || null,
    font_size: Number.isFinite(textStyle.fontSize) ? textStyle.fontSize : null,
    bold: textStyle.bold === true,
    italic: textStyle.italic === true,
    underline: textStyle.underline === true,
    align: textStyle.align || null,
  };
}

function editableOperations(element) {
  const operations = ["update_element", "delete_element"];
  if (TEXT_ELEMENT_TYPES.has(element?.type)) operations.unshift("replace_text", "replace_range");
  if (element?.type === "table") operations.unshift("set_table_cell");
  if (element?.type === "chart") operations.unshift("update_chart_data");
  return operations;
}

function clientObject(slideNumber, element) {
  const text = elementText(element);
  return {
    anchor: elementAnchor(slideNumber, element),
    kind: String(element?.type || "unknown"),
    object_id: String(element?.shapeId || element?.id || ""),
    name: String(element?.name || `${element?.type || "对象"} ${element?.shapeId || ""}`).trim(),
    placeholder: String(element?.placeholderType || ""),
    text,
    position: {
      x: Number(element?.x) || 0,
      y: Number(element?.y) || 0,
      width: Number(element?.width) || 0,
      height: Number(element?.height) || 0,
    },
    rotation: Number(element?.rotation) || 0,
    opacity: Number.isFinite(element?.opacity) ? element.opacity : 1,
    hidden: element?.hidden === true,
    shape_type: element?.shapeType || null,
    style: clientStyle(element),
    table_data: tableDataForClient(element),
    chart_data: chartDataForClient(element),
    can_replace_range: TEXT_ELEMENT_TYPES.has(element?.type),
    editable_operations: editableOperations(element),
  };
}

function warningMessages(handler, data) {
  const warnings = [...(data?.warnings || []), ...(handler.getCompatibilityWarnings?.() || [])];
  const seen = new Set();
  const result = [];
  for (const warning of warnings) {
    const message = String(warning?.message || warning?.code || warning || "").trim();
    if (!message || seen.has(message)) continue;
    seen.add(message);
    result.push(message);
    if (result.length >= 50) break;
  }
  return result;
}

function safePreviewSvg(slide, data, remainingBytes) {
  if (remainingBytes <= 0) return null;
  try {
    const svg = SvgExporter.exportSlide(slide, data.width, data.height, {
      defaultFontFamily: "Aptos, Arial, sans-serif",
      defaultFontSize: 18,
    });
    const bytes = Buffer.byteLength(svg, "utf8");
    if (bytes > MAX_SINGLE_PREVIEW_SVG_BYTES || bytes > remainingBytes) return null;
    return { svg, bytes };
  } catch {
    return null;
  }
}

async function openPptx(input) {
  const buffer = Buffer.isBuffer(input) ? input : await readFile(input);
  const handler = new PptxHandler();
  try {
    const data = await handler.load(arrayBufferFor(buffer), {
      eagerDecodeImages: true,
      allowExternalImages: false,
      maxUncompressedBytes: 500 * 1024 * 1024,
    });
    if (!Array.isArray(data?.slides) || !data.slides.length) throw new ApiError("PPTX 没有可读取的页面", 400);
    if (data.slides.length > MAX_SLIDES) throw new ApiError(`PPTX 页面过多，最多支持 ${MAX_SLIDES} 页`, 400);
    return { handler, data };
  } catch (error) {
    handler.dispose?.();
    if (error instanceof ApiError) throw error;
    if (error?.code === "ZIP_BOMB") throw new ApiError("PPTX 解压后内容过大，已停止读取", 400);
    if (/password|encrypted/i.test(String(error?.message || ""))) throw new ApiError("暂不支持加密的 PPTX 文件", 400);
    throw new ApiError(`PPTX 文件无法读取：${String(error?.message || "文件已损坏")}`, 400);
  }
}

function buildModel(handler, data, { includePreview = true } = {}) {
  const sections = [];
  const targetIndex = new Map();
  let previewBytes = 0;
  let previewTruncated = false;
  for (let index = 0; index < data.slides.length; index += 1) {
    const slide = data.slides[index];
    const number = index + 1;
    const objects = (slide.elements || []).map((element) => {
      const object = clientObject(number, element);
      targetIndex.set(object.anchor, { slide, slideIndex: index, element, elementIndex: slide.elements.indexOf(element) });
      return object;
    });
    const preview = includePreview
      ? safePreviewSvg(slide, data, MAX_PREVIEW_SVG_BYTES - previewBytes)
      : null;
    if (preview) previewBytes += preview.bytes;
    else if (includePreview) previewTruncated = true;
    const notes = typeof slide.notes === "string"
      ? { anchor: notesAnchor(number), text: visibleNotes(slide, number) }
      : null;
    if (notes) targetIndex.set(notes.anchor, { slide, slideIndex: index, kind: "notes" });
    sections.push({
      anchor: slideAnchor(number),
      kind: "slide",
      number,
      object_id: slide.id,
      name: slide.name || `第 ${number} 页`,
      layout_name: slide.layoutName || "",
      hidden: slide.hidden === true,
      size: { width: data.width, height: data.height },
      background: {
        color: slide.backgroundColor || "#FFFFFF",
        gradient: slide.backgroundGradient || null,
        has_image: Boolean(slide.backgroundImage),
      },
      preview_svg: preview?.svg || null,
      objects,
      notes,
    });
    targetIndex.set(slideAnchor(number), { slide, slideIndex: index, kind: "slide" });
  }
  return { sections, targetIndex, previewTruncated };
}

export async function inspectPptxFile(filePath) {
  const opened = await openPptx(filePath);
  try {
    const { sections, previewTruncated } = buildModel(opened.handler, opened.data);
    const warnings = warningMessages(opened.handler, opened.data);
    if (previewTruncated) warnings.unshift("部分复杂页面未生成内置预览；仍可选择对象并在 PowerPoint 中打开核对。");
    if (opened.data.hasDigitalSignatures) warnings.unshift("这个演示文稿带有数字签名；任何保存都会使原签名失效。");
    return {
      format: "pptx",
      sections,
      capabilities: {
        create: true,
        replace_text: true,
        replace_range: true,
        update_element: true,
        delete_element: true,
        set_table_cell: true,
        update_chart_data: true,
        move_slide: true,
        duplicate_slide: true,
        delete_slide: true,
        set_slide_visibility: true,
        update_notes: true,
        svg_preview: true,
        layout_preserved: true,
      },
      warnings,
    };
  } finally {
    opened.handler.dispose?.();
  }
}

function requireSlide(data, page) {
  const number = Math.trunc(finiteNumber(page, "PPTX 页码", { min: 1, max: MAX_SLIDES }));
  const slide = data.slides[number - 1];
  if (!slide) throw new ApiError("PPTX 页面已失效，请重新打开当前版本", 409);
  return { slide, index: number - 1, number };
}

function replaceElementText(element, operation) {
  if (!TEXT_ELEMENT_TYPES.has(element?.type)) throw new ApiError("这个 PPTX 对象没有可编辑文字", 409);
  const before = String(element.text || "");
  let after = safeText(operation.text);
  if (operation.type === "replace_range") {
    const start = Math.trunc(finiteNumber(operation.start, "文字起点", { min: 0, max: before.length }));
    const end = Math.trunc(finiteNumber(operation.end, "文字终点", { min: start, max: before.length }));
    after = before.slice(0, start) + after + before.slice(end);
  }
  element.text = after;
  return { before, after };
}

function updateElement(element, operation, page) {
  if (operation.position !== undefined) {
    throw new ApiError("PPTX update_element 请直接使用 x、y、width、height，不要传 position 对象", 400);
  }
  if (operation.style !== undefined) {
    throw new ApiError("PPTX update_element 请直接使用 text_color、fill_color、font_size 等字段，不要传 style 对象", 400);
  }
  const before = {
    text: elementText(element),
    position: { x: element.x, y: element.y, width: element.width, height: element.height },
    rotation: element.rotation || 0,
    opacity: element.opacity ?? 1,
    hidden: element.hidden === true,
    style: clientStyle(element),
  };
  for (const field of POSITION_FIELDS) {
    if (operation[field] === undefined) continue;
    const bounds = field === "opacity"
      ? { min: 0, max: 1 }
      : field === "rotation"
        ? { min: -360, max: 360 }
        : field === "width" || field === "height"
          ? { min: 1, max: 1_000_000 }
          : { min: -1_000_000, max: 1_000_000 };
    element[field] = finiteNumber(operation[field], `PPTX ${field}`, bounds);
  }
  if (operation.hidden !== undefined) element.hidden = operation.hidden === true;
  if (operation.text !== undefined) {
    if (!TEXT_ELEMENT_TYPES.has(element?.type)) throw new ApiError("这个 PPTX 对象没有可编辑文字", 409);
    element.text = safeText(operation.text);
  }
  const fillColor = optionalColor(operation.fill_color, "填充色");
  const strokeColor = optionalColor(operation.stroke_color, "描边色");
  if (fillColor || strokeColor || operation.stroke_width !== undefined) {
    element.shapeStyle = { ...(element.shapeStyle || {}) };
    if (fillColor) Object.assign(element.shapeStyle, { fillColor, fillMode: "solid" });
    if (strokeColor) element.shapeStyle.strokeColor = strokeColor;
    if (operation.stroke_width !== undefined) {
      element.shapeStyle.strokeWidth = finiteNumber(operation.stroke_width, "描边宽度", { min: 0, max: 100 });
    }
  }
  const textColor = optionalColor(operation.text_color, "文字颜色");
  const hasTextStyle = textColor || operation.font_family !== undefined || operation.font_size !== undefined
    || operation.bold !== undefined || operation.italic !== undefined || operation.underline !== undefined
    || operation.align !== undefined;
  if (hasTextStyle) {
    if (!TEXT_ELEMENT_TYPES.has(element?.type)) throw new ApiError("这个 PPTX 对象不支持文字样式", 409);
    element.textStyle = { ...(element.textStyle || {}) };
    if (textColor) element.textStyle.color = textColor;
    if (operation.font_family !== undefined) element.textStyle.fontFamily = safeText(operation.font_family, 200).trim();
    if (operation.font_size !== undefined) element.textStyle.fontSize = finiteNumber(operation.font_size, "字号", { min: 1, max: 400 });
    if (operation.bold !== undefined) element.textStyle.bold = operation.bold === true;
    if (operation.italic !== undefined) element.textStyle.italic = operation.italic === true;
    if (operation.underline !== undefined) element.textStyle.underline = operation.underline === true;
    if (operation.align !== undefined) {
      const align = String(operation.align || "").trim();
      if (!["left", "center", "right", "justify"].includes(align)) throw new ApiError("文字对齐方式无效", 400);
      element.textStyle.align = align;
    }
  }
  const after = clientObject(page, element);
  const comparableAfter = {
    text: after.text,
    position: after.position,
    rotation: after.rotation,
    opacity: after.opacity,
    hidden: after.hidden,
    style: after.style,
  };
  if (JSON.stringify(before) === JSON.stringify(comparableAfter)) {
    throw new ApiError("PPTX update_element 没有产生变化；请检查字段名和目标值", 400);
  }
  return { before, after };
}

function updateTableCell(element, operation) {
  if (element?.type !== "table" || !element.tableData) throw new ApiError("选中的对象不是可编辑表格", 409);
  const row = Math.trunc(finiteNumber(operation.row, "表格行号", { min: 1, max: MAX_TABLE_ROWS * 100 }));
  const column = Math.trunc(finiteNumber(operation.column, "表格列号", { min: 1, max: MAX_TABLE_COLUMNS * 100 }));
  const cell = element.tableData.rows?.[row - 1]?.cells?.[column - 1];
  if (!cell) throw new ApiError("PPTX 表格单元格已失效，请重新检查", 409);
  const before = String(cell.text || "");
  cell.text = safeText(operation.text, 50_000);
  return { before, after: cell.text, row, column };
}

function updateChartData(element, operation) {
  if (element?.type !== "chart" || !element.chartData) throw new ApiError("选中的对象不是可编辑图表", 409);
  const categories = Array.isArray(operation.categories)
    ? operation.categories.map((item) => safeText(item, 2_000))
    : [...(element.chartData.categories || [])];
  const seriesInput = Array.isArray(operation.series) ? operation.series : null;
  if (!categories.length || categories.length > MAX_CHART_CATEGORIES) throw new ApiError(`图表分类需为 1 到 ${MAX_CHART_CATEGORIES} 项`, 400);
  const series = seriesInput
    ? seriesInput.map((item, index) => {
        const values = Array.isArray(item?.values) ? item.values.map((value) => finiteNumber(value, "图表数值")) : [];
        if (values.length !== categories.length) throw new ApiError(`图表第 ${index + 1} 个系列的数值数量必须与分类数量一致`, 400);
        return {
          ...(element.chartData.series?.[index] || {}),
          name: safeText(item?.name || `系列 ${index + 1}`, 500),
          values,
          ...(optionalColor(item?.color, "系列颜色") ? { color: optionalColor(item.color, "系列颜色") } : {}),
        };
      })
    : element.chartData.series;
  if (!Array.isArray(series) || !series.length || series.length > MAX_CHART_SERIES) {
    throw new ApiError(`图表系列需为 1 到 ${MAX_CHART_SERIES} 项`, 400);
  }
  const before = chartDataForClient(element);
  element.chartData = {
    ...element.chartData,
    ...(operation.title !== undefined ? { title: safeText(operation.title, 2_000) } : {}),
    categories,
    series,
  };
  return { before, after: chartDataForClient(element) };
}

function prepareElementsForSave(elements = []) {
  for (const element of elements) {
    if (element?.type === "table") {
      const table = element.rawXml?.["a:graphic"]?.["a:graphicData"]?.["a:tbl"];
      if (table && (table["a:tblPr"] === "" || table["a:tblPr"] === null)) table["a:tblPr"] = {};
    }
    if (element?.type === "group" && Array.isArray(element.children)) prepareElementsForSave(element.children);
  }
}

function applySlideOperation(data, operation) {
  const type = String(operation?.type || "");
  if (!["move_slide", "delete_slide", "duplicate_slide", "set_slide_visibility", "update_notes"].includes(type)) return null;
  const selected = requireSlide(data, operation.page);
  if (type === "move_slide") {
    const position = Math.trunc(finiteNumber(operation.position, "目标页码", { min: 1, max: data.slides.length }));
    const [slide] = data.slides.splice(selected.index, 1);
    data.slides.splice(position - 1, 0, slide);
    return { operation: type, page: selected.number, position };
  }
  if (type === "delete_slide") {
    if (data.slides.length <= 1) throw new ApiError("演示文稿至少要保留一页", 400);
    data.slides.splice(selected.index, 1);
    return { operation: type, page: selected.number };
  }
  if (type === "duplicate_slide") {
    if (data.slides.length >= MAX_SLIDES) throw new ApiError(`演示文稿最多支持 ${MAX_SLIDES} 页`, 400);
    const clone = structuredClone(selected.slide);
    clone.sourceSlideId = selected.slide.id;
    clone.id = `new-slide-${randomUUID()}`;
    clone.rId = "";
    clone.slideNumber = selected.number + 1;
    data.slides.splice(selected.index + 1, 0, clone);
    return { operation: type, page: selected.number, position: selected.number + 1 };
  }
  if (type === "set_slide_visibility") {
    selected.slide.hidden = operation.hidden === true;
    return { operation: type, page: selected.number, hidden: selected.slide.hidden };
  }
  if (type === "update_notes") {
    const before = visibleNotes(selected.slide, selected.number);
    selected.slide.notes = safeText(operation.text, 200_000);
    selected.slide.notesSegments = undefined;
    return { operation: type, anchor: notesAnchor(selected.number), before, after: selected.slide.notes };
  }
  return null;
}

export async function editPptxFile(inputPath, outputPath, operations = []) {
  const opened = await openPptx(inputPath);
  try {
    if (opened.data.hasDigitalSignatures) throw new ApiError("带数字签名的 PPTX 暂不允许直接保存，请先另存为未签名副本", 409);
    const { targetIndex } = buildModel(opened.handler, opened.data, { includePreview: false });
    const changes = [];
    for (const operation of operations) {
      const slideChange = applySlideOperation(opened.data, operation);
      if (slideChange) {
        changes.push(slideChange);
        continue;
      }
      const target = targetIndex.get(String(operation?.anchor || ""));
      if (!target?.element) throw new ApiError("PPTX 选区已失效，请重新打开当前版本", 409);
      if (operation?.type === "replace_text" || operation?.type === "replace_range") {
        changes.push({ anchor: operation.anchor, operation: operation.type, ...replaceElementText(target.element, operation) });
      } else if (operation?.type === "update_element") {
        changes.push({ anchor: operation.anchor, operation: operation.type, ...updateElement(target.element, operation, target.slideIndex + 1) });
      } else if (operation?.type === "set_table_cell") {
        changes.push({ anchor: operation.anchor, operation: operation.type, ...updateTableCell(target.element, operation) });
      } else if (operation?.type === "update_chart_data") {
        changes.push({ anchor: operation.anchor, operation: operation.type, ...updateChartData(target.element, operation) });
      } else if (operation?.type === "delete_element") {
        target.slide.elements.splice(target.elementIndex, 1);
        changes.push({ anchor: operation.anchor, operation: operation.type, before: clientObject(target.slideIndex + 1, target.element), after: null });
      } else {
        throw new ApiError("PPTX 不支持这个修改动作", 400);
      }
    }
    opened.data.slides.forEach((slide, index) => { slide.slideNumber = index + 1; });
    for (const slide of opened.data.slides) prepareElementsForSave(slide.elements);
    const output = await opened.handler.save(opened.data.slides);
    await writeFile(outputPath, Buffer.from(output), { mode: 0o600, flag: "wx" });
    return { changes, warnings: warningMessages(opened.handler, opened.data) };
  } finally {
    opened.handler.dispose?.();
  }
}

function slideLayout(item, index) {
  const value = String(item?.layout || "").toLowerCase();
  if (["title", "cover"].includes(value) || (index === 0 && !value)) return "title";
  if (["section", "divider"].includes(value)) return "section";
  if (["two-column", "two_column", "columns"].includes(value)) return "two-column";
  return "content";
}

function addSlideText(slide, item, index, total, accent) {
  const layout = slideLayout(item, index);
  const title = String(item?.title || (index === 0 ? "演示文稿" : `第 ${index + 1} 页`));
  const body = String(item?.body || "");
  if (layout === "title") {
    slide.background = { color: String(item?.background_color || "17131F").replace(/^#/, "") };
    slide.addShape("rect", { x: 0, y: 0, w: 0.16, h: 7.5, fill: { color: accent }, line: { color: accent } });
    slide.addText(title, { x: 0.85, y: 2.15, w: 11.5, h: 1.35, fontFace: "Aptos Display", fontSize: 34, bold: true, color: "FFFFFF", margin: 0, breakLine: false, fit: "shrink" });
    if (body) slide.addText(body, { x: 0.9, y: 3.75, w: 10.8, h: 1.25, fontFace: "Aptos", fontSize: 17, color: "CFC8D8", margin: 0, valign: "top", fit: "shrink" });
    return;
  }
  if (layout === "section") {
    slide.background = { color: String(item?.background_color || accent).replace(/^#/, "") };
    slide.addText(String(index + 1).padStart(2, "0"), { x: 0.8, y: 0.75, w: 1.2, h: 0.5, fontFace: "Aptos", fontSize: 16, bold: true, color: "FFFFFF", transparency: 18, margin: 0 });
    slide.addText(title, { x: 0.8, y: 2.45, w: 11.5, h: 1.1, fontFace: "Aptos Display", fontSize: 32, bold: true, color: "FFFFFF", margin: 0, fit: "shrink" });
    if (body) slide.addText(body, { x: 0.85, y: 3.8, w: 10.7, h: 1.25, fontFace: "Aptos", fontSize: 17, color: "F2EEF5", margin: 0, fit: "shrink" });
    return;
  }
  slide.background = { color: String(item?.background_color || "F8F7FA").replace(/^#/, "") };
  slide.addShape("rect", { x: 0.72, y: 0.5, w: 0.12, h: 0.58, fill: { color: accent }, line: { color: accent } });
  slide.addText(title, { x: 1, y: 0.48, w: 11.3, h: 0.7, fontFace: "Aptos Display", fontSize: 26, bold: true, color: "241D2D", margin: 0, fit: "shrink" });
  if (layout === "two-column") {
    slide.addText(String(item?.left || body), { x: 0.85, y: 1.65, w: 5.55, h: 4.95, fontFace: "Aptos", fontSize: 17, color: "3F3948", margin: 0.08, valign: "top", fit: "shrink" });
    slide.addShape("line", { x: 6.65, y: 1.65, w: 0, h: 4.8, line: { color: "DDD8E2", width: 1 } });
    slide.addText(String(item?.right || ""), { x: 6.95, y: 1.65, w: 5.5, h: 4.95, fontFace: "Aptos", fontSize: 17, color: "3F3948", margin: 0.08, valign: "top", fit: "shrink" });
  } else {
    slide.addText(body, { x: 0.85, y: 1.55, w: 11.65, h: 5.1, fontFace: "Aptos", fontSize: 18, color: "3F3948", margin: 0.08, valign: "top", fit: "shrink" });
  }
  slide.addText(`${index + 1} / ${total}`, { x: 11.4, y: 7.05, w: 1.05, h: 0.22, fontFace: "Aptos", fontSize: 8, color: "88818F", margin: 0, align: "right" });
}

export async function createPptxFile(outputPath, specification = {}) {
  const presentation = new PptxGenJS();
  presentation.layout = "LAYOUT_WIDE";
  presentation.author = "DeepSeek Harness Desktop App";
  presentation.subject = String(specification.title || "本地演示文稿");
  presentation.title = String(specification.title || "本地演示文稿");
  presentation.company = "DeepSeek AI";
  presentation.lang = "zh-CN";
  presentation.theme = {
    headFontFace: "Aptos Display",
    bodyFontFace: "Aptos",
    lang: "zh-CN",
  };
  const slides = Array.isArray(specification.slides) && specification.slides.length
    ? specification.slides
    : [{ title: specification.title || "演示文稿", body: specification.content || "", layout: "title" }];
  const accent = optionalColor(specification.accent_color || "#72559B", "主题色").replace(/^#/, "");
  for (const [index, item] of slides.slice(0, MAX_SLIDES).entries()) {
    const slide = presentation.addSlide();
    addSlideText(slide, item, index, Math.min(slides.length, MAX_SLIDES), accent);
    if (String(item?.notes || "").trim() && typeof slide.addNotes === "function") slide.addNotes(String(item.notes));
  }
  const buffer = await presentation.write({ outputType: "nodebuffer" });
  await writeFile(outputPath, Buffer.from(buffer), { mode: 0o600, flag: "wx" });
  return inspectPptxFile(outputPath);
}

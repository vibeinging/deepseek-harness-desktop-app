import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";

import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import { ApiError } from "../../errors.js";

const MAX_PAGES = 1_000;
const MAX_ANNOTATIONS = 500;

function normalizeAnnotations(value) {
  return (Array.isArray(value) ? value : []).slice(0, MAX_ANNOTATIONS).map((item, index) => ({
    id: String(item?.id || `annotation-${index + 1}`),
    page: Number(item?.page || 1),
    rect: item?.rect || null,
    text: String(item?.text || ""),
    color: String(item?.color || "#8b5cf6"),
    type: String(item?.type || "note"),
  }));
}

function hexColor(value) {
  const match = String(value || "").match(/^#?([0-9a-f]{6})$/i);
  if (!match) return rgb(0.545, 0.361, 0.965);
  const number = Number.parseInt(match[1], 16);
  return rgb(((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255);
}

function normalizedRect(page, value) {
  const rect = value && typeof value === "object" ? value : {};
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new ApiError("PDF 区域必须使用 0 到 1 的页面比例坐标", 400);
  }
  const pageWidth = page.getWidth();
  const pageHeight = page.getHeight();
  return {
    x: x * pageWidth,
    y: pageHeight - (y + height) * pageHeight,
    width: width * pageWidth,
    height: height * pageHeight,
  };
}

async function extractedPages(buffer) {
  const mod = await import("pdf-parse");
  if (typeof mod.PDFParse !== "function") return [];
  const parser = new mod.PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return Array.isArray(result?.pages) ? result.pages : [];
  } catch {
    return [];
  } finally {
    await parser.destroy().catch(() => null);
  }
}

export async function inspectPdfFile(filePath, { annotations = [] } = {}) {
  const buffer = await readFile(filePath);
  let document;
  try {
    document = await PDFDocument.load(buffer, { updateMetadata: false });
  } catch {
    throw new ApiError("PDF 文件已损坏或受到不支持的加密保护", 400);
  }
  const textPages = await extractedPages(buffer);
  const pageAnnotations = normalizeAnnotations(annotations);
  const sections = document.getPages().slice(0, MAX_PAGES).map((page, index) => ({
    anchor: `pdf:page:${index + 1}`,
    kind: "page",
    page: index + 1,
    width: page.getWidth(),
    height: page.getHeight(),
    rotation: page.getRotation()?.angle || 0,
    text: String(textPages[index]?.text || ""),
    annotations: pageAnnotations.filter((item) => item.page === index + 1),
  }));
  return {
    format: "pdf",
    sections,
    capabilities: { create: true, annotate_region: true, cover_text: true, direct_source_edit: false },
    warnings: ["PDF 修改会生成新的 PDF 版本；要修改原始排版内容，请优先编辑对应的 DOCX、XLSX 或 PPTX 源产物。"],
  };
}

function assertPage(document, pageNumber) {
  const index = Number(pageNumber) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= document.getPageCount()) throw new ApiError("PDF 页码不存在", 404);
  return { page: document.getPage(index), pageNumber: index + 1 };
}

function encodableText(font, value) {
  const text = String(value || "");
  try {
    font.encodeText(text);
    return text;
  } catch {
    throw new ApiError("当前 PDF 覆盖文字只支持拉丁字符；中文修改请编辑源文档后重新生成 PDF", 400);
  }
}

function unicodeFontCandidates() {
  const configured = String(process.env.DSH_PDF_FONT_PATH || "").trim();
  return [
    configured,
    ...(process.platform === "darwin" ? [
      "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
      "/Library/Fonts/Arial Unicode.ttf",
    ] : []),
    ...(process.platform === "win32" ? [
      "C:/Windows/Fonts/msyh.ttf",
      "C:/Windows/Fonts/msyh.ttc",
      "C:/Windows/Fonts/simhei.ttf",
    ] : []),
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].filter(Boolean);
}

async function embedUnicodeFont(document) {
  const path = unicodeFontCandidates().find((candidate) => existsSync(candidate));
  if (!path) return null;
  try {
    document.registerFontkit(fontkit);
    return await document.embedFont(await readFile(path), { subset: true });
  } catch {
    return null;
  }
}

export async function editPdfFile(inputPath, outputPath, operations = [], { annotations = [] } = {}) {
  const buffer = await readFile(inputPath);
  let document;
  try {
    document = await PDFDocument.load(buffer, { updateMetadata: false });
  } catch {
    throw new ApiError("PDF 文件已损坏或受到不支持的加密保护", 400);
  }
  const markerFont = await document.embedFont(StandardFonts.Helvetica);
  const contentFont = await embedUnicodeFont(document) || markerFont;
  const nextAnnotations = normalizeAnnotations(annotations);
  const changes = [];
  for (const operation of operations) {
    if (!(operation?.type === "annotate_region" || operation?.type === "cover_text")) {
      throw new ApiError("PDF 只支持区域标注和覆盖文字", 400);
    }
    const { page, pageNumber } = assertPage(document, operation.page);
    const rect = normalizedRect(page, operation.rect);
    const color = hexColor(operation.color);
    if (operation.type === "cover_text") {
      const text = encodableText(contentFont, operation.text);
      page.drawRectangle({ ...rect, color: rgb(1, 1, 1), borderColor: color, borderWidth: 1 });
      page.drawText(text, {
        x: rect.x + 3,
        y: rect.y + Math.max(2, rect.height - 14),
        size: Math.min(12, Math.max(7, rect.height - 6)),
        font: contentFont,
        color: rgb(0.12, 0.12, 0.14),
        maxWidth: Math.max(1, rect.width - 6),
      });
      changes.push({ anchor: `pdf:page:${pageNumber}`, type: "cover_text", page: pageNumber, rect: operation.rect, after: text });
      continue;
    }
    const number = nextAnnotations.length + 1;
    page.drawRectangle({ ...rect, borderColor: color, borderWidth: 2, opacity: 0.18, borderOpacity: 0.95 });
    page.drawRectangle({ x: rect.x, y: rect.y + rect.height - 14, width: 20, height: 14, color, opacity: 0.92 });
    page.drawText(`#${number}`, { x: rect.x + 3, y: rect.y + rect.height - 11, size: 7, font: markerFont, color: rgb(1, 1, 1) });
    const annotation = {
      id: `annotation-${Date.now().toString(36)}-${number}`,
      type: "note",
      page: pageNumber,
      rect: operation.rect,
      text: String(operation.text || ""),
      color: String(operation.color || "#8b5cf6"),
    };
    nextAnnotations.push(annotation);
    changes.push({ anchor: `pdf:page:${pageNumber}`, type: "annotate_region", page: pageNumber, rect: operation.rect, after: annotation.text });
  }
  const output = await document.save({ useObjectStreams: false, updateFieldAppearances: false });
  await writeFile(outputPath, Buffer.from(output), { mode: 0o600, flag: "wx" });
  return { changes, metadata: { office_annotations: nextAnnotations } };
}

function wrapText(font, value, maxWidth, size) {
  const text = encodableText(font, value);
  const lines = [];
  let line = "";
  for (const character of Array.from(text)) {
    const candidate = `${line}${character}`;
    if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      lines.push(line);
      line = character.trimStart();
    } else {
      line = candidate;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

export async function createPdfFile(outputPath, { title = "", content = "" } = {}) {
  const document = await PDFDocument.create();
  const standard = await document.embedFont(StandardFonts.Helvetica);
  const standardBold = await document.embedFont(StandardFonts.HelveticaBold);
  const unicode = await embedUnicodeFont(document);
  const font = unicode || standard;
  const bold = unicode || standardBold;
  const safeTitle = encodableText(bold, String(title || "Document"));
  const safeContent = encodableText(font, String(content || ""));
  const width = 595.28;
  const height = 841.89;
  const margin = 54;
  let page = document.addPage([width, height]);
  let y = height - margin;
  page.drawText(safeTitle, { x: margin, y, size: 24, font: bold, color: rgb(0.14, 0.11, 0.18), maxWidth: width - margin * 2 });
  y -= 42;
  for (const paragraph of safeContent.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    for (const line of wrapText(font, paragraph, width - margin * 2, 11)) {
      if (y < margin + 18) {
        page = document.addPage([width, height]);
        y = height - margin;
      }
      page.drawText(line, { x: margin, y, size: 11, font, color: rgb(0.18, 0.17, 0.2) });
      y -= 17;
    }
    y -= 8;
  }
  const output = await document.save({ useObjectStreams: false });
  await writeFile(outputPath, Buffer.from(output), { mode: 0o600, flag: "wx" });
  return inspectPdfFile(outputPath);
}

import { extname } from "node:path";

import { ApiError } from "../../errors.js";
import { createDocxFile, editDocxFile, inspectDocxFile } from "./office_docx.js";
import { createMarkdownFile, editMarkdownFile, inspectMarkdownFile } from "./office_markdown.js";
import { createPdfFile, editPdfFile, inspectPdfFile } from "./office_pdf.js";
import { createPptxFile, editPptxFile, inspectPptxFile } from "./office_pptx.js";
import { createXlsxFile, editXlsxFile, inspectXlsxFile } from "./office_xlsx.js";

const FORMAT_BY_EXTENSION = new Map([
  [".md", "markdown"],
  [".markdown", "markdown"],
  [".docx", "docx"],
  [".xlsx", "xlsx"],
  [".pptx", "pptx"],
  [".pdf", "pdf"],
]);

const EXTENSION_BY_FORMAT = new Map([
  ["markdown", ".md"],
  ["docx", ".docx"],
  ["xlsx", ".xlsx"],
  ["pptx", ".pptx"],
  ["pdf", ".pdf"],
]);

export const OFFICE_ARTIFACT_FORMATS = Object.freeze([...EXTENSION_BY_FORMAT.keys()]);

export function officeFormatForPath(filePath) {
  return FORMAT_BY_EXTENSION.get(extname(String(filePath || "")).toLowerCase()) || null;
}

export function extensionForOfficeFormat(format) {
  return EXTENSION_BY_FORMAT.get(String(format || "").trim().toLowerCase()) || null;
}

function requireFormat(filePath, requested = "") {
  const detected = officeFormatForPath(filePath);
  const format = String(requested || detected || "").trim().toLowerCase();
  if (!OFFICE_ARTIFACT_FORMATS.includes(format)) throw new ApiError("这个文件格式暂不支持内置编辑", 400);
  if (detected && detected !== format) throw new ApiError("文件扩展名与编辑格式不一致", 400);
  return format;
}

export async function inspectOfficeArtifact(filePath, { metadata = {}, format = "" } = {}) {
  const selected = requireFormat(filePath, format);
  if (selected === "markdown") return inspectMarkdownFile(filePath);
  if (selected === "docx") return inspectDocxFile(filePath);
  if (selected === "xlsx") return inspectXlsxFile(filePath);
  if (selected === "pptx") return inspectPptxFile(filePath);
  return inspectPdfFile(filePath, { annotations: metadata?.office_annotations });
}

export async function editOfficeArtifact(inputPath, outputPath, operations, { metadata = {}, format = "" } = {}) {
  const selected = requireFormat(inputPath, format);
  if (!Array.isArray(operations) || !operations.length) throw new ApiError("至少需要一个修改动作", 400);
  if (operations.length > 5_000) throw new ApiError("一次修改动作过多", 400);
  if (selected === "markdown") return editMarkdownFile(inputPath, outputPath, operations);
  if (selected === "docx") return editDocxFile(inputPath, outputPath, operations);
  if (selected === "xlsx") return editXlsxFile(inputPath, outputPath, operations);
  if (selected === "pptx") return editPptxFile(inputPath, outputPath, operations);
  return editPdfFile(inputPath, outputPath, operations, { annotations: metadata?.office_annotations });
}

export async function createOfficeArtifactFile(outputPath, specification = {}) {
  const format = requireFormat(outputPath, specification.format);
  if (format === "markdown") return createMarkdownFile(outputPath, specification);
  if (format === "docx") return createDocxFile(outputPath, specification);
  if (format === "xlsx") return createXlsxFile(outputPath, specification);
  if (format === "pptx") return createPptxFile(outputPath, specification);
  return createPdfFile(outputPath, specification);
}

function flattened(model) {
  const entries = new Map();
  const add = (anchor, value) => {
    if (anchor) entries.set(String(anchor), value);
  };
  for (const section of model?.sections || []) {
    if (model.format === "markdown") add(section.anchor, { kind: section.kind, text: section.text });
    else if (model.format === "docx") {
      if (section.kind === "paragraph") add(section.anchor, { kind: section.kind, text: section.text, style: section.style });
      if (section.kind === "table") {
        for (const row of section.rows || []) for (const cell of row.cells || []) add(cell.anchor, { kind: cell.kind, text: cell.text });
      }
    } else if (model.format === "xlsx") {
      for (const cell of section.cells || []) add(cell.anchor, { value: cell.value, formula: cell.formula, display: cell.display });
    } else if (model.format === "pptx") {
      for (const object of section.objects || []) add(object.anchor, { kind: object.kind, text: object.text, position: object.position || null });
      if (section.notes) add(section.notes.anchor, { kind: "notes", text: section.notes.text });
    } else if (model.format === "pdf") {
      add(section.anchor, { kind: "page", text: section.text, annotations: section.annotations || [] });
    }
  }
  return entries;
}

export async function compareOfficeArtifacts(fromPath, toPath, { fromMetadata = {}, toMetadata = {} } = {}) {
  const fromFormat = requireFormat(fromPath);
  const toFormat = requireFormat(toPath);
  if (fromFormat !== toFormat) throw new ApiError("只能比较相同格式的办公产物", 400);
  const [fromModel, toModel] = await Promise.all([
    inspectOfficeArtifact(fromPath, { metadata: fromMetadata, format: fromFormat }),
    inspectOfficeArtifact(toPath, { metadata: toMetadata, format: toFormat }),
  ]);
  const before = flattened(fromModel);
  const after = flattened(toModel);
  const anchors = [...new Set([...before.keys(), ...after.keys()])];
  const changes = [];
  for (const anchor of anchors) {
    const left = before.get(anchor) ?? null;
    const right = after.get(anchor) ?? null;
    if (JSON.stringify(left) === JSON.stringify(right)) continue;
    changes.push({ anchor, type: left === null ? "added" : right === null ? "removed" : "changed", before: left, after: right });
    if (changes.length >= 500) break;
  }
  return {
    format: fromFormat,
    changes,
    truncated: changes.length >= 500 && anchors.length > changes.length,
    summary: changes.length ? `检测到 ${changes.length} 个内容单元变化` : "没有检测到内容单元变化",
  };
}

export default {
  OFFICE_ARTIFACT_FORMATS,
  officeFormatForPath,
  extensionForOfficeFormat,
  inspectOfficeArtifact,
  editOfficeArtifact,
  createOfficeArtifactFile,
  compareOfficeArtifacts,
};

import { randomUUID } from "node:crypto";
import { basename } from "node:path";

const MAX_ATTACHMENTS = 12;
const MAX_ARTIFACT_SELECTIONS = 64;

function cleanText(value) {
  return String(value || "").trim();
}
function cleanArtifactSelection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const format = cleanText(value.format).slice(0, 32);
  const anchor = cleanText(value.anchor).slice(0, 1024);
  const label = cleanText(value.label).slice(0, 512);
  if (!(format && anchor && label)) return null;
  const page = Number(value.page);
  const rect = value.rect && typeof value.rect === "object" && !Array.isArray(value.rect)
    ? {
        x: Number(value.rect.x) || 0,
        y: Number(value.rect.y) || 0,
        width: Number(value.rect.width) || 0,
        height: Number(value.rect.height) || 0,
      }
    : null;
  return {
    format,
    anchor,
    label,
    ...(Number.isFinite(page) && page > 0 ? { page } : {}),
    ...(cleanText(value.sheet) ? { sheet: cleanText(value.sheet).slice(0, 256) } : {}),
    ...(cleanText(value.address) ? { address: cleanText(value.address).slice(0, 64) } : {}),
    ...(cleanText(value.object_id || value.objectId) ? { object_id: cleanText(value.object_id || value.objectId).slice(0, 256) } : {}),
    ...(cleanText(value.kind) ? { kind: cleanText(value.kind).slice(0, 64) } : {}),
    ...(rect ? { rect } : {}),
  };
}

function cleanArtifactSelections(item) {
  const raw = Array.isArray(item?.artifact_selections)
    ? item.artifact_selections
    : Array.isArray(item?.artifactSelections)
      ? item.artifactSelections
      : [item?.artifact_selection || item?.artifactSelection];
  const selections = [];
  const seen = new Set();
  for (const value of raw) {
    const selection = cleanArtifactSelection(value);
    if (!selection || seen.has(selection.anchor)) continue;
    seen.add(selection.anchor);
    selections.push(selection);
    if (selections.length >= MAX_ARTIFACT_SELECTIONS) break;
  }
  return selections;
}

export function normalizeMessageAttachments(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const path = cleanText(item.path || item.file_path || item.filePath);
    if (!path) continue;
    const name = cleanText(item.name || item.file_name || item.filename) || basename(path);
    const artifactSelections = cleanArtifactSelections(item);
    out.push({
      path,
      name,
      is_dir: Boolean(item.is_dir || item.isDir || item.type === "dir"),
      mime_type: cleanText(item.mime_type || item.mimeType) || null,
      size_bytes: Number(item.size_bytes || item.size || 0) || null,
      width: Number(item.width || 0) || null,
      height: Number(item.height || 0) || null,
      sha256: cleanText(item.sha256) || null,
      kind: cleanText(item.kind) || null,
      artifact_id: cleanText(item.artifact_id || item.artifactId).slice(0, 256) || null,
      artifact_version_id: cleanText(item.artifact_version_id || item.artifactVersionId).slice(0, 256) || null,
      artifact_version_number: Number(item.artifact_version_number || item.artifactVersionNumber || 0) || null,
      artifact_selections: artifactSelections,
      artifact_selection: artifactSelections[0] || null,
    });
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}

export function buildUserContentItems(content, attachments = []) {
  const items = [];
  for (const attachment of normalizeMessageAttachments(attachments)) {
    items.push({
      id: randomUUID(),
      type: "attachment",
      content: attachment.name,
      metadata: {
        path: attachment.path,
        name: attachment.name,
        is_dir: attachment.is_dir,
        ...(attachment.mime_type ? { mime_type: attachment.mime_type } : {}),
        ...(attachment.size_bytes ? { size_bytes: attachment.size_bytes } : {}),
        ...(attachment.width ? { width: attachment.width } : {}),
        ...(attachment.height ? { height: attachment.height } : {}),
        ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
        ...(attachment.kind ? { kind: attachment.kind } : {}),
        ...(attachment.artifact_id ? { artifact_id: attachment.artifact_id } : {}),
        ...(attachment.artifact_version_id ? { artifact_version_id: attachment.artifact_version_id } : {}),
        ...(attachment.artifact_version_number ? { artifact_version_number: attachment.artifact_version_number } : {}),
        ...(attachment.artifact_selections.length ? { artifact_selections: attachment.artifact_selections } : {}),
        ...(attachment.artifact_selection ? { artifact_selection: attachment.artifact_selection } : {}),
      },
      is_complete: true,
      display_type: "file",
    });
  }
  const text = String(content || "").trim();
  if (text) {
    items.push({
      id: randomUUID(),
      type: "text",
      content: text,
      metadata: {},
      is_complete: true,
      display_type: "text",
    });
  }
  return items.length ? items : [{
    id: randomUUID(),
    type: "text",
    content: "请处理附件。",
    metadata: {},
    is_complete: true,
    display_type: "text",
  }];
}

export function buildAttachmentContextMessage(userMessage, attachments = []) {
  const normalized = normalizeMessageAttachments(attachments);
  const text = String(userMessage || "").trim() || "请处理附件。";
  if (!normalized.length) return text;
  const lines = normalized.map((attachment, index) => {
    const kind = attachment.is_dir ? "目录" : "文件";
    const artifact = attachment.artifact_id
      ? `\n   项目产物: artifact_id=${attachment.artifact_id}${attachment.artifact_version_id ? `, reference_version_id=${attachment.artifact_version_id}` : ""}`
      : "";
    const selection = attachment.artifact_selections.map((item, selectionIndex, allSelections) => (
      `\n   ${allSelections.length === 1 ? "已引用选区" : `已引用选区 ${selectionIndex + 1}`}: ${item.label}, format=${item.format}, anchor=${item.anchor}`
        + `${item.kind ? `, kind=${item.kind}` : ""}`
        + `${item.object_id ? `, object_id=${item.object_id}` : ""}`
        + `${item.page ? `, page=${item.page}` : ""}`
        + `${item.sheet ? `, sheet=${item.sheet}` : ""}`
        + `${item.address ? `, address=${item.address}` : ""}`
        + `${item.rect ? `, rect=${JSON.stringify(item.rect)}` : ""}`
    )).join("");
    return `${index + 1}. ${kind}: ${attachment.name}\n   路径: ${attachment.path}${artifact}${selection}`;
  });
  const hasArtifactSelection = normalized.some((attachment) => attachment.artifact_selections.length > 0);
  const artifactRule = hasArtifactSelection
    ? "\n引用的是项目产物中的一个或多个精确选区。先调用 DSH 工具 artifact_office_inspect 读取当前版本和每个稳定锚点，再用 artifact_office_edit 只修改这些选区；写入时使用实际读取到的当前 version_id 作为 base_version_id，并保存为新版本，不覆盖历史。"
    : "";
  return `${text}\n\n## 用户随消息附加的本地文件\n${lines.join("\n")}\n\n请把这些附件视为用户当前问题的一部分。需要了解附件内容时,直接使用 read/ls/grep/find 等本地文件工具读取,不要回答无法访问本地文件。${artifactRule}`;
}

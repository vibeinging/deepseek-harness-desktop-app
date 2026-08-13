import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { dataPath } from "../../config/paths.js";
import { ApiError } from "../../errors.js";

const MAX_CANVAS_BYTES = 8 * 1024 * 1024;
const MAX_TITLE_LENGTH = 160;
const MAX_SUMMARY_LENGTH = 2_000;
const canvasMutationLocks = new Map();

function clean(value) {
  return String(value ?? "").trim();
}

function optionalText(value, maxLength = MAX_SUMMARY_LENGTH) {
  if (value == null) return null;
  const text = clean(value);
  return text ? text.slice(0, maxLength) : null;
}

function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function storageSegment(value, label) {
  const text = clean(value);
  if (!text) throw new ApiError(`${label}无效`, 400);
  return sha256(text).slice(0, 32);
}

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function withCanvasMutation(keyInput, work) {
  const key = clean(keyInput);
  const previous = canvasMutationLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const tail = previous.catch(() => undefined).then(() => gate);
  canvasMutationLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (canvasMutationLocks.get(key) === tail) canvasMutationLocks.delete(key);
  }
}

async function ensureDirectory(path, root) {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw new ApiError("无法创建 Canvas 存储目录", 503);
  }
  let entry;
  try {
    entry = lstatSync(path);
  } catch {
    throw new ApiError("Canvas 存储目录不可用", 503);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new ApiError("Canvas 存储目录无效", 409);
  const canonical = realpathSync(path);
  if (root && !inside(root, canonical)) throw new ApiError("Canvas 存储目录越界", 409);
  await chmod(canonical, 0o700).catch(() => {});
  return canonical;
}

async function ensureCanvasDirectory({ userId, sessionId, canvasId, storageRoot } = {}) {
  const requestedRoot = resolve(storageRoot || dataPath("canvases"));
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  let rootEntry;
  try {
    rootEntry = lstatSync(requestedRoot);
  } catch {
    throw new ApiError("Canvas 存储目录不可用", 503);
  }
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new ApiError("Canvas 存储目录无效", 409);
  const root = realpathSync(requestedRoot);
  await chmod(root, 0o700).catch(() => {});
  let current = root;
  for (const [value, label] of [[userId, "用户"], [sessionId, "会话"], [canvasId, "Canvas"]]) {
    current = await ensureDirectory(join(current, storageSegment(value, label)), root);
  }
  return { root, directory: current };
}

function sessionCanvasDirectory({ userId, sessionId, storageRoot } = {}) {
  const root = resolve(storageRoot || dataPath("canvases"));
  return join(root, storageSegment(userId, "用户"), storageSegment(sessionId, "会话"));
}

function canvasKind(value) {
  const kind = clean(value).toLowerCase() || "document";
  if (!new Set(["document", "code", "site"]).has(kind)) throw new ApiError("Canvas 类型必须是 document、code 或 site", 400);
  return kind;
}

function canvasTitle(value, content, kind) {
  const explicit = clean(value).replace(/\s+/g, " ");
  if (explicit) return explicit.slice(0, MAX_TITLE_LENGTH);
  if (kind === "site") {
    const declared = String(content || "").match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      || String(content || "").match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
      || "";
    const siteTitle = clean(declared.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
    return (siteTitle || "未命名 Site").slice(0, MAX_TITLE_LENGTH);
  }
  const heading = String(content || "").match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1];
  const firstLine = clean(heading || String(content || "").split(/\r?\n/).find((line) => clean(line)) || "");
  const fallback = kind === "code" ? "代码" : kind === "site" ? "未命名 Site" : "未命名文档";
  return (firstLine || fallback).replace(/^[`*_>#\-\s]+|[`*_#\s]+$/g, "").slice(0, MAX_TITLE_LENGTH);
}

function canvasContent(value) {
  if (typeof value !== "string") throw new ApiError("Canvas 内容必须是文本", 400);
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > MAX_CANVAS_BYTES) throw new ApiError("Canvas 内容不能超过 8 MB", 413);
  return { text: value.replace(/\r\n?/g, "\n"), bytes };
}

function trustedSource(value = {}) {
  return {
    messageId: optionalText(value.messageId ?? value.message_id, 180),
    itemId: optionalText(value.itemId ?? value.item_id, 180),
    turnId: optionalText(value.turnId ?? value.turn_id, 180),
    runId: optionalText(value.runId ?? value.run_id, 180),
    toolCallId: optionalText(value.toolCallId ?? value.tool_call_id, 180),
    type: ["assistant", "user", "tool", "restore"].includes(clean(value.type)) ? clean(value.type) : "user",
  };
}

async function assertSessionAccess(db, userId, sessionId) {
  if (!(db?.query && db?.queryOne)) throw new ApiError("Canvas 存储不可用", 503);
  const uid = clean(userId);
  const sid = clean(sessionId);
  if (!(uid && sid)) throw new ApiError("会话不存在或无权限", 404);
  const session = await db.queryOne(
    `SELECT id,project_id,created_by,action_type,title
       FROM sessions
      WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL
      LIMIT 1`,
    [sid, uid],
  );
  if (!session) throw new ApiError("会话不存在或无权限", 404);
  return session;
}

const CANVAS_SELECT = `
  SELECT c.*,s.title AS session_title,
         v.version_number AS current_version_number,
         v.size_bytes AS current_size_bytes,v.sha256 AS current_sha256,
         v.change_summary AS current_change_summary,v.parent_version_id AS current_parent_version_id,
         v.restored_from_version_id AS current_restored_from_version_id,
         v.source_type AS current_source_type,v.source_turn_id AS current_source_turn_id,
         v.source_run_id AS current_source_run_id,v.source_item_id AS current_source_item_id,
         v.source_tool_call_id AS current_source_tool_call_id,v.created_at AS current_created_at,
         (SELECT COUNT(*) FROM agent_canvas_versions cv WHERE cv.canvas_id=c.id) AS version_count,
         (SELECT COUNT(*) FROM agent_canvas_suggestions cs WHERE cs.canvas_id=c.id AND cs.status='pending') AS pending_suggestion_count
    FROM agent_canvases c
    JOIN sessions s ON s.id=c.session_id AND s.deleted_at IS NULL
    LEFT JOIN agent_canvas_versions v ON v.id=c.current_version_id`;

function publicVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    canvas_id: row.canvas_id,
    version_number: Number(row.version_number || 0),
    size_bytes: Number(row.size_bytes || 0),
    sha256: row.sha256,
    change_summary: row.change_summary || "",
    parent_version_id: row.parent_version_id || null,
    restored_from_version_id: row.restored_from_version_id || null,
    source_type: row.source_type || null,
    source_turn_id: row.source_turn_id || null,
    source_run_id: row.source_run_id || null,
    source_item_id: row.source_item_id || null,
    source_tool_call_id: row.source_tool_call_id || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function currentVersionFromCanvas(row) {
  if (!row?.current_version_id) return null;
  return publicVersion({
    id: row.current_version_id,
    canvas_id: row.id,
    version_number: row.current_version_number,
    size_bytes: row.current_size_bytes,
    sha256: row.current_sha256,
    change_summary: row.current_change_summary,
    parent_version_id: row.current_parent_version_id,
    restored_from_version_id: row.current_restored_from_version_id,
    source_type: row.current_source_type,
    source_turn_id: row.current_source_turn_id,
    source_run_id: row.current_source_run_id,
    source_item_id: row.current_source_item_id,
    source_tool_call_id: row.current_source_tool_call_id,
    created_at: row.current_created_at,
  });
}

function publicCanvas(row) {
  return {
    id: row.id,
    session_id: row.session_id,
    session_title: row.session_title || null,
    project_id: row.project_id,
    title: row.title,
    kind: row.kind,
    language: row.language || null,
    current_version_id: row.current_version_id || null,
    current_version: currentVersionFromCanvas(row),
    version_count: Number(row.version_count || 0),
    pending_suggestion_count: Number(row.pending_suggestion_count || 0),
    source_message_id: row.source_message_id || null,
    source_item_id: row.source_item_id || null,
    source_turn_id: row.source_turn_id || null,
    source_run_id: row.source_run_id || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function publicSuggestion(row) {
  return {
    id: row.id,
    canvas_id: row.canvas_id,
    base_version_id: row.base_version_id,
    start_offset: Number(row.start_offset || 0),
    end_offset: Number(row.end_offset || 0),
    selected_text: row.selected_text,
    selected_text_hash: row.selected_text_hash,
    replacement_text: row.replacement_text,
    instruction: row.instruction || "",
    status: row.status,
    accepted_version_id: row.accepted_version_id || null,
    source_turn_id: row.source_turn_id || null,
    source_run_id: row.source_run_id || null,
    source_item_id: row.source_item_id || null,
    source_tool_call_id: row.source_tool_call_id || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function ownedCanvasRow(db, userId, sessionId, canvasId) {
  await assertSessionAccess(db, userId, sessionId);
  const row = await db.queryOne(
    `${CANVAS_SELECT}
      WHERE c.id=$1 AND c.session_id=$2 AND c.user_id=$3 AND c.deleted_at IS NULL
      LIMIT 1`,
    [clean(canvasId), clean(sessionId), clean(userId)],
  );
  if (!row) throw new ApiError("Canvas 不存在或无权限", 404);
  return row;
}

async function versionRows(db, canvasId) {
  return db.query(
    `SELECT * FROM agent_canvas_versions WHERE canvas_id=$1 ORDER BY version_number DESC`,
    [canvasId],
  );
}

async function suggestionRows(db, canvasId) {
  return db.query(
    `SELECT * FROM agent_canvas_suggestions WHERE canvas_id=$1 ORDER BY created_at DESC`,
    [canvasId],
  );
}

async function verifySnapshot(row) {
  let stat;
  try {
    const entry = lstatSync(row.snapshot_path);
    if (entry.isSymbolicLink()) throw new Error("symlink");
    stat = statSync(row.snapshot_path);
  } catch {
    throw new ApiError("Canvas 历史版本已损坏或不存在", 409);
  }
  if (!stat.isFile() || stat.size !== Number(row.size_bytes || 0)) throw new ApiError("Canvas 历史版本指纹校验失败", 409);
  const buffer = await readFile(row.snapshot_path);
  if (sha256(buffer) !== row.sha256) throw new ApiError("Canvas 历史版本指纹校验失败", 409);
  return buffer.toString("utf8");
}

async function currentVersionRow(db, canvas) {
  if (!canvas.current_version_id) throw new ApiError("Canvas 当前版本不存在", 409);
  const version = await db.queryOne(
    `SELECT * FROM agent_canvas_versions WHERE id=$1 AND canvas_id=$2 LIMIT 1`,
    [canvas.current_version_id, canvas.id],
  );
  if (!version) throw new ApiError("Canvas 当前版本不存在", 409);
  return version;
}

async function writeSnapshot({ userId, sessionId, canvasId, versionId, versionNumber, content, storageRoot } = {}) {
  const { directory } = await ensureCanvasDirectory({ userId, sessionId, canvasId, storageRoot });
  const snapshotPath = join(directory, `v${String(versionNumber).padStart(6, "0")}-${versionId}.txt`);
  const buffer = Buffer.from(content, "utf8");
  try {
    await writeFile(snapshotPath, buffer, { flag: "wx", mode: 0o600 });
    const stat = statSync(snapshotPath);
    if (!stat.isFile() || stat.size !== buffer.length) throw new Error("snapshot_size_mismatch");
    await chmod(snapshotPath, 0o400).catch(() => {});
    return { snapshotPath, sizeBytes: buffer.length, sha256: sha256(buffer) };
  } catch (error) {
    await rm(snapshotPath, { force: true }).catch(() => {});
    if (error instanceof ApiError) throw error;
    throw new ApiError("保存 Canvas 版本失败", 503);
  }
}

async function nextVersionNumber(db, canvasId) {
  const row = await db.queryOne(
    `SELECT COALESCE(MAX(version_number),0)+1 AS next_version FROM agent_canvas_versions WHERE canvas_id=$1`,
    [canvasId],
  );
  return Math.max(1, Number(row?.next_version || 1));
}

async function insertCanvasVersion(db, {
  canvas,
  userId,
  content,
  changeSummary,
  source: sourceInput,
  metadata = {},
  restoredFromVersionId = null,
  forceVersion = false,
  storageRoot,
} = {}) {
  const normalized = canvasContent(content);
  const current = canvas.current_version_id ? await currentVersionRow(db, canvas) : null;
  const contentHash = sha256(Buffer.from(normalized.text, "utf8"));
  if (!forceVersion && current && current.sha256 === contentHash && Number(current.size_bytes || 0) === Buffer.byteLength(normalized.text, "utf8")) {
    return { version: publicVersion(current), deduplicated: true };
  }
  const versionNumber = await nextVersionNumber(db, canvas.id);
  const versionId = randomUUID();
  const source = trustedSource(sourceInput);
  const snapshot = await writeSnapshot({
    userId,
    sessionId: canvas.session_id,
    canvasId: canvas.id,
    versionId,
    versionNumber,
    content: normalized.text,
    storageRoot,
  });
  try {
    await db.query(
      `INSERT INTO agent_canvas_versions
        (id,canvas_id,version_number,snapshot_path,size_bytes,sha256,change_summary,parent_version_id,
         restored_from_version_id,source_type,source_turn_id,source_run_id,source_item_id,source_tool_call_id,
         metadata_json,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())`,
      [
        versionId, canvas.id, versionNumber, snapshot.snapshotPath, snapshot.sizeBytes, snapshot.sha256,
        optionalText(changeSummary) || (versionNumber === 1 ? "创建 Canvas" : "更新 Canvas"),
        current?.id || null, restoredFromVersionId, source.type, source.turnId, source.runId, source.itemId,
        source.toolCallId, JSON.stringify(metadata || {}), clean(userId) || null,
      ],
    );
    const updated = await db.query(
      `UPDATE agent_canvases
          SET current_version_id=$2,updated_at=now()
        WHERE id=$1
          AND (($3 IS NULL AND current_version_id IS NULL) OR current_version_id=$3)
        RETURNING id`,
      [canvas.id, versionId, current?.id || null],
    );
    if (!Array.isArray(updated) || updated.length !== 1) throw new ApiError("Canvas 已经产生新版本，请重新打开后再保存", 409);
    await db.query(
      `UPDATE agent_canvas_suggestions SET status='stale',updated_at=now()
        WHERE canvas_id=$1 AND status='pending'`,
      [canvas.id],
    ).catch(() => {});
  } catch (error) {
    await db.query("DELETE FROM agent_canvas_versions WHERE id=$1", [versionId]).catch(() => {});
    await rm(snapshot.snapshotPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    version: publicVersion(await db.queryOne("SELECT * FROM agent_canvas_versions WHERE id=$1", [versionId])),
    deduplicated: false,
  };
}

export async function listSessionCanvases(db, { userId, sessionId, limit = 100 } = {}) {
  await assertSessionAccess(db, userId, sessionId);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  const rows = await db.query(
    `${CANVAS_SELECT}
      WHERE c.session_id=$1 AND c.user_id=$2 AND c.deleted_at IS NULL
      ORDER BY c.updated_at DESC
      LIMIT ${safeLimit}`,
    [clean(sessionId), clean(userId)],
  );
  return rows.map(publicCanvas);
}

export async function getCanvas(db, { userId, sessionId, canvasId } = {}) {
  const row = await ownedCanvasRow(db, userId, sessionId, canvasId);
  const current = await currentVersionRow(db, row);
  const [content, versions, suggestions] = await Promise.all([
    verifySnapshot(current),
    versionRows(db, row.id),
    suggestionRows(db, row.id),
  ]);
  return {
    ...publicCanvas(row),
    content,
    versions: versions.map(publicVersion),
    suggestions: suggestions.map(publicSuggestion),
  };
}

export async function getCanvasVersion(db, { userId, sessionId, canvasId, versionId } = {}) {
  await ownedCanvasRow(db, userId, sessionId, canvasId);
  const version = await db.queryOne(
    `SELECT * FROM agent_canvas_versions WHERE id=$1 AND canvas_id=$2 LIMIT 1`,
    [clean(versionId), clean(canvasId)],
  );
  if (!version) throw new ApiError("Canvas 版本不存在", 404);
  return { version: publicVersion(version), content: await verifySnapshot(version) };
}

export async function createCanvas(db, {
  userId,
  sessionId,
  title = "",
  kind = "document",
  language = "",
  content = "",
  changeSummary = "",
  source: sourceInput = {},
  metadata = {},
  storageRoot,
} = {}) {
  const session = await assertSessionAccess(db, userId, sessionId);
  const source = trustedSource(sourceInput);
  return withCanvasMutation(`session:${session.id}`, async () => {
    if (source.itemId) {
      const existing = await db.queryOne(
        `SELECT id FROM agent_canvases
          WHERE session_id=$1 AND source_item_id=$2 AND deleted_at IS NULL LIMIT 1`,
        [session.id, source.itemId],
      );
      if (existing) return { canvas: await getCanvas(db, { userId, sessionId: session.id, canvasId: existing.id }), created: false, deduplicated: true };
    }
    const resolvedKind = canvasKind(kind);
    const normalized = canvasContent(content);
    const id = randomUUID();
    const name = canvasTitle(title, normalized.text, resolvedKind);
    try {
      await db.query(
        `INSERT INTO agent_canvases
          (id,session_id,project_id,user_id,title,kind,language,current_version_id,
           source_message_id,source_item_id,source_turn_id,source_run_id,metadata_json,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,now(),now())`,
        [
          id, session.id, session.project_id, clean(userId), name, resolvedKind,
          resolvedKind === "site" ? "html" : optionalText(language, 80), source.messageId, source.itemId, source.turnId, source.runId,
          JSON.stringify(metadata || {}),
        ],
      );
      const row = await db.queryOne("SELECT * FROM agent_canvases WHERE id=$1", [id]);
      await insertCanvasVersion(db, {
        canvas: row,
        userId,
        content: normalized.text,
        changeSummary: changeSummary || "创建 Canvas",
        source,
        metadata,
        storageRoot,
      });
    } catch (error) {
      await db.query("DELETE FROM agent_canvas_versions WHERE canvas_id=$1", [id]).catch(() => {});
      await db.query("DELETE FROM agent_canvases WHERE id=$1 AND current_version_id IS NULL", [id]).catch(() => {});
      const path = sessionCanvasDirectory({ userId, sessionId: session.id, storageRoot });
      const canvasDir = join(path, storageSegment(id, "Canvas"));
      await rm(canvasDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    return { canvas: await getCanvas(db, { userId, sessionId: session.id, canvasId: id }), created: true, deduplicated: false };
  });
}

function normalizeOffset(value, label, length) {
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < 0 || offset > length) throw new ApiError(`${label}无效`, 400);
  return offset;
}

export function applyCanvasOperations(content, operations) {
  if (!Array.isArray(operations) || !operations.length) throw new ApiError("至少需要一项 Canvas 修改", 400);
  const normalized = operations.map((operation, index) => {
    const type = clean(operation?.type || "replace_range");
    if (type === "replace_all") {
      if (operations.length !== 1) throw new ApiError("全文替换不能和其他修改一起提交", 400);
      return { type, start: 0, end: content.length, text: String(operation?.text ?? ""), index };
    }
    if (type !== "replace_range") throw new ApiError(`不支持的 Canvas 修改类型：${type}`, 400);
    const start = normalizeOffset(operation?.start, "修改起点", content.length);
    const end = normalizeOffset(operation?.end, "修改终点", content.length);
    if (end < start) throw new ApiError("修改终点不能早于起点", 400);
    return { type, start, end, text: String(operation?.text ?? ""), index };
  }).sort((a, b) => b.start - a.start || b.end - a.end);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].start < normalized[index].end) throw new ApiError("Canvas 修改范围不能重叠", 400);
  }
  let next = content;
  for (const operation of normalized) next = `${next.slice(0, operation.start)}${operation.text}${next.slice(operation.end)}`;
  return canvasContent(next).text;
}

export async function editCanvas(db, {
  userId,
  sessionId,
  canvasId,
  baseVersionId,
  content,
  operations,
  changeSummary = "",
  source = {},
  metadata = {},
  storageRoot,
} = {}) {
  return withCanvasMutation(`canvas:${clean(canvasId)}`, async () => {
    const canvas = await ownedCanvasRow(db, userId, sessionId, canvasId);
    if (!clean(baseVersionId) || canvas.current_version_id !== clean(baseVersionId)) {
      throw new ApiError("Canvas 已经产生新版本，请重新打开后再保存", 409);
    }
    const current = await currentVersionRow(db, canvas);
    const before = await verifySnapshot(current);
    const next = typeof content === "string" ? canvasContent(content).text : applyCanvasOperations(before, operations);
    const result = await insertCanvasVersion(db, {
      canvas,
      userId,
      content: next,
      changeSummary,
      source,
      metadata,
      storageRoot,
    });
    return {
      canvas: await getCanvas(db, { userId, sessionId, canvasId }),
      version: result.version,
      deduplicated: result.deduplicated,
    };
  });
}

export async function restoreCanvasVersion(db, {
  userId,
  sessionId,
  canvasId,
  baseVersionId,
  versionId,
  changeSummary = "",
  source = {},
  storageRoot,
} = {}) {
  return withCanvasMutation(`canvas:${clean(canvasId)}`, async () => {
    const canvas = await ownedCanvasRow(db, userId, sessionId, canvasId);
    if (!clean(baseVersionId) || canvas.current_version_id !== clean(baseVersionId)) {
      throw new ApiError("Canvas 已经产生新版本，请重新打开后再恢复", 409);
    }
    const target = await db.queryOne(
      `SELECT * FROM agent_canvas_versions WHERE id=$1 AND canvas_id=$2 LIMIT 1`,
      [clean(versionId), canvas.id],
    );
    if (!target) throw new ApiError("要恢复的 Canvas 版本不存在", 404);
    if (target.id === canvas.current_version_id) throw new ApiError("该版本已经是当前版本", 409);
    const content = await verifySnapshot(target);
    const result = await insertCanvasVersion(db, {
      canvas,
      userId,
      content,
      changeSummary: changeSummary || `恢复版本 v${target.version_number}`,
      source: { ...source, type: "restore" },
      metadata: { restored_from_version_id: target.id },
      restoredFromVersionId: target.id,
      forceVersion: true,
      storageRoot,
    });
    return {
      canvas: await getCanvas(db, { userId, sessionId, canvasId }),
      version: result.version,
      restored: !result.deduplicated,
      deduplicated: result.deduplicated,
    };
  });
}

export async function createCanvasSuggestion(db, {
  userId,
  sessionId,
  canvasId,
  baseVersionId,
  start,
  end,
  selectedText,
  replacementText,
  instruction = "",
  source: sourceInput = {},
} = {}) {
  return withCanvasMutation(`canvas:${clean(canvasId)}`, async () => {
    const canvas = await ownedCanvasRow(db, userId, sessionId, canvasId);
    if (!clean(baseVersionId) || canvas.current_version_id !== clean(baseVersionId)) {
      throw new ApiError("Canvas 已经产生新版本，请重新选择内容", 409);
    }
    const current = await currentVersionRow(db, canvas);
    const content = await verifySnapshot(current);
    const startOffset = normalizeOffset(start, "建议起点", content.length);
    const endOffset = normalizeOffset(end, "建议终点", content.length);
    if (endOffset <= startOffset) throw new ApiError("请先选择要建议的内容", 400);
    const actual = content.slice(startOffset, endOffset);
    if (typeof selectedText === "string" && selectedText !== actual) throw new ApiError("所选文字已经变化，请重新选择", 409);
    const replacement = canvasContent(String(replacementText ?? "")).text;
    const source = trustedSource(sourceInput);
    const id = randomUUID();
    await db.query(
      `INSERT INTO agent_canvas_suggestions
        (id,canvas_id,base_version_id,start_offset,end_offset,selected_text,selected_text_hash,
         replacement_text,instruction,status,source_turn_id,source_run_id,source_item_id,source_tool_call_id,
         created_by,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12,$13,$14,now(),now())`,
      [
        id, canvas.id, current.id, startOffset, endOffset, actual, sha256(actual), replacement,
        optionalText(instruction), source.turnId, source.runId, source.itemId, source.toolCallId, clean(userId),
      ],
    );
    return publicSuggestion(await db.queryOne("SELECT * FROM agent_canvas_suggestions WHERE id=$1", [id]));
  });
}

export async function decideCanvasSuggestion(db, {
  userId,
  sessionId,
  canvasId,
  suggestionId,
  decision,
  source = {},
  storageRoot,
} = {}) {
  return withCanvasMutation(`canvas:${clean(canvasId)}`, async () => {
    const canvas = await ownedCanvasRow(db, userId, sessionId, canvasId);
    const suggestion = await db.queryOne(
      `SELECT * FROM agent_canvas_suggestions WHERE id=$1 AND canvas_id=$2 LIMIT 1`,
      [clean(suggestionId), canvas.id],
    );
    if (!suggestion) throw new ApiError("Canvas 建议不存在", 404);
    if (suggestion.status !== "pending") throw new ApiError("Canvas 建议已经处理", 409);
    const normalizedDecision = clean(decision).toLowerCase();
    if (normalizedDecision === "reject") {
      await db.query(
        `UPDATE agent_canvas_suggestions SET status='rejected',updated_at=now() WHERE id=$1 AND status='pending'`,
        [suggestion.id],
      );
      return { suggestion: publicSuggestion({ ...suggestion, status: "rejected" }), canvas: await getCanvas(db, { userId, sessionId, canvasId }) };
    }
    if (normalizedDecision !== "accept") throw new ApiError("建议处理方式必须是 accept 或 reject", 400);
    if (canvas.current_version_id !== suggestion.base_version_id) {
      await db.query(`UPDATE agent_canvas_suggestions SET status='stale',updated_at=now() WHERE id=$1`, [suggestion.id]);
      throw new ApiError("Canvas 已经变化，这条建议已失效", 409);
    }
    const current = await currentVersionRow(db, canvas);
    const content = await verifySnapshot(current);
    const actual = content.slice(Number(suggestion.start_offset), Number(suggestion.end_offset));
    if (actual !== suggestion.selected_text || sha256(actual) !== suggestion.selected_text_hash) {
      await db.query(`UPDATE agent_canvas_suggestions SET status='stale',updated_at=now() WHERE id=$1`, [suggestion.id]);
      throw new ApiError("所选文字已经变化，这条建议已失效", 409);
    }
    const next = `${content.slice(0, Number(suggestion.start_offset))}${suggestion.replacement_text}${content.slice(Number(suggestion.end_offset))}`;
    const result = await insertCanvasVersion(db, {
      canvas,
      userId,
      content: next,
      changeSummary: suggestion.instruction || "接受行内建议",
      source,
      metadata: { accepted_suggestion_id: suggestion.id },
      storageRoot,
    });
    await db.query(
      `UPDATE agent_canvas_suggestions
          SET status='accepted',accepted_version_id=$2,updated_at=now()
        WHERE id=$1`,
      [suggestion.id, result.version.id],
    );
    return {
      suggestion: publicSuggestion({ ...suggestion, status: "accepted", accepted_version_id: result.version.id }),
      canvas: await getCanvas(db, { userId, sessionId, canvasId }),
      version: result.version,
      deduplicated: result.deduplicated,
    };
  });
}

function fencedCodeCandidate(content) {
  let best = null;
  const pattern = /```([\w.+#-]*)\s*\n([\s\S]*?)```/g;
  for (const match of content.matchAll(pattern)) {
    const code = String(match[2] || "").replace(/\s+$/, "");
    const lines = code.split("\n").length;
    if (lines < 16) continue;
    if (!best || code.length > best.content.length) best = { content: code, language: clean(match[1]), lines };
  }
  return best;
}

export function detectAutoCanvasCandidate(items = []) {
  const candidates = (Array.isArray(items) ? items : [])
    .filter((item) => (
      ["markdown", "text"].includes(clean(item?.type))
      && item?.metadata?.display !== false
      && item?.metadata?.answer_status === "accepted"
      && clean(item?.content)
    ));
  if (!candidates.length) return null;
  const item = candidates[candidates.length - 1];
  const content = String(item.content || "").replace(/\r\n?/g, "\n").trim();
  const code = fencedCodeCandidate(content);
  if (code && code.content.length >= content.length * 0.45) {
    return {
      itemId: item.id,
      title: canvasTitle(item.title, code.content, "code"),
      kind: "code",
      language: code.language || null,
      content: code.content,
      reason: "long_code",
    };
  }
  const structuralLines = content.split("\n").filter((line) => /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/.test(line)).length;
  const longDocument = content.length >= 1_600 || (content.length >= 900 && structuralLines >= 4);
  if (!longDocument) return null;
  return {
    itemId: item.id,
    title: canvasTitle(item.title, content, "document"),
    kind: "document",
    language: null,
    content,
    reason: content.length >= 1_600 ? "long_document" : "structured_document",
  };
}

export async function autoCreateCanvasFromTurn(db, {
  userId,
  sessionId,
  assistantMessageId,
  turnId,
  runId,
  items,
  storageRoot,
} = {}) {
  const candidate = detectAutoCanvasCandidate(items);
  if (!candidate) return null;
  return createCanvas(db, {
    userId,
    sessionId,
    title: candidate.title,
    kind: candidate.kind,
    language: candidate.language,
    content: candidate.content,
    changeSummary: "从本轮长内容创建",
    source: {
      type: "assistant",
      messageId: assistantMessageId,
      itemId: candidate.itemId,
      turnId,
      runId,
    },
    metadata: { auto_created: true, auto_reason: candidate.reason },
    storageRoot,
  });
}

export async function purgeSessionCanvases(db, { userId, sessionId, storageRoot } = {}) {
  const uid = clean(userId);
  const sid = clean(sessionId);
  if (!(uid && sid)) return { removed: false, canvas_count: 0 };
  const rows = await db.query("SELECT id FROM agent_canvases WHERE session_id=$1 AND user_id=$2", [sid, uid]);
  for (const row of rows) {
    await db.query("DELETE FROM agent_canvas_suggestions WHERE canvas_id=$1", [row.id]);
    await db.query("DELETE FROM agent_canvas_versions WHERE canvas_id=$1", [row.id]);
  }
  await db.query("DELETE FROM agent_canvases WHERE session_id=$1 AND user_id=$2", [sid, uid]);
  const requestedRoot = resolve(storageRoot || dataPath("canvases"));
  const target = sessionCanvasDirectory({ userId: uid, sessionId: sid, storageRoot });
  if (inside(requestedRoot, target) && target !== requestedRoot) await rm(target, { recursive: true, force: true });
  return { removed: rows.length > 0, canvas_count: rows.length };
}

export default {
  listSessionCanvases,
  getCanvas,
  getCanvasVersion,
  createCanvas,
  editCanvas,
  restoreCanvasVersion,
  createCanvasSuggestion,
  decideCanvasSuggestion,
  detectAutoCanvasCandidate,
  autoCreateCanvasFromTurn,
  purgeSessionCanvases,
};

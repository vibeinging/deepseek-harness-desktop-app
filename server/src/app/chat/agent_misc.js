/**
 * L1 use-case layer for Agent workspace non-streaming endpoints.
 * Standard contract: async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
 * response shape res.json({success,data,message}) in source matches ok(), so normalize to return { data, message }.
 * Optional navigation reads may return an empty result when the current UI can continue without that data.
 *
 * The Agent chat controller and scoped response endpoints share pendingDecisions.
 *
 * Note: app/chat/ is one layer deeper than routes/, so engine imports use ../../engine.
 */
import { randomUUID } from "node:crypto";
import { basename, extname, posix } from "node:path";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { ApiError } from "../../errors.js";
import {
  hasHiddenOrGeneratedPath,
  listDirectoryItems,
  listProjectFileRoots,
  resolveAuthorizedRootPath,
} from "./project_files.js";
import {
  createAppSkill,
  deleteAppSkill,
  generateSkillDraft,
  getAppSkill,
  listAppSkills,
  listEnabledAppSkills,
  setAppSkillEnabled,
  updateAppSkill,
} from "../../engine/agents/skill_registry.js";
import { publishConversationStatusChanged } from "../../engine/agents/conversation_status_events.js";
import { getDshRuntimeClient } from "../../engine/dsh_runtime/client.js";
import { loadDshSessionBinding } from "../../engine/dsh_runtime/session_binding.js";
import { ensureDshWorkspaceSession } from "../../engine/dsh_runtime/session_attachment.js";
import { dshModelOptions, encodeDshModelRoute } from "../../engine/dsh_runtime/model_route.js";

// Shared interactive state: runtime item id -> scoped resolver.
function publishPendingDecision(value, reason) {
  const sessionId = String(value?.sessionId || "").trim();
  if (!sessionId) return;
  publishConversationStatusChanged({
    userId: value?.userId || null,
    projectId: value?.projectId || null,
    sessionId,
    runId: value?.runId || null,
    reason,
  });
}

class ObservablePendingDecisionMap extends Map {
  set(key, value) {
    const previous = this.get(key);
    if (previous && previous !== value) publishPendingDecision(previous, "interaction_resolved");
    super.set(key, value);
    const kind = value?.kind === "user_input" ? "user_input" : "approval";
    publishPendingDecision(value, `interaction_waiting_${kind}`);
    return this;
  }

  delete(key) {
    const previous = this.get(key);
    const deleted = super.delete(key);
    if (deleted) publishPendingDecision(previous, "interaction_resolved");
    return deleted;
  }

  clear() {
    const previous = [...this.values()];
    super.clear();
    for (const value of previous) publishPendingDecision(value, "interaction_resolved");
  }
}

export const pendingDecisions = new ObservablePendingDecisionMap();

export const LIVE_PENDING_INTERACTION_VERSION = 1;

function publicUserInputRequest(value) {
  if (!value || typeof value !== "object") return null;
  const questions = (Array.isArray(value.questions) ? value.questions : []).map((question) => {
    const secret = question?.isSecret === true || question?.is_secret === true;
    const shaped = {
      id: String(question?.id || "").trim(),
      header: String(question?.header || ""),
      question: String(question?.question || ""),
      isOther: question?.isOther === true || question?.is_other === true,
      isSecret: secret,
      required: question?.required === true,
      allowMultiple: question?.allowMultiple === true || question?.allow_multiple === true,
      options: (Array.isArray(question?.options) ? question.options : []).map((option) => ({
        label: String(option?.label || ""),
        description: String(option?.description || ""),
      })).filter((option) => option.label),
    };
    if (!secret && question?.defaultValue != null) shaped.defaultValue = structuredClone(question.defaultValue);
    return shaped;
  }).filter((question) => question.id && (question.question || question.options.length));
  return {
    request_id: String(value.request_id || value.itemId || "").trim() || null,
    threadId: String(value.threadId || "").trim() || null,
    turnId: String(value.turnId || "").trim() || null,
    itemId: String(value.itemId || value.request_id || "").trim() || null,
    questions,
    autoResolutionMs: value.autoResolutionMs ?? null,
  };
}

export function createLivePendingInteraction(entry = {}, {
  requestId = null,
  request = null,
  block = null,
  createdAt = null,
} = {}) {
  const id = String(requestId || entry.itemId || "").trim();
  const runId = String(entry.runId || "").trim();
  const sessionId = String(entry.sessionId || "").trim();
  if (!(id && runId && sessionId && block && typeof block === "object")) return null;
  const kind = entry.kind === "user_input" ? "user_input" : "approval";
  const safeRequest = kind === "user_input" && request ? publicUserInputRequest(request) : null;
  const safeBlock = structuredClone(block);
  if (safeRequest && safeBlock.type === "user_input") safeBlock.content = JSON.stringify(safeRequest);
  return {
    version: LIVE_PENDING_INTERACTION_VERSION,
    kind,
    status: "pending",
    request_id: id,
    run_id: runId,
    session_id: sessionId,
    resolution: {
      type: "native_turn",
      thread_id: String(entry.threadId || "").trim() || null,
      turn_id: String(entry.turnId || "").trim() || null,
      item_id: String(entry.itemId || id).trim() || id,
    },
    ...(safeRequest ? { request: safeRequest } : {}),
    block: safeBlock,
    created_at: createdAt || entry.createdAt || new Date().toISOString(),
  };
}

export function attachPendingDecisionPublicInteraction(requestId, {
  request = null,
  block = null,
  createdAt = null,
} = {}) {
  const id = String(requestId || "").trim();
  const entry = pendingDecisions.get(id);
  if (!entry) return false;
  const publicInteraction = createLivePendingInteraction(entry, {
    requestId: id,
    request,
    block,
    createdAt: createdAt || entry.publicInteraction?.created_at || null,
  });
  if (!publicInteraction) return false;
  entry.publicInteraction = publicInteraction;
  publishPendingDecision(entry, "interaction_public_ready");
  return true;
}

export function listLivePendingInteractions({
  userId,
  projectId,
  sessionId,
} = {}) {
  const expectedUserId = String(userId || "").trim();
  const expectedProjectId = String(projectId || "").trim();
  const expectedSessionId = String(sessionId || "").trim();
  if (!(expectedUserId && expectedProjectId && expectedSessionId)) return [];
  const items = [];
  for (const entry of pendingDecisions.values()) {
    if (String(entry?.userId || "").trim() !== expectedUserId) continue;
    if (String(entry?.projectId || "").trim() !== expectedProjectId) continue;
    if (String(entry?.sessionId || "").trim() !== expectedSessionId) continue;
    if (!entry?.publicInteraction) continue;
    items.push(structuredClone(entry.publicInteraction));
  }
  return items;
}

export async function persistAgentTurnBeforeRunTerminal({
  persist,
  runtime,
  runCreated,
  finalStatus,
  interruptReason = "request_aborted",
} = {}) {
  if (typeof persist !== "function") throw new TypeError("缺少会话记录保存函数");
  const persistence = await persist();
  const durableStatus = persistence?.ok ? finalStatus : "failed";
  let terminalError = null;
  if (runCreated) {
    try {
      if (durableStatus === "interrupted") await runtime?.interruptRun?.(interruptReason);
      else await runtime?.completeRun?.(durableStatus === "completed" ? "completed" : "failed");
    } catch (error) {
      terminalError = error;
    }
  }
  return { persistence, durable_status: durableStatus, terminal_error: terminalError };
}

function latestAgentRunOrder(alias) {
  return `COALESCE(${alias}.status_changed_at, ${alias}.created_at) DESC, ${alias}.created_at DESC, ${alias}.id DESC`;
}

function liveInteractionStatusesBySession() {
  const statuses = new Map();
  for (const pending of pendingDecisions.values()) {
    const sessionId = String(pending?.sessionId || "").trim();
    const status = pending?.kind === "user_input"
      ? "waiting_user_input"
      : pending?.kind === "approval"
        ? "waiting_approval"
        : null;
    if (!sessionId || !status) continue;
    // A direct answer is the more specific action if inconsistent runtime state
    // temporarily exposes both kinds for one session.
    if (status === "waiting_user_input" || !statuses.has(sessionId)) statuses.set(sessionId, status);
  }
  return statuses;
}

export function redactUserInputAnswers(questions = [], answers = {}) {
  const secretQuestionIds = new Set((Array.isArray(questions) ? questions : [])
    .filter((question) => question?.isSecret === true || question?.is_secret === true)
    .map((question) => String(question.id || ""))
    .filter(Boolean));
  return Object.fromEntries(Object.entries(answers && typeof answers === "object" ? answers : {}).map(([questionId, answer]) => (
    secretQuestionIds.has(questionId)
      ? [questionId, { answers: [], answered: true, secret: true }]
      : [questionId, answer]
  )));
}

const FILE_PREVIEW_TEXT_BYTES = 200 * 1024;
const FILE_PREVIEW_DOCUMENT_BYTES = 25 * 1024 * 1024;
const PREVIEW_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const PREVIEW_DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".xls"]);
const PREVIEW_TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".log", ".csv", ".tsv", ".json", ".jsonl", ".ndjson",
  ".html", ".htm", ".xml", ".css", ".scss", ".less", ".js", ".jsx", ".ts", ".tsx",
  ".mjs", ".cjs", ".py", ".sql", ".sh", ".bash", ".zsh", ".fish", ".yaml", ".yml",
  ".toml", ".ini", ".conf", ".env", ".java", ".go", ".rs", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".php", ".rb", ".swift", ".kt", ".kts", ".r", ".vue", ".svelte",
]);
const PREVIEW_TEXT_FILE_NAMES = new Set(["dockerfile", "makefile", "license", "readme", ".gitignore", ".npmrc"]);

function readLimitedFile(filePath, size) {
  const bytesToRead = Math.min(Math.max(0, Number(size) || 0), FILE_PREVIEW_TEXT_BYTES);
  if (!bytesToRead) return { buffer: Buffer.alloc(0), truncated: false };
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
    return {
      buffer: bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead),
      truncated: Number(size) > bytesRead,
    };
  } finally {
    closeSync(fd);
  }
}

function looksLikeText(buffer) {
  if (!buffer.length) return true;
  let controls = 0;
  for (const byte of buffer) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / buffer.length < 0.02;
}

function textPreview(filePath, stat, extension, previewKind = "text") {
  const { buffer, truncated } = readLimitedFile(filePath, stat.size);
  if (!looksLikeText(buffer)) {
    return {
      content: "",
      can_preview: false,
      preview_kind: "unsupported",
      preview_mode: "none",
      truncated: false,
      reason: "这是二进制文件，请用本机应用打开。",
    };
  }
  return {
    content: buffer.toString("utf8").replace(/\uFFFD$/, ""),
    can_preview: true,
    preview_kind: previewKind,
    preview_mode: "source_text",
    truncated,
    reason: truncated ? "文件较大，只显示前 200 KB。" : "",
    extension,
  };
}

async function loadPreviewDocument(filePath, extension) {
  const buffer = await readFile(filePath);
  if (extension === ".pdf") {
    const mod = await import("pdf-parse");
    if (typeof mod.PDFParse === "function") {
      const parser = new mod.PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        return result?.text || "";
      } finally {
        await parser.destroy().catch(() => null);
      }
    }
    const legacy = mod.default || mod;
    if (typeof legacy !== "function") throw new Error("PDF 解析器不可用");
    const result = await legacy(buffer);
    return result?.text || "";
  }
  if (extension === ".docx") {
    const mod = await import("mammoth");
    const mammoth = mod.default || mod;
    const result = await mammoth.extractRawText({ buffer });
    return result?.value || "";
  }
  if (extension === ".pptx") {
    const mod = await import("jszip");
    const JSZip = mod.default || mod;
    const archive = await JSZip.loadAsync(buffer);
    const decodeXml = (value) => String(value || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
    const fallbackSlideNames = Object.keys(archive.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort((left, right) => {
        const leftNumber = Number(left.match(/slide(\d+)\.xml$/i)?.[1] || 0);
        const rightNumber = Number(right.match(/slide(\d+)\.xml$/i)?.[1] || 0);
        return leftNumber - rightNumber;
      });
    const [presentationXml, relationshipsXml] = await Promise.all([
      archive.file("ppt/presentation.xml")?.async("string"),
      archive.file("ppt/_rels/presentation.xml.rels")?.async("string"),
    ]);
    const attribute = (tag, name) => {
      const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return decodeXml(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] || "");
    };
    const relationshipTargets = new Map(
      [...String(relationshipsXml || "").matchAll(/<Relationship\b([^>]*)\/?\s*>/gi)]
        .map((match) => [attribute(match[1], "Id"), attribute(match[1], "Target")])
        .filter(([id, target]) => id && target),
    );
    const orderedSlideNames = [...String(presentationXml || "").matchAll(/<p:sldId\b([^>]*)\/?\s*>/gi)]
      .map((match) => relationshipTargets.get(attribute(match[1], "r:id")) || "")
      .map((target) => target.startsWith("/") ? target.slice(1) : posix.normalize(posix.join("ppt", target)))
      .filter((name) => archive.file(name));
    const orderedSet = new Set(orderedSlideNames);
    const slideNames = [...orderedSlideNames, ...fallbackSlideNames.filter((name) => !orderedSet.has(name))];
    const slides = [];
    for (let index = 0; index < slideNames.length; index += 1) {
      const xml = await archive.file(slideNames[index])?.async("string");
      if (!xml) continue;
      const paragraphs = [...xml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi)]
        .map((paragraph) => [...paragraph[1].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)]
          .map((text) => decodeXml(text[1]).trim())
          .filter(Boolean)
          .join(""))
        .filter(Boolean);
      if (paragraphs.length) slides.push(`# Slide ${index + 1}\n${paragraphs.join("\n")}`);
    }
    return slides.join("\n\n");
  }
  if (extension === ".xlsx" || extension === ".xls") {
    const mod = await import("xlsx");
    const XLSX = mod.default || mod;
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const parts = [];
    for (const sheetName of workbook.SheetNames || []) {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      if (csv?.trim()) parts.push(`# Sheet: ${sheetName}\n${csv}`);
    }
    return parts.join("\n\n");
  }
  throw new Error("不支持的文档类型");
}

// Build a safe, size-limited preview after the caller has checked workspace access.
export async function buildAgentFilePreview(filePath, displayPath = "", rootId = "") {
  const stat = statSync(filePath);
  if (!stat.isFile()) throw new Error("目标不是普通文件");
  const extension = extname(filePath).toLowerCase();
  const name = basename(filePath);
  const base = {
    path: displayPath || name,
    name,
    root_id: rootId,
    size: stat.size,
    extension: extension.replace(/^\./, ""),
  };

  if (PREVIEW_IMAGE_EXTENSIONS.has(extension)) {
    return {
      ...base,
      content: "",
      can_preview: true,
      preview_kind: "image",
      preview_mode: "native_image",
      truncated: false,
      reason: "",
    };
  }

  if (PREVIEW_DOCUMENT_EXTENSIONS.has(extension)) {
    if (stat.size > FILE_PREVIEW_DOCUMENT_BYTES) {
      return {
        ...base,
        content: "",
        can_preview: false,
        preview_kind: extension === ".xlsx" || extension === ".xls" ? "table" : "document",
        preview_mode: "none",
        truncated: false,
        reason: "文件超过 25 MB，请用本机应用打开。",
      };
    }
    try {
      const extracted = String(await loadPreviewDocument(filePath, extension));
      const content = extracted.slice(0, FILE_PREVIEW_TEXT_BYTES);
      const truncated = extracted.length > content.length;
      return {
        ...base,
        content,
        can_preview: Boolean(content.trim()),
        preview_kind: extension === ".xlsx" || extension === ".xls" ? "table" : "document",
        preview_mode: "extracted_text",
        truncated,
        reason: content.trim()
          ? (truncated ? "提取内容较长，只显示前 200 KB。" : "显示提取文本，版式可能与原文件不同。")
          : "没有提取到可预览的文字，请用本机应用打开。",
      };
    } catch {
      return {
        ...base,
        content: "",
        can_preview: false,
        preview_kind: extension === ".xlsx" || extension === ".xls" ? "table" : "document",
        preview_mode: "none",
        truncated: false,
        reason: "无法提取文件内容，请用本机应用打开。",
      };
    }
  }

  const knownText = PREVIEW_TEXT_EXTENSIONS.has(extension)
    || (!extension && PREVIEW_TEXT_FILE_NAMES.has(name.toLowerCase()));
  if (knownText || !extension) return { ...base, ...textPreview(filePath, stat, extension) };

  // Unknown small files get one safe text sniff. This keeps extensionless and
  // custom source files useful without rendering arbitrary binary bytes.
  if (stat.size <= FILE_PREVIEW_TEXT_BYTES) {
    const sniffed = textPreview(filePath, stat, extension);
    if (sniffed.can_preview) return { ...base, ...sniffed };
  }

  return {
    ...base,
    content: "",
    can_preview: false,
    preview_kind: "unsupported",
    preview_mode: "none",
    truncated: false,
    reason: "暂不支持这种文件的内置预览，请用本机应用打开。",
  };
}

// GET /api/agent/projects/:pid/sessions — workspace history: unified agent sessions
export async function listAgentSessions(ctx, input) {
  const archived = input.query?.archived === "1" || input.query?.archived === "true";
  const statusFilter = archived
    ? "AND COALESCE(sessions.status,'active')='archived'"
    : "AND COALESCE(sessions.status,'active')<>'archived'";
  const rows = await ctx.query(
      `SELECT sessions.id, sessions.project_id, sessions.title, sessions.status,
              sessions.message_count, sessions.session_config, sessions.created_at, sessions.updated_at,
              latest_run.id AS latest_run_id,
              latest_run.status AS latest_run_status,
              latest_run.viewed_at AS latest_run_viewed_at
         FROM sessions
         LEFT JOIN agent_runs latest_run ON latest_run.id=(
           SELECT ar.id
            FROM agent_runs ar
           WHERE ar.session_id=sessions.id AND ar.deleted_at IS NULL
            ORDER BY ${latestAgentRunOrder("ar")}
            LIMIT 1
         )
        WHERE sessions.project_id=$1 AND sessions.created_by=$2 AND sessions.deleted_at IS NULL
          AND sessions.action_type IN ('agentic_chat','automation')
          AND (
            sessions.action_type='automation'
            OR EXISTS (
              SELECT 1 FROM session_messages visible_user_message
               WHERE visible_user_message.session_id=sessions.id
                 AND visible_user_message.role='user'
                 AND visible_user_message.deleted_at IS NULL
            )
          )
          ${statusFilter}
        ORDER BY sessions.updated_at DESC`,
      [input.params.pid, ctx.userId || ""],
    );
  const liveStatuses = liveInteractionStatusesBySession();
  return {
    data: {
      items: rows.map((row) => {
        const { session_config: _sessionConfig, ...session } = row;
        return {
          ...session,
          live_interaction_status: liveStatuses.get(String(row.id)) || null,
        };
      }),
    },
    message: "ok",
  };
}

// POST /api/agent/projects/:pid/sessions/:sid/viewed — clear only the newest terminal result.
export async function markAgentSessionViewed(ctx, input) {
  const { pid, sid } = input.params || {};
  const expectedRunId = String(input.body?.run_id || "").trim();
  if (!expectedRunId) throw new ApiError("缺少运行记录 ID", 400);
  const ownedSession = await ctx.queryOne(
    `SELECT id FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
      LIMIT 1`,
    [sid, pid, ctx.userId || ""],
  );
  if (!ownedSession) throw new ApiError("会话不存在或无权限", 404);

  const liveStatus = liveInteractionStatusesBySession().get(String(sid)) || null;
  const latestRunSql = `SELECT latest.id AS run_id, latest.status, latest.viewed_at
                          FROM agent_runs latest
                         WHERE latest.session_id=$1 AND latest.deleted_at IS NULL
                         ORDER BY ${latestAgentRunOrder("latest")}
                         LIMIT 1`;
  if (liveStatus) {
    const latest = await ctx.queryOne(latestRunSql, [sid]);
    return {
      data: {
        run_id: latest?.run_id || null,
        status: latest?.status || null,
        viewed_at: latest?.viewed_at || null,
        viewed: false,
      },
      message: "ok",
    };
  }

  const updated = await ctx.queryOne(
    `UPDATE agent_runs
        SET viewed_at=COALESCE(viewed_at,now())
      WHERE session_id=$1 AND deleted_at IS NULL
        AND status IN ('completed','failed','interrupted','expired')
        AND id=$2
        AND id=(
          SELECT latest.id
            FROM agent_runs latest
           WHERE latest.session_id=$1 AND latest.deleted_at IS NULL
           ORDER BY ${latestAgentRunOrder("latest")}
           LIMIT 1
        )
      RETURNING id AS run_id, status, viewed_at`,
    [sid, expectedRunId],
  );
  if (updated) {
    publishConversationStatusChanged({
      userId: ctx.userId || null,
      projectId: pid,
      sessionId: sid,
      runId: updated.run_id,
      reason: "run_viewed",
    });
    return { data: { ...updated, viewed: true }, message: "ok" };
  }

  const latest = await ctx.queryOne(latestRunSql, [sid]);
  return {
    data: {
      run_id: latest?.run_id || null,
      status: latest?.status || null,
      viewed_at: latest?.viewed_at || null,
      viewed: false,
    },
    message: "ok",
  };
}

const SEARCHABLE_MESSAGE_TYPES = new Set(["text", "markdown", "agentMessage"]);

function parseContentItems(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Search only text that is visible as part of the conversation. Tool payloads
// and hidden reasoning may contain private or misleading matches, so they are
// deliberately left out even though they share the same JSON column.
export function extractConversationSearchText(contentItems) {
  return parseContentItems(contentItems)
    .filter((item) => {
      if (!item || !SEARCHABLE_MESSAGE_TYPES.has(String(item.type || ""))) return false;
      return item.metadata?.display !== false;
    })
    .map((item) => String(item.content || item.text || "").trim())
    .filter(Boolean)
    .join("\n");
}

export function buildConversationSearchSnippet(text, query, maxLength = 150) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  const needle = String(query || "").trim();
  if (!clean || !needle) return "";
  const index = clean.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index < 0) return "";
  const safeMax = Math.max(60, Number(maxLength) || 150);
  const contextBefore = Math.min(50, Math.floor((safeMax - needle.length) / 2));
  let start = Math.max(0, index - contextBefore);
  let end = Math.min(clean.length, start + safeMax);
  if (end === clean.length) start = Math.max(0, end - safeMax);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

// GET /api/agent/search/conversations?q=... — search titles and visible message text.
// Archived conversations remain searchable; temporary chats never enter this result.
export async function searchAgentConversations(ctx, input) {
  const queryText = String(input.query?.q || "").trim().slice(0, 200);
  const requestedLimit = Number.parseInt(String(input.query?.limit || "40"), 10);
  const limit = Math.min(80, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 40));
  if (!queryText) return { data: { query: "", items: [] }, message: "ok" };

  const candidateLimit = Math.min(200, Math.max(80, limit * 4));
  const projectId = String(input.query?.project_id || input.query?.projectId || "").trim();
  const sinceValue = String(input.query?.since || "").trim();
  const since = Number.isFinite(Date.parse(sinceValue)) ? new Date(sinceValue).toISOString() : "";
  const candidateParams = [ctx.userId || "", queryText];
  const candidateFilters = [];
  if (projectId) {
    candidateParams.push(projectId);
    candidateFilters.push(`AND s.project_id=$${candidateParams.length}`);
  }
  if (since) {
    candidateParams.push(since);
    candidateFilters.push(`AND s.updated_at >= $${candidateParams.length}`);
  }
  candidateParams.push(candidateLimit);
  const candidates = await ctx.query(
    `SELECT s.id, s.project_id, s.title, COALESCE(s.status,'active') AS status,
            s.updated_at, p.name AS project_name,
            CASE WHEN instr(lower(COALESCE(s.title,'')), lower($2)) > 0 THEN 1 ELSE 0 END AS title_match
       FROM sessions s
       LEFT JOIN projects p
         ON p.id=s.project_id AND p.deleted_at IS NULL
      WHERE s.created_by=$1 AND s.deleted_at IS NULL
        AND s.action_type='agentic_chat'
        AND EXISTS (
          SELECT 1 FROM session_messages visible_message
           WHERE visible_message.session_id=s.id
             AND visible_message.role IN ('user','assistant')
             AND visible_message.deleted_at IS NULL
        )
        AND (
          s.project_id='__chat__'
          OR (
            p.id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM project_members pm
               WHERE pm.project_id=s.project_id AND pm.user_id=$1 AND pm.deleted_at IS NULL
            )
          )
        )
        ${candidateFilters.join("\n        ")}
        AND (
          instr(lower(COALESCE(s.title,'')), lower($2)) > 0
          OR EXISTS (
            SELECT 1
              FROM session_messages sm,
                   json_each(
                     CASE WHEN json_valid(COALESCE(sm.content_items,''))
                          THEN sm.content_items ELSE '[]' END
                   ) item
             WHERE sm.session_id=s.id AND sm.deleted_at IS NULL
               AND sm.role IN ('user','assistant')
               AND json_extract(item.value,'$.type') IN ('text','markdown','agentMessage')
               AND COALESCE(json_extract(item.value,'$.metadata.display'),1) <> 0
               AND instr(lower(COALESCE(
                     json_extract(item.value,'$.content'),
                     json_extract(item.value,'$.text'),
                     ''
                   )), lower($2)) > 0
          )
        )
      ORDER BY title_match DESC, s.updated_at DESC
      LIMIT $${candidateParams.length}`,
    candidateParams,
  );

  if (!candidates.length) return { data: { query: queryText, items: [] }, message: "ok" };

  const messageRows = await ctx.query(
    `WITH matching_messages AS (
       SELECT sm.session_id, sm.role, sm.content_items, sm.sequence_number,
              ROW_NUMBER() OVER (
                PARTITION BY sm.session_id
                ORDER BY sm.sequence_number DESC, sm.created_at DESC
              ) AS search_rank
         FROM session_messages sm
        WHERE sm.session_id = ANY($1::text[])
          AND sm.deleted_at IS NULL
          AND sm.role IN ('user','assistant')
          AND EXISTS (
            SELECT 1
              FROM json_each(
                     CASE WHEN json_valid(COALESCE(sm.content_items,''))
                          THEN sm.content_items ELSE '[]' END
                   ) item
             WHERE json_extract(item.value,'$.type') IN ('text','markdown','agentMessage')
               AND COALESCE(json_extract(item.value,'$.metadata.display'),1) <> 0
               AND instr(lower(COALESCE(
                     json_extract(item.value,'$.content'),
                     json_extract(item.value,'$.text'),
                     ''
                   )), lower($2)) > 0
          )
     )
     SELECT session_id, role, content_items
       FROM matching_messages
      WHERE search_rank=1`,
    [candidates.map((row) => row.id), queryText],
  );

  const messageBySession = new Map();
  for (const row of messageRows) {
    const text = extractConversationSearchText(row.content_items);
    const snippet = buildConversationSearchSnippet(text, queryText);
    if (snippet) messageBySession.set(row.session_id, { role: row.role, snippet });
  }

  const loweredQuery = queryText.toLocaleLowerCase();
  const items = candidates.flatMap((row) => {
    const titleMatch = String(row.title || "").toLocaleLowerCase().includes(loweredQuery);
    const message = messageBySession.get(row.id);
    // A raw JSON match can come from hidden metadata. Do not expose it unless
    // the visible title or visible message text also matches.
    if (!titleMatch && !message) return [];
    return [{
      session_id: row.id,
      project_id: row.project_id,
      title: row.title || "新对话",
      project_name: row.project_id === "__chat__" ? "聊天" : (row.project_name || "项目"),
      status: row.status || "active",
      updated_at: row.updated_at,
      match_type: titleMatch ? "title" : "message",
      snippet: message?.snippet || "",
      role: message?.role || null,
    }];
  }).slice(0, limit);

  return { data: { query: queryText, items }, message: "ok" };
}

export function extractWebSources(contentItems) {
  const sources = [];
  for (const item of parseContentItems(contentItems)) {
    if (!item || String(item.type || "") !== "web_sources") continue;
    let payload = item.content;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch { payload = null; }
    }
    const candidates = Array.isArray(payload?.sources)
      ? payload.sources
      : Array.isArray(item.metadata?.web_sources)
        ? item.metadata.web_sources
        : [];
    for (const source of candidates) {
      if (!source?.source_id || !/^https?:\/\//i.test(String(source.url || ""))) continue;
      sources.push({
        source_id: String(source.source_id),
        url: String(source.url),
        canonical_url: String(source.canonical_url || source.url),
        title: String(source.title || source.site_name || source.url),
        site_name: String(source.site_name || ""),
        published_at: source.published_at || null,
        accessed_at: source.accessed_at || null,
        excerpt: String(source.excerpt || ""),
      });
    }
  }
  return sources;
}

// GET /api/agent/search/web-sources?q=... — search persisted, user-visible web citations.
export async function searchAgentWebSources(ctx, input) {
  const queryText = String(input.query?.q || "").trim().slice(0, 200);
  const requestedLimit = Number.parseInt(String(input.query?.limit || "40"), 10);
  const limit = Math.min(80, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 40));
  if (!queryText) return { data: { query: "", items: [] }, message: "ok" };

  const projectId = String(input.query?.project_id || input.query?.projectId || "").trim();
  const sinceValue = String(input.query?.since || "").trim();
  const since = Number.isFinite(Date.parse(sinceValue)) ? new Date(sinceValue).toISOString() : "";
  const params = [ctx.userId || "", queryText];
  const filters = [];
  if (projectId) {
    params.push(projectId);
    filters.push(`AND s.project_id=$${params.length}`);
  }
  if (since) {
    params.push(since);
    filters.push(`AND sm.created_at >= $${params.length}`);
  }
  params.push(Math.min(400, Math.max(120, limit * 8)));

  const rows = await ctx.query(
    `SELECT sm.session_id, sm.content_items, sm.created_at,
            s.project_id, s.title AS session_title, p.name AS project_name
       FROM session_messages sm
       JOIN sessions s ON s.id=sm.session_id AND s.deleted_at IS NULL
       LEFT JOIN projects p ON p.id=s.project_id AND p.deleted_at IS NULL
      WHERE s.created_by=$1 AND s.action_type='agentic_chat'
        AND sm.deleted_at IS NULL AND sm.role='assistant'
        AND (
          s.project_id='__chat__'
          OR (
            p.id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM project_members pm
               WHERE pm.project_id=s.project_id AND pm.user_id=$1 AND pm.deleted_at IS NULL
            )
          )
        )
        ${filters.join("\n        ")}
        AND instr(lower(COALESCE(sm.content_items,'')), lower($2)) > 0
      ORDER BY sm.created_at DESC
      LIMIT $${params.length}`,
    params,
  );

  const loweredQuery = queryText.toLocaleLowerCase();
  const seen = new Set();
  const items = [];
  for (const row of rows) {
    for (const source of extractWebSources(row.content_items)) {
      const haystack = [source.title, source.site_name, source.url, source.excerpt].join("\n").toLocaleLowerCase();
      if (!haystack.includes(loweredQuery)) continue;
      const key = `${row.session_id}:${source.canonical_url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        ...source,
        session_id: row.session_id,
        session_title: row.session_title || "新对话",
        project_id: row.project_id,
        project_name: row.project_id === "__chat__" ? "聊天" : (row.project_name || "项目"),
        message_created_at: row.created_at,
      });
      if (items.length >= limit) break;
    }
    if (items.length >= limit) break;
  }
  return { data: { query: queryText, items }, message: "ok" };
}

// GET /api/agent/projects/:pid/model — DSH catalog and current Session target.
export async function getAgentModel(ctx, input) {
  const client = getDshRuntimeClient();
  await client.start();
  const sessionId = String(input.query?.session_id || "").trim();
  let catalog = null;
  if (sessionId) {
    const owned = await ctx.queryOne(
      `SELECT id FROM sessions
        WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
        LIMIT 1`,
      [sessionId, input.params.pid, ctx.userId || ""],
    ).catch(() => null);
    if (owned) {
      const binding = await loadDshSessionBinding(ctx, sessionId).catch(() => null);
      if (binding) catalog = await client.request("session.models", { sessionId: binding.dshSessionId }).catch(() => null);
    }
  }
  if (!catalog) {
    const [directory, host] = await Promise.all([
      client.request("llm.models", {}),
      client.request("host.describe", {}),
    ]);
    catalog = {
      ...directory,
      current: host?.provider && host?.model ? { provider: host.provider, model: host.model } : null,
    };
  }
  const items = dshModelOptions(catalog);
  const defaultId = catalog?.current?.provider && catalog?.current?.model
    ? encodeDshModelRoute(catalog.current.provider, catalog.current.model)
    : "";
  return {
    data: {
      default_model_id: defaultId,
      model_id: defaultId,
      model_name: catalog?.current?.model || "",
      provider: catalog?.current?.provider || "",
      items: items.map((item) => ({ ...item, is_enabled: item.id === defaultId })),
      failures: catalog?.failures || [],
    },
    message: "ok",
  };
}

// GET /api/agent/skills — app-level skills (global chat / generic agents)
export async function listAppAgentSkills(ctx) {
  return { data: await listAppSkills(ctx), message: "获取 App 技能列表成功" };
}

// GET /api/agent/skills/enabled/list
export async function listEnabledAppAgentSkills(ctx) {
  const skills = await listEnabledAppSkills(ctx);
  return {
    data: skills.filter((skill) => !skill.plugin_name),
    message: "获取启用 App 技能成功",
  };
}

// GET /api/agent/skills/:skillName
export async function getAppAgentSkill(ctx, input) {
  return { data: await getAppSkill(ctx, input.params.skillName), message: "获取 App 技能详情成功" };
}

// POST /api/agent/skills
export async function createAppAgentSkill(ctx, input) {
  const data = await createAppSkill(ctx, input.body || {}, ctx.userId || "");
  return { data, message: "创建 App 技能成功" };
}

// PUT /api/agent/skills/:skillName
export async function updateAppAgentSkill(ctx, input) {
  const data = await updateAppSkill(ctx, input.params.skillName, input.body || {}, ctx.userId || "");
  return { data, message: "更新 App 技能成功" };
}

// DELETE /api/agent/skills/:skillName
export async function deleteAppAgentSkill(ctx, input) {
  return { data: await deleteAppSkill(ctx, input.params.skillName, ctx.userId || ""), message: "删除 App 技能成功" };
}

// PATCH /api/agent/skills/:skillName/toggle
export async function toggleAppAgentSkill(ctx, input) {
  const data = await setAppSkillEnabled(ctx, input.params.skillName, input.body || {}, ctx.userId || "");
  return { data, message: "更新 App 技能状态成功" };
}

// POST /api/agent/skills/ai-generate
export async function aiGenerateAppAgentSkill(_ctx, input) {
  return { data: generateSkillDraft(input.body?.description || ""), message: "生成 Skill 基础模板成功" };
}

// GET /api/agent/projects/:pid/files — workspace file tree
export async function getAgentFiles(ctx, input) {
  try {
    const projectId = String(input.params?.pid || "").trim();
    const sessionId = String(input.query?.session_id || input.query?.sessionId || input.params?.sid || "").trim();
    const roots = await listProjectFileRoots(ctx, { projectId, sessionId });
    const rootId = String(input.query?.root_id || input.query?.rootId || "").trim();
    const path = String(input.query?.path || "").trim();
    if (rootId) {
      const root = roots.find((item) => String(item.id) === rootId);
      if (!root) return { data: { root_id: rootId, path, items: [], truncated: false }, message: "文件根目录不存在或无权限" };
      const listed = listDirectoryItems(root, path);
      return { data: { root_id: root.id, path, ...listed }, message: "ok" };
    }
    return {
      data: {
        roots: roots.map((root) => {
          const listed = listDirectoryItems(root);
          return { ...root, tree: listed.items, tree_truncated: listed.truncated };
        }),
      },
      message: "ok",
    };
  } catch (e) {
    return { data: { roots: [] }, message: e?.message || String(e) };
  }
}

// GET /api/agent/projects/:pid/file?path=... — read one workspace file (preview, workspace-limited and size-limited)
export async function getAgentFile(ctx, input) {
  try {
    const projectId = String(input.params?.pid || "").trim();
    const sessionId = String(input.query?.session_id || input.query?.sessionId || input.params?.sid || "").trim();
    const roots = await listProjectFileRoots(ctx, { projectId, sessionId });
    const rootId = String(input.query?.root_id || input.query?.rootId || "").trim();
    const root = roots.find((item) => item.id === rootId) || (roots.length === 1 ? roots[0] : null);
    if (!root) return { data: null, message: "文件根目录不存在或无权限" };
    const rel = String(input.query?.path || "");
    const resolved = resolveAuthorizedRootPath(root, rel, { type: "file" });
    if (!resolved || hasHiddenOrGeneratedPath(resolved.relativePath)) {
      return { data: null, message: "文件不存在或无权限" };
    }
    const data = await buildAgentFilePreview(resolved.fullPath, resolved.relativePath, root.id);
    return { data, message: "ok" };
  } catch (e) {
    return { data: null, message: e?.message || String(e) };
  }
}

// POST /api/agent/projects/:pid/sessions/:sid/compact — manually compact session context (/compact)
export async function compactAgentSession(ctx, input, { client = getDshRuntimeClient() } = {}) {
  const sid = input.params.sid;
  const row = await ctx.queryOne(
    `SELECT id FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
      LIMIT 1`,
    [sid, input.params.pid, ctx.userId || ""],
  );
  if (!row) throw new ApiError("会话不存在或无权限", 404);
  const binding = await loadDshSessionBinding(ctx, sid);
  if (!binding?.cwd) throw new ApiError("旧会话没有可用的 DSH Session，请新建对话", 409);
  await client.start();
  await ensureDshWorkspaceSession(client, { sessionId: binding.dshSessionId, cwd: binding.cwd });
  const result = await client.request("command.execute", {
    sessionId: binding.dshSessionId,
    line: "/compact",
  });
  if (result?.matched !== true) throw new ApiError("当前 DSH Profile 没有提供 /compact", 409);
  const text = String(result?.command?.text || "").trim();
  const compacted = !text.startsWith("No compactable history");
  return {
    data: { compacted, thread_id: binding.dshSessionId, dsh_command: text || null },
    message: compacted ? "已通过 DSH 压缩上下文" : "当前没有可压缩的历史",
  };
}

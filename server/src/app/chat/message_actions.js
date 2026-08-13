import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { ApiError } from "../../errors.js";
import { dataPath } from "../../config/paths.js";
import { getDshRuntimeClient } from "../../engine/dsh_runtime/client.js";
import { dshEventsToMessages } from "../../engine/dsh_runtime/dsh_history_adapter.js";
import { loadDshSessionBinding, saveDshSessionBinding } from "../../engine/dsh_runtime/session_binding.js";
import { ensureDshWorkspaceSession } from "../../engine/dsh_runtime/session_attachment.js";
import { loadAllDshHistoryPages, mergeProductProjection } from "../reads/reads_session.js";

const BRANCH_MODES = new Set(["branch", "retry", "edit"]);
const ACTIVE_RUN_STATUSES = [
  "pending",
  "queued",
  "running",
  "suspended",
  "waiting_approval",
  "waiting_user_input",
  "recovering",
];

function clean(value) {
  return String(value || "").trim();
}

function parseObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value };
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseItems(value) {
  if (Array.isArray(value)) return structuredClone(value);
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeSegment(value) {
  return clean(value)
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "_")
    .slice(0, 160);
}

function isInsidePath(candidate, root) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function copyDirectoryTree(sourceRoot, targetRoot) {
  if (!existsSync(sourceRoot)) {
    return { copiedFiles: 0, copiedDirectories: 0, rollback: () => {} };
  }
  if (existsSync(targetRoot)) throw new Error(`分支目标目录已存在：${targetRoot}`);
  const sourceStat = lstatSync(sourceRoot);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error(`分支来源目录不安全：${sourceRoot}`);
  }

  let copiedFiles = 0;
  let copiedDirectories = 0;
  mkdirSync(targetRoot, { recursive: true });
  const copyEntry = (source, target) => {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      mkdirSync(target, { recursive: true });
      copiedDirectories += 1;
      for (const child of readdirSync(source)) copyEntry(join(source, child), join(target, child));
      return;
    }
    if (!stat.isFile()) return;
    copyFileSync(source, target);
    copiedFiles += 1;
  };

  try {
    for (const child of readdirSync(sourceRoot)) copyEntry(join(sourceRoot, child), join(targetRoot, child));
  } catch (error) {
    rmSync(targetRoot, { recursive: true, force: true });
    throw error;
  }
  return {
    copiedFiles,
    copiedDirectories,
    rollback: () => rmSync(targetRoot, { recursive: true, force: true }),
  };
}

export function copyConversationLocalFiles(projectId, sourceSessionId, targetSessionId) {
  const safeProject = safeSegment(projectId);
  const safeSource = safeSegment(sourceSessionId);
  const safeTarget = safeSegment(targetSessionId);
  if (!(safeProject && safeSource && safeTarget)) throw new Error("分支会话目录参数不合法");

  const roots = [
    {
      source: dataPath("attachments", safeProject, safeSource),
      target: dataPath("attachments", safeProject, safeTarget),
    },
    ...(projectId === "__chat__" ? [{
      source: dataPath("projects", "__chat__", safeSource),
      target: dataPath("projects", "__chat__", safeTarget),
    }] : []),
  ];
  const completed = [];
  try {
    for (const root of roots) {
      const copied = copyDirectoryTree(root.source, root.target);
      completed.push({ ...root, ...copied });
    }
  } catch (error) {
    for (const item of [...completed].reverse()) item.rollback();
    throw error;
  }

  const remapPath = (value) => {
    const raw = clean(value);
    if (!raw || !isAbsolute(raw)) return value;
    const candidate = resolve(raw);
    for (const item of completed) {
      const sourceRoot = resolve(item.source);
      if (!isInsidePath(candidate, sourceRoot)) continue;
      return join(item.target, relative(sourceRoot, candidate));
    }
    return value;
  };
  return {
    report: {
      copied_files: completed.reduce((total, item) => total + item.copiedFiles, 0),
      copied_directories: completed.reduce((total, item) => total + item.copiedDirectories, 0),
    },
    remapPath,
    rollback: () => {
      for (const item of [...completed].reverse()) item.rollback();
    },
  };
}

function remapLocalPaths(value, remapPath) {
  if (Array.isArray(value)) return value.map((item) => remapLocalPaths(item, remapPath));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && isAbsolute(value) ? remapPath(value) : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, remapLocalPaths(item, remapPath)]),
  );
}

function userDraft(row, remapPath) {
  const items = remapLocalPaths(parseItems(row?.content_items), remapPath);
  const metadata = remapLocalPaths(parseObject(row?.message_metadata), remapPath);
  const text = items
    .filter((item) => item && item.type !== "attachment" && typeof item.content === "string")
    .map((item) => item.content.trim())
    .filter(Boolean)
    .join("\n");
  const attachments = items
    .filter((item) => item?.type === "attachment")
    .map((item) => {
      const details = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
      return {
        path: clean(details.path || details.file_path),
        name: clean(details.name || item.content || basename(clean(details.path || ""))),
        is_dir: details.is_dir === true,
        mime_type: clean(details.mime_type) || null,
        size_bytes: Number(details.size_bytes || 0) || null,
        width: Number(details.width || 0) || null,
        height: Number(details.height || 0) || null,
        sha256: clean(details.sha256) || null,
        kind: clean(details.kind) || null,
      };
    })
    .filter((item) => item.path);
  const request = metadata.turn_request && typeof metadata.turn_request === "object"
    ? metadata.turn_request
    : {};
  return {
    text,
    attachments,
    input: Array.isArray(metadata.turn_input) ? metadata.turn_input : null,
    request,
  };
}

function branchTitle(title, mode) {
  const suffix = mode === "retry" ? "重试" : mode === "edit" ? "编辑" : "分支";
  const base = clean(title) || "新建对话";
  return `${base.slice(0, Math.max(1, 92 - suffix.length))} · ${suffix}`;
}

function cloneMessages(rows, targetSessionId, remapPath) {
  const idMap = new Map(rows.map((row) => [row.id, randomUUID()]));
  return rows.map((row, index) => {
    const id = idMap.get(row.id);
    const metadata = remapLocalPaths(parseObject(row.message_metadata), remapPath);
    return {
      id,
      session_id: targetSessionId,
      role: row.role,
      content_items: remapLocalPaths(parseItems(row.content_items), remapPath),
      message_metadata: {
        ...metadata,
        ...(metadata.message_id ? { message_id: id } : {}),
        branched_from_message_id: row.id,
      },
      sequence_number: index + 1,
      parent_message_id: idMap.get(row.parent_message_id) || null,
      reply_to_message_id: idMap.get(row.reply_to_message_id) || null,
      created_at: row.created_at || null,
      updated_at: row.updated_at || row.created_at || null,
    };
  });
}

function localRowsForDshPrefix(rows, messages) {
  const identities = new Set();
  for (const message of messages) {
    const role = String(message?.role || "");
    const metadata = parseObject(message?.message_metadata);
    const identity = role === "user"
      ? clean(metadata.dsh_prompt_rpc_id)
      : clean(metadata.turn_id || message?.id);
    if (identity) identities.add(`${role}:${identity}`);
  }
  return rows.filter((row) => {
    const role = String(row?.role || "");
    const metadata = parseObject(row?.message_metadata);
    const identity = role === "user"
      ? clean(metadata.dsh_prompt_rpc_id || row?.id)
      : clean(metadata.turn_id || metadata.runtime_turn_id);
    return Boolean(identity && identities.has(`${role}:${identity}`));
  });
}

function dshUserText(message) {
  return (Array.isArray(message?.content_items) ? message.content_items : [])
    .map((item) => String(item?.text || item?.content || "").trim())
    .filter(Boolean)
    .join("\n");
}

async function branchDshAgentMessage(ctx, {
  projectId,
  sessionId,
  messageId,
  mode,
  session,
  rows,
  binding,
  client,
}) {
  await client.start();
  if (!binding.cwd) throw new ApiError("DSH 会话缺少工作目录，不能可靠创建分支", 409);
  await ensureDshWorkspaceSession(client, { sessionId: binding.dshSessionId, cwd: binding.cwd });
  const sourceHistory = await loadAllDshHistoryPages(client, binding);
  const sourceProjection = dshEventsToMessages({
    entries: sourceHistory.entries,
    projections: sourceHistory.projections,
    sessionId: binding.dshSessionId,
  });
  const sourceMessages = sourceProjection.messages;
  const targetIndex = sourceMessages.findIndex((message) => String(message.id) === String(messageId));
  if (targetIndex < 0) throw new ApiError("DSH 历史中找不到这条消息", 404);
  const target = sourceMessages[targetIndex];

  let sourceUser = null;
  let retainedMessages = [];
  if (mode === "branch") {
    if (target.role !== "assistant" || target.message_metadata?.turn_status !== "completed") {
      throw new ApiError("请从一条完整回答创建分支", 400);
    }
    retainedMessages = sourceMessages.slice(0, targetIndex + 1);
  } else if (mode === "retry") {
    if (target.role !== "assistant") throw new ApiError("只能重试助手回答", 400);
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      if (sourceMessages[index]?.role === "user") {
        sourceUser = sourceMessages[index];
        retainedMessages = sourceMessages.slice(0, index);
        break;
      }
    }
    if (!sourceUser) throw new ApiError("找不到这条回答对应的用户消息", 409);
  } else {
    if (target.role !== "user") throw new ApiError("只能编辑用户消息", 400);
    sourceUser = target;
    retainedMessages = sourceMessages.slice(0, targetIndex);
  }

  const previousAssistant = [...retainedMessages].reverse().find((message) => message.role === "assistant");
  const atSeq = Number(previousAssistant?.message_metadata?.dsh_last_seq);
  const targetSessionId = randomUUID();
  let targetDshSessionId = null;
  let transfer = null;
  try {
    transfer = copyConversationLocalFiles(projectId, sessionId, targetSessionId);
    if (previousAssistant && Number.isFinite(atSeq) && atSeq >= 0) {
      const forked = await client.request("session.fork", { sessionId: binding.dshSessionId, atSeq });
      targetDshSessionId = clean(forked?.sessionId);
    } else {
      const created = await ensureDshWorkspaceSession(client, { cwd: binding.cwd });
      targetDshSessionId = clean(created?.sessionId);
    }
    if (!targetDshSessionId) throw new Error("DSH 没有返回分支 session id");

    const nextTitle = branchTitle(session.title, mode);
    await client.request("session.rename", { sessionId: targetDshSessionId, title: nextTitle });
    const sourceConfig = parseObject(session.session_config);
    const config = {
      ...sourceConfig,
      runtime_backend: "dsh",
      dsh_runtime_session_id: targetDshSessionId,
      dsh_runtime_cwd: binding.cwd,
      dsh_runtime_branch_source_session_id: sessionId,
      dsh_runtime_branch_source_message_id: messageId,
      dsh_runtime_branch_mode: mode,
      dsh_runtime_branched_at: new Date().toISOString(),
    };
    delete config.agent_kernel;
    delete config.agent_runtime_thread_id;
    delete config.agent_runtime_capability_revision;
    delete config.agent_runtime_native_move;

    const localPrefix = localRowsForDshPrefix(rows, retainedMessages);
    const clonedMessages = cloneMessages(localPrefix, targetSessionId, transfer.remapPath);
    await ctx.query(
      `INSERT INTO sessions
         (id, project_id, created_by, title, description, source_type, source_id,
          action_type, status, message_count, session_config, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,now(),now())`,
      [
        targetSessionId,
        projectId,
        ctx.userId || "",
        nextTitle,
        session.description || null,
        session.source_type || "agent",
        session.source_id || projectId,
        session.action_type || "agentic_chat",
        clonedMessages.length,
        JSON.stringify(config),
      ],
    );
    for (const message of clonedMessages) {
      await ctx.query(
        `INSERT INTO session_messages
           (id, session_id, role, content_items, message_metadata, sequence_number,
            parent_message_id, reply_to_message_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,now()),COALESCE($10,now()))`,
        [
          message.id,
          message.session_id,
          message.role,
          JSON.stringify(message.content_items),
          JSON.stringify(message.message_metadata),
          message.sequence_number,
          message.parent_message_id,
          message.reply_to_message_id,
          message.created_at,
          message.updated_at,
        ],
      );
    }
    await saveDshSessionBinding(ctx, {
      appSessionId: targetSessionId,
      dshSessionId: targetDshSessionId,
      cwd: binding.cwd,
      projectId,
      userId: ctx.userId || "",
    });
    const targetHistory = await loadAllDshHistoryPages(client, { dshSessionId: targetDshSessionId });
    const targetProjection = dshEventsToMessages({
      entries: targetHistory.entries,
      projections: targetHistory.projections,
      sessionId: targetDshSessionId,
      appSessionId: targetSessionId,
    });

    const sourceUserIdentity = clean(sourceUser?.message_metadata?.dsh_prompt_rpc_id);
    const localSourceUser = sourceUserIdentity
      ? rows.find((row) => row.role === "user" && clean(parseObject(row.message_metadata).dsh_prompt_rpc_id || row.id) === sourceUserIdentity)
      : null;
    const draft = sourceUser
      ? localSourceUser
        ? userDraft(localSourceUser, transfer.remapPath)
        : { text: dshUserText(sourceUser), attachments: [], input: null, request: {} }
      : null;
    return {
      data: {
        session: {
          id: targetSessionId,
          project_id: projectId,
          title: nextTitle,
          description: session.description || null,
          source_type: session.source_type || "agent",
          source_id: session.source_id || projectId,
          action_type: session.action_type || "agentic_chat",
          status: "active",
          message_count: targetProjection.messages.length,
          session_config: JSON.stringify(config),
        },
        messages: mergeProductProjection(targetProjection.messages, clonedMessages),
        mode,
        source_session_id: sessionId,
        source_message_id: messageId,
        runtime_thread_id: targetDshSessionId,
        boundary_turn_id: clean(target?.message_metadata?.turn_id || target.id),
        draft,
        workspace: transfer.report,
      },
      message: mode === "retry" ? "已创建回答重试分支" : mode === "edit" ? "已创建消息编辑分支" : "已创建对话分支",
    };
  } catch (error) {
    await ctx.query("DELETE FROM session_messages WHERE session_id=$1", [targetSessionId]).catch(() => null);
    await ctx.query("DELETE FROM sessions WHERE id=$1", [targetSessionId]).catch(() => null);
    transfer?.rollback?.();
    if (targetDshSessionId) {
      await client.request("workspace.archiveSession", { sessionId: targetDshSessionId }).catch(() => null);
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(`创建 DSH 消息分支失败：${error?.message || error}`, 500);
  }
}

export async function branchAgentMessage(ctx, input, {
  dshClient = getDshRuntimeClient(),
} = {}) {
  const { pid: projectId, sid: sessionId, mid: messageId } = input.params || {};
  const mode = clean(input.body?.mode || "branch").toLowerCase();
  if (!BRANCH_MODES.has(mode)) throw new ApiError("消息操作类型不合法", 400);

  const session = await ctx.queryOne(
    `SELECT id, project_id, created_by, title, description, source_type, source_id,
            action_type, session_config
       FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
      LIMIT 1`,
    [sessionId, projectId, ctx.userId || ""],
  ).catch(() => null);
  if (!session) throw new ApiError("会话不存在或无权限", 404);
  if (session.action_type === "temporary_chat") throw new ApiError("临时对话不能创建持久分支", 400);
  if (session.action_type && session.action_type !== "agentic_chat") {
    throw new ApiError("当前会话不支持消息分支", 400);
  }

  const active = await ctx.queryOne(
    `SELECT id FROM agent_runs
      WHERE session_id=$1 AND status IN (${ACTIVE_RUN_STATUSES.map((_, index) => `$${index + 2}`).join(",")})
      LIMIT 1`,
    [sessionId, ...ACTIVE_RUN_STATUSES],
  );
  if (active) throw new ApiError("对话仍在运行，请停止后再操作消息", 409);

  const rows = await ctx.query(
    `SELECT id, session_id, role, content_items, message_metadata, sequence_number,
            parent_message_id, reply_to_message_id, created_at, updated_at
       FROM session_messages
      WHERE session_id=$1 AND deleted_at IS NULL
      ORDER BY sequence_number ASC, created_at ASC`,
    [sessionId],
  );
  const dshBinding = await loadDshSessionBinding(ctx, sessionId);
  if (dshBinding) {
    return branchDshAgentMessage(ctx, {
      projectId,
      sessionId,
      messageId,
      mode,
      session,
      rows,
      binding: dshBinding,
      client: dshClient,
    });
  }
  throw new ApiError("此旧会话未绑定 DSH Session，不能再使用旧 Agent 分支逻辑；请新建对话", 409);
}

export default branchAgentMessage;

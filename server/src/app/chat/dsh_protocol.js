import { ApiError } from "../../errors.js";
import { DshEventAdapter } from "../../engine/dsh_runtime/event_adapter.js";
import { getDshRuntimeClient } from "../../engine/dsh_runtime/client.js";
import { loadDshSessionBinding } from "../../engine/dsh_runtime/session_binding.js";
import { ensureDshWorkspaceSession } from "../../engine/dsh_runtime/session_attachment.js";
import { dshPromptContent, normalizeDshPromptError } from "../../engine/dsh_runtime/prompt_content.js";
import { prepareImageTurnInput } from "./image_inputs.js";
import { buildAttachmentContextMessage, normalizeMessageAttachments } from "./message_blocks.js";
import { loadAllDshHistoryPages } from "../reads/reads_session.js";
import {
  applyDshProjectionBaseline,
  snapshotDshSessionState,
  subscribeDshSessionState,
} from "../../engine/dsh_runtime/session_state.js";

async function ownedBinding(ctx, projectId, appSessionId) {
  const row = await ctx.queryOne(
    `SELECT id FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
      LIMIT 1`,
    [appSessionId, projectId, ctx.userId || ""],
  ).catch(() => null);
  if (!row) throw new ApiError("会话不存在或无权限", 404);
  const binding = await loadDshSessionBinding(ctx, appSessionId);
  if (!binding) throw new ApiError("这个会话还没有绑定 DSH session", 409);
  if (!binding.cwd) throw new ApiError("这个会话缺少 DSH 工作目录，不能安全恢复", 409);
  return binding;
}

function queueEditTextContent(input) {
  const blocks = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type === "text") {
      const text = String(item.text || "");
      if (text) blocks.push({ type: "text", text });
      continue;
    }
    throw new ApiError("DSH RC2 的队列旧消息只支持文字编辑；请删除后重新发送图片消息", 409);
  }
  if (!blocks.length) throw new ApiError("请输入内容", 400);
  return blocks;
}

async function ensureAttached(client, binding, db) {
  try {
    await ensureDshWorkspaceSession(client, {
      sessionId: binding.dshSessionId,
      cwd: binding.cwd,
    });
  } catch (error) {
    if (error?.code === "session-conflict") {
      throw new ApiError("DSH session 的工作目录与当前项目不一致，请新建对话或恢复原项目目录", 409);
    }
    throw error;
  }
  client.registerProductHostSession({
    db,
    userId: binding.userId,
    projectId: binding.projectId,
    appSessionId: binding.appSessionId,
    dshSessionId: binding.dshSessionId,
  });
}

export async function getDshProtocolState(ctx, input) {
  const { pid, threadId } = input.params || {};
  const binding = await ownedBinding(ctx, pid, threadId);
  const client = getDshRuntimeClient();
  await client.start();
  await ensureAttached(client, binding, ctx);
  const history = await client.request("session.history", {
    sessionId: binding.dshSessionId,
    maxMessages: 1,
  });
  if (history?.projections) applyDshProjectionBaseline(binding.dshSessionId, history.projections);
  return {
    data: snapshotDshSessionState(threadId),
    message: "获取 DSH 会话状态成功",
  };
}

/** Return the owning DSH Session's canonical history entries for the review workbench. */
export async function getDshTrajectory(ctx, input, { client = getDshRuntimeClient() } = {}) {
  const { pid, threadId } = input.params || {};
  const binding = await ownedBinding(ctx, pid, threadId);
  await client.start();
  await ensureAttached(client, binding, ctx);
  const history = await loadAllDshHistoryPages(client, binding);
  if (history.projections) applyDshProjectionBaseline(binding.dshSessionId, history.projections);
  const lastSeq = history.entries.reduce((latest, entry) => {
    const seq = Number(entry?.event?.seq);
    return Number.isFinite(seq) ? Math.max(latest, seq) : latest;
  }, -1);
  return {
    data: {
      appSessionId: threadId,
      dshSessionId: binding.dshSessionId,
      source: "session.history",
      lastSeq,
      events: history.entries,
      projections: history.projections || null,
    },
    message: "获取 DSH 轨迹成功",
  };
}

export async function listDshSkills(ctx, input) {
  const { pid, threadId } = input.params || {};
  const binding = await ownedBinding(ctx, pid, threadId);
  const client = getDshRuntimeClient();
  await client.start();
  await ensureAttached(client, binding, ctx);
  const result = await client.request("skill.list", { sessionId: binding.dshSessionId });
  return {
    data: Array.isArray(result?.skills) ? result.skills : [],
    message: "获取 DSH Skill 成功",
  };
}

function permissionSelectFromState(state) {
  const value = state?.projections?.permissions;
  if (!value || typeof value !== "object") return null;
  const currentValue = String(value.currentValue || "").trim();
  const options = (Array.isArray(value.options) ? value.options : []).map((option) => ({
    value: String(option?.value || "").trim(),
    name: String(option?.name || option?.value || "").trim(),
    ...(String(option?.description || "").trim()
      ? { description: String(option.description).trim() }
      : {}),
  })).filter((option) => option.value && option.name);
  return currentValue && options.length ? { currentValue, options } : null;
}

function effectivePlanModeFromState(state) {
  const value = state?.projections?.plan;
  if (!value || typeof value !== "object") return null;
  const active = value.active === true;
  return value.pending === true ? !active : active;
}

const waitForDshProjection = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Switch one session through DSH's logged command registry. */
export async function setDshPermission(ctx, input, { client = getDshRuntimeClient() } = {}) {
  const { pid, threadId } = input.params || {};
  const binding = await ownedBinding(ctx, pid, threadId);
  await client.start();
  await ensureAttached(client, binding, ctx);

  const before = await client.request("session.history", {
    sessionId: binding.dshSessionId,
    maxMessages: 1,
  });
  if (before?.projections) applyDshProjectionBaseline(binding.dshSessionId, before.projections);
  const permission = permissionSelectFromState(snapshotDshSessionState(threadId));
  if (!permission) throw new ApiError("当前 DSH Profile 没有提供权限设置", 409);

  const preset = String(input.body?.preset || "").trim();
  const option = permission.options.find((candidate) => candidate.value === preset);
  if (!option || preset === "custom") throw new ApiError("这个权限预设不在 DSH 当前允许的范围内", 400);

  const execution = await client.requestRemote("commands/execute", {
    agentId: binding.dshSessionId,
    line: `/permission ${preset}`,
  });
  if (!execution) throw new ApiError("当前 DSH Profile 没有提供权限命令", 409);
  if (execution.result?.kind !== "success") {
    throw new ApiError(execution.result?.text || "当前 DSH Profile 没有接受权限设置", 409);
  }

  let confirmed = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const after = await client.request("session.history", {
      sessionId: binding.dshSessionId,
      maxMessages: 1,
    });
    if (after?.projections) applyDshProjectionBaseline(binding.dshSessionId, after.projections);
    const current = permissionSelectFromState(snapshotDshSessionState(threadId));
    if (current?.currentValue === preset) {
      confirmed = true;
      break;
    }
    await waitForDshProjection(50);
  }
  if (!confirmed) throw new ApiError("DSH 已接受权限命令，但会话状态尚未确认更新，请重试", 409);
  return {
    data: snapshotDshSessionState(threadId),
    message: "DSH 会话权限已更新",
  };
}

/** Switch one session through DSH's logged Plan command and confirm its projection. */
export async function setDshPlanMode(ctx, input, { client = getDshRuntimeClient() } = {}) {
  const { pid, threadId } = input.params || {};
  const binding = await ownedBinding(ctx, pid, threadId);
  const mode = input.body?.mode;
  if (mode !== "default" && mode !== "plan") throw new ApiError("Plan 模式不合法", 400);
  await client.start();
  await ensureAttached(client, binding, ctx);

  const refresh = async () => {
    const history = await client.request("session.history", {
      sessionId: binding.dshSessionId,
      maxMessages: 1,
    });
    if (history?.projections) applyDshProjectionBaseline(binding.dshSessionId, history.projections);
    return snapshotDshSessionState(threadId);
  };
  const wanted = mode === "plan";
  const before = await refresh();
  if (effectivePlanModeFromState(before) === null) {
    throw new ApiError("当前 DSH Profile 没有提供 Plan 投影", 409);
  }
  if (effectivePlanModeFromState(before) !== wanted) {
    const result = await client.request("command.execute", {
      sessionId: binding.dshSessionId,
      line: wanted ? "/plan" : "/plan off",
    });
    if (result?.matched !== true) throw new ApiError("当前 DSH Profile 没有接受 Plan 设置", 409);
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const state = await refresh();
    if (effectivePlanModeFromState(state) === wanted) {
      return { data: state, message: "DSH Plan 模式已更新" };
    }
    await waitForDshProjection(50);
  }
  throw new ApiError("DSH 已接受 Plan 命令，但会话状态尚未确认更新，请重试", 409);
}

export async function promptDshQueue(ctx, input, { client = getDshRuntimeClient() } = {}) {
  const { pid, threadId } = input.params || {};
  const binding = await ownedBinding(ctx, pid, threadId);
  const prepared = await prepareImageTurnInput(input.body?.input, input.body?.attachments);
  const attachments = normalizeMessageAttachments(prepared.attachments);
  const text = prepared.input
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text || ""))
    .join("\n");
  const normalizedInput = [
    { type: "text", text: buildAttachmentContextMessage(text, attachments) },
    ...prepared.input.filter((item) => item?.type !== "text"),
  ];
  let content;
  try {
    content = await dshPromptContent(normalizedInput);
  } catch (error) {
    throw new ApiError(error?.message || "DSH 输入无效", 400);
  }
  const mode = input.body?.mode === "steer" ? "steer" : "queue";
  await client.start();
  await ensureAttached(client, binding, ctx);
  let result;
  try {
    result = await client.request("session.prompt", {
      sessionId: binding.dshSessionId,
      mode,
      content,
    });
  } catch (error) {
    if (error?.code === "attachment-error") {
      const normalized = normalizeDshPromptError(error);
      throw new ApiError(normalized.message, 400, normalized.details.reason);
    }
    throw error;
  }
  return { data: { accepted: result?.accepted === true, mode }, message: mode === "steer" ? "已补充到当前任务" : "已加入 DSH 队列" };
}

/** Read one durable DSH image after verifying its owning dsh-work Session. */
export async function readDshAttachment(ctx, input, { client = getDshRuntimeClient() } = {}) {
  const { sid, attachmentId } = input.params || {};
  const row = await ctx.queryOne(
    `SELECT id,project_id FROM sessions
      WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL
      LIMIT 1`,
    [sid, ctx.userId || ""],
  ).catch(() => null);
  if (!row) throw new ApiError("会话不存在或无权限", 404);
  const binding = await loadDshSessionBinding(ctx, sid);
  if (!binding) throw new ApiError("这个会话还没有绑定 DSH session", 409);
  await client.start();
  await ensureAttached(client, binding, ctx);
  let result;
  try {
    result = await client.request("session.attachment", {
      sessionId: binding.dshSessionId,
      attachmentId: String(attachmentId || "").trim(),
    });
  } catch (error) {
    if (error?.code === "attachment-error") throw new ApiError(error.message || "图片附件不可用", 404);
    throw error;
  }
  const mediaType = String(result?.attachment?.mediaType || "").trim();
  if (!mediaType.startsWith("image/") || typeof result?.data !== "string") {
    throw new ApiError("DSH 返回了无效的图片附件", 502);
  }
  return {
    _binary: true,
    data: Buffer.from(result.data, "base64"),
    headers: {
      "content-type": mediaType,
      "cache-control": "private, max-age=31536000, immutable",
      "content-disposition": "inline",
    },
  };
}

export async function updateDshQueueItem(ctx, input) {
  const { pid, threadId, itemId } = input.params || {};
  const binding = await ownedBinding(ctx, pid, threadId);
  const kind = String(input.body?.kind || "").trim();
  let action;
  if (kind === "edit") action = { kind, content: queueEditTextContent(input.body?.input) };
  else if (kind === "remove" || kind === "steer") action = { kind };
  else throw new ApiError("队列操作不合法", 400);
  const client = getDshRuntimeClient();
  await client.start();
  await ensureAttached(client, binding, ctx);
  const result = await client.request("session.updateQueue", {
    sessionId: binding.dshSessionId,
    itemId,
    action,
  });
  return { data: { accepted: result?.accepted === true, item_id: itemId, action: kind }, message: "DSH 队列已更新" };
}

function rpcNotification(method, params = {}) {
  return { jsonrpc: "2.0", method, params };
}

export async function watchDshProtocol(ctx, input, emit) {
  const { pid, threadId } = input.params || {};
  const binding = await ownedBinding(ctx, pid, threadId);
  const client = getDshRuntimeClient();
  await client.start();
  await ensureAttached(client, binding, ctx);
  const adapter = new DshEventAdapter({
    sessionId: binding.dshSessionId,
    emit: (method, params) => emit(rpcNotification(method, params)),
  });
  const sendState = (state) => emit(rpcNotification("dsh/session-state", { state }));
  let eventQueue = Promise.resolve();
  const initial = snapshotDshSessionState(threadId);
  if (initial) sendState(initial);
  const dispose = subscribeDshSessionState(threadId, ({ state, frame }) => {
    sendState(state);
    const payload = frame?.payload;
    if (payload?.type === "session/event") {
      eventQueue = eventQueue
        .then(() => adapter.handle(payload.event, payload.view || null))
        .catch((error) => {
          emit(rpcNotification("dsh/stream-error", { message: error?.message || String(error) }));
        });
    }
  });
  await new Promise((resolve) => {
    if (ctx.signal?.aborted) return resolve();
    ctx.signal?.addEventListener?.("abort", resolve, { once: true });
  });
  dispose();
  await eventQueue;
  return { data: null, message: "DSH 会话状态流已关闭" };
}

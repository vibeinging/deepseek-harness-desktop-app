import { randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import { normalizeCollaborationMode } from "../../engine/agents/collaboration_mode.js";
import {
  activeRunSnapshot,
  steerActiveRun,
  stopActiveRun,
} from "../../engine/agents/active_run_registry.js";
import { agentChat } from "./agent_chat.js";
import { pendingDecisions } from "./agent_misc.js";
import { buildUserContentItems, normalizeMessageAttachments } from "./message_blocks.js";
import { prepareImageTurnInput } from "./image_inputs.js";
import {
  applyWorkspaceEdit,
  getCurrentWorkspaceDiff,
  resolveFileReference,
  revertWorkspaceChange,
} from "../../engine/agents/workspace_change_provider.js";

function userInputText(input = []) {
  return (Array.isArray(input) ? input : [])
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function inputWithAttachments(input = [], attachments = []) {
  const normalizedInput = Array.isArray(input) ? input : [];
  const text = userInputText(input);
  const paths = (Array.isArray(attachments) ? attachments : [])
    .map((item) => String(item?.path || "").trim())
    .filter(Boolean);
  if (!paths.length) return normalizedInput;
  return [{
    type: "text",
    text: [text, "", "本轮附带的本地路径：", ...paths.map((path) => `- ${path}`)].join("\n").trim(),
  }, ...normalizedInput.filter((item) => item?.type !== "text")];
}

function normalizeReviewComments(comments = []) {
  return (Array.isArray(comments) ? comments : []).slice(0, 50).map((item) => ({
    id: String(item?.id || "").trim(),
    path: String(item?.path || "").trim().slice(0, 1000),
    comment: String(item?.comment || "").trim().slice(0, 4000),
    side: item?.side === "old" ? "old" : "new",
    oldLine: item?.oldLine != null && Number.isFinite(Number(item.oldLine)) ? Number(item.oldLine) : null,
    newLine: item?.newLine != null && Number.isFinite(Number(item.newLine)) ? Number(item.newLine) : null,
    lineText: String(item?.lineText || "").slice(0, 1000),
    hunkId: String(item?.hunkId || "").slice(0, 500) || null,
  })).filter((item) => item.path && item.comment);
}

function inputWithReviewComments(input = [], comments = []) {
  const normalizedInput = Array.isArray(input) ? input : [];
  const normalizedComments = normalizeReviewComments(comments);
  if (!normalizedComments.length) return normalizedInput;
  const text = userInputText(normalizedInput);
  const reviewText = normalizedComments.map((item) => {
    const line = item.side === "old" ? item.oldLine : item.newLine;
    const location = line ? `${item.path}:${line}` : item.path;
    const hunk = item.hunkId ? `（hunk ${item.hunkId}）` : "";
    return `- ${location}${hunk}：${item.comment}${item.lineText ? `\n  相关代码：${item.lineText}` : ""}`;
  }).join("\n");
  return [{
    type: "text",
    text: [text, "", "用户在更改审核中提交了以下意见，请逐条处理：", reviewText].join("\n").trim(),
  }, ...normalizedInput.filter((item) => item?.type !== "text")];
}

function hasInput(input = []) {
  return (Array.isArray(input) ? input : []).some((item) => item && typeof item === "object");
}

async function ensureOwnedSession(ctx, sessionId) {
  const owned = await ctx.queryOne(
    "SELECT id, action_type FROM sessions WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL LIMIT 1",
    [sessionId, ctx.userId || ""],
  ).catch(() => null);
  if (!owned) throw new ApiError("无权操作这个会话", 403);
  return owned;
}

async function persistSteeredUserMessage(ctx, sessionId, body = {}) {
  const clientId = String(body.clientUserMessageId || "").trim();
  const messageId = `steer:${sessionId}:${clientId || randomUUID()}`;
  const text = userInputText(body.input);
  const attachments = normalizeMessageAttachments(body.attachments);
  const messageMetadata = {
    client_user_message_id: clientId || null,
    source: "turn_steer",
    steer_status: "reserved",
  };
  const seqRow = await ctx.queryOne(
    "SELECT COALESCE(MAX(sequence_number),0) AS m FROM session_messages WHERE session_id=$1",
    [sessionId],
  ).catch(() => ({ m: 0 }));
  const inserted = await ctx.query(
    `INSERT INTO session_messages
       (id,session_id,role,content_items,message_metadata,sequence_number,created_at,updated_at)
     VALUES ($1,$2,'user',$3,$4,$5,now(),now())
     ON CONFLICT(id) DO NOTHING
     RETURNING id`,
    [
      messageId,
      sessionId,
      JSON.stringify(buildUserContentItems(text, attachments)),
      JSON.stringify(messageMetadata),
      Number(seqRow?.m || 0) + 1,
    ],
  );
  if (Array.isArray(inserted) && inserted.length > 0) {
    await ctx.query(
      "UPDATE sessions SET updated_at=now(), message_count=COALESCE(message_count,0)+1 WHERE id=$1",
      [sessionId],
    );
    return { messageId, created: true, accepted: false, metadata: messageMetadata };
  }
  const existing = await ctx.queryOne(
    "SELECT id,message_metadata FROM session_messages WHERE id=$1 AND session_id=$2 AND deleted_at IS NULL LIMIT 1",
    [messageId, sessionId],
  ).catch(() => null);
  if (!existing) return null;
  let existingMetadata = {};
  try {
    existingMetadata = typeof existing.message_metadata === "string"
      ? JSON.parse(existing.message_metadata)
      : existing.message_metadata || {};
  } catch {
    existingMetadata = {};
  }
  return {
    messageId,
    created: false,
    accepted: existingMetadata.steer_status === "accepted",
    metadata: existingMetadata,
  };
}

async function acceptSteeredUserMessage(ctx, sessionId, reservation) {
  if (!reservation?.messageId) return false;
  const metadata = {
    ...(reservation.metadata || {}),
    source: "turn_steer",
    steer_status: "accepted",
  };
  await ctx.query(
    `UPDATE session_messages
        SET message_metadata=$1,updated_at=now()
      WHERE id=$2 AND session_id=$3 AND role='user' AND deleted_at IS NULL`,
    [JSON.stringify(metadata), reservation.messageId, sessionId],
  );
  return true;
}

async function rollbackSteeredUserMessage(ctx, sessionId, reservation) {
  if (!reservation?.created || !reservation.messageId) return false;
  const removed = await ctx.query(
    `DELETE FROM session_messages
      WHERE id=$1 AND session_id=$2 AND role='user'
      RETURNING id`,
    [reservation.messageId, sessionId],
  );
  if (!Array.isArray(removed) || removed.length === 0) return false;
  await ctx.query(
    "UPDATE sessions SET updated_at=now(),message_count=MAX(0,COALESCE(message_count,0)-1) WHERE id=$1",
    [sessionId],
  );
  return true;
}

async function moveActiveAssistantAfterSteer(ctx, sessionId, agentRunId) {
  const runId = String(agentRunId || "").trim();
  if (!runId) return false;
  const moved = await ctx.query(
    `UPDATE session_messages
        SET sequence_number=(
              SELECT COALESCE(MAX(sequence_number),0)+1
                FROM session_messages
               WHERE session_id=$1 AND deleted_at IS NULL
            ),updated_at=now()
      WHERE id=$2 AND session_id=$1 AND role='assistant' AND deleted_at IS NULL
        AND sequence_number < (
              SELECT COALESCE(MAX(sequence_number),0)
                FROM session_messages
               WHERE session_id=$1 AND deleted_at IS NULL
            )
      RETURNING id`,
    [sessionId, `assistant:${runId}`],
  );
  return Array.isArray(moved) && moved.length > 0;
}

function rpcNotification(event = {}) {
  if (!event?.type) return event;
  return {
    jsonrpc: "2.0",
    method: event.type,
    params: {
      ...(event.payload || {}),
      threadId: event.thread_id || null,
      turnId: event.turn_id || null,
      itemId: event.item_id || event.payload?.itemId || event.payload?.item?.id || null,
      _meta: {
        seq: Number(event.seq || 0),
        ts: event.ts || new Date().toISOString(),
      },
    },
  };
}

export function emitAgentRpc(emit) {
  return (event) => emit(rpcNotification(event));
}

// Thin HTTP/SSE entrypoint. The main loop lives in Agent Runtime; this layer
// only validates the user input shape and supplies Dsh project context.
export async function startAgentTurn(ctx, input, emit) {
  const { pid, threadId } = input.params || {};
  const body = input.body || {};
  const turnInput = inputWithReviewComments(body.input, body.reviewComments);
  const message = userInputText(turnInput);
  if (!message && !hasInput(turnInput) && !(Array.isArray(body.attachments) && body.attachments.length)) {
    throw new ApiError("请输入内容", 400);
  }
  return agentChat(
    ctx,
    {
      ...input,
      params: { pid, sid: threadId },
      body: {
        ...body,
        input: turnInput,
        message: message || "请处理附件。",
        question: message || "请处理附件。",
        content: message || "请处理附件。",
        display_message: typeof body.displayMessage === "string" ? body.displayMessage : message,
        // DSH's logged permission preset owns approval behavior. The App no
        // longer translates its retired ask/auto/full preference per turn.
        approval: "ask",
        settings: {
          ...(body.model ? { modelId: body.model } : {}),
          ...(body.effort ? { reasoningEffort: body.effort } : {}),
          ...(body.summary ? { reasoningSummary: body.summary } : {}),
          ...(body.verbosity ? { verbosity: body.verbosity } : {}),
          collaborationMode: normalizeCollaborationMode(body.collaborationMode),
          ...(["auto", "required", "off"].includes(body.searchMode) ? { searchMode: body.searchMode } : {}),
        },
      },
    },
    emitAgentRpc(emit),
  );
}

/**
 * Start a codex-native code review as a special turn.
 * The review runs inline on the current thread via `review/start` with
 * `target: { type: "uncommittedChanges" }` (or `baseBranch` if given).
 * Output streams through the same notification protocol as a normal turn.
 */
export async function startAgentReview(ctx, input, emit) {
  const { pid, threadId } = input.params || {};
  const body = input.body || {};
  const baseBranch = String(body.baseBranch || "").trim();
  const reviewTarget = baseBranch
    ? { type: "baseBranch", branch: baseBranch }
    : { type: "uncommittedChanges" };
  return agentChat(
    ctx,
    {
      ...input,
      params: { pid, sid: threadId },
      body: {
        ...body,
        input: [],
        message: "审查当前工作区改动",
        question: "审查当前工作区改动",
        content: "审查当前工作区改动",
        display_message: "审查当前工作区改动",
        approval: "auto",
        review_target: reviewTarget,
        settings: {
          ...(body.model ? { modelId: body.model } : {}),
          ...(body.effort ? { reasoningEffort: body.effort } : {}),
          ...(body.summary ? { reasoningSummary: body.summary } : {}),
          ...(body.verbosity ? { verbosity: body.verbosity } : {}),
          collaborationMode: "off",
          searchMode: "off",
        },
      },
    },
    emitAgentRpc(emit),
  );
}

export async function steerAgentTurn(ctx, input) {
  const { threadId, turnId } = input.params || {};
  const active = activeRunSnapshot(turnId);
  if (!active || active.session_id !== threadId) throw new ApiError("当前任务已经结束，无法继续输入", 409);
  const owned = await ensureOwnedSession(ctx, threadId);
  const body = input.body || {};
  const preparedImages = await prepareImageTurnInput(body.input, body.attachments);
  const preparedBody = {
    ...body,
    input: preparedImages.input,
    attachments: preparedImages.attachments,
  };
  const turnInput = inputWithReviewComments(
    inputWithAttachments(preparedBody.input, preparedBody.attachments),
    preparedBody.reviewComments,
  );
  if (!userInputText(turnInput) && !hasInput(turnInput)) throw new ApiError("请输入补充内容", 400);
  const temporary = owned.action_type === "temporary_chat";
  let reservation = null;
  if (!temporary) {
    try {
      reservation = await persistSteeredUserMessage(ctx, threadId, preparedBody);
      if (!reservation) throw new Error("补充消息没有写入会话记录");
    } catch (error) {
      console.error("[agent turn steer persist]", error?.message || error);
      throw new ApiError("补充内容保存失败，未发送给当前任务", 500);
    }
  }
  if (reservation?.accepted) {
    await moveActiveAssistantAfterSteer(ctx, threadId, active.agent_run_id).catch(() => false);
    return {
      data: { turnId, accepted: true, persisted: true, temporary: false, idempotent: true },
      message: "补充内容已经发送",
    };
  }
  let result;
  try {
    result = await steerActiveRun(turnId, {
      input: turnInput,
      clientUserMessageId: preparedBody.clientUserMessageId || null,
    });
    if (!result.accepted) throw new ApiError("当前任务不能接收补充内容", 409);
  } catch (error) {
    if (reservation?.created) {
      await rollbackSteeredUserMessage(ctx, threadId, reservation).catch((rollbackError) => {
        console.error("[agent turn steer rollback]", rollbackError?.message || rollbackError);
      });
    }
    throw error;
  }
  let persisted = temporary;
  if (!temporary) {
    try {
      persisted = await acceptSteeredUserMessage(ctx, threadId, reservation);
    } catch (error) {
      // The content row already exists. Keep the accepted turn visible even if
      // the auxiliary idempotency marker cannot be updated.
      persisted = Boolean(reservation);
      console.error("[agent turn steer accept persist]", error?.message || error);
    }
    await moveActiveAssistantAfterSteer(ctx, threadId, active.agent_run_id).catch((error) => {
      console.error("[agent turn steer reorder]", error?.message || error);
    });
  }
  return {
    data: { turnId, accepted: true, persisted: temporary ? false : persisted, temporary, idempotent: false },
    message: temporary
      ? "已补充到临时任务"
      : persisted ? "已补充到当前任务" : "已补充到当前任务，但会话记录保存失败",
  };
}

export async function interruptAgentTurn(ctx, input) {
  const { threadId, turnId } = input.params || {};
  const active = activeRunSnapshot(turnId);
  if (!active || active.session_id !== threadId) return { data: { turnId, interrupted: false }, message: "任务已结束" };
  await ensureOwnedSession(ctx, threadId);
  const result = await stopActiveRun(turnId, "user_stop", { waitForSettlementMs: 10_000 });
  return {
    data: {
      turnId,
      interrupted: result.stopped,
      settled: result.settled === true,
      settlement: result.settlement || null,
    },
    message: result.stopped
      ? result.settled ? "已停止" : "已请求停止，任务仍在收尾"
      : "任务已结束",
  };
}

function canonicalApprovalDecision(value) {
  if (Array.isArray(value)) return value.map(canonicalApprovalDecision);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalApprovalDecision(value[key])]));
}

function normalizeApprovalDecision(value) {
  if (value === true) return "accept";
  if (["accept", "acceptForSession", "acceptAlways", "decline", "cancel"].includes(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "decline";
  const keys = Object.keys(value);
  if (keys.length !== 1) return "decline";
  if (keys[0] === "acceptWithExecpolicyAmendment" && value.acceptWithExecpolicyAmendment?.execpolicy_amendment) {
    return structuredClone(value);
  }
  if (keys[0] === "applyNetworkPolicyAmendment" && value.applyNetworkPolicyAmendment?.network_policy_amendment) {
    return structuredClone(value);
  }
  return "decline";
}

function approvalAccepted(decision) {
  return ["accept", "acceptForSession", "acceptAlways"].includes(decision)
    || Boolean(decision?.acceptWithExecpolicyAmendment)
    || decision?.applyNetworkPolicyAmendment?.network_policy_amendment?.action === "allow";
}

export async function resolveAgentApproval(ctx, input) {
  const { threadId, turnId, itemId } = input.params || {};
  const entry = pendingDecisions.get(itemId);
  if (!entry || typeof entry === "function" || entry.kind === "user_input") throw new ApiError("批准请求已失效", 409);
  if ((entry.threadId && entry.threadId !== threadId) || (entry.turnId && entry.turnId !== turnId)) {
    throw new ApiError("批准请求与当前任务不匹配", 409);
  }
  const owned = await ctx.queryOne(
    "SELECT id FROM sessions WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL LIMIT 1",
    [entry.sessionId, ctx.userId || ""],
  ).catch(() => null);
  if (!owned) throw new ApiError("无权处理这个批准请求", 403);
  const normalizedDecision = normalizeApprovalDecision(input.body?.decision);
  if (Array.isArray(entry.availableDecisions)) {
    const expected = JSON.stringify(canonicalApprovalDecision(normalizedDecision));
    const allowed = entry.availableDecisions.some((decision) => (
      JSON.stringify(canonicalApprovalDecision(decision)) === expected
    ));
    if (!allowed) throw new ApiError("这个批准选项不在底座允许的范围内", 400);
  }
  const approved = approvalAccepted(normalizedDecision);
  pendingDecisions.delete(itemId);
  entry.resolve?.(entry.returnsDecision ? normalizedDecision : approved);
  return { data: { threadId, turnId, itemId, decision: normalizedDecision }, message: "ok" };
}

export async function resolveAgentUserInput(ctx, input) {
  const { threadId, turnId, itemId } = input.params || {};
  const entry = pendingDecisions.get(itemId);
  if (!entry || typeof entry === "function" || entry.kind !== "user_input") {
    throw new ApiError("问题已经失效", 409);
  }
  if ((entry.threadId && entry.threadId !== threadId) || (entry.turnId && entry.turnId !== turnId)) {
    throw new ApiError("问题与当前任务不匹配", 409);
  }
  const owned = await ctx.queryOne(
    "SELECT id FROM sessions WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL LIMIT 1",
    [entry.sessionId, ctx.userId || ""],
  ).catch(() => null);
  if (!owned) throw new ApiError("无权回答这个问题", 403);
  const rawAnswers = input.body?.answers;
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    throw new ApiError("请填写答案", 400);
  }
  const answers = Object.fromEntries(Object.entries(rawAnswers).map(([questionId, answer]) => {
    const values = Array.isArray(answer?.answers)
      ? answer.answers
      : Array.isArray(answer)
        ? answer
        : [answer];
    return [questionId, { answers: values.map((value) => String(value || "").trim()).filter(Boolean) }];
  }).filter(([, answer]) => answer.answers.length));
  if (!Object.keys(answers).length) throw new ApiError("请填写答案", 400);
  pendingDecisions.delete(itemId);
  entry.resolve?.({ answers });
  return { data: { threadId, turnId, itemId, answers }, message: "ok" };
}

export default {
  startAgentTurn,
  startAgentReview,
  steerAgentTurn,
  interruptAgentTurn,
  resolveAgentApproval,
  resolveAgentUserInput,
  revertWorkspaceChange,
  applyWorkspaceEdit,
  resolveFileReference,
  getCurrentWorkspaceDiff,
};

export { applyWorkspaceEdit, getCurrentWorkspaceDiff, resolveFileReference, revertWorkspaceChange };

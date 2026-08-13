import { ApiError } from "../../errors.js";
import {
  buildUserInputContinuationMessage,
  resolvePendingApproval,
  resolvePendingUserInput,
} from "../../engine/agents/agent_run_runtime.js";
import { agentChat } from "../chat/agent_chat.js";
import { syncAgentAutomationRun } from "../agents/automation_executor.js";

async function syncAutomationAfterResume(ctx, runId) {
  if (!runId) return;
  await syncAgentAutomationRun(ctx, runId).catch((error) => {
    console.warn("[automation] 恢复后同步收件箱失败:", error?.message || error);
  });
}

function automationFromCheckpoint(checkpoint = {}) {
  return checkpoint.automation && typeof checkpoint.automation === "object"
    ? checkpoint.automation
    : null;
}

function continuationBody(body, { message, displayMessage, skill }) {
  const { settings: _ignoredSettings, ...safeBody } = body || {};
  return {
    ...safeBody,
    message,
    question: message,
    content: message,
    display_message: displayMessage,
    skill: skill || undefined,
  };
}

export async function requireOwnedDurablePendingAction(ctx, {
  projectId,
  sessionId,
  requestId,
  runId,
  inputType,
} = {}) {
  const userId = String(ctx?.userId || "").trim();
  const scope = {
    projectId: String(projectId || "").trim(),
    sessionId: String(sessionId || "").trim(),
    requestId: String(requestId || "").trim(),
    runId: String(runId || "").trim(),
    inputType: inputType === "approval" ? "approval" : "user_input",
  };
  if (!(userId && scope.projectId && scope.sessionId && scope.requestId && scope.runId)) {
    throw new ApiError("待处理请求已经失效", 409);
  }

  const session = await ctx.queryOne(
    `SELECT id FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
      LIMIT 1`,
    [scope.sessionId, scope.projectId, userId],
  );
  if (!session) throw new ApiError("会话不存在或无权限", 404);

  const pending = await ctx.queryOne(
    `SELECT pending.id, pending.run_id, pending.session_id, pending.project_id,
            pending.user_id, pending.request_id, pending.input_type, pending.status
       FROM agent_pending_inputs pending
       JOIN agent_runs run ON run.id=pending.run_id
      WHERE pending.request_id=$1
        AND pending.session_id=$2
        AND pending.run_id=$3
        AND pending.project_id=$4
        AND pending.user_id=$5
        AND pending.input_type=$6
        AND pending.deleted_at IS NULL
        AND run.session_id=$2
        AND run.project_id=$4
        AND run.user_id=$5
        AND run.deleted_at IS NULL
      ORDER BY pending.created_at DESC
      LIMIT 1`,
    [
      scope.requestId,
      scope.sessionId,
      scope.runId,
      scope.projectId,
      userId,
      scope.inputType,
    ],
  );
  if (!pending) throw new ApiError("待处理请求已经失效", 409);
  return pending;
}

// Durable background actions resume through the same Agent controller. The
// desktop interactive path uses native in-turn approvals and request_user_input.
export async function resolveAgentPendingAction(ctx, input, emit) {
  const { pid, sid, requestId: routeRequestId } = input.params || {};
  const body = input.body || {};
  const value = String(body.value ?? body.message ?? body.content ?? "").trim();
  const resumeHandle = body.resume_handle && typeof body.resume_handle === "object" ? body.resume_handle : null;
  const runId = String(body.run_id || resumeHandle?.run_id || "").trim();
  const requestId = String(routeRequestId || body.request_id || resumeHandle?.request_id || "").trim();
  const actionType = String(body.action_type || resumeHandle?.type || "").trim();
  if (!requestId || !runId) throw new ApiError("待处理请求已经失效", 409);

  const inputType = actionType === "approval" || actionType === "approval_resume"
    ? "approval"
    : "user_input";
  await requireOwnedDurablePendingAction(ctx, {
    projectId: pid,
    sessionId: sid,
    requestId,
    runId,
    inputType,
  });

  if (inputType === "approval") {
    const approved = body.approved === true || value === "approved";
    const resolved = await resolvePendingApproval(
      { query: ctx.query, queryOne: ctx.queryOne },
      { sessionId: sid, requestId, runId, approved, userId: ctx.userId || "" },
    );
    if (resolved?.status !== "answered" || !resolved?.recorded) {
      throw new ApiError(resolved?.status === "expired" ? "这个审批已过期" : "这个审批已经失效", 409);
    }
    const checkpoint = resolved.checkpoint || {};
    const payload = resolved.payload || {};
    const original = checkpoint.original_user_message || checkpoint.enhanced_user_query || "原任务";
    const toolName = String(payload.tool_name || checkpoint.tool_name || "操作");
    const message = approved
      ? `用户已批准 ${toolName}。请继续原任务：${original}`
      : `用户拒绝了 ${toolName}。不要执行该操作；请说明影响并基于现有信息继续原任务：${original}`;
    const result = await agentChat(
      ctx,
      {
        ...input,
        params: { pid, sid },
        resumeRunId: resolved.run_id || runId,
        approvalGrant: approved ? {
          approved: true,
          request_id: requestId,
          tool_name: toolName,
          args_fingerprint: payload.args_fingerprint || checkpoint.args_fingerprint || "",
          consumed: false,
        } : null,
        automationContext: automationFromCheckpoint(checkpoint),
        body: continuationBody(body, {
          message,
          displayMessage: approved ? "已批准" : "已拒绝",
          skill: checkpoint.skill,
        }),
      },
      emit,
    );
    await syncAutomationAfterResume(ctx, resolved.run_id || runId);
    return result;
  }

  const resolved = await resolvePendingUserInput(
    { query: ctx.query, queryOne: ctx.queryOne },
    { sessionId: sid, requestId, runId, value, userId: ctx.userId || "" },
  );
  if (resolved?.status !== "answered" || !resolved?.recorded) {
    throw new ApiError(resolved?.status === "expired" ? "这个问题已过期" : "这个问题已经失效", 409);
  }
  const checkpoint = resolved.checkpoint || {};
  const payload = resolved.payload || {};
  const original = checkpoint.original_user_message || checkpoint.enhanced_user_query || "";
  const message = buildUserInputContinuationMessage({
    originalMessage: original,
    selectedValue: value,
    askPrompt: payload.prompt || checkpoint.params?.prompt || "",
    mode: "handle",
  });
  const result = await agentChat(
    ctx,
    {
      ...input,
      params: { pid, sid },
      resumeRunId: resolved.run_id || runId,
      automationContext: automationFromCheckpoint(checkpoint),
      body: continuationBody(body, {
        message,
        displayMessage: value,
        skill: checkpoint.skill,
      }),
    },
    emit,
  );
  await syncAutomationAfterResume(ctx, resolved.run_id || runId);
  return result;
}

export default { resolveAgentPendingAction };

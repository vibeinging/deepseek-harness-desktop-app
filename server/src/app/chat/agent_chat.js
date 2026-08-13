import { randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import { WorkspaceAgent } from "../../engine/agents/workspace_agent.js";
import { normalizeApprovalMode } from "../../engine/agents/approval_mode.js";
import { normalizeCollaborationMode } from "../../engine/agents/collaboration_mode.js";
import { createAgentRuntime } from "../../engine/agents/agent_run_runtime.js";
import { claimActiveSession, registerActiveRun } from "../../engine/agents/active_run_registry.js";
import {
  buildFileReferenceAnnotations,
  workspaceRoot,
} from "../../engine/agents/message_annotations.js";
import { AgentStreamAdapter } from "../../engine/agent_kernel/stream_adapter.js";
import { nativeCollaborationRunEvent } from "../../engine/agent_kernel/native_collaboration.js";
import { AgentContext } from "../../engine/core/agent_context.js";
import { completeTurnCapabilities } from "../../engine/core/turn_completion.js";
import {
  answerMetadata,
  finalizeTerminalContentItems,
  finalizeTurnAnswer,
  finalizeTurnStatus,
  hasSubstantiveAnswerText,
  invalidateNonSubstantiveNarrativeItems,
  resolveTurnAnswerCandidate,
} from "../../engine/core/turn_finalizer.js";
import { createAgentStreamEmitter } from "../../engine/stream/agent_stream_emitter.js";
import { autoCreateCanvasFromTurn } from "../../engine/agents/canvas_store.js";
import { beginWorkspaceTurnSnapshot } from "../../engine/agents/workspace_turn_snapshot.js";
import { runWithTraceContext, traceAgentCall } from "../../engine/trace/trace_context.js";
import { createTraceRecorder } from "../traces/yitrace_service.js";
import {
  attachPendingDecisionPublicInteraction,
  createLivePendingInteraction,
  pendingDecisions,
  persistAgentTurnBeforeRunTerminal,
  redactUserInputAnswers,
} from "./agent_misc.js";
import {
  buildAttachmentContextMessage,
  buildUserContentItems,
  normalizeMessageAttachments,
} from "./message_blocks.js";
import { prepareImageTurnInput } from "./image_inputs.js";
import { requireProjectMember } from "../projects/access.js";
import { decodeDshModelRoute } from "../../engine/dsh_runtime/model_route.js";

function clean(value) {
  return String(value || "").trim();
}

const FINAL_ANSWER_METADATA_MAX_KEYS = 32;
const FINAL_ANSWER_METADATA_MAX_BYTES = 16 * 1024;
const PROTECTED_FINAL_ANSWER_METADATA_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "content_id",
  "content_type",
  "title",
  "replace_snapshot",
  "display",
  "phase",
  "msg_category",
  "result_role",
  "resultRole",
  "candidate_status",
  "answer_status",
  "answer_source",
  "answer_rejection_code",
  "answer_rejection_message",
]);

function normalizeDeclaredFinalAnswerMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    return {};
  }
  if (!serialized || Buffer.byteLength(serialized, "utf8") > FINAL_ANSWER_METADATA_MAX_BYTES) return {};
  let parsed = null;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const metadata = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (Object.keys(metadata).length >= FINAL_ANSWER_METADATA_MAX_KEYS) break;
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(key)) continue;
    if (PROTECTED_FINAL_ANSWER_METADATA_KEYS.has(key)) continue;
    Object.defineProperty(metadata, key, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return metadata;
}

/**
 * Capabilities may explicitly publish bounded metadata for an accepted final
 * answer through verdict.details.final_answer_metadata. The chat layer does
 * not inspect capability IDs or copy arbitrary domain details.
 */
export function finalAnswerMetadataFromCapabilityVerdicts(completion = {}) {
  const metadata = {};
  for (const verdict of Array.isArray(completion?.verdicts) ? completion.verdicts : []) {
    if (verdict?.status !== "passed") continue;
    const declared = normalizeDeclaredFinalAnswerMetadata(verdict?.details?.final_answer_metadata);
    for (const [key, value] of Object.entries(declared)) {
      // Policy order is stable. The first declaration owns a key so a later
      // capability cannot silently replace metadata already attached by one
      // with higher priority.
      if (Object.hasOwn(metadata, key)) continue;
      Object.defineProperty(metadata, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return metadata;
}

function agentTraceInput(agentContext = {}) {
  const input = agentContext?.input_data || {};
  return {
    user_message: input.user_message || "",
    enhanced_user_query: input.enhanced_user_query || "",
    project_id: agentContext?.project_id || input.project_id || "",
    session_id: agentContext?.session_id || input.session_id || "",
    business_id: input.business_id || "",
  };
}

function rpcNotification(event = {}) {
  const method = String(event.type || "");
  return {
    jsonrpc: "2.0",
    method: method.startsWith("dsh/") ? method : `dsh/${method}`,
    params: {
      ...(event.payload || {}),
      threadId: event.thread_id || null,
      turnId: event.turn_id || null,
      itemId: event.item_id || event.payload?.itemId || event.payload?.item?.id || null,
      _meta: {
        seq: Number(event.seq || 0),
        ts: event.ts || new Date().toISOString(),
        source: "dsh-extension",
      },
    },
  };
}

function runtimeRpc(method, params = {}, fallback = {}) {
  const threadId = params.threadId || params.thread?.id || fallback.threadId || null;
  const turnId = params.turnId || params.turn?.id || fallback.turnId || null;
  const itemId = params.itemId || params.item?.id || null;
  return {
    jsonrpc: "2.0",
    method,
    params: {
      ...params,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
      _meta: {
        ...(params._meta && typeof params._meta === "object" ? params._meta : {}),
        source: "app-server",
      },
    },
  };
}

function runtimeEvent(method, params = {}, fallback = {}) {
  const threadId = params.threadId || params.thread?.id || fallback.threadId || null;
  const turnId = params.turnId || params.turn?.id || fallback.turnId || null;
  const itemId = params.itemId || params.item?.id || null;
  return {
    type: method,
    thread_id: threadId,
    turn_id: turnId,
    item_id: itemId,
    payload: params,
  };
}

function nativeNotificationItemId(params = {}) {
  return clean(params.itemId || params.item?.id);
}

export function shouldDeferNativeTerminalNotification(
  agentContext,
  method,
) {
  // New turns defer only the native terminal event. Runtime item events remain
  // observable while the model is working; Turn Finalizer publishes the one
  // authoritative terminal after capability policies settle.
  return agentContext?.deferNativeTerminal === true && method === "turn/completed";
}

function normalizeTurnInput(input, message, attachments) {
  const media = (Array.isArray(input) ? input : []).filter((item) => item && item.type !== "text");
  return [
    { type: "text", text: buildAttachmentContextMessage(message, attachments) },
    ...media,
  ];
}

export function validateWebCitationMarkers(items, sources, { answerItemId = "" } = {}) {
  const available = new Set((sources || []).map((source) => String(source?.source_id || "")).filter(Boolean));
  const answerItems = (items || []).filter((item) => ["text", "markdown", "agentMessage"].includes(item?.type));
  const terminalId = clean(answerItemId);
  const finalItems = terminalId
    ? answerItems.filter((item) => String(item?.id || "") === terminalId)
    : [];
  const answerText = finalItems
    .map((item) => String(item?.content || item?.text || ""))
    .join("\n");
  const matches = [...answerText.matchAll(/【(S\d+)】/g)];
  const cited = matches.map((match) => match[1]);
  const invalid = [...new Set(cited.filter((id) => !available.has(id)))];
  const unbound = [...new Set(matches.flatMap((match) => {
    const id = match[1];
    if (!available.has(id)) return [];
    const index = Number(match.index || 0);
    const lineStart = answerText.lastIndexOf("\n", index - 1) + 1;
    const lineEndAt = answerText.indexOf("\n", index);
    const lineEnd = lineEndAt < 0 ? answerText.length : lineEndAt;
    const boundText = answerText.slice(lineStart, lineEnd).replace(/【S\d+】/g, "");
    return /[\p{L}\p{N}]/u.test(boundText) ? [] : [id];
  }))];
  const valid = [...new Set(cited.filter((id) => available.has(id) && !unbound.includes(id)))];
  return {
    valid,
    invalid,
    unbound,
    uncited: [...available].filter((id) => !valid.includes(id)),
  };
}

export function webCitationPolicyFailure(searchMode, sources, validation, activity = {}) {
  if (searchMode !== "required") return "";
  if (Number(activity?.search_count || 0) < 1) return "本轮没有执行网页搜索";
  if (!Array.isArray(sources) || sources.length === 0) return "本轮没有打开并核对任何网页";
  if (validation?.invalid?.length) return `回答使用了未核对的来源编号：${validation.invalid.join("、")}`;
  if (validation?.unbound?.length) return `来源编号没有绑定回答文字：${validation.unbound.join("、")}`;
  if (!validation?.valid?.length) return "回答没有引用任何已打开并核对的网页";
  return "";
}

function upsertItem(items, item) {
  if (!item?.id) return;
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index >= 0) items[index] = { ...items[index], ...item };
  else items.push(item);
}

export { finalizeTerminalContentItems };

async function validateTurnScope(ctx, { projectId, sessionId, modelId }) {
  await requireProjectMember(ctx, projectId, { allowChat: true });
  const session = await ctx.queryOne(
    `SELECT id, action_type, session_config FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
      LIMIT 1`,
    [sessionId, projectId, ctx.userId || ""],
  ).catch(() => null);
  if (!session) throw new ApiError("会话不存在或无权限", 404);
  let sessionConfig = {};
  try {
    sessionConfig = typeof session.session_config === "string"
      ? JSON.parse(session.session_config)
      : (session.session_config || {});
  } catch {
    sessionConfig = {};
  }
  const temporary = session.action_type === "temporary_chat" || sessionConfig.temporary === true;
  const explicitModelId = String(modelId || "").trim();
  let model = null;
  if (explicitModelId) {
    try {
      model = { id: explicitModelId, ...decodeDshModelRoute(explicitModelId) };
    } catch (error) {
      throw new ApiError(
        error?.message || "所选 DSH 模型不可用，请重新选择",
        400,
        error?.code || 400,
      );
    }
  }
  return {
    temporary,
    sessionConfig,
    model,
  };
}

export async function persistInitialUserMessage(ctx, {
  sessionId,
  userMessageId,
  displayMessage,
  attachments,
  userMetadata,
}) {
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
      userMessageId,
      sessionId,
      JSON.stringify(buildUserContentItems(displayMessage, attachments)),
      JSON.stringify(userMetadata || {}),
      Number(seqRow?.m || 0) + 1,
    ],
  );
  const created = Array.isArray(inserted) && inserted.length > 0;
  if (created) {
    await ctx.query(
      "UPDATE sessions SET updated_at=now(), message_count=COALESCE(message_count,0)+1 WHERE id=$1",
      [sessionId],
    );
  }
  return { ok: true, created };
}

export async function persistAssistantSnapshot(ctx, {
  sessionId,
  assistantMessageId,
  items,
  metadata,
}) {
  try {
    const seqRow = await ctx.queryOne(
      "SELECT COALESCE(MAX(sequence_number),0) AS m FROM session_messages WHERE session_id=$1",
      [sessionId],
    ).catch(() => ({ m: 0 }));
    const inserted = await ctx.query(
      `INSERT INTO session_messages
         (id,session_id,role,content_items,message_metadata,sequence_number,created_at,updated_at)
       VALUES ($1,$2,'assistant',$3,$4,$5,now(),now())
       ON CONFLICT(id) DO NOTHING
       RETURNING id`,
      [assistantMessageId, sessionId, JSON.stringify(items || []), JSON.stringify(metadata || {}), Number(seqRow?.m || 0) + 1],
    );
    const created = Array.isArray(inserted) && inserted.length > 0;
    if (created) {
      await ctx.query(
        "UPDATE sessions SET updated_at=now(), message_count=COALESCE(message_count,0)+1 WHERE id=$1",
        [sessionId],
      );
    } else {
      await ctx.query(
        `UPDATE session_messages
            SET content_items=$1, message_metadata=$2, updated_at=now()
          WHERE id=$3 AND session_id=$4 AND role='assistant' AND deleted_at IS NULL`,
        [JSON.stringify(items || []), JSON.stringify(metadata || {}), assistantMessageId, sessionId],
      );
    }
    return { ok: true, created };
  } catch (error) {
    console.error("[agent_chat assistant snapshot persist]", error?.message || error);
    return { ok: false, error };
  }
}

async function persistTurn(ctx, {
  sessionId,
  userMessageId,
  userMetadata,
  assistantMessageId,
  items,
  metadata,
}) {
  try {
    await ctx.query(
      `UPDATE session_messages
          SET message_metadata=$1, updated_at=now()
        WHERE id=$2 AND session_id=$3 AND role='user' AND deleted_at IS NULL`,
      [JSON.stringify(userMetadata || {}), userMessageId, sessionId],
    );
    return persistAssistantSnapshot(ctx, {
      sessionId,
      assistantMessageId,
      items,
      metadata,
    });
  } catch (error) {
    console.error("[agent_chat persist]", error?.message || error);
    return { ok: false, error };
  }
}

/** Current Chat main path: one DSH Profile Session owns the full turn loop. */
async function agentChatUnlocked(ctx, input, emit) {
  if (ctx.signal?.aborted) return;
  const { pid: projectId, sid: sessionId } = input.params || {};
  const body = input.body || {};
  const message = String(body.message || body.question || body.content || "").trim();
  const preparedImages = await prepareImageTurnInput(body.input, body.attachments);
  const attachments = normalizeMessageAttachments(preparedImages.attachments);
  const turnInput = preparedImages.input;
  const hasRichInput = turnInput.some((item) => item && item.type !== "text");
  if (!message && !attachments.length && !hasRichInput) throw new ApiError("请输入内容", 400);

  const settings = body.settings && typeof body.settings === "object" ? { ...body.settings } : {};
  settings.collaborationMode = normalizeCollaborationMode(
    body.collaborationMode ?? settings.collaborationMode,
  );
  const turnScope = await validateTurnScope(ctx, {
    projectId,
    sessionId,
    modelId: String(settings.modelId || "").trim(),
  });
  const selectedModel = turnScope.model;
  const temporary = turnScope.temporary === true;
  if (selectedModel?.id) settings.modelId = selectedModel.id;

  const turnSkillNames = [...new Set([
    ...(Array.isArray(body.skills) ? body.skills : []),
    body.skill,
  ].map((skill) => String(skill || "").trim()).filter(Boolean))];
  const selectedSkills = turnSkillNames;

  const resumeRunId = String(input.resumeRunId || body.resume_run_id || "").trim();
  const runId = resumeRunId || String(input.agentRunId || "").trim() || randomUUID();
  const automationContext = input.automationContext && typeof input.automationContext === "object"
    ? input.automationContext
    : null;
  const runMode = automationContext ? "automation" : temporary ? "temporary" : "agent";
  const assistantMessageId = `assistant:${runId}`;
  const displayMessage = typeof body.display_message === "string" ? body.display_message : message;
  const selectedSkill = selectedSkills[0] || "";
  const userMessageId = `user:${runId}`;
  const userMetadata = {
    client_user_message_id: clean(body.clientUserMessageId),
    dsh_prompt_rpc_id: userMessageId,
    runtime_thread_id: null,
    turn_id: runId,
    turn_input: turnInput,
    turn_request: {
      model: clean(settings.modelId) || null,
      effort: clean(settings.reasoningEffort) || null,
      summary: clean(settings.reasoningSummary) || null,
      verbosity: clean(settings.verbosity) || null,
      approvalMode: normalizeApprovalMode(body.approval),
      searchMode: ["auto", "required", "off"].includes(settings.searchMode)
        ? settings.searchMode
        : "auto",
      collaborationMode: settings.collaborationMode,
      skills: selectedSkills,
      skill_selections: selectedSkills.map((selection) => ({
        selection_key: selection,
        name: selection.includes(":") ? selection.slice(selection.lastIndexOf(":") + 1) : selection,
        qualified_name: selection,
        display_name: selection,
        selection_mode: "explicit",
      })),
    },
  };
  if (!temporary) {
    try {
      await persistInitialUserMessage(ctx, {
        sessionId,
        userMessageId,
        displayMessage,
        attachments,
        userMetadata,
      });
    } catch (error) {
      console.error("[agent_chat user persist]", error?.message || error);
      throw new ApiError("用户消息保存失败，本轮任务没有启动", 500);
    }
  }
  let restoredItems = [];
  if (!temporary && resumeRunId) {
    const restored = await ctx.queryOne(
      `SELECT content_items
         FROM session_messages
        WHERE id=$1 AND session_id=$2 AND role='assistant' AND deleted_at IS NULL
        LIMIT 1`,
      [assistantMessageId, sessionId],
    ).catch(() => null);
    try {
      const parsed = typeof restored?.content_items === "string"
        ? JSON.parse(restored.content_items)
        : restored?.content_items;
      if (Array.isArray(parsed)) restoredItems = parsed;
    } catch {
      restoredItems = [];
    }
  }
  const items = restoredItems;
  let runtimeThreadId = null;
  let runtimeTurnId = null;
  let startedAtMs = null;
  let completedAtMs = null;
  let finalStatus = "failed";
  let completionFailure = "";
  let traceError = null;
  let finalAnswerItem = null;
  let turnAnswerFinalization = null;
  let latestTurnDiff = null;
  let runtimeTerminalAnswerItemId = null;
  let runtimeLegacyAnswerItemId = null;
  let activeAgent = null;
  let stopRequested = false;
  let runCreated = false;
  let unregisterActiveTurn = () => {};
  let resolveActiveTurnSettlement = () => {};
  const activeTurnSettlement = new Promise((resolve) => {
    resolveActiveTurnSettlement = resolve;
  });
  const decisionIds = [];
  let projectionQueue = Promise.resolve();
  let collaborationQueue = Promise.resolve();
  let nativeTerminalPublished = false;
  let authoritativeTerminalPublished = false;
  let pendingAuthoritativeTerminal = null;
  let workspaceTurnSnapshot = null;

  const trace = await createTraceRecorder({
    emit: (event) => emit(rpcNotification(event)),
    projectId,
    sessionId: temporary ? null : sessionId,
    runId,
    userId: ctx.userId || "",
    mode: runMode,
    skill: selectedSkill || null,
    question: message,
    callSite: "agent_chat",
  });
  const extensionStream = createAgentStreamEmitter({
    emit: trace.emit,
    turnId: runId,
    threadId: sessionId,
    messageId: assistantMessageId,
  });
  let partialPersistenceTimer = null;
  let partialPersistenceDirty = false;
  let partialPersistenceClosed = false;
  let partialPersistenceQueue = Promise.resolve({ ok: true, skipped: true });
  const enqueuePartialPersistence = () => {
    if (temporary || !runCreated || partialPersistenceClosed) return partialPersistenceQueue;
    partialPersistenceDirty = false;
    const snapshotItems = structuredClone(items);
    const snapshotMetadata = {
      thread_id: runtimeThreadId || sessionId,
      runtime_thread_id: runtimeThreadId,
      turn_id: runtimeTurnId || runId,
      run_id: runId,
      message_id: assistantMessageId,
      turn_status: "inProgress",
      partial: true,
      recovery_state: "streaming",
      started_at: new Date(startedAtMs || Date.now()).toISOString(),
    };
    partialPersistenceQueue = partialPersistenceQueue
      .then(() => persistAssistantSnapshot(ctx, {
        sessionId,
        assistantMessageId,
        items: snapshotItems,
        metadata: snapshotMetadata,
      }))
      .catch((error) => {
        console.error("[agent_chat partial persistence]", error?.message || error);
        return { ok: false, error };
      });
    return partialPersistenceQueue;
  };
  const schedulePartialPersistence = ({ immediate = false } = {}) => {
    if (temporary || !runCreated || partialPersistenceClosed) return partialPersistenceQueue;
    partialPersistenceDirty = true;
    if (immediate) {
      if (partialPersistenceTimer) clearTimeout(partialPersistenceTimer);
      partialPersistenceTimer = null;
      return enqueuePartialPersistence();
    }
    if (!partialPersistenceTimer) {
      partialPersistenceTimer = setTimeout(() => {
        partialPersistenceTimer = null;
        void enqueuePartialPersistence();
      }, 100);
      partialPersistenceTimer.unref?.();
    }
    return partialPersistenceQueue;
  };
  const flushPartialPersistence = async () => {
    if (partialPersistenceTimer) clearTimeout(partialPersistenceTimer);
    partialPersistenceTimer = null;
    if (partialPersistenceDirty) await enqueuePartialPersistence();
    else await partialPersistenceQueue;
  };
  const queueAuthoritativeTerminal = ({
    status,
    message: terminalMessage = "",
    error = null,
    answerStatus = null,
    answerItemId = null,
    answerSource = null,
    answerRejectionCode = null,
  } = {}) => {
    if (authoritativeTerminalPublished || pendingAuthoritativeTerminal) return pendingAuthoritativeTerminal;
    pendingAuthoritativeTerminal = {
      status,
      message: terminalMessage,
      error,
      answerStatus,
      answerItemId,
      answerSource,
      answerRejectionCode,
    };
    return pendingAuthoritativeTerminal;
  };
  const emitAuthoritativeTerminal = () => {
    if (authoritativeTerminalPublished || !pendingAuthoritativeTerminal) return null;
    authoritativeTerminalPublished = true;
    const event = extensionStream.runCompleted({
      status: pendingAuthoritativeTerminal.status,
      message: pendingAuthoritativeTerminal.message
        || (pendingAuthoritativeTerminal.status === "completed" ? "处理完成" : "处理失败"),
      error: pendingAuthoritativeTerminal.error,
      emitTerminal: false,
      answerStatus: pendingAuthoritativeTerminal.answerStatus,
      answerItemId: pendingAuthoritativeTerminal.answerItemId,
      answerSource: pendingAuthoritativeTerminal.answerSource,
      answerRejectionCode: pendingAuthoritativeTerminal.answerRejectionCode,
    });
    // `emitTerminal:false` only builds the event so persistence can happen
    // before it is visible. Publish the canonical product terminal now.
    trace.emit(event);
    // The native terminal notification is deferred for every new turn. Replay
    // exactly one unprefixed terminal event after Turn Finalizer has decided
    // the answer. Host-only projection remains under dsh/*.
    if (agentContext?.deferNativeTerminal === true && !nativeTerminalPublished) {
      emit(runtimeRpc("turn/completed", event?.payload || {}, {
        threadId: runtimeThreadId || sessionId,
        turnId: runtimeTurnId || runId,
      }));
      nativeTerminalPublished = true;
    }
    return event;
  };
  const projectionStream = createAgentStreamEmitter({
    emit: () => {},
    turnId: runId,
    threadId: sessionId,
    messageId: assistantMessageId,
  });
  const projectionAdapter = new AgentStreamAdapter({
    streamCallback: async (content, options = {}) => {
      const projected = projectionStream.content(content, options);
      upsertItem(items, projected.item);
      await schedulePartialPersistence({
        immediate: ["confirm", "user_input", "generative_ui"].includes(String(options.content_type || "")),
      });
      return projected.contentId;
    },
    generativeUiEnabled: () => agentContext?.generativeUi === true,
    allowedLocalRoots: () => agentContext?.generativeUiWorkspaceRoots || [],
  });
  const streamCallback = async (content, options = {}) => {
    const pushed = extensionStream.content(content, options);
    upsertItem(items, pushed.item);
    if (options.content_type === "confirm" && options.tool_call_id) {
      attachPendingDecisionPublicInteraction(options.tool_call_id, { block: pushed.item });
    }
    await schedulePartialPersistence({
      immediate: ["confirm", "user_input", "generative_ui"].includes(String(options.content_type || "")),
    });
    return pushed.contentId;
  };

  const agentContext = new AgentContext({
    task_id: runId,
    user_id: ctx.userId || "",
    project_id: projectId,
    session_id: sessionId,
    input_data: {
      user_message: message || "请处理附件。",
      turn_input: normalizeTurnInput(turnInput, message || "请处理附件。", attachments),
      project_id: projectId,
      session_id: sessionId,
      temporary,
      attachments,
      operators: [],
      review_target: body.review_target || null,
    },
  });
  agentContext.db = { query: ctx.query, queryOne: ctx.queryOne, transaction: ctx.transaction };
  agentContext.signal = ctx.signal;
  agentContext.settings = settings;
  agentContext.automation = automationContext;
  agentContext.approvalGrant = input.approvalGrant && typeof input.approvalGrant === "object"
    ? input.approvalGrant
    : null;
  agentContext.clientUserMessageId = String(body.clientUserMessageId || "").trim() || null;
  agentContext.userMessageId = userMessageId;
  agentContext.approval = normalizeApprovalMode(body.approval);
  agentContext.skillDecisions = selectedSkills.map((skill_name) => ({ skill_name, runtime: "native", reason: "user_selected" }));
  agentContext.skillDecision = agentContext.skillDecisions[0] || null;
  agentContext.directRuntimeNotifications = true;
  agentContext.deferNativeTerminal = true;
  agentContext.temporary = temporary;
  agentContext.projectChatMemory = body.clientCapabilities?.projectChatMemory === true;
  agentContext.globalChatMemory = body.clientCapabilities?.globalChatMemory === true;
  agentContext.generativeUi = body.clientCapabilities?.renderGenerativeUi === true;
  if (!agentContext.automation) agentContext.awaitDecision = (id, scope = {}) => {
      decisionIds.push(id);
      const createdAt = new Date().toISOString();
      return new Promise((resolve) => pendingDecisions.set(id, {
        resolve,
        sessionId,
        projectId,
        userId: ctx.userId || null,
        runId,
        threadId: scope.threadId || runtimeThreadId,
        turnId: scope.turnId || runtimeTurnId,
        itemId: scope.itemId || id,
        nativeItemId: scope.nativeItemId || null,
        method: scope.method || null,
        availableDecisions: Array.isArray(scope.availableDecisions) ? structuredClone(scope.availableDecisions) : null,
        kind: "approval",
        returnsDecision: true,
        createdAt,
      }));
    };
  if (!agentContext.automation) agentContext.requestUserInput = async (params = {}) => {
    const itemId = String(params.itemId || randomUUID());
    const request = {
      request_id: itemId,
      threadId: params.threadId || runtimeThreadId,
      turnId: params.turnId || runtimeTurnId,
      itemId,
      questions: Array.isArray(params.questions) ? params.questions : [],
      autoResolutionMs: params.autoResolutionMs ?? null,
    };
    decisionIds.push(itemId);
    const createdAt = new Date().toISOString();
    const pendingBlock = {
      id: `user_input:${itemId}`,
      type: "user_input",
      content: JSON.stringify(request),
      title: "requested",
      metadata: { request_id: itemId, status: "requested" },
      is_complete: false,
      display_type: "user_input",
    };
    const responsePromise = new Promise((resolve) => {
      let timer = null;
      const finish = (value) => {
        if (timer) clearTimeout(timer);
        if (pendingDecisions.get(itemId)?.resolve === finish) pendingDecisions.delete(itemId);
        resolve(value);
      };
      const entry = {
        resolve: finish,
        sessionId,
        projectId,
        userId: ctx.userId || null,
        runId,
        threadId: request.threadId,
        turnId: request.turnId,
        itemId,
        kind: "user_input",
        createdAt,
      };
      entry.publicInteraction = createLivePendingInteraction(entry, {
        requestId: itemId,
        request,
        block: pendingBlock,
        createdAt,
      });
      pendingDecisions.set(itemId, entry);
      const autoResolutionMs = Number(request.autoResolutionMs || 0);
      if (autoResolutionMs > 0) {
        timer = setTimeout(() => finish({ answers: {} }), autoResolutionMs);
        timer.unref?.();
      }
    });
    extensionStream.userInputRequested(request);
    upsertItem(items, pendingBlock);
    await schedulePartialPersistence({ immediate: true });
    const response = await responsePromise;
    const answers = response?.answers && typeof response.answers === "object" ? response.answers : {};
    const persistedAnswers = redactUserInputAnswers(request.questions, answers);
    const visibleAnswer = Object.entries(persistedAnswers).flatMap(([questionId, answer]) => (
      answer?.secret === true
        ? (answer?.answered ? [`${questionId}：已回答`] : [])
        : (answer?.answers || [])
    )).join("，");
    extensionStream.userInputResolved({
      request_id: itemId,
      value: visibleAnswer,
      answers: persistedAnswers,
    });
    upsertItem(items, {
      id: `user_input:${itemId}`,
      type: "user_input",
      content: JSON.stringify({ ...request, answers: persistedAnswers }),
      title: "resolved",
      metadata: { request_id: itemId, status: "resolved", response: persistedAnswers },
      is_complete: true,
      display_type: "user_input",
    });
    await schedulePartialPersistence({ immediate: true });
    return { answers };
    };
  agentContext.onAgent = (agent) => {
    activeAgent = agent;
  };

  const runtime = createAgentRuntime({
    ctx: agentContext.db,
    stream: extensionStream,
    runId,
    sessionId,
    projectId,
    userId: ctx.userId || "",
    skill: selectedSkill || null,
    mode: runMode,
  });
  agentContext.runtime = runtime;

  const bindActiveTurn = (turnId) => {
    if (!turnId || turnId === runtimeTurnId) return;
    unregisterActiveTurn();
    runtimeTurnId = turnId;
    const control = {
      sessionId,
      projectId,
      runId,
      supportsImageInput: true,
      cancel: async (reason) => {
        stopRequested = true;
        activeAgent?.abort?.();
      },
      steer: async ({ input: steerInput, clientUserMessageId = null } = {}) => {
        if (!activeAgent?.steer) throw new ApiError("当前任务不能接收补充内容", 409);
        return activeAgent.steer(steerInput, { clientUserMessageId });
      },
      waitForSettlement: () => activeTurnSettlement,
    };
    const unregisterTurn = registerActiveRun(turnId, control);
    const unregisterRun = turnId === runId ? () => {} : registerActiveRun(runId, control);
    unregisterActiveTurn = () => {
      unregisterTurn();
      unregisterRun();
    };
  };

  agentContext.onRuntimeNotification = (method, params = {}, runtimeTarget = {}) => {
    runtimeThreadId ||= params.threadId || runtimeTarget.threadId || null;
    const turnId = params.turnId || params.turn?.id || runtimeTarget.turnId || null;
    if (turnId) bindActiveTurn(turnId);
    agentContext.runtime_thread_id = runtimeThreadId;
    agentContext.runtime_turn_id = runtimeTurnId;
    if (runtimeThreadId) {
      extensionStream.threadId = runtimeThreadId;
      projectionStream.threadId = runtimeThreadId;
    }
    if (runtimeTurnId) {
      extensionStream.turnId = runtimeTurnId;
      projectionStream.turnId = runtimeTurnId;
    }
    if (method === "serverRequest/resolved" && params.localRequestId) {
      const localRequestId = String(params.localRequestId);
      const pending = pendingDecisions.get(localRequestId);
      if (pending && (!pending.threadId || pending.threadId === runtimeThreadId)) {
        pendingDecisions.delete(localRequestId);
        pending.resolve?.(pending.kind === "user_input" ? { answers: {} } : false);
      }
    }
    if (method === "turn/started") {
      startedAtMs = params.turn?.startedAt ? Number(params.turn.startedAt) * 1000 : Date.now();
      void ctx.query("UPDATE agent_runs SET turn_id=$2, updated_at=now() WHERE id=$1", [runId, runtimeTurnId]).catch(() => null);
    }
    if (method === "turn/completed") {
      completedAtMs = params.turn?.completedAt ? Number(params.turn.completedAt) * 1000 : Date.now();
      finalStatus = params.turn?.status || "completed";
    }
    if (method === "item/completed" && params.item?.type === "agentMessage") {
      const itemPhase = clean(params.item?.phase || params.item?.metadata?.phase);
      const itemId = nativeNotificationItemId(params);
      if (itemPhase === "final_answer") runtimeTerminalAnswerItemId = itemId || runtimeTerminalAnswerItemId;
      else if (!itemPhase) runtimeLegacyAnswerItemId = itemId || runtimeLegacyAnswerItemId;
    }
    if (method === "turn/diff/updated" && typeof params.diff === "string") {
      latestTurnDiff = params.diff;
    }
    const resolvedTarget = { threadId: runtimeThreadId, turnId: runtimeTurnId };
    const collaborationEvent = nativeCollaborationRunEvent(method, params);
    if (collaborationEvent) {
      collaborationQueue = collaborationQueue
        .then(() => runtime.recordEvent(collaborationEvent))
        .catch((error) => console.error("[agent_chat collaboration]", error?.message || error));
    }
    trace.observe(runtimeEvent(method, params, resolvedTarget));
    const deferNativeTerminal = shouldDeferNativeTerminalNotification(
      agentContext,
      method,
    );
    if (!deferNativeTerminal) {
      emit(runtimeRpc(method, params, resolvedTarget));
      if (method === "turn/completed") nativeTerminalPublished = true;
    }
    projectionQueue = projectionQueue
      .then(() => projectionAdapter.handle(method, params))
      .catch((error) => console.error("[agent_chat projection]", error?.message || error));
  };

  const onAbort = () => {
    activeAgent?.abort?.();
    for (const id of decisionIds) {
      const pending = pendingDecisions.get(id);
      pendingDecisions.delete(id);
      pending?.resolve?.(false);
    }
  };
  ctx.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    runCreated = Boolean(await (resumeRunId ? runtime.resumeRun() : runtime.createRun()));
    if (!runCreated) throw new Error("无法初始化运行记录");
    await schedulePartialPersistence({ immediate: true });
    if (!resumeRunId) {
      const visibleWorkspaceRoot = await workspaceRoot(ctx, projectId, sessionId).catch(() => null);
      if (visibleWorkspaceRoot) {
        workspaceTurnSnapshot = await beginWorkspaceTurnSnapshot({
          roots: [{ id: "workspace", path: visibleWorkspaceRoot }],
        }).catch((error) => {
          console.warn("[agent_chat workspace snapshot] baseline skipped", error?.message || error);
          return null;
        });
      }
    }
    const agent = new WorkspaceAgent({ projectId });
    const result = await runWithTraceContext(trace, () => traceAgentCall({
      name: "WorkspaceAgent",
      input: agentTraceInput(agentContext),
      attrs: {
        trace_source: "workspace_agent",
        agent_method: "execute",
        agent_class: "WorkspaceAgent",
      },
    }, () => agent.execute(agentContext, streamCallback)));
    await projectionQueue;
    await collaborationQueue;
    const interrupted = Boolean(ctx.signal?.aborted || stopRequested || result?.status === "interrupted");
    finalStatus = interrupted ? "interrupted" : result?.success === false ? "failed" : "completed";
    const runtimeFinalStatus = finalStatus;
    const invalidNarrativeItems = invalidateNonSubstantiveNarrativeItems(items);
    for (const item of invalidNarrativeItems) {
      await streamCallback("", {
        content_id: item.id,
        content_type: item.type,
        title: item.title,
        display: false,
        replace_snapshot: true,
        protocol_violation: "NON_SUBSTANTIVE_NARRATIVE",
      });
    }
    const runtimeAnswerItemId = runtimeTerminalAnswerItemId || runtimeLegacyAnswerItemId;
    const answerResolution = resolveTurnAnswerCandidate(items, { answerItemId: runtimeAnswerItemId });
    finalAnswerItem = answerResolution?.item || null;
    const webSources = agentContext?.webResearch?.getSources?.() || [];
    const webActivity = agentContext?.webResearch?.getActivity?.() || { search_count: 0, open_count: 0, find_count: 0 };
    let citationValidation = { valid: [], invalid: [], unbound: [], uncited: [] };
    if (webSources.length) {
      citationValidation = validateWebCitationMarkers(items, webSources, {
        answerItemId: answerResolution?.itemId || null,
      });
      await streamCallback(JSON.stringify({ sources: webSources, citation_validation: citationValidation, activity: webActivity }), {
        content_id: `web-sources:${runtimeTurnId || runId}`,
        content_type: "web_sources",
        title: "来源",
        web_sources: webSources,
      });
      if (citationValidation.invalid.length) {
        const invalidCitation = extensionStream.content(`回答中包含无效来源编号：${citationValidation.invalid.join("、")}。这些编号不会显示为有效引用。`, {
          content_id: `web-citations-invalid:${runtimeTurnId || runId}`,
          content_type: "error",
          title: "引用校验失败",
        });
        upsertItem(items, invalidCitation.item);
      }
      if (citationValidation.unbound.length) {
        const unboundCitation = extensionStream.content(`以下来源编号没有绑定任何回答文字：${citationValidation.unbound.join("、")}。`, {
          content_id: `web-citations-unbound:${runtimeTurnId || runId}`,
          content_type: "error",
          title: "引用位置无效",
        });
        upsertItem(items, unboundCitation.item);
      }
      if (citationValidation.valid.length === 0) {
        const missingCitation = extensionStream.content("本轮已打开网页，但最终回答没有引用任何有效来源编号。", {
          content_id: `web-citations-missing:${runtimeTurnId || runId}`,
          content_type: "error",
          title: "缺少正文引用",
        });
        upsertItem(items, missingCitation.item);
      }
    } else if (settings.searchMode === "required") {
      const missingSource = extensionStream.content("本轮要求联网，但没有打开并核对任何网页；当前回答不能视为已联网验证。", {
        content_id: `web-sources-missing:${runtimeTurnId || runId}`,
        content_type: "error",
        title: "缺少联网来源",
      });
      upsertItem(items, missingSource.item);
    }
    const webPolicyFailure = webCitationPolicyFailure(settings.searchMode, webSources, citationValidation, webActivity);
    if (finalStatus === "completed" && webPolicyFailure) {
      finalStatus = "failed";
      completionFailure = `联网引用校验失败：${webPolicyFailure}`;
    }
    if (!completedAtMs) completedAtMs = Date.now();
    if (!startedAtMs) startedAtMs = completedAtMs;
    const capabilityCompletion = await completeTurnCapabilities(agentContext, {
      status: finalStatus,
      answerText: answerResolution?.text || "",
      answerItemId: answerResolution?.itemId || null,
      answerAccepted: Boolean(answerResolution),
      runtimeStatus: runtimeFinalStatus,
      runtimeError: result?.error || result?.message || completionFailure || null,
    });
    finalStatus = capabilityCompletion.status;
    if (capabilityCompletion.failures.length) {
      const message = capabilityCompletion.failures
        .map((failure) => failure.message)
        .filter(Boolean)
        .join("；");
      completionFailure = message || "能力完成条件未满足";
      const completionError = extensionStream.content(completionFailure, {
        content_id: `turn-completion:${runtimeTurnId || runId}`,
        content_type: "error",
        title: capabilityCompletion.failures[0]?.title || "任务未完成",
        completion_failures: capabilityCompletion.failures,
      });
      upsertItem(items, completionError.item);
    }
    const primaryFailure = capabilityCompletion.failures[0] || null;
    turnAnswerFinalization = finalizeTurnAnswer({
      items,
      answerItemId: answerResolution?.itemId || null,
      turnStatus: finalStatus,
      capabilityStatus: finalStatus,
      answerSource: "runtime_terminal",
      rejectionCode: primaryFailure?.code || (completionFailure ? "TURN_COMPLETION_REJECTED" : null),
      rejectionMessage: primaryFailure?.message || completionFailure,
    });
    finalAnswerItem = turnAnswerFinalization.item;
    const statusBeforeAnswerGate = finalStatus;
    finalStatus = finalizeTurnStatus(finalStatus, turnAnswerFinalization);
    if (
      statusBeforeAnswerGate === "completed"
      && finalStatus === "failed"
      && !completionFailure
    ) {
      completionFailure = turnAnswerFinalization.rejectionMessage || "最终回答未通过验收，任务不能标记为完成。";
    }
    if (finalAnswerItem) {
      const capabilityAnswerMetadata = finalAnswerMetadataFromCapabilityVerdicts(capabilityCompletion);
      if (turnAnswerFinalization.accepted && Object.keys(capabilityAnswerMetadata).length) {
        finalAnswerItem.metadata = {
          ...(finalAnswerItem.metadata || {}),
          ...capabilityAnswerMetadata,
        };
      }
      await streamCallback(finalAnswerItem.content || finalAnswerItem.text || "", {
        ...(finalAnswerItem.metadata || {}),
        content_id: finalAnswerItem.id,
        content_type: finalAnswerItem.type,
        title: finalAnswerItem.title,
        replace_snapshot: true,
      });
    }
    if (finalStatus === "completed") {
      const automaticCanvas = await autoCreateCanvasFromTurn(ctx, {
        userId: ctx.userId || "",
        sessionId,
        assistantMessageId,
        turnId: runtimeTurnId || runId,
        runId,
        items,
      }).catch((error) => {
        console.error("[agent_chat canvas]", error?.message || error);
        return null;
      });
      if (automaticCanvas?.canvas) {
        const workspaceEvent = {
          type: "workspace_event",
          event: "canvas_opened",
          session_id: sessionId,
          project_id: projectId,
          canvas_id: automaticCanvas.canvas.id,
          canvas: automaticCanvas.canvas,
          open: true,
        };
        const canvasItem = extensionStream.content(JSON.stringify(workspaceEvent), {
          content_id: `workspace:canvas:${automaticCanvas.canvas.id}`,
          content_type: "workspace_event",
          workspace_event: workspaceEvent,
          display: false,
        });
        upsertItem(items, canvasItem.item);
      }
    }
    traceError = result?.error || null;
    queueAuthoritativeTerminal({
      status: finalStatus,
      message: completionFailure || (finalStatus === "completed" ? "处理完成" : "任务未完成"),
      error: finalStatus === "failed" ? new Error(completionFailure || "任务未完成") : null,
      answerStatus: turnAnswerFinalization?.status || "missing",
      answerItemId: turnAnswerFinalization?.answerItemId || null,
      answerSource: turnAnswerFinalization?.answerSource || null,
      answerRejectionCode: turnAnswerFinalization?.rejectionCode || null,
    });
  } catch (error) {
    finalStatus = ctx.signal?.aborted || stopRequested ? "interrupted" : "failed";
    completedAtMs ||= Date.now();
    startedAtMs ||= completedAtMs;
    const errorItem = extensionStream.content(`⚠️ ${error?.message || "任务执行失败"}`, {
      content_id: `error:${runtimeTurnId || runId}`,
      content_type: "error",
      title: "错误",
    });
    upsertItem(items, errorItem.item);
    const capabilityCompletion = await completeTurnCapabilities(agentContext, {
      status: finalStatus,
      answerText: "",
      answerItemId: null,
      runtimeStatus: finalStatus,
      runtimeError: error?.message || String(error),
    });
    finalStatus = capabilityCompletion.status;
    if (capabilityCompletion.failures.length) {
      completionFailure = capabilityCompletion.failures.map((failure) => failure.message).filter(Boolean).join("；");
      const completionError = extensionStream.content(completionFailure, {
        content_id: `turn-completion:${runtimeTurnId || runId}`,
        content_type: "error",
        title: capabilityCompletion.failures[0]?.title || "能力收尾失败",
        completion_failures: capabilityCompletion.failures,
      });
      upsertItem(items, completionError.item);
    }
    turnAnswerFinalization = finalizeTurnAnswer({
      items,
      answerItemId: runtimeTerminalAnswerItemId || runtimeLegacyAnswerItemId,
      turnStatus: finalStatus,
      capabilityStatus: finalStatus,
      rejectionCode: capabilityCompletion.failures[0]?.code || "TURN_EXECUTION_FAILED",
      rejectionMessage: capabilityCompletion.failures[0]?.message || error?.message || String(error),
    });
    if (turnAnswerFinalization.item) {
      await streamCallback(turnAnswerFinalization.item.content || turnAnswerFinalization.item.text || "", {
        ...(turnAnswerFinalization.item.metadata || {}),
        content_id: turnAnswerFinalization.item.id,
        content_type: turnAnswerFinalization.item.type,
        title: turnAnswerFinalization.item.title,
        replace_snapshot: true,
      }).catch(() => null);
    }
    traceError = error;
    queueAuthoritativeTerminal({
      status: finalStatus,
      message: completionFailure || error?.message || "任务执行失败",
      error,
      answerStatus: turnAnswerFinalization?.status || "missing",
      answerItemId: turnAnswerFinalization?.answerItemId || null,
      answerSource: turnAnswerFinalization?.answerSource || null,
      answerRejectionCode: turnAnswerFinalization?.rejectionCode || null,
    });
  } finally {
    await projectionQueue;
    await collaborationQueue;
    if (workspaceTurnSnapshot) {
      try {
        const summary = await workspaceTurnSnapshot.finish();
        if (summary.changes.length) {
          const nativeTurnDiff = String(latestTurnDiff || "").trim();
          const snapshotTurnDiff = String(summary.unifiedDiff || "").trim();
          const hasNativeFileChange = items.some((item) => item?.type === "file_change");
          const needsSnapshotCard = !hasNativeFileChange
            || !snapshotTurnDiff
            || nativeTurnDiff !== snapshotTurnDiff;
          if (snapshotTurnDiff) latestTurnDiff = summary.unifiedDiff;
          if (needsSnapshotCard) {
            const contentId = `workspace-snapshot:${runtimeTurnId || runId}`;
            const payload = {
              changes: summary.changes,
              status: "completed",
              patch: summary.unifiedDiff,
              source: summary.source,
              reviewable: summary.reviewable,
              reversible: summary.reversible,
              truncated: summary.truncated,
            };
            await streamCallback(JSON.stringify(payload), {
              content_id: contentId,
              content_type: "file_change",
              title: "done",
              origin: summary.source,
              reviewable: summary.reviewable,
              reversible: summary.reversible,
              truncated: summary.truncated,
              replace_snapshot: true,
            });
            extensionStream.itemCompleted({
              id: contentId,
              type: "fileChange",
              status: "completed",
              changes: summary.changes,
              source: summary.source,
              reviewable: summary.reviewable,
              reversible: summary.reversible,
              truncated: summary.truncated,
            });
          }
          if (snapshotTurnDiff && nativeTurnDiff !== snapshotTurnDiff) {
            extensionStream.event("turn/diff/updated", {
              diff: summary.unifiedDiff,
              diffHash: summary.diffHash,
              source: summary.source,
            });
          }
        }
      } catch (error) {
        // Snapshot failure must not change an otherwise valid model Turn.
        console.warn("[agent_chat workspace snapshot] finish skipped", error?.message || error);
      } finally {
        await workspaceTurnSnapshot.dispose().catch(() => null);
        workspaceTurnSnapshot = null;
      }
    }
    await flushPartialPersistence();
    partialPersistenceClosed = true;
    finalizeTerminalContentItems(items, finalStatus);
    if (Array.isArray(agentContext.selectedSkillSelections)) {
      userMetadata.turn_request.skill_selections = agentContext.selectedSkillSelections;
    }
    const messageAnnotations = {};
    if (finalStatus === "completed") {
      const cwd = await workspaceRoot(ctx, projectId, sessionId).catch(() => null);
      if (cwd) {
        for (const item of items) {
          if (!["markdown", "text"].includes(String(item?.type || "")) || !String(item?.content || "").trim()) continue;
          const projection = await buildFileReferenceAnnotations({
            text: item.content,
            cwd,
            sessionId,
            runtimeThreadId: runtimeThreadId || sessionId,
            turnId: runtimeTurnId || runId,
            itemId: item.id,
          }).catch(() => null);
          if (!projection?.annotations?.length) continue;
          item.metadata = {
            ...(item.metadata || {}),
            text_hash: projection.textHash,
            annotations: projection.annotations,
          };
          messageAnnotations[item.id] = projection;
          emit(rpcNotification({
            type: "messageAnnotations/updated",
            thread_id: runtimeThreadId || sessionId,
            turn_id: runtimeTurnId || runId,
            item_id: item.id,
            payload: {
              textHash: projection.textHash,
              annotations: projection.annotations,
            },
          }));
        }
      }
    }
    const terminalSettlement = await persistAgentTurnBeforeRunTerminal({
      persist: () => temporary
        ? Promise.resolve({ ok: true, skipped: true })
        : persistTurn(ctx, {
        sessionId,
        userMessageId,
        userMetadata: {
          ...userMetadata,
          runtime_thread_id: runtimeThreadId,
          turn_id: runtimeTurnId || runId,
        },
        assistantMessageId,
        items,
        metadata: {
          thread_id: runtimeThreadId || sessionId,
          runtime_thread_id: runtimeThreadId,
          turn_id: runtimeTurnId || runId,
          run_id: runId,
          message_id: assistantMessageId,
          turn_status: finalStatus,
          ...answerMetadata(turnAnswerFinalization),
          started_at: new Date(startedAtMs || Date.now()).toISOString(),
          completed_at: new Date(completedAtMs || Date.now()).toISOString(),
          duration_ms: Math.max(0, Number(completedAtMs || Date.now()) - Number(startedAtMs || Date.now())),
          turn_diff: latestTurnDiff,
          message_annotations: messageAnnotations,
          client_capabilities: body.clientCapabilities && typeof body.clientCapabilities === "object"
            ? body.clientCapabilities
            : null,
        },
        }),
      runtime,
      runCreated,
      finalStatus,
      interruptReason: stopRequested ? "user_stop" : "request_aborted",
    });
    const persistence = terminalSettlement.persistence;
    finalStatus = terminalSettlement.durable_status;
    if (terminalSettlement.terminal_error) {
      console.error("[agent_chat terminal]", terminalSettlement.terminal_error?.message || terminalSettlement.terminal_error);
      traceError ||= terminalSettlement.terminal_error;
    }
    if (!persistence.ok) {
      const persistenceError = persistence.error || new Error("会话记录保存失败");
      completionFailure = "回答已生成，但会话记录保存失败，请重试或复制当前结果";
      traceError ||= persistenceError;
      if (pendingAuthoritativeTerminal) {
        pendingAuthoritativeTerminal = {
          ...pendingAuthoritativeTerminal,
          status: "failed",
          message: completionFailure,
          error: persistenceError,
        };
      }
      emit(runtimeRpc("error", {
        threadId: runtimeThreadId || sessionId,
        turnId: runtimeTurnId || runId,
        itemId: `persistence:error:${runId}`,
        error: { message: completionFailure },
      }));
    }
    // Persist the final assistant snapshot before publishing the authoritative
    // terminal. Consumers can now hydrate the same answer they just observed.
    emitAuthoritativeTerminal();
    resolveActiveTurnSettlement({
      status: finalStatus,
      persisted: persistence.ok === true,
      run_id: runId,
      turn_id: runtimeTurnId || runId,
    });
    await trace.finish({ status: finalStatus, error: traceError });
    unregisterActiveTurn();
    ctx.signal?.removeEventListener("abort", onAbort);
    for (const id of decisionIds) {
      const pending = pendingDecisions.get(id);
      pendingDecisions.delete(id);
      pending?.resolve?.(false);
    }
  }
}

export async function agentChat(ctx, input, emit) {
  const sessionId = input?.params?.sid;
  const releaseSession = claimActiveSession(sessionId);
  if (!releaseSession) throw new ApiError("当前会话已有任务在运行，请继续输入或先停止当前任务", 409);
  try {
    return await agentChatUnlocked(ctx, input, emit);
  } finally {
    releaseSession();
  }
}

export default agentChat;

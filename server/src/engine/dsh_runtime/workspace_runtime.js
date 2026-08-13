import { randomUUID } from "node:crypto";
import { AgentStreamAdapter } from "../agent_kernel/stream_adapter.js";
import { DshEventAdapter, dshTurnStatus } from "./event_adapter.js";
import { getDshRuntimeClient } from "./client.js";
import { acceptedDshDecision, dshQuestionAnswers } from "./interaction_wire.js";
import { loadDshSessionBinding, saveDshSessionBinding } from "./session_binding.js";
import { ensureDshWorkspaceSession } from "./session_attachment.js";
import { dshPromptContent, normalizeDshPromptError } from "./prompt_content.js";
import { decodeDshModelRoute } from "./model_route.js";

async function loadBinding(agentContext) {
  const id = agentContext?.session_id;
  if (!id) {
    console.warn("[dsh-runtime] loadBinding: no session_id on agentContext");
    return null;
  }
  const db = agentContext?.db;
  if (!db?.queryOne) {
    console.warn(`[dsh-runtime] loadBinding: agentContext.db.queryOne missing (session ${id})`);
    return null;
  }
  const binding = await loadDshSessionBinding(db, id).catch((error) => {
    console.warn(`[dsh-runtime] loadBinding: DB query failed for session ${id}:`, error?.message || error);
    return null;
  });
  console.info(`[dsh-runtime] loadBinding: session ${id} → dsh ${binding?.dshSessionId || "(none)"}`);
  return binding;
}

async function saveBinding(agentContext, runtimeSessionId, cwd) {
  const id = agentContext?.session_id;
  const db = agentContext?.db;
  if (!id || !db?.query || !db?.queryOne) return null;
  return saveDshSessionBinding(db, {
    appSessionId: id,
    dshSessionId: runtimeSessionId,
    cwd,
    projectId: agentContext?.project_id,
    userId: agentContext?.user_id,
  });
}

function turnInput(agentContext) {
  return Array.isArray(agentContext?.input_data?.turn_input)
    ? agentContext.input_data.turn_input
    : [];
}

const DSH_SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** Serialize compatibility-composer selections through DSH's native Skill reference syntax. */
export function dshSkillReferenceText(agentContext) {
  const decisions = Array.isArray(agentContext?.skillDecisions) ? agentContext.skillDecisions : [];
  const names = [...new Set(decisions.map((decision) => {
    const qualified = String(decision?.skill_name || "").trim();
    return qualified.slice(qualified.lastIndexOf(":") + 1);
  }).filter((name) => DSH_SKILL_NAME.test(name)))];
  return names.map((name) => `<skill>${name}</skill>`).join(" ");
}

function withSkillReferences(content, agentContext) {
  const references = dshSkillReferenceText(agentContext);
  if (!references) return content;
  const firstText = content.findIndex((block) => block?.type === "text");
  if (firstText < 0) return [{ type: "text", text: references }, ...content];
  return content.map((block, index) => (
    index === firstText ? { ...block, text: `${references}\n${block.text}` } : block
  ));
}

function abortError(message = "Agent Turn 已取消") {
  const error = new Error(message);
  error.name = "AbortError";
  error.code = "DSH_TURN_ABORTED";
  return error;
}

/** Read the effective target from DSH's logged plan projection. */
export function effectiveDshPlanMode(value) {
  if (!value || typeof value !== "object") return null;
  const active = value.active === true;
  return value.pending === true ? !active : active;
}

/** Derive only the DSH commands needed to align one turn's plan mode. */
export function dshPolicyCommands(projections, agentContext) {
  const values = projections?.values;
  if (!values || typeof values !== "object") {
    const error = new Error("DSH 会话没有提供运行策略投影，不能安全设置 Plan 模式");
    error.code = "DSH_POLICY_PROJECTIONS_MISSING";
    throw error;
  }
  const plan = values.plan;
  if (!plan || typeof plan !== "object") {
    const error = new Error("DSH 桌面组合缺少 plan 投影");
    error.code = "DSH_POLICY_CAPABILITY_MISSING";
    throw error;
  }
  const commands = [];
  const wantedPlan = agentContext?.settings?.collaborationMode === "plan";
  if (effectiveDshPlanMode(plan) !== wantedPlan) commands.push(wantedPlan ? "/plan" : "/plan off");
  return commands;
}

/** Resolve one opaque App selection back to its exact DSH provider/model route. */
export function resolveDshModelTarget(catalog, modelRoute) {
  const route = decodeDshModelRoute(modelRoute);
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const listedGroup = groups.find((candidate) => candidate.id === route.provider);
  const listedModel = listedGroup?.models?.find((candidate) => candidate.id === route.model);
  return {
    group: listedGroup || { id: route.provider, name: route.provider, models: [] },
    candidate: listedModel || { id: route.model, name: route.model },
    listed: Boolean(listedGroup && listedModel),
  };
}

/** One dsh-work turn driven by the source or npm DSH ApiProxy process. */
export class DshWorkspaceRuntime {
  constructor({ client = getDshRuntimeClient(), ephemeral = null } = {}) {
    this.client = client;
    this.ephemeral = ephemeral;
    this.sessionId = null;
    this.turnId = null;
    this.running = false;
  }

  async #ensureSession(agentContext, cwd) {
    if (this.ephemeral) {
      if (this.ephemeral.cwd && this.ephemeral.cwd !== cwd) {
        const error = new Error("临时 DSH 会话的工作目录在对话期间发生了变化，请关闭后重新创建临时对话");
        error.code = "DSH_SESSION_CWD_MISMATCH";
        throw error;
      }
      const created = await ensureDshWorkspaceSession(this.client, {
        cwd,
        ...(this.ephemeral.dshSessionId ? { sessionId: this.ephemeral.dshSessionId } : {}),
      });
      this.ephemeral.dshSessionId = created.sessionId;
      this.ephemeral.cwd = cwd;
      return created.sessionId;
    }
    const saved = await loadBinding(agentContext);
    if (saved && saved.cwd !== cwd) {
      const error = new Error(
        saved.cwd
          ? `DSH Session 固定工作目录为 ${saved.cwd}，当前目录为 ${cwd}；为避免历史分裂，拒绝自动换绑`
          : "旧 DSH Session 没有固定工作目录；为避免历史分裂，请删除此旧对话后新建",
      );
      error.code = "DSH_SESSION_CWD_MISMATCH";
      throw error;
    }
    const createPayload = { cwd, ...(saved ? { sessionId: saved.dshSessionId } : {}) };
    console.info(`[dsh-runtime] #ensureSession: saved=${saved?.dshSessionId || "(none)"} cwd=${cwd} payload=${JSON.stringify({ ...createPayload, sessionId: createPayload.sessionId ? "<set>" : "(absent)" })}`);
    try {
      const created = await ensureDshWorkspaceSession(this.client, createPayload);
      console.info(`[dsh-runtime] #ensureSession: session.create returned ${created.sessionId}${saved && created.sessionId !== saved.dshSessionId ? " (DIFFERENT FROM SAVED!)" : ""}`);
      await saveBinding(agentContext, created.sessionId, cwd);
      return created.sessionId;
    } catch (error) {
      if (saved && error?.code === "session-conflict") {
        const conflict = new Error("DSH 拒绝了已保存的 Session 工作目录；为避免历史分裂，拒绝自动创建替代会话", { cause: error });
        conflict.code = "DSH_SESSION_CWD_MISMATCH";
        throw conflict;
      }
      throw error;
    }
  }

  async #handleApproval(frame, agentContext, streamCallback) {
    const request = frame.payload;
    const approvalId = String(request.approvalId || randomUUID());
    const decisionPromise = agentContext?.awaitDecision?.(approvalId, {
      threadId: this.sessionId,
      turnId: this.turnId,
      itemId: approvalId,
      method: "dsh/approval",
      availableDecisions: ["accept", "decline"],
    });
    const summary = `DSH 请求调用 ${request.toolName || "工具"}${request.reason ? `：${request.reason}` : ""}`;
    await streamCallback(summary, {
      content_id: `confirm:${approvalId}`,
      content_type: "confirm",
      title: "工具确认",
      tool_call_id: approvalId,
      approval_request: {
        kind: "dsh_tool_call",
        method: "dsh/approval",
        threadId: this.sessionId,
        turnId: this.turnId,
        itemId: approvalId,
        tool_name: request.toolName || null,
        reason: request.reason || null,
        availableDecisions: ["accept", "decline"],
      },
    });
    const decision = await decisionPromise?.catch(() => false);
    const allowed = acceptedDshDecision(decision);
    await this.client.respond(frame.rpcId, {
      sessionId: this.sessionId,
      approvalId: request.approvalId,
      outcome: allowed ? "allowed-once" : "rejected",
    });
    await streamCallback(summary, {
      content_id: `confirm:${approvalId}`,
      content_type: "confirm",
      title: allowed ? "approved" : "rejected",
      tool_call_id: approvalId,
      replace_snapshot: true,
    });
  }

  async #handleQuestion(frame, agentContext) {
    const questions = Array.isArray(frame.payload?.questions) ? frame.payload.questions : [];
    const response = typeof agentContext?.requestUserInput === "function"
      ? await agentContext.requestUserInput({
        threadId: this.sessionId,
        turnId: this.turnId,
        itemId: frame.rpcId,
        questions,
      }).catch(() => ({ answers: {} }))
      : { answers: {} };
    await this.client.respond(frame.rpcId, {
      sessionId: this.sessionId,
      answer: { answers: dshQuestionAnswers(questions, response) },
    });
  }

  async #applyModelSelection(agentContext) {
    const modelId = agentContext?.settings?.modelId;
    if (!modelId) return;
    const catalog = await this.client.request("session.models", { sessionId: this.sessionId });
    const { group, candidate } = resolveDshModelTarget(catalog, modelId);
    const reasoningEffort = String(agentContext?.settings?.reasoningEffort || "").trim() || undefined;
    const selected = await this.client.request("session.selectModel", {
      sessionId: this.sessionId,
      provider: group.id,
      model: candidate.id,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    console.info(`[dsh-runtime] session.selectModel: provider=${group.id} model=${candidate.id} → ${selected?.selected?.model || "ok"}`);
  }

  async #applyTurnPolicy(agentContext) {
    const history = await this.client.request("session.history", {
      sessionId: this.sessionId,
      maxMessages: 1,
    });
    const commands = dshPolicyCommands(history?.projections, agentContext);
    for (const line of commands) {
      const result = await this.client.request("command.execute", {
        sessionId: this.sessionId,
        line,
      });
      if (result?.matched !== true) {
        const error = new Error(`DSH 没有接受运行策略命令：${line}`);
        error.code = "DSH_POLICY_COMMAND_REJECTED";
        throw error;
      }
    }
  }

  async execute({ agentContext, streamCallback, cwd }) {
    await this.client.start();
    this.sessionId = await this.#ensureSession(agentContext, cwd);
    await this.#applyTurnPolicy(agentContext);
    await this.#applyModelSelection(agentContext);
    this.client.registerProductHostSession({
      db: agentContext?.db,
      userId: agentContext?.user_id,
      projectId: agentContext?.project_id,
      appSessionId: agentContext?.session_id,
      dshSessionId: this.sessionId,
    });
    const nativeAdapter = agentContext?.directRuntimeNotifications
      ? null
      : new AgentStreamAdapter({ streamCallback });
    let notificationQueue = Promise.resolve();
    const emit = (method, params) => {
      agentContext?.onRuntimeNotification?.(method, params, {
        threadId: this.sessionId,
        turnId: this.turnId,
      });
      return nativeAdapter ? nativeAdapter.handle(method, params) : Promise.resolve();
    };
    const adapter = new DshEventAdapter({ sessionId: this.sessionId, emit });
    let seenRunning = false;
    let idle = false;
    let turnEnd = null;
    let settled = false;
    let resolveTurn;
    let rejectTurn;
    const completion = new Promise((resolve, reject) => {
      resolveTurn = resolve;
      rejectTurn = reject;
    });
    const maybeSettle = () => {
      if (settled || !seenRunning || !idle || !turnEnd) return;
      settled = true;
      resolveTurn(turnEnd);
    };
    const onMux = (frame) => {
      const payload = frame?.payload;
      if (payload?.sessionId !== this.sessionId) return;
      if (payload.type === "approval/requested") {
        notificationQueue = notificationQueue.then(() => this.#handleApproval(frame, agentContext, streamCallback));
        return;
      }
      if (payload.type === "question/requested") {
        notificationQueue = notificationQueue.then(() => this.#handleQuestion(frame, agentContext));
        return;
      }
      if (payload.type !== "session/event") return;
      notificationQueue = notificationQueue.then(async () => {
        const result = await adapter.handle(payload.event, payload.view || null);
        if (result?.kind === "turn-start") {
          this.turnId = result.turnId;
          this.running = true;
        }
        if (result?.kind === "turn-end") turnEnd = result;
        maybeSettle();
      }).catch(rejectTurn);
    };
    const onHost = (frame) => {
      const payload = frame?.payload;
      if (payload?.sessionId !== this.sessionId) return;
      if (payload.type === "host/session-status") {
        if (payload.running) {
          seenRunning = true;
          idle = false;
          this.running = true;
        } else if (seenRunning) {
          idle = true;
          maybeSettle();
        }
      }
      if (payload.type === "host/agent-error") rejectTurn(new Error(payload.message || "DSH Agent 执行失败"));
    };
    const onStreamError = ({ error }) => rejectTurn(error);
    const onExit = () => rejectTurn(new Error("DSH 运行时在 Turn 完成前退出"));
    const onAbort = () => {
      void this.cancel();
      if (!seenRunning && !settled) rejectTurn(abortError());
    };
    this.client.on("mux", onMux);
    this.client.on("host", onHost);
    this.client.on("stream-error", onStreamError);
    this.client.on("exit", onExit);
    agentContext?.signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      if (agentContext?.signal?.aborted) throw abortError();
      const content = withSkillReferences(await dshPromptContent(turnInput(agentContext), {
        fallbackText: agentContext?.input_data?.user_message,
      }), agentContext);
      let prompted;
      try {
        prompted = await this.client.request("session.prompt", {
          sessionId: this.sessionId,
          mode: "queue",
          content,
        }, { rpcId: agentContext?.userMessageId || randomUUID() });
      } catch (error) {
        throw normalizeDshPromptError(error);
      }
      if (agentContext?.signal?.aborted) {
        await this.cancel();
        if (!seenRunning) throw abortError();
      }
      if (prompted?.command) {
        const commandTurnId = `dsh:${this.sessionId}:command:${randomUUID()}`;
        this.turnId = commandTurnId;
        await emit("turn/started", {
          threadId: this.sessionId,
          turnId: commandTurnId,
          turn: { id: commandTurnId, status: "inProgress", startedAt: Date.now() / 1000 },
        });
        if (prompted.command.text) {
          await emit("item/completed", {
            threadId: this.sessionId,
            turnId: commandTurnId,
            item: { id: `${commandTurnId}:answer`, type: "agentMessage", text: prompted.command.text, status: "completed" },
          });
        }
        turnEnd = { reason: { kind: "completed" }, turnId: commandTurnId };
      } else {
        turnEnd = await completion;
      }
      await notificationQueue;
      const status = agentContext?.signal?.aborted ? "interrupted" : dshTurnStatus(turnEnd.reason);
      await emit("turn/completed", {
        threadId: this.sessionId,
        turnId: turnEnd.turnId || this.turnId,
        turn: {
          id: turnEnd.turnId || this.turnId,
          status,
          completedAt: Date.now() / 1000,
        },
      });
      await notificationQueue;
      return { success: status === "completed", status, thread_id: this.sessionId };
    } finally {
      this.running = false;
      this.client.off("mux", onMux);
      this.client.off("host", onHost);
      this.client.off("stream-error", onStreamError);
      this.client.off("exit", onExit);
      agentContext?.signal?.removeEventListener?.("abort", onAbort);
    }
  }

  cancel() {
    if (!this.sessionId) return Promise.resolve({ accepted: false });
    return this.client.request("session.cancel", { sessionId: this.sessionId }).catch(() => ({ accepted: false }));
  }

  async steer(input, options = {}) {
    if (!this.sessionId || !this.running) {
      const error = new Error("当前 DSH Turn 还不能接收补充内容");
      error.code = "AGENT_TURN_NOT_STEERABLE";
      throw error;
    }
    const content = await dshPromptContent(
      Array.isArray(input) ? input : [{ type: "text", text: String(input || "") }],
    );
    try {
      return await this.client.request(
        "session.prompt",
        { sessionId: this.sessionId, mode: "steer", content },
        { rpcId: options.clientUserMessageId || randomUUID() },
      );
    } catch (error) {
      throw normalizeDshPromptError(error);
    }
  }
}

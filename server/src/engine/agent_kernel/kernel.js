import { randomUUID } from "node:crypto";
import { AppServerClient } from "./app_server_client.js";
import { resolveAgentRuntimeBinary } from "./runtime_binary.js";
import { createDynamicToolBridge } from "./dynamic_tools.js";
import { APP_DISPLAY_NAME } from "../../config/app_name.js";

// 客户端身份：title 取自主进程注入的 DSH_APP_NAME（用户自定义应用名，见 config/app_name.js）。
const DEFAULT_CLIENT_INFO = Object.freeze({ name: "dsh-desktop", title: APP_DISPLAY_NAME, version: "0.0.1" });
const runtimeStartupQueues = new Map();
const SUBAGENT_SOURCE_KINDS = Object.freeze([
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
]);

function serializeRuntimeStartup(key, task) {
  const previous = runtimeStartupQueues.get(key) || Promise.resolve();
  const running = previous.catch(() => {}).then(task);
  runtimeStartupQueues.set(key, running);
  return running.finally(() => {
    if (runtimeStartupQueues.get(key) === running) runtimeStartupQueues.delete(key);
  });
}

function turnIdOf(params = {}) {
  return params.turn?.id || params.turnId || params.turn_id || null;
}

function threadIdOf(params = {}) {
  return params.threadId || params.thread?.id || params.thread_id || null;
}

function compactionItem(params = {}) {
  return params.item?.type === "contextCompaction" ? params.item : null;
}

function totalTokens(usage = null) {
  // `last` is the active context size; `total` is accumulated session usage.
  const value = usage?.last?.totalTokens ?? usage?.last?.total_tokens;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function emptyPermissionGrant() {
  // Codex 0.147.0 does not model permission approval as a decision string.
  // An empty turn-scoped grant is the protocol-defined way to grant nothing.
  return { permissions: {}, scope: "turn" };
}

function quotedConfigKeySegment(value) {
  // config/value/write parses a TOML-style dotted key. JSON string escaping is
  // compatible with TOML basic strings for quotes, slashes and U+0000-U+001F;
  // DEL is also forbidden by TOML but JSON leaves it literal, so escape it
  // explicitly. This keeps unusual but valid project paths inside one segment.
  return JSON.stringify(String(value)).replace(/\u007f/g, "\\u007f");
}

export class AgentKernel {
  constructor({
    binary = null,
    args = ["app-server"],
    cwd = process.cwd(),
    env = process.env,
    requestTimeoutMs = 30_000,
    clientInfo = DEFAULT_CLIENT_INFO,
    experimentalApi = true,
    skillExtraRoots = [],
    approvalHandler = null,
    mcpElicitationHandler = null,
    clientFactory = (options) => new AppServerClient(options),
  } = {}) {
    this.binary = binary;
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientInfo = clientInfo;
    this.experimentalApi = experimentalApi;
    this.skillExtraRoots = [...new Set(skillExtraRoots.map((root) => String(root || "").trim()).filter(Boolean))];
    this.defaultApprovalHandler = approvalHandler;
    this.defaultMcpElicitationHandler = mcpElicitationHandler;
    this.clientFactory = clientFactory;
    this.instanceId = randomUUID();
    this.client = null;
    this.initialized = false;
    this.toolBridges = new Map();
    this.approvalHandlers = new Map();
    this.userInputHandlers = new Map();
    this.mcpElicitationHandlers = new Map();
    this.threadTokenUsage = new Map();
    this.knownThreads = new Map();
    this.threadParents = new Map();
    this.threadStatuses = new Map();
    this.activeTurns = new Map();
    // One native Thread can have only one active Turn. Keep at most one local
    // interruption tombstone per Thread to reject a late turn/started race
    // without accumulating every historical Turn id forever.
    this.inactiveTurns = new Map();
    this.runningTurnThreads = new Set();
    this.runningTurnStops = new Set();
    this.globalNotificationThreadId = null;
    this.serverRequests = new Map();
    this.mcpOauthAttempts = new Map();
    this.mcpOauthAttemptByConnection = new Map();
    this.runtimeNotificationListener = null;
    this.startPromise = null;
    this.stopPromise = null;
    this.stopping = false;
    this.subtreeStopBarriers = new Set();
    this.subtreeStopPromises = new Map();
  }

  async start() {
    if (this.stopping) {
      const error = new Error("Agent 运行时正在停止");
      error.code = "AGENT_KERNEL_STOPPING";
      throw error;
    }
    if (this.initialized && this.client?.running !== false) return this;
    if (this.startPromise) return this.startPromise;
    const runtimeHome = String(this.env?.CODEX_HOME || this.env?.HOME || "default");
    const pending = serializeRuntimeStartup(runtimeHome, async () => {
      if (this.initialized && this.client?.running !== false) return this;
      return this._startUnlocked();
    });
    this.startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = null;
    }
  }

  async _startUnlocked() {
    const binary = this.binary || resolveAgentRuntimeBinary({ env: this.env });
    const client = this.clientFactory({
      binary,
      args: this.args,
      cwd: this.cwd,
      env: this.env,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    this.client = client;
    this.runtimeNotificationListener = ({ method, params = {} }) => {
      this._observeRuntimeNotification(method, params);
      if (method === "thread/tokenUsage/updated") {
        const threadId = threadIdOf(params);
        if (threadId && params.tokenUsage) this.threadTokenUsage.set(threadId, params.tokenUsage);
        return;
      }
      if (method === "mcpServer/oauthLogin/completed") this._completeMcpOauthAttempt(params);
    };
    client.on("notification", this.runtimeNotificationListener);
    client.handle("item/tool/call", (params) => this._handleDynamicToolCall(params));
    client.handle("item/tool/requestUserInput", (params, message) => (
      this._handleTrackedServerRequest("item/tool/requestUserInput", params, message, () => this._handleUserInput(params))
    ));
    client.handle("mcpServer/elicitation/request", (params, message) => (
      this._handleTrackedServerRequest("mcpServer/elicitation/request", params, message, () => this._handleMcpElicitation(params))
    ));
    client.handle("currentTime/read", () => ({ currentTimeAt: Math.floor(Date.now() / 1000) }));
    for (const method of [
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
    ]) {
      client.handle(method, (params, message) => (
        this._handleTrackedServerRequest(method, params, message, () => this._handleApproval(method, params))
      ));
    }
    try {
      await client.start();
      const result = await client.request("initialize", {
        clientInfo: this.clientInfo,
        capabilities: {
          experimentalApi: this.experimentalApi,
          // This Host does not implement `attestation/generate`.
          requestAttestation: false,
          // The Host renders supported primitive fields and returns a valid
          // cancel response when an extended MCP form cannot be rendered.
          mcpServerOpenaiFormElicitation: true,
        },
      });
      client.notify("initialized", {});
      this.initialized = true;
      this.initializeResult = result;
      if (this.skillExtraRoots.length) {
        await client.request("skills/extraRoots/set", { extraRoots: this.skillExtraRoots });
      }
      return this;
    } catch (error) {
      this.initialized = false;
      client.off("notification", this.runtimeNotificationListener);
      try { await client.stop?.(); } catch { /* failed startup cleanup is best-effort */ }
      if (this.client === client) this.client = null;
      this.runtimeNotificationListener = null;
      throw error;
    }
  }

  async probe() {
    await this.start();
    const models = await this.client.request("model/list", { limit: 20 });
    return {
      running: true,
      binary: this.binary || resolveAgentRuntimeBinary({ env: this.env }),
      userAgent: this.initializeResult?.userAgent || null,
      modelCount: Array.isArray(models?.data) ? models.data.length : Array.isArray(models?.models) ? models.models.length : 0,
      models,
    };
  }

  async listSkills({ cwds = [], forceReload = false } = {}) {
    await this.start();
    return this.client.request("skills/list", { cwds, forceReload });
  }

  async fuzzyFileSearch({ query = "", roots = [], cancellationToken = null } = {}) {
    await this.start();
    return this.client.request("fuzzyFileSearch", {
      query: String(query || ""),
      roots: [...new Set((Array.isArray(roots) ? roots : [])
        .map((root) => String(root || "").trim())
        .filter(Boolean))],
      ...(cancellationToken ? { cancellationToken: String(cancellationToken) } : {}),
    });
  }

  async listApps({ cursor = null, limit = 100, threadId = null, forceRefetch = false } = {}) {
    await this.start();
    return this.client.request("app/list", {
      ...(cursor ? { cursor } : {}),
      ...(Number(limit) > 0 ? { limit: Number(limit) } : {}),
      ...(threadId ? { threadId } : {}),
      forceRefetch: forceRefetch === true,
    });
  }

  async listCollaborationModes() {
    await this.start();
    return this.client.request("collaborationMode/list", {});
  }

  async setSkillExtraRoots(extraRoots = []) {
    await this.start();
    return this.client.request("skills/extraRoots/set", { extraRoots });
  }

  async setSkillEnabled({ path = null, name = null, enabled = true } = {}) {
    await this.start();
    return this.client.request("skills/config/write", {
      ...(path ? { path } : {}),
      ...(name ? { name } : {}),
      enabled: !!enabled,
    });
  }

  async readConfig({ includeLayers = true, cwd = null } = {}) {
    await this.start();
    return this.client.request("config/read", {
      includeLayers: includeLayers === true,
      ...(cwd ? { cwd } : {}),
    });
  }

  /**
   * Codex 0.147.0 requires an explicit trust decision for unfamiliar local
   * projects before sandbox writes are allowed. Mark a project workspace root
   * trusted in the runtime config (idempotent).
   */
  async setProjectTrustLevel(projectPath, { trustLevel = "trusted" } = {}) {
    const root = String(projectPath || "").trim();
    if (!root) return null;
    if (trustLevel !== "trusted" && trustLevel !== "untrusted") {
      throw new Error(`不支持的项目可信级别: ${trustLevel}`);
    }
    await this.start();
    return this.client.request("config/value/write", {
      keyPath: `projects.${quotedConfigKeySegment(root)}.trust_level`,
      value: trustLevel,
      mergeStrategy: "upsert",
    });
  }

  async writeConfigValue({ keyPath, value, mergeStrategy = "replace", filePath = null, expectedVersion = null } = {}) {
    await this.start();
    return this.client.request("config/value/write", {
      keyPath,
      value,
      mergeStrategy,
      ...(filePath ? { filePath } : {}),
      ...(expectedVersion ? { expectedVersion } : {}),
    });
  }

  async reloadMcpServers() {
    await this.start();
    return this.client.request("config/mcpServer/reload", {});
  }

  async listMcpServerStatus({ cursor = null, limit = null, detail = "full", threadId = null } = {}) {
    await this.start();
    return this.client.request("mcpServerStatus/list", {
      ...(cursor ? { cursor } : {}),
      ...(Number(limit) > 0 ? { limit: Number(limit) } : {}),
      ...(detail ? { detail } : {}),
      ...(threadId ? { threadId } : {}),
    });
  }

  async startMcpOauthLogin({ name, threadId = null, scopes = null, timeoutSecs = null } = {}) {
    await this.start();
    const attempt = this._beginMcpOauthAttempt({ name, threadId });
    try {
      const response = await this.client.request("mcpServer/oauth/login", {
        name,
        ...(threadId ? { threadId } : {}),
        ...(Array.isArray(scopes) && scopes.length ? { scopes } : {}),
        ...(Number(timeoutSecs) > 0 ? { timeoutSecs: Number(timeoutSecs) } : {}),
      });
      return { ...response, oauthAttemptId: attempt.id };
    } catch (error) {
      this._finishMcpOauthAttempt(attempt, {
        completed: true,
        success: false,
        error: error?.message || "MCP 授权启动失败",
      });
      throw error;
    }
  }

  async waitForMcpOauthCompletion({ attemptId, name, threadId = null, timeoutMs = 120_000 } = {}) {
    await this.start();
    this._pruneMcpOauthAttempts();
    const attempt = this.mcpOauthAttempts.get(String(attemptId || ""));
    if (!attempt || attempt.name !== String(name || "") || attempt.threadId !== String(threadId || "")) {
      const error = new Error("Plugin MCP 授权记录不存在或已过期");
      error.code = "PLUGIN_MCP_OAUTH_ATTEMPT_NOT_FOUND";
      throw error;
    }
    if (attempt.outcome) return attempt.outcome;
    const waitMs = Math.max(100, Math.min(Number(timeoutMs) || 120_000, 120_000));
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({
        completed: false,
        success: false,
        name: attempt.name,
        threadId: attempt.threadId || null,
        error: null,
      }), waitMs);
    });
    try {
      return await Promise.race([attempt.completion, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async startThread({
    tools = [],
    toolContext = {},
    approvalHandler = null,
    userInputHandler = null,
    mcpElicitationHandler = null,
    signal = null,
    ...params
  } = {}) {
    await this.start();
    const bridge = createDynamicToolBridge({
      tools,
      context: toolContext,
      signal,
      isCallActive: (call) => this._isDynamicToolCallActive(call),
    });
    // Codex 0.147.0 moved thread sandbox control to the `sandbox` mode field;
    // the legacy thread-level `permissions` profile name is no longer accepted.
    // Custom read-only roots still flow through the thread `config` permissions
    // table (see withWorkspacePermissionProfile).
    const response = await this.client.request("thread/start", {
      cwd: params.cwd || this.cwd,
      approvalPolicy: params.approvalPolicy ?? "on-request",
      approvalsReviewer: params.approvalsReviewer ?? "user",
      sandbox: params.sandbox ?? "workspace-write",
      ephemeral: params.ephemeral ?? false,
      ...(params.model ? { model: params.model } : {}),
      ...(params.modelProvider ? { modelProvider: params.modelProvider } : {}),
      ...(params.baseInstructions ? { baseInstructions: params.baseInstructions } : {}),
      ...(params.developerInstructions ? { developerInstructions: params.developerInstructions } : {}),
      ...(params.config ? { config: params.config } : {}),
      ...(params.runtimeWorkspaceRoots ? { runtimeWorkspaceRoots: params.runtimeWorkspaceRoots } : {}),
      ...(params.selectedCapabilityRoots ? { selectedCapabilityRoots: params.selectedCapabilityRoots } : {}),
      dynamicTools: bridge.specs,
    }, { signal });
    const threadId = response?.thread?.id;
    if (!threadId) throw new Error("Agent thread/start 未返回 thread.id");
    this._rememberThread(response.thread);
    this._bindThread(threadId, { bridge, approvalHandler, userInputHandler, mcpElicitationHandler });
    return response;
  }

  async resumeThread(threadId, {
    tools = [],
    toolContext = {},
    approvalHandler = null,
    userInputHandler = null,
    mcpElicitationHandler = null,
    signal = null,
    ...params
  } = {}) {
    await this.start();
    const bridge = createDynamicToolBridge({
      tools,
      context: toolContext,
      signal,
      isCallActive: (call) => this._isDynamicToolCallActive(call),
    });
    const response = await this.client.request("thread/resume", { threadId, ...params }, { signal });
    this._rememberThread(response?.thread || { id: threadId });
    this._bindThread(threadId, { bridge, approvalHandler, userInputHandler, mcpElicitationHandler });
    return response;
  }

  async forkThread(threadId, {
    lastTurnId = null,
    beforeTurnId = null,
    signal = null,
    ...params
  } = {}) {
    await this.start();
    const id = String(threadId || "").trim();
    const last = String(lastTurnId || "").trim() || null;
    const before = String(beforeTurnId || "").trim() || null;
    if (!id) throw new Error("Agent thread/fork 缺少 threadId");
    if (last && before) throw new Error("Agent thread/fork 不能同时使用 lastTurnId 和 beforeTurnId");

    const response = await this.client.request("thread/fork", {
      threadId: id,
      ...(last ? { lastTurnId: last } : {}),
      ...(before ? { beforeTurnId: before } : {}),
      ...params,
    }, { signal });
    const forkedThreadId = String(response?.thread?.id || "").trim();
    if (!forkedThreadId) throw new Error("Agent thread/fork 未返回 thread.id");
    this._rememberThread(response.thread);
    return response;
  }

  async updateThreadSettings(threadId, params = {}) {
    await this.start();
    const id = String(threadId || "").trim();
    if (!id) throw new Error("Agent thread/settings/update 缺少 threadId");
    return this.client.request("thread/settings/update", { threadId: id, ...params });
  }

  async deleteThread(threadId, { signal = null } = {}) {
    await this.start();
    const id = String(threadId || "").trim();
    if (!id) throw new Error("Agent thread/delete 缺少 threadId");
    const response = await this.client.request("thread/delete", { threadId: id }, { signal });
    this._forgetThread(id);
    return response;
  }

  async archiveThread(threadId, { signal = null } = {}) {
    await this.start();
    const id = String(threadId || "").trim();
    if (!id) throw new Error("Agent thread/archive 缺少 threadId");
    const response = await this.client.request("thread/archive", { threadId: id }, { signal });
    this._forgetThread(id);
    return response;
  }

  async startTurn({ threadId, input, signal = null, ...params } = {}) {
    this._assertThreadActivityAllowed(threadId);
    await this.start();
    await this._prepareThreadForNewTurn(threadId);
    this._assertThreadActivityAllowed(threadId);
    const normalizedInput = Array.isArray(input) ? input : [{ type: "text", text: String(input || "") }];
    return this.client.request("turn/start", { threadId, input: normalizedInput, ...params }, { signal });
  }

  /**
   * Start a codex-native code review on an existing thread.
   * The review runs inline (on the current thread) and its output streams
   * through the same turn notification protocol (turn/started → items →
   * turn/completed) as a normal turn, so the UI can reuse existing rendering.
   *
   * `target` follows codex ReviewTarget:
   *   { type: "uncommittedChanges" } | { type: "baseBranch", branch } | { type: "commit", sha, title } | { type: "custom", instructions }
   */
  async startReview({ threadId, target, signal = null } = {}) {
    this._assertThreadActivityAllowed(threadId);
    await this.start();
    await this._prepareThreadForNewTurn(threadId);
    this._assertThreadActivityAllowed(threadId);
    return this.client.request("review/start", {
      threadId,
      target,
      delivery: "inline",
    }, { signal });
  }

  async runTurn({ threadId, input, signal = null, onNotification = null, ...params } = {}) {
    await this.start();
    if (signal?.aborted) {
      const error = new Error("Agent Turn 已取消");
      error.name = "AbortError";
      throw error;
    }
    const isInlineReview = Boolean(params.review);
    let turnId = null;
    let interruptTurnId = null;
    let reviewStartResolved = !isInlineReview;
    let reviewModeEntered = false;
    let reviewStartedPublished = false;
    const queuedReviewNotifications = [];
    let settled = false;
    let abortRequested = false;
    let interruptPromise = null;
    let abortListener = null;
    let notificationListener = null;
    let rejectCompleted = null;
    let kernelStopListener = null;
    // Capture this Turn's bridge. A later resume may bind a replacement, which
    // must not be revoked by delayed cleanup from the previous Turn.
    const turnBridge = this.toolBridges.get(threadId) || null;
    this.runningTurnThreads.add(threadId);
    if (!this.globalNotificationThreadId) this.globalNotificationThreadId = threadId;
    const abortError = () => {
      const error = new Error("Agent Turn 已取消");
      error.name = "AbortError";
      return error;
    };
    const interruptOnce = () => {
      const targetTurnId = interruptTurnId || (!isInlineReview ? turnId : null);
      if (!targetTurnId) return null;
      if (!interruptPromise) {
        interruptPromise = this.interruptTurn(threadId, targetTurnId).catch(() => null);
      }
      return interruptPromise;
    };
    const cleanup = () => {
      turnBridge?.revoke?.(abortRequested || signal?.aborted ? "Agent Turn 已取消" : "Agent Turn 已结束");
      if (notificationListener) this.client?.off("notification", notificationListener);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
      if (kernelStopListener) this.runningTurnStops.delete(kernelStopListener);
      this.runningTurnThreads.delete(threadId);
      if (this.globalNotificationThreadId === threadId) {
        this.globalNotificationThreadId = this.runningTurnThreads.values().next().value || null;
      }
    };
    const completed = new Promise((resolvePromise, reject) => {
      rejectCompleted = reject;
      notificationListener = (event) => {
        if (settled) return;
        const { method, params: notification } = event;
        const notificationThreadId = notification.threadId || notification.thread?.id || null;
        if (notificationThreadId && notificationThreadId !== threadId) return;
        if (!notificationThreadId && this.globalNotificationThreadId !== threadId) return;
        const rawNotificationTurnId = String(turnIdOf(notification) || "").trim();
        if (isInlineReview && !reviewStartResolved) {
          // review/start normally responds before the delegated reviewer starts,
          // but buffer the race so no internal id can leak into persisted/UI state.
          queuedReviewNotifications.push(event);
          return;
        }
        if (
          isInlineReview
          && method === "item/started"
          && notification?.item?.type === "enteredReviewMode"
          && rawNotificationTurnId === turnId
        ) {
          reviewModeEntered = true;
        }
        if (isInlineReview && method === "turn/started") {
          const validControlStart = rawNotificationTurnId === turnId
            || (reviewModeEntered && !interruptTurnId && rawNotificationTurnId);
          if (!validControlStart && rawNotificationTurnId !== interruptTurnId) return;
          // Codex 0.147 inline review exposes the delegated reviewer Turn here,
          // while review/start and the parent turn/completed use the canonical
          // outer review Turn. Lock the first review control id for interrupt.
          interruptTurnId ||= rawNotificationTurnId;
          if (reviewStartedPublished) return;
          reviewStartedPublished = true;
        }
        if (
          isInlineReview
          && rawNotificationTurnId
          && rawNotificationTurnId !== turnId
          && rawNotificationTurnId !== interruptTurnId
        ) {
          // Do not project arbitrary same-thread Turn activity into this Review.
          return;
        }
        if (
          isInlineReview
          && (method === "turn/completed" || method === "error")
          && rawNotificationTurnId
          && rawNotificationTurnId !== turnId
        ) {
          // A delegated reviewer terminal is not the terminal of the outer
          // review Turn. Fail closed until the canonical outer id completes.
          return;
        }
        let deliveredNotification = notification;
        if (
          isInlineReview
          && turnId
          && notification
          && typeof notification === "object"
          && rawNotificationTurnId === interruptTurnId
        ) {
          const normalized = { ...notification };
          if (rawNotificationTurnId && "turnId" in normalized) normalized.turnId = turnId;
          if (normalized.turn && typeof normalized.turn === "object" && normalized.turn.id) {
            normalized.turn = { ...normalized.turn, id: turnId };
          }
          deliveredNotification = normalized;
        }
        if (method === "turn/started") {
          const startedTurnId = String(turnIdOf(deliveredNotification) || "").trim();
          if (startedTurnId && !isInlineReview) {
            turnId = startedTurnId;
            interruptTurnId = startedTurnId;
          }
          if (abortRequested && interruptTurnId) {
            void interruptOnce();
            settled = true;
            cleanup();
            reject(abortError());
            return;
          }
        }
        onNotification?.(method, deliveredNotification);
        if (method === "turn/completed" && (!turnId || turnIdOf(deliveredNotification) === turnId)) {
          if (isInlineReview) this._deactivateTurn(threadId, null, "Agent Turn 已结束", { remember: false });
          settled = true;
          cleanup();
          resolvePromise(deliveredNotification);
        }
        if (method === "error" && deliveredNotification.willRetry !== true && (!turnId || deliveredNotification.turnId === turnId)) {
          if (isInlineReview) this._deactivateTurn(threadId, null, "Agent Turn 已结束", { remember: false });
          settled = true;
          cleanup();
          reject(new Error(deliveredNotification.error?.message || deliveredNotification.message || "Agent Turn 执行失败"));
        }
      };
      this.client.on("notification", notificationListener);
      abortListener = () => {
        if (settled) return;
        abortRequested = true;
        if (isInlineReview && !interruptTurnId) return;
        if (!(interruptTurnId || turnId)) return;
        void interruptOnce();
        settled = true;
        cleanup();
        reject(abortError());
      };
      signal?.addEventListener("abort", abortListener, { once: true });
    });
    kernelStopListener = () => {
      if (settled) return;
      abortRequested = true;
      settled = true;
      const error = new Error("Agent 运行时已停止");
      error.name = "AbortError";
      error.code = "AGENT_KERNEL_STOPPED";
      cleanup();
      rejectCompleted?.(error);
    };
    this.runningTurnStops.add(kernelStopListener);
    try {
      // Keep the start response observable after a local abort. JSON-RPC has no
      // request cancellation, so dropping this response could leave a started
      // Turn running without a known id to interrupt.
      const started = params.review
        ? await this.startReview({ threadId, target: params.review })
        : await this.startTurn({ threadId, input, ...params });
      turnId = String(started?.turn?.id || turnId || "").trim() || null;
      if (!turnId) throw new Error("Agent turn/start 未返回 turn.id");
      if (!isInlineReview) interruptTurnId ||= turnId;
      reviewStartResolved = true;
      if (!settled && queuedReviewNotifications.length) {
        for (const event of queuedReviewNotifications.splice(0)) notificationListener?.(event);
      }
      if (abortRequested || signal?.aborted) {
        abortRequested = true;
        if (!isInlineReview || interruptTurnId) {
          await interruptOnce();
          settled = true;
          cleanup();
          rejectCompleted?.(abortError());
          void completed.catch(() => {});
          throw abortError();
        }
      }
      return { started, completed: await completed };
    } catch (error) {
      settled = true;
      cleanup();
      void completed.catch(() => {});
      throw error;
    }
  }

  async interruptTurn(threadId, turnId) {
    const id = String(threadId || "").trim();
    const activeTurnId = String(turnId || "").trim();
    this._deactivateTurn(id, activeTurnId, "Agent Turn 已取消");
    await this.start();
    return this.client.request("turn/interrupt", { threadId: id, turnId: activeTurnId });
  }

  hasThread(threadId) {
    const id = String(threadId || "").trim();
    return Boolean(id && (this.knownThreads.has(id) || this.toolBridges.has(id)));
  }

  async readThread(threadId, { includeTurns = true } = {}) {
    await this.start();
    const response = await this.client.request("thread/read", {
      threadId,
      includeTurns: includeTurns === true,
    });
    if (response?.thread) this._rememberThread(response.thread);
    return response;
  }

  async injectThreadItems(threadId, items = [], { signal = null } = {}) {
    await this.start();
    const id = String(threadId || "").trim();
    if (!id) throw new Error("Agent thread/inject_items 缺少 threadId");
    const normalizedItems = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!normalizedItems.length) return {};
    return this.client.request("thread/inject_items", {
      threadId: id,
      items: normalizedItems,
    }, { signal });
  }

  async listSubagentThreads(parentThreadId, {
    recursive = true,
    limit = 100,
    cursor = null,
  } = {}) {
    await this.start();
    const response = await this.client.request("thread/list", {
      ...(recursive ? { ancestorThreadId: parentThreadId } : { parentThreadId }),
      sourceKinds: SUBAGENT_SOURCE_KINDS,
      limit: Math.max(1, Math.min(100, Number(limit) || 100)),
      ...(cursor ? { cursor } : {}),
      sortKey: "created_at",
      sortDirection: "asc",
    });
    for (const thread of response?.data || []) this._rememberThread(thread);
    return response;
  }

  async _listAllSubagentThreads(parentThreadId, {
    recursive = true,
    limit = 100,
    maxPages = 1_000,
  } = {}) {
    const data = [];
    const seenIds = new Set();
    const seenCursors = new Set();
    let cursor = null;
    let pages = 0;
    while (pages < maxPages) {
      let response;
      try {
        response = await this.listSubagentThreads(parentThreadId, { recursive, limit, cursor });
      } catch (error) {
        return {
          data,
          complete: false,
          pages,
          error: error?.message || String(error),
        };
      }
      pages += 1;
      for (const thread of response?.data || []) {
        const id = String(thread?.id || "").trim();
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        data.push(thread);
      }
      const nextCursor = response?.nextCursor ?? response?.next_cursor ?? null;
      if (!nextCursor) return { data, complete: true, pages, error: null };
      const cursorKey = typeof nextCursor === "string" ? nextCursor : JSON.stringify(nextCursor);
      if (!cursorKey || seenCursors.has(cursorKey)) {
        return {
          data,
          complete: false,
          pages,
          error: "Agent thread/list 返回了重复 cursor",
        };
      }
      seenCursors.add(cursorKey);
      cursor = nextCursor;
    }
    return {
      data,
      complete: false,
      pages,
      error: `Agent thread/list 超过 ${maxPages} 页安全上限`,
    };
  }

  async interruptThread(threadId, { turnId = null, drain = true, drainTimeoutMs = 1_000 } = {}) {
    const id = String(threadId || "").trim();
    if (!id) return {
      threadId: id,
      turnId: null,
      interrupted: false,
      reason: "missing_thread",
      settled: false,
      pendingCalls: 0,
    };
    let activeTurnId = String(turnId || this.activeTurns.get(id) || "").trim();
    if (activeTurnId) this._deactivateTurn(id, activeTurnId, "Agent Turn 已取消");
    await this.start();
    if (!activeTurnId) {
      let response;
      try {
        response = await this.readThread(id, { includeTurns: true });
      } catch (error) {
        return {
          threadId: id,
          turnId: null,
          interrupted: false,
          reason: "thread_read_failed",
          error: error?.message || String(error),
          settled: false,
          pendingCalls: 0,
        };
      }
      const turns = Array.isArray(response?.thread?.turns) ? response.thread.turns : [];
      activeTurnId = String([...turns].reverse().find((turn) => turn?.status === "inProgress")?.id || "");
      if (activeTurnId) {
        this._blockTurnForSubtreeStops(id, activeTurnId);
        this._deactivateTurn(id, activeTurnId, "Agent Turn 已取消");
      }
    }
    if (!activeTurnId) return {
      threadId: id,
      turnId: null,
      interrupted: false,
      reason: "not_running",
      settled: true,
      pendingCalls: 0,
    };
    await this.interruptTurn(id, activeTurnId);
    const drainage = drain
      ? await (this.toolBridges.get(id)?.drain?.({ timeoutMs: drainTimeoutMs, threadIds: [id] })
        ?? Promise.resolve({ settled: true, pendingCalls: 0 }))
      : { settled: true, pendingCalls: 0 };
    return {
      threadId: id,
      turnId: activeTurnId,
      interrupted: true,
      settled: drainage.settled !== false,
      pendingCalls: Number(drainage.pendingCalls || 0),
    };
  }

  interruptThreadTree(rootThreadId, options = {}) {
    const root = String(rootThreadId || "").trim();
    if (!root) return this._interruptThreadTree(rootThreadId, options);
    const existing = this.subtreeStopPromises.get(root);
    if (existing) return existing;

    let resolveStop;
    let rejectStop;
    const shared = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    // Publish the shared Promise before starting the operation so even a
    // re-entrant same-root caller observes the first stop pass.
    this.subtreeStopPromises.set(root, shared);
    const operation = this._interruptThreadTree(root, options).catch((error) => {
      const message = error?.message || String(error);
      // Any unexpected failure after a barrier is published must settle that
      // barrier. Keep it as a retryable partial tombstone so old runtime work
      // stays blocked, but never leave `inProgress` stuck forever.
      for (const barrier of this.subtreeStopBarriers) {
        if (barrier.root !== root || !barrier.inProgress) continue;
        barrier.inProgress = false;
        barrier.partial = true;
        barrier.enumerationComplete = false;
        barrier.turnsSettled = false;
        barrier.callsSettled = false;
        barrier.stopErrors.push({ threadId: root, phase: "subtree/stop", error: message });
      }
      throw error;
    });
    operation.then(resolveStop, rejectStop);
    const forget = () => {
      if (this.subtreeStopPromises.get(root) === shared) this.subtreeStopPromises.delete(root);
    };
    void shared.then(forget, forget);
    return shared;
  }

  async _interruptThreadTree(rootThreadId, {
    rootTurnId = null,
    drainTimeoutMs = 1_000,
    settleTimeoutMs = 1_000,
  } = {}) {
    const root = String(rootThreadId || "").trim();
    if (!root) {
      return {
        root: { threadId: root, turnId: null, interrupted: false, reason: "missing_thread", settled: false, pendingCalls: 0 },
        children: [],
        enumeration: { complete: false, pages: 0, error: "missing_thread" },
        partial: true,
        settled: false,
        pendingCalls: 0,
        pendingTurns: 0,
        barrierRetained: false,
      };
    }

    // Install the barrier before the first await. Runtime turn/started events
    // can still arrive while thread/list and turn/interrupt are in flight, but
    // they can no longer reactivate Host tools and are added to this stop pass.
    const barrier = {
      root,
      inProgress: true,
      threadIds: new Set([root]),
      turns: new Map(),
      completedTurns: new Set(),
      revision: 0,
      partial: false,
      enumerationComplete: false,
      turnsSettled: false,
      callsSettled: false,
      bridges: new Set(),
      stopErrors: [],
      lateInterrupts: new Map(),
      lateErrors: [],
    };
    this.subtreeStopBarriers.add(barrier);
    const initiallyObserved = [...this.knownThreads.values()]
      .filter((thread) => this._isDescendantOf(thread?.id, root));
    for (const thread of initiallyObserved) barrier.threadIds.add(String(thread?.id || "").trim());
    for (const id of barrier.threadIds) {
      const activeTurnId = String(
        id === root ? (rootTurnId || this.activeTurns.get(id) || "") : (this.activeTurns.get(id) || ""),
      ).trim();
      if (activeTurnId) this._recordSubtreeStopTurn(barrier, id, activeTurnId);
    }

    await this.start();
    const enumeration = await this._listAllSubagentThreads(root, { recursive: true, limit: 100 });
    const threadById = new Map();
    const refreshThreads = () => {
      for (const thread of [...enumeration.data, ...this.knownThreads.values()]) {
        const id = String(thread?.id || "").trim();
        if (!id || !(id === root || this._isDescendantOf(id, root))) continue;
        threadById.set(id, { ...thread, id });
        barrier.threadIds.add(id);
        this._blockThreadForSubtreeStops(id);
      }
      for (const id of barrier.threadIds) {
        if (id !== root && !threadById.has(id)) {
          threadById.set(id, {
            id,
            parentThreadId: this.threadParents.get(id) || this.knownThreads.get(id)?.parentThreadId || null,
          });
        }
      }
    };
    refreshThreads();

    const summaries = new Map();
    const attemptedTurns = new Set();
    const failedTurns = new Set();
    const readThreads = new Set();
    const stopErrors = [];
    const summaryFor = (threadId) => {
      const id = String(threadId || "").trim();
      if (!summaries.has(id)) {
        summaries.set(id, {
          threadId: id,
          turnId: null,
          interrupted: false,
          reason: "not_running",
          settled: true,
          pendingCalls: 0,
          turns: [],
        });
      }
      return summaries.get(id);
    };
    const turnKey = (threadId, turnId) => `${threadId}\u0000${turnId}`;
    const unresolvedRecordedTurns = (threadId) => [...(barrier.turns.get(threadId) || [])]
      .filter((turnId) => {
        const key = turnKey(threadId, turnId);
        return !attemptedTurns.has(key) && !barrier.completedTurns.has(key);
      });
    const discoverRunningTurns = async (threadId) => {
      const id = String(threadId || "").trim();
      if (unresolvedRecordedTurns(id).length || readThreads.has(id)) return;
      readThreads.add(id);
      try {
        const response = await this.readThread(id, { includeTurns: true });
        const turns = Array.isArray(response?.thread?.turns) ? response.thread.turns : [];
        for (const turn of turns.filter((candidate) => candidate?.status === "inProgress")) {
          this._recordSubtreeStopTurn(barrier, id, turn?.id);
        }
      } catch (error) {
        const message = error?.message || String(error);
        const summary = summaryFor(id);
        summary.reason = "thread_read_failed";
        summary.error = message;
        summary.settled = false;
        stopErrors.push({ threadId: id, phase: "thread/read", error: message });
      }
    };
    const interruptRecordedTurns = async (threadId) => {
      const id = String(threadId || "").trim();
      const summary = summaryFor(id);
      await discoverRunningTurns(id);
      for (const turnId of unresolvedRecordedTurns(id)) {
        const key = turnKey(id, turnId);
        attemptedTurns.add(key);
        try {
          await this.interruptTurn(id, turnId);
          summary.turnId = turnId;
          summary.interrupted = true;
          summary.reason = null;
          summary.turns.push({ turnId, interrupted: true });
        } catch (error) {
          const message = error?.message || String(error);
          failedTurns.add(key);
          summary.turnId = turnId;
          summary.error = message;
          summary.settled = false;
          summary.turns.push({ turnId, interrupted: false, error: message });
          stopErrors.push({ threadId: id, turnId, phase: "turn/interrupt", error: message });
        }
      }
    };
    const depth = (threadId) => {
      let value = 0;
      let parent = this.threadParents.get(threadId) || threadById.get(threadId)?.parentThreadId || null;
      const seen = new Set();
      while (parent && parent !== root && !seen.has(parent)) {
        seen.add(parent);
        value += 1;
        parent = this.threadParents.get(parent) || threadById.get(parent)?.parentThreadId || null;
      }
      return value;
    };
    const runInterruptPass = async () => {
      refreshThreads();
      const children = [...barrier.threadIds]
        .filter((id) => id && id !== root)
        .sort((a, b) => depth(b) - depth(a));
      for (const child of children) await interruptRecordedTurns(child);
      await interruptRecordedTurns(root);
    };
    const pendingTurnCount = () => [...barrier.turns.entries()]
      .reduce((total, [threadId, turns]) => total + [...turns]
        .filter((turnId) => {
          const key = turnKey(threadId, turnId);
          return !barrier.completedTurns.has(key)
            && (!attemptedTurns.has(key) || failedTurns.has(key));
        }).length, 0);
    const settleTurns = async () => {
      const timeout = Math.max(0, Math.min(30_000, Number(settleTimeoutMs) || 0));
      const deadline = Date.now() + timeout;
      while (true) {
        await runInterruptPass();
        if (failedTurns.size) return false;
        const revision = barrier.revision;
        await new Promise((resolve) => setImmediate(resolve));
        if (pendingTurnCount() === 0 && barrier.revision === revision) return true;
        if (Date.now() >= deadline) return false;
      }
    };

    let turnsSettled = await settleTurns();
    refreshThreads();
    const targetThreadIds = [...barrier.threadIds];
    const bridges = new Set(targetThreadIds.map((id) => this.toolBridges.get(id)).filter(Boolean));
    for (const bridge of bridges) barrier.bridges.add(bridge);
    const drainResults = await Promise.all([...bridges].map((bridge) => bridge.drain?.({
      timeoutMs: drainTimeoutMs,
      threadIds: targetThreadIds,
    }) ?? Promise.resolve({ settled: true, pendingCalls: 0 })));
    let callsSettled = drainResults.every((result) => result?.settled !== false);
    // A child can start while a cancellation-aware Host call is draining. The
    // barrier captured it, so make one more stable interrupt pass before return.
    turnsSettled = (await settleTurns()) && turnsSettled;

    refreshThreads();
    const finalTargetThreadIds = [...barrier.threadIds];
    const finalBridges = new Set(finalTargetThreadIds.map((id) => this.toolBridges.get(id)).filter(Boolean));
    for (const bridge of finalBridges) barrier.bridges.add(bridge);
    const pendingCalls = [...finalBridges].reduce((total, bridge) => total + Number(
      bridge.pendingCallCount?.({ threadIds: finalTargetThreadIds }) || 0,
    ), 0);
    callsSettled = callsSettled && pendingCalls === 0;
    for (const id of finalTargetThreadIds) {
      const pendingForThread = Number(this.toolBridges.get(id)?.pendingCallCount?.({ threadIds: [id] }) || 0);
      const summary = summaryFor(id);
      summary.pendingCalls = pendingForThread;
      if (pendingForThread > 0) summary.settled = false;
    }

    const children = [...barrier.threadIds]
      .filter((id) => id && id !== root)
      .sort((a, b) => depth(b) - depth(a));
    const parent = summaryFor(root);
    const enumerationStatus = {
      complete: enumeration.complete === true,
      pages: enumeration.pages,
      error: enumeration.error || null,
    };
    const partial = !enumerationStatus.complete || stopErrors.length > 0 || !turnsSettled || !callsSettled;
    barrier.partial = partial;
    barrier.enumerationComplete = enumerationStatus.complete;
    barrier.turnsSettled = turnsSettled;
    barrier.callsSettled = callsSettled;
    barrier.stopErrors = [...stopErrors];
    barrier.inProgress = false;
    if (!partial) {
      for (const previous of [...this.subtreeStopBarriers]) {
        if (previous !== barrier && !previous.inProgress && previous.root === root) {
          this.subtreeStopBarriers.delete(previous);
        }
      }
    }
    return {
      root: parent,
      children: children.map((id) => summaryFor(id)),
      enumeration: enumerationStatus,
      partial,
      settled: !partial,
      pendingCalls,
      pendingTurns: pendingTurnCount(),
      errors: stopErrors,
      barrierRetained: true,
    };
  }

  async steerTurn(threadId, turnId, input, { clientUserMessageId = null } = {}) {
    this._assertThreadActivityAllowed(threadId);
    await this.start();
    this._assertThreadActivityAllowed(threadId);
    const normalizedInput = Array.isArray(input) ? input : [{ type: "text", text: String(input || "") }];
    return this.client.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: normalizedInput,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
    });
  }

  async compactThread(threadId, { timeoutMs = Math.max(this.requestTimeoutMs * 2, 120_000) } = {}) {
    await this.start();
    const beforeUsage = this.threadTokenUsage.get(threadId) || null;
    let startedItem = null;
    let latestUsage = beforeUsage;
    let timer = null;
    let notificationListener = null;
    const completion = new Promise((resolvePromise, reject) => {
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (notificationListener) this.client.off("notification", notificationListener);
      };
      notificationListener = ({ method, params = {} }) => {
        if (threadIdOf(params) !== threadId) return;
        if (method === "thread/tokenUsage/updated" && params.tokenUsage) {
          latestUsage = params.tokenUsage;
          return;
        }
        const item = compactionItem(params);
        if (method === "item/started" && item) {
          startedItem = { item, turnId: turnIdOf(params) };
          return;
        }
        if (method === "item/completed" && item && (!startedItem || startedItem.item.id === item.id)) {
          const result = {
            threadId,
            turnId: turnIdOf(params) || startedItem?.turnId || null,
            itemId: item.id || startedItem?.item?.id || null,
          };
          setTimeout(() => {
            cleanup();
            resolvePromise(result);
          }, 0);
          return;
        }
        if (method === "error" && (!startedItem || !turnIdOf(params) || turnIdOf(params) === startedItem.turnId)) {
          cleanup();
          reject(new Error(params.error?.message || params.message || "上下文压缩失败"));
        }
      };
      this.client.on("notification", notificationListener);
      timer = setTimeout(() => {
        cleanup();
        const error = new Error(`上下文压缩超时 (${timeoutMs}ms)`);
        error.code = "AGENT_RUNTIME_COMPACTION_TIMEOUT";
        reject(error);
      }, timeoutMs);
    });
    try {
      await this.client.request("thread/compact/start", { threadId });
      const result = await completion;
      const afterUsage = latestUsage || this.threadTokenUsage.get(threadId) || null;
      return {
        ...result,
        before: totalTokens(beforeUsage),
        after: totalTokens(afterUsage),
        beforeUsage,
        afterUsage,
      };
    } catch (error) {
      if (notificationListener) this.client.off("notification", notificationListener);
      if (timer) clearTimeout(timer);
      void completion.catch(() => {});
      throw error;
    }
  }

  stop({ drainTimeoutMs = 1_000 } = {}) {
    if (this.stopPromise) return this.stopPromise;
    // Dynamic calls must fail closed as soon as stop() is invoked. Everything
    // before this method's first await runs synchronously for the caller.
    this.stopping = true;
    this.initialized = false;
    const bridges = new Set(this.toolBridges.values());
    for (const bridge of bridges) {
      bridge?.revoke?.("Agent 运行时已停止");
    }
    this.toolBridges.clear();
    this.activeTurns.clear();
    this.approvalHandlers.clear();
    this.userInputHandlers.clear();
    this.mcpElicitationHandlers.clear();
    for (const attempt of this.mcpOauthAttempts.values()) {
      if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer);
      if (!attempt.outcome) {
        this._finishMcpOauthAttempt(attempt, {
          completed: true,
          success: false,
          error: "Agent 运行时已停止",
        });
      }
    }
    this.mcpOauthAttempts.clear();
    this.mcpOauthAttemptByConnection.clear();
    this.serverRequests.clear();
    for (const stopRunningTurn of [...this.runningTurnStops]) stopRunningTurn();
    const work = this._finishStop({ bridges, drainTimeoutMs });
    let tracked = null;
    tracked = work.finally(() => {
      if (this.stopPromise === tracked) this.stopPromise = null;
      this.stopping = false;
    });
    this.stopPromise = tracked;
    return tracked;
  }

  async _finishStop({ bridges, drainTimeoutMs }) {
    const drainResults = await Promise.all([...bridges].map((bridge) => (
      bridge?.drain?.({ timeoutMs: drainTimeoutMs })
        ?? Promise.resolve({ settled: true, pendingCalls: 0 })
    )));
    const pendingCalls = drainResults.reduce((total, result) => total + Number(result?.pendingCalls || 0), 0);
    const settled = drainResults.every((result) => result?.settled !== false);
    await this.startPromise?.catch(() => {});
    this.initialized = false;
    const client = this.client;
    const notificationListener = this.runtimeNotificationListener;
    try {
      if (notificationListener) client?.off("notification", notificationListener);
      await client?.stop();
    } finally {
      if (this.client === client) this.client = null;
      if (this.runtimeNotificationListener === notificationListener) this.runtimeNotificationListener = null;
      this.toolBridges.clear();
      this.threadTokenUsage.clear();
      this.knownThreads.clear();
      this.threadParents.clear();
      this.threadStatuses.clear();
      this.activeTurns.clear();
      this.inactiveTurns.clear();
      this.subtreeStopBarriers.clear();
      this.runningTurnStops.clear();
    }
    return { settled, pendingCalls };
  }

  _bindThread(threadId, {
    bridge = null,
    approvalHandler = null,
    userInputHandler = null,
    mcpElicitationHandler = null,
  } = {}) {
    const id = String(threadId || "").trim();
    if (!id) return;
    if (bridge) this.toolBridges.set(id, bridge);
    if (approvalHandler) this.approvalHandlers.set(id, approvalHandler);
    if (userInputHandler) this.userInputHandlers.set(id, userInputHandler);
    if (mcpElicitationHandler) this.mcpElicitationHandlers.set(id, mcpElicitationHandler);
    // Native grandchildren may be ephemeral and absent from thread/list, so
    // refresh the complete graph already observed from runtime notifications.
    const seen = new Set([id]);
    for (const child of this.knownThreads.values()) {
      if (child?.parentThreadId === id) this._inheritThreadBindings(child.id, id, seen);
    }
  }

  _inheritThreadBindings(threadId, parentThreadId, seen = new Set()) {
    const id = String(threadId || "").trim();
    const parent = String(parentThreadId || "").trim();
    if (!(id && parent) || seen.has(id)) return;
    seen.add(id);
    const bridge = this.toolBridges.get(parent);
    if (bridge) this.toolBridges.set(id, bridge);
    const approval = this.approvalHandlers.get(parent);
    if (approval) this.approvalHandlers.set(id, approval);
    const userInput = this.userInputHandlers.get(parent);
    if (userInput) this.userInputHandlers.set(id, userInput);
    const elicitation = this.mcpElicitationHandlers.get(parent);
    if (elicitation) this.mcpElicitationHandlers.set(id, elicitation);
    for (const child of this.knownThreads.values()) {
      if (child?.parentThreadId === id) this._inheritThreadBindings(child.id, id, seen);
    }
  }

  _rememberThread(thread = {}) {
    const id = String(thread?.id || "").trim();
    if (!id) return;
    const previous = this.knownThreads.get(id) || {};
    const remembered = { ...previous, ...thread, id };
    this.knownThreads.set(id, remembered);
    const parent = String(thread?.parentThreadId || previous.parentThreadId || "").trim();
    if (parent) {
      this.threadParents.set(id, parent);
      this._inheritThreadBindings(id, parent);
    }
    if (thread?.status) this.threadStatuses.set(id, thread.status);
    this._blockThreadForSubtreeStops(id);
  }

  async _ensureThreadBindings(threadId) {
    const id = String(threadId || "").trim();
    if (!id) return;
    const hasBindings = (candidate) => (
      this.toolBridges.has(candidate)
      || this.approvalHandlers.has(candidate)
      || this.userInputHandlers.has(candidate)
      || this.mcpElicitationHandlers.has(candidate)
    );
    if (hasBindings(id)) return;

    const seen = new Set();
    let current = id;
    while (current && !seen.has(current) && seen.size < 32) {
      seen.add(current);
      let parent = this.threadParents.get(current)
        || this.knownThreads.get(current)?.parentThreadId
        || null;
      if (!parent) {
        try {
          const response = await this.client?.request("thread/read", {
            threadId: current,
            includeTurns: false,
          }, { timeoutMs: 2_000 });
          if (response?.thread) this._rememberThread(response.thread);
        } catch {
          return;
        }
        if (hasBindings(id)) return;
        parent = this.threadParents.get(current)
          || this.knownThreads.get(current)?.parentThreadId
          || null;
      }
      if (!parent) return;
      this._inheritThreadBindings(current, parent);
      if (hasBindings(id)) return;
      current = String(parent);
    }
  }

  _forgetThread(threadId) {
    const id = String(threadId || "").trim();
    if (!id) return;
    this._deactivateTurn(id, null, "Agent Thread 已结束", { remember: false });
    this.knownThreads.delete(id);
    this.threadParents.delete(id);
    this.threadStatuses.delete(id);
    this.activeTurns.delete(id);
    this.toolBridges.delete(id);
    this.approvalHandlers.delete(id);
    this.userInputHandlers.delete(id);
    this.mcpElicitationHandlers.delete(id);
    this.inactiveTurns.delete(id);
  }

  _isDynamicToolCallActive(params = {}) {
    if (this.stopping) return false;
    const threadId = String(threadIdOf(params) || "").trim();
    const turnId = String(turnIdOf(params) || "").trim();
    if (!(threadId && turnId)) return false;
    if (this._subtreeStopBarriersForThread(threadId).length) return false;
    return this.activeTurns.get(threadId) === turnId
      && this.inactiveTurns.get(threadId) !== turnId;
  }

  _isInteractionRequestBlocked(params = {}) {
    if (this.stopping) return true;
    const threadId = String(threadIdOf(params) || "").trim();
    if (!threadId) return false;
    if (this._subtreeStopBarriersForThread(threadId).length) return true;
    const turnId = String(turnIdOf(params) || "").trim();
    return Boolean(turnId && this.inactiveTurns.get(threadId) === turnId);
  }

  _deactivateTurn(threadId, turnId = null, reason = "Agent Turn 已结束", { remember = true } = {}) {
    const thread = String(threadId || "").trim();
    if (!thread) return null;
    const turn = String(turnId || this.activeTurns.get(thread) || "").trim();
    if (!turn) return null;
    if (remember) this.inactiveTurns.set(thread, turn);
    else if (this.inactiveTurns.get(thread) === turn) this.inactiveTurns.delete(thread);
    if (this.activeTurns.get(thread) === turn) this.activeTurns.delete(thread);
    this.toolBridges.get(thread)?.revokeTurn?.(thread, turn, reason);
    return turn;
  }

  _isDescendantOf(threadId, ancestorThreadId) {
    const ancestor = String(ancestorThreadId || "").trim();
    let current = String(threadId || "").trim();
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const parent = this.threadParents.get(current) || this.knownThreads.get(current)?.parentThreadId || null;
      if (parent === ancestor) return true;
      current = String(parent || "");
    }
    return false;
  }

  _threadBelongsToSubtreeStop(threadId, barrier) {
    const id = String(threadId || "").trim();
    return Boolean(id && barrier && (id === barrier.root || this._isDescendantOf(id, barrier.root)));
  }

  _subtreeStopBarriersForThread(threadId) {
    return [...this.subtreeStopBarriers]
      .filter((barrier) => this._threadBelongsToSubtreeStop(threadId, barrier));
  }

  _recordSubtreeStopTurn(barrier, threadId, turnId) {
    const thread = String(threadId || "").trim();
    const turn = String(turnId || "").trim();
    if (!(thread && turn) || !this._threadBelongsToSubtreeStop(thread, barrier)) return false;
    barrier.threadIds.add(thread);
    const turns = barrier.turns.get(thread) || new Set();
    const added = !turns.has(turn);
    turns.add(turn);
    barrier.turns.set(thread, turns);
    if (added) barrier.revision += 1;
    this.inactiveTurns.set(thread, turn);
    if (this.activeTurns.get(thread) === turn) this.activeTurns.delete(thread);
    const bridge = this.toolBridges.get(thread) || null;
    if (bridge) barrier.bridges?.add(bridge);
    bridge?.revokeTurn?.(thread, turn, "Agent Turn 已取消");
    if (!barrier.inProgress) {
      const key = `${thread}\u0000${turn}`;
      if (!barrier.lateInterrupts.has(key) && !barrier.completedTurns.has(key)) {
        const interrupt = this.interruptTurn(thread, turn)
          .catch((error) => {
            const message = error?.message || String(error);
            barrier.partial = true;
            barrier.lateErrors.push({ threadId: thread, turnId: turn, phase: "late_turn/interrupt", error: message });
          })
          .finally(() => barrier.lateInterrupts.delete(key));
        barrier.lateInterrupts.set(key, interrupt);
      }
    }
    return true;
  }

  _markSubtreeStopTurnCompleted(threadId, turnId) {
    const thread = String(threadId || "").trim();
    const turn = String(turnId || "").trim();
    if (!(thread && turn)) return;
    const key = `${thread}\u0000${turn}`;
    for (const barrier of this._subtreeStopBarriersForThread(thread)) {
      if (!barrier.completedTurns.has(key)) {
        barrier.completedTurns.add(key);
        barrier.revision += 1;
      }
    }
  }

  _blockThreadForSubtreeStops(threadId) {
    const thread = String(threadId || "").trim();
    if (!thread) return false;
    let blocked = false;
    for (const barrier of this._subtreeStopBarriersForThread(thread)) {
      barrier.threadIds.add(thread);
      const turn = String(this.activeTurns.get(thread) || "").trim();
      if (turn) this._recordSubtreeStopTurn(barrier, thread, turn);
      blocked = true;
    }
    return blocked;
  }

  _blockTurnForSubtreeStops(threadId, turnId) {
    const barriers = this._subtreeStopBarriersForThread(threadId);
    if (!barriers.length) return false;
    for (const barrier of barriers) this._recordSubtreeStopTurn(barrier, threadId, turnId);
    return true;
  }

  _assertThreadActivityAllowed(threadId) {
    const activeBarrier = this._subtreeStopBarriersForThread(threadId)
      .find((barrier) => barrier.inProgress);
    if (!activeBarrier) return;
    const error = new Error("Agent Thread 正在停止，不能启动新 Turn");
    error.code = "AGENT_SUBTREE_STOPPING";
    error.details = { rootThreadId: activeBarrier.root };
    throw error;
  }

  async _prepareThreadForNewTurn(threadId) {
    this._assertThreadActivityAllowed(threadId);
    // Successful stops retain a tombstone until the next explicit Host Turn so
    // late runtime starts cannot revive themselves. A partial stop is stricter:
    // it can only reopen once in-flight Host work has drained and discovery /
    // interrupt completed without uncertainty.
    for (const barrier of this._subtreeStopBarriersForThread(threadId)) {
      if (barrier.inProgress) continue;
      if (barrier.lateInterrupts.size) {
        await Promise.allSettled([...barrier.lateInterrupts.values()]);
      }
      const drainResults = await Promise.all([...barrier.bridges].map((bridge) => bridge.drain?.({
        timeoutMs: 0,
        threadIds: [...barrier.threadIds],
      }) ?? Promise.resolve({ settled: true, pendingCalls: 0 })));
      const pendingCalls = drainResults.reduce((total, result) => total + Number(result?.pendingCalls || 0), 0);
      const unsafePartial = barrier.enumerationComplete !== true
        || barrier.turnsSettled !== true
        || barrier.stopErrors.length > 0
        || barrier.lateErrors.length > 0
        || pendingCalls > 0;
      if (barrier.partial && unsafePartial) {
        const error = new Error("Agent Thread 上一次停止尚未完全结算");
        error.code = "AGENT_SUBTREE_STOP_PARTIAL";
        error.details = {
          rootThreadId: barrier.root,
          enumerationComplete: barrier.enumerationComplete === true,
          turnsSettled: barrier.turnsSettled === true,
          pendingCalls,
          errors: [...barrier.stopErrors, ...barrier.lateErrors],
        };
        throw error;
      }
      this.subtreeStopBarriers.delete(barrier);
    }
  }

  _observeRuntimeNotification(method, params = {}) {
    if (method === "thread/started" && params.thread) {
      this._rememberThread(params.thread);
      return;
    }
    const threadId = String(threadIdOf(params) || "").trim();
    if (method === "serverRequest/resolved") {
      const requestId = String(params.requestId ?? "");
      const binding = this.serverRequests.get(requestId);
      if (binding) {
        this.serverRequests.delete(requestId);
        Object.defineProperties(params, {
          localRequestId: { configurable: true, enumerable: false, value: binding.localRequestId },
          localRequestKind: { configurable: true, enumerable: false, value: binding.kind },
        });
      }
      return;
    }
    if (method === "item/completed" && params.item?.type === "dynamicToolCall" && threadId) {
      const hostResult = this.toolBridges.get(threadId)?.takeHostResult?.(params.item.id, {
        threadId,
        turnId: String(turnIdOf(params) || ""),
      });
      if (hostResult !== undefined) {
        // Keep Host-only metadata available to the local projection adapters
        // without adding it to the 0.147.0 JSON-RPC notification payload.
        Object.defineProperty(params.item, "hostResult", {
          configurable: true,
          enumerable: false,
          value: hostResult,
        });
      }
    }
    if (method === "thread/status/changed" && threadId) {
      this.threadStatuses.set(threadId, params.status || null);
      return;
    }
    if (["thread/closed", "thread/deleted"].includes(method) && threadId) {
      this._forgetThread(threadId);
      return;
    }
    if (method === "turn/started" && threadId) {
      const turnId = String(turnIdOf(params) || "").trim();
      if (!turnId || this._blockTurnForSubtreeStops(threadId, turnId)) return;
      if (this.inactiveTurns.get(threadId) === turnId) return;
      // A distinct start is the next native Turn for this Thread, so the one
      // pending interruption tombstone can be retired safely.
      this.inactiveTurns.delete(threadId);
      const previousTurnId = this.activeTurns.get(threadId);
      if (previousTurnId && previousTurnId !== turnId) {
        this._deactivateTurn(threadId, previousTurnId, "Agent Turn 已结束", { remember: false });
      }
      this.activeTurns.set(threadId, turnId);
      return;
    }
    if (method === "turn/completed" && threadId) {
      const turnId = String(turnIdOf(params) || "").trim();
      this._markSubtreeStopTurnCompleted(threadId, turnId);
      this._deactivateTurn(threadId, turnId || null, "Agent Turn 已结束", { remember: false });
      return;
    }
    if (method === "error" && params.willRetry !== true && threadId) {
      const turnId = String(turnIdOf(params) || "").trim();
      if (turnId) {
        this._markSubtreeStopTurnCompleted(threadId, turnId);
        this._deactivateTurn(threadId, turnId, "Agent Turn 已结束", { remember: false });
      }
      return;
    }
    const item = params.item;
    if (!["item/started", "item/completed"].includes(method) || item?.type !== "collabAgentToolCall") return;
    const parent = String(item.senderThreadId || threadId || "").trim();
    for (const receiver of item.receiverThreadIds || []) {
      const child = String(receiver || "").trim();
      if (!child) continue;
      this._rememberThread({ id: child, parentThreadId: parent });
    }
  }

  _mcpOauthConnectionKey({ name, threadId = null } = {}) {
    return `${String(threadId || "")}\u0000${String(name || "")}`;
  }

  _beginMcpOauthAttempt({ name, threadId = null } = {}) {
    this._pruneMcpOauthAttempts();
    const normalizedName = String(name || "");
    const normalizedThreadId = String(threadId || "");
    const connectionKey = this._mcpOauthConnectionKey({ name: normalizedName, threadId: normalizedThreadId });
    const previousId = this.mcpOauthAttemptByConnection.get(connectionKey);
    const previous = previousId ? this.mcpOauthAttempts.get(previousId) : null;
    if (previous && !previous.outcome) {
      this._finishMcpOauthAttempt(previous, {
        completed: true,
        success: false,
        error: "已开始新的授权流程",
      });
    }
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const attempt = {
      id: randomUUID(),
      name: normalizedName,
      threadId: normalizedThreadId,
      connectionKey,
      createdAt: Date.now(),
      completion,
      resolveCompletion,
      outcome: null,
      expiryTimer: null,
    };
    attempt.expiryTimer = setTimeout(() => {
      if (!attempt.outcome) {
        this._finishMcpOauthAttempt(attempt, {
          completed: true,
          success: false,
          error: "授权流程已过期",
        });
      }
      this.mcpOauthAttempts.delete(attempt.id);
    }, 5 * 60_000);
    attempt.expiryTimer.unref?.();
    this.mcpOauthAttempts.set(attempt.id, attempt);
    this.mcpOauthAttemptByConnection.set(connectionKey, attempt.id);
    return attempt;
  }

  _completeMcpOauthAttempt(params = {}) {
    const name = String(params.name || "");
    const threadId = String(threadIdOf(params) || "");
    const connectionKey = this._mcpOauthConnectionKey({ name, threadId });
    const attemptId = this.mcpOauthAttemptByConnection.get(connectionKey);
    const attempt = attemptId ? this.mcpOauthAttempts.get(attemptId) : null;
    if (!attempt) return;
    const oauthError = typeof params.error === "string" ? params.error : params.error?.message;
    this._finishMcpOauthAttempt(attempt, {
      completed: true,
      success: params.success === true,
      name,
      threadId: threadId || null,
      error: oauthError || null,
    });
  }

  _finishMcpOauthAttempt(attempt, outcome = {}) {
    if (!attempt || attempt.outcome) return;
    attempt.outcome = Object.freeze({
      completed: outcome.completed !== false,
      success: outcome.success === true,
      name: outcome.name || attempt.name,
      threadId: (outcome.threadId ?? attempt.threadId) || null,
      error: outcome.error || null,
    });
    attempt.resolveCompletion(attempt.outcome);
    if (this.mcpOauthAttemptByConnection.get(attempt.connectionKey) === attempt.id) {
      this.mcpOauthAttemptByConnection.delete(attempt.connectionKey);
    }
  }

  _pruneMcpOauthAttempts(now = Date.now()) {
    const maxAgeMs = 5 * 60_000;
    for (const [attemptId, attempt] of this.mcpOauthAttempts.entries()) {
      if (now - attempt.createdAt <= maxAgeMs) continue;
      if (!attempt.outcome) {
        this._finishMcpOauthAttempt(attempt, {
          completed: true,
          success: false,
          error: "授权流程已过期",
        });
      }
      if (attempt.expiryTimer) clearTimeout(attempt.expiryTimer);
      this.mcpOauthAttempts.delete(attemptId);
    }
  }

  async _handleDynamicToolCall(params) {
    await this._ensureThreadBindings(params.threadId);
    const bridge = this.toolBridges.get(params.threadId);
    if (!bridge) {
      return { success: false, contentItems: [{ type: "inputText", text: "该任务没有可用的应用工具。" }] };
    }
    return bridge.handleCall(params);
  }

  async _handleTrackedServerRequest(method, params = {}, message = {}, handler) {
    const requestId = String(message?.id ?? "");
    const kind = method === "item/tool/requestUserInput"
      ? "user_input"
      : method === "mcpServer/elicitation/request"
        ? "mcp_elicitation"
        : "approval";
    const nativeRequestId = params.approvalId || params.itemId || params.elicitationId || requestId;
    const requestThreadId = String(params.threadId || "");
    const localRequestId = nativeRequestId
      ? `${kind}:${this.instanceId}:${requestThreadId}:${String(nativeRequestId)}`
      : "";
    if (requestId && localRequestId) {
      this.serverRequests.set(requestId, {
        kind,
        localRequestId,
        threadId: params.threadId || null,
      });
      Object.defineProperty(params, "serverRequestId", {
        configurable: true,
        enumerable: false,
        value: requestId,
      });
      Object.defineProperty(params, "localRequestId", {
        configurable: true,
        enumerable: false,
        value: localRequestId,
      });
    }
    return handler();
  }

  async _handleApproval(method, params) {
    await this._ensureThreadBindings(params.threadId);
    if (this._isInteractionRequestBlocked(params)) {
      if (method === "item/permissions/requestApproval") return emptyPermissionGrant();
      return { decision: "decline" };
    }
    const handler = this.approvalHandlers.get(params.threadId) || this.defaultApprovalHandler;
    if (typeof handler === "function") return handler({ method, params });
    if (method === "item/permissions/requestApproval") return emptyPermissionGrant();
    return { decision: "decline" };
  }

  async _handleUserInput(params) {
    await this._ensureThreadBindings(params.threadId);
    if (this._isInteractionRequestBlocked(params)) return { answers: {} };
    const handler = this.userInputHandlers.get(params.threadId);
    if (typeof handler === "function") return handler(params);
    return { answers: {} };
  }

  async _handleMcpElicitation(params) {
    await this._ensureThreadBindings(params.threadId);
    if (this._isInteractionRequestBlocked(params)) return { action: "decline", content: null, _meta: null };
    const handler = this.mcpElicitationHandlers.get(params.threadId) || this.defaultMcpElicitationHandler;
    if (typeof handler === "function") return handler(params);
    return { action: "decline", content: null, _meta: null };
  }
}

export default AgentKernel;

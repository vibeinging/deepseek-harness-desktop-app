import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { dataRoot } from "../../config/paths.js";
import { dshRuntimeEnabled, resolveDshRuntimeDistribution } from "./source_locator.js";
import { createSessionProductHostDispatcher } from "./product_host_dispatcher.js";
import { ensureDshWorkspaceSession } from "./session_attachment.js";
import { prepareTrustedProfilePlugins } from "./trusted_client_plugins.js";

const CHILD_PATH = fileURLToPath(new URL("./source_runtime_child.mjs", import.meta.url));
const CLIENT_PATCH_PATH = fileURLToPath(new URL("./desktop_web.patch.yml", import.meta.url));
const START_TIMEOUT_MS = 60_000;
const CLIENT_SURFACE_TIMEOUT_MS = 60_000;
const STREAM_RETRY_BASE_MS = 500;
const STREAM_RETRY_MAX_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;

function errorFromPayload(payload, fallback) {
  const error = new Error(payload?.message || fallback);
  error.name = payload?.name || "Error";
  if (payload?.code) error.code = payload.code;
  if (payload?.stack) error.stack = payload.stack;
  return error;
}

function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

function streamFailure(stream, message, code = "DSH_EVENT_STREAM_FAILED") {
  const error = new Error(message);
  error.code = code;
  error.stream = stream;
  return error;
}

/** Accept only the loopback origin emitted by the trusted DSH child. */
export function normalizeDshClientSurface(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    const error = new Error("DSH 客户端地址不是受信任的 loopback HTTP origin");
    error.code = "DSH_CLIENT_SURFACE_INVALID";
    throw error;
  }
  return `${url.origin}/`;
}

export class DshRuntimeClient extends EventEmitter {
  constructor({
    env = process.env,
    spawn = fork,
    fetch: fetchImpl = globalThis.fetch,
    WebSocket: WebSocketImpl = globalThis.WebSocket,
    productHostDispatcher = createSessionProductHostDispatcher(),
  } = {}) {
    super();
    this.env = env;
    this.spawn = spawn;
    this.fetch = fetchImpl;
    this.WebSocket = WebSocketImpl;
    this.productHostDispatcher = productHostDispatcher;
    this.child = null;
    this.starting = null;
    this.closing = false;
    this.restarting = false;
    this.restartTimer = null;
    this.restartAttempt = 0;
    this.clientSurface = null;
    this.clientSurfaceError = null;
    this.streamController = null;
    this.streamLoop = null;
  }

  /**
   * Register the parent-owned identity for one DSH Session. The binding remains
   * valid across turns and child restarts; the child supplies only dshSessionId
   * on each product request.
   */
  registerProductHostSession({ db, userId, projectId, appSessionId, dshSessionId }) {
    if (typeof this.productHostDispatcher.bind === "function") {
      return this.productHostDispatcher.bind({ db, userId, projectId, appSessionId, dshSessionId });
    }
    return dshSessionId;
  }

  unregisterProductHostSession(dshSessionId) {
    if (typeof this.productHostDispatcher.clear === "function") {
      return this.productHostDispatcher.clear(dshSessionId);
    }
    return false;
  }

  async start() {
    if (this.starting) return this.starting;
    if (this.child?.connected) return this;
    this.starting = this.#start().finally(() => { this.starting = null; });
    return this.starting;
  }

  async #start() {
    const resolved = resolveDshRuntimeDistribution({ env: this.env });
    if (!resolved) throw new Error("DSH 运行时未启用");
    this.clientSurface = null;
    this.clientSurfaceError = null;
    const dshHome = this.env.DSH_RUNTIME_HOME || dataRoot();
    const childEnv = {
      ...process.env,
      ...this.env,
      DSH_RUNTIME_DISTRIBUTION: resolved.distribution,
      DSH_RUNTIME_VERSION: resolved.version || "",
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: this.env.DSH_TELEMETRY_DISABLED || "1",
      DSH_APP_BOOT_PATH: resolved.appBootPath,
      ...(resolved.profileBootPath ? { DSH_PROFILE_BOOT_PATH: resolved.profileBootPath } : {}),
    };
    let launchPath = CHILD_PATH;
    let launchArgs = [];
    if (resolved.launch === "cli") {
      await prepareTrustedProfilePlugins({
        appBootPath: resolved.appBootPath,
        env: childEnv,
        runtimeRoot: resolved.root,
        dshHome,
      });
      launchPath = resolved.entryPath;
      launchArgs = ["web", "--patch", CLIENT_PATCH_PATH];
    }
    const child = this.spawn(launchPath, launchArgs, {
      execPath: process.execPath,
      execArgv: resolved.execArgv,
      cwd: resolved.root,
      env: childEnv,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "advanced",
    });
    this.child = child;
    child.on("message", (message) => this.#onMessage(message));
    child.once("exit", (code, signal) => this.#onExit(child, code, signal));
    child.once("error", (error) => this.#fail(error));
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("DSH 源码运行时启动超时")), START_TIMEOUT_MS);
        timer.unref?.();
        const ready = () => {
          clearTimeout(timer);
          this.off("fatal", fatal);
          resolve();
        };
        const fatal = (error) => {
          clearTimeout(timer);
          this.off("ready", ready);
          reject(error);
        };
        this.once("ready", ready);
        this.once("fatal", fatal);
      });
    } catch (error) {
      if (child.connected) child.disconnect();
      child.kill();
      if (this.child === child) this.child = null;
      throw error;
    }
    return this;
  }

  #onMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "ready") {
      void this.#activateRuntime(message);
      return;
    }
    if (message.type === "client-ready") {
      try {
        this.clientSurface = normalizeDshClientSurface(message.url);
        this.clientSurfaceError = null;
        this.emit("client-surface", this.clientSurface);
      } catch (error) {
        this.clientSurface = null;
        this.clientSurfaceError = error;
        this.emit("client-surface-error", error);
      }
      return;
    }
    if (message.type === "fatal") {
      this.emit("fatal", errorFromPayload(message.error, "DSH 运行时启动失败"));
      return;
    }
    if (message.type === "product-cancel") {
      this.productHostDispatcher.cancel?.(message);
      return;
    }
    if (message.type === "product-request") {
      const child = this.child;
      if (!child?.connected) return;
      void this.productHostDispatcher.handle(message).then((response) => {
        if (child.connected) child.send(response);
      }).catch((error) => {
        if (!child.connected) return;
        child.send({
          type: "product-response",
          id: message.id,
          result: {
            ok: false,
            error: { code: "product-unavailable", message: error?.message || String(error) },
          },
        });
      });
      return;
    }
  }

  async #activateRuntime(message) {
    try {
      await this.#startEventStreams();
      this.emit("ready", message);
    } catch (error) {
      this.emit("fatal", error);
    }
  }

  async #startEventStreams() {
    this.#stopEventStreams();
    if (!this.clientSurface) {
      throw streamFailure("all", "DSH Web 客户端地址未在运行时就绪前发布", "DSH_EVENT_STREAM_SURFACE_MISSING");
    }
    const controller = new AbortController();
    this.streamController = controller;
    let openedResolve;
    let openedReject;
    const opened = new Promise((resolve, reject) => {
      openedResolve = resolve;
      openedReject = reject;
    });
    this.streamLoop = this.#runEventStreamLoop(controller, openedResolve, openedReject);
    await opened;
  }

  #stopEventStreams() {
    this.streamController?.abort();
    this.streamController = null;
    this.streamLoop = null;
  }

  async #runEventStreamLoop(lifecycle, openedResolve, openedReject) {
    let firstGeneration = true;
    let attempt = 0;
    while (!lifecycle.signal.aborted && this.child?.connected && !this.closing) {
      const generation = new AbortController();
      const abortGeneration = () => generation.abort();
      lifecycle.signal.addEventListener("abort", abortGeneration, { once: true });
      try {
        const streams = await Promise.all([
          this.#openEventStream("mux", generation.signal),
          this.#openEventStream("host", generation.signal),
        ]);
        if (firstGeneration) openedResolve();
        firstGeneration = false;
        attempt = 0;
        const ended = await Promise.race(streams.map(({ done }) => done));
        if (ended.error) throw ended.error;
        if (!generation.signal.aborted) {
          throw streamFailure("all", "DSH 事件流意外结束");
        }
      } catch (error) {
        if (lifecycle.signal.aborted || this.closing || !this.child?.connected) return;
        if (firstGeneration) {
          openedReject(error);
          return;
        }
        this.emit("stream-error", { stream: error?.stream || "all", error });
      } finally {
        lifecycle.signal.removeEventListener("abort", abortGeneration);
        generation.abort();
      }
      attempt += 1;
      const delay = Math.min(STREAM_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), STREAM_RETRY_MAX_MS);
      await abortableDelay(delay, lifecycle.signal);
    }
  }

  async #openEventStream(stream, signal) {
    if (typeof this.WebSocket !== "function") {
      throw streamFailure(stream, "当前 Node.js 运行时不支持 WebSocket", "DSH_EVENT_STREAM_WEBSOCKET_MISSING");
    }
    const url = new URL(`api/events.${stream}`, this.clientSurface);
    url.protocol = "ws:";
    const socket = new this.WebSocket(url);
    let opened = false;
    let openResolve;
    let openReject;
    let doneResolve;
    const open = new Promise((resolve, reject) => {
      openResolve = resolve;
      openReject = reject;
    });
    const done = new Promise((resolve) => { doneResolve = resolve; });
    const close = () => {
      try {
        socket.close(1000, "runtime stream stopped");
      } catch {
        // A socket that failed before negotiation is already closed.
      }
    };
    signal.addEventListener("abort", close, { once: true });
    socket.addEventListener("open", () => {
      opened = true;
      openResolve();
    }, { once: true });
    socket.addEventListener("message", (event) => this.#emitEventMessage(stream, event.data));
    socket.addEventListener("error", () => {
      const error = streamFailure(stream, `DSH ${stream} WebSocket 连接失败`, "DSH_EVENT_STREAM_WEBSOCKET_ERROR");
      if (!opened) openReject(error);
      else doneResolve({ error });
    });
    socket.addEventListener("close", () => {
      signal.removeEventListener("abort", close);
      if (!opened) {
        openReject(streamFailure(stream, `DSH ${stream} WebSocket 在就绪前关闭`, "DSH_EVENT_STREAM_WEBSOCKET_CLOSED"));
      } else {
        doneResolve({ error: null });
      }
    }, { once: true });
    await open;
    return { stream, socket, done };
  }

  #emitEventMessage(stream, data) {
    if (typeof data !== "string") {
      this.emit("stream-error", {
        stream,
        error: streamFailure(stream, `DSH ${stream} WebSocket 包含非文本消息`, "DSH_EVENT_STREAM_INVALID_FRAME"),
      });
      return;
    }
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      this.emit("stream-error", {
        stream,
        error: streamFailure(stream, `DSH ${stream} 事件流包含无效 JSON`, "DSH_EVENT_STREAM_INVALID_FRAME"),
      });
      return;
    }
    if (message?.type !== "server-request" || typeof message.rpcId !== "string"
      || !message.payload || typeof message.payload !== "object") {
      this.emit("stream-error", {
        stream,
        error: streamFailure(stream, `DSH ${stream} 事件流包含无效消息`, "DSH_EVENT_STREAM_INVALID_FRAME"),
      });
      return;
    }
    if (message.payload.type === "stream/error") {
      this.emit("stream-error", {
        stream,
        error: errorFromPayload(message.payload.error, `DSH ${stream} 事件流失败`),
      });
      return;
    }
    this.emit(stream, { rpcId: message.rpcId, payload: message.payload });
  }

  #onExit(exitedChild, code, signal) {
    if (this.child !== exitedChild) return;
    this.child = null;
    this.clientSurface = null;
    this.#stopEventStreams();
    const reason = signal || (code ?? "unknown");
    const error = new Error(`DSH 运行时已退出（${reason}）`);
    error.code = "DSH_RUNTIME_EXITED";
    if (this.starting) this.emit("fatal", error);
    this.emit("exit", { code, signal });
    // Auto-restart on unexpected exit (not a deliberate close()). This keeps
    // the resident mux-baseline subscriber's listener fed after a crash, and
    // avoids the cold-start latency on the next request. Deliberate shutdown
    // (close() sets this.closing = true) skips the restart.
    if (!this.closing && !this.restarting) this.#scheduleRestart();
  }

  /**
   * Schedule an automatic restart with exponential backoff (1s → 2s → 4s, cap
   * 8s, reset on successful start). The restart re-opens the mux stream so the
   * DSH baseline replays pending approval/question frames to the resident
   * subscriber. Only one restart timer is active at a time.
   */
  #scheduleRestart() {
    if (this.restartTimer !== null) return;
    const delay = Math.min(1000 * 2 ** this.restartAttempt, 8000);
    this.restartAttempt += 1;
    console.info(`[dsh-runtime] 自动重启中（${delay}ms 后，第 ${this.restartAttempt} 次）`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start().then(() => {
        this.restartAttempt = 0;
        console.info("[dsh-runtime] 自动重启成功");
        return this.reattachSessions();
      }).catch((error) => {
        console.error("[dsh-runtime] 自动重启失败:", error?.message || error);
        this.#scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref?.();
  }

  async reattachSessions() {
    const { listDshSessionBindings } = await import("./session_state.js");
    const results = [];
    for (const binding of listDshSessionBindings()) {
      if (!binding.cwd) {
        results.push({ ...binding, attached: false, error: "missing-cwd" });
        continue;
      }
      try {
        await ensureDshWorkspaceSession(this, { sessionId: binding.dshSessionId, cwd: binding.cwd });
        results.push({ ...binding, attached: true });
      } catch (error) {
        results.push({ ...binding, attached: false, error: error?.code || error?.message || String(error) });
      }
    }
    const failed = results.filter((result) => !result.attached);
    if (failed.length) console.error(`[dsh-runtime] 自动恢复会话失败 ${failed.length}/${results.length}`, failed);
    return results;
  }

  #fail(error) {
    this.#stopEventStreams();
    this.emit("fatal", error);
  }

  async request(method, payload = {}, { rpcId = randomUUID() } = {}) {
    return this.requestClientApi(method, payload, { rpcId });
  }

  /** Call one unary method on the trusted loopback DSH Web ApiProxy. */
  async requestClientApi(method, payload = {}, { rpcId = randomUUID() } = {}) {
    const surface = await this.waitForClientSurface();
    const response = await this.fetch(new URL(`api/${method}`, surface), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
    });
    if (!response.ok) {
      const error = new Error(`DSH Web ApiProxy 请求失败（HTTP ${response.status}）`);
      error.code = "DSH_WEB_API_HTTP_ERROR";
      throw error;
    }
    const message = await response.json();
    if (message?.rpcId !== rpcId || !message?.result || typeof message.result.ok !== "boolean") {
      const error = new Error("DSH Web ApiProxy 返回了无效响应");
      error.code = "DSH_WEB_API_INVALID_RESPONSE";
      throw error;
    }
    if (!message.result.ok) {
      const error = new Error(message.result.error?.message || "DSH Web ApiProxy 请求失败");
      error.code = message.result.error?.code || "DSH_WEB_API_FAILED";
      error.details = message.result.error?.details || {};
      throw error;
    }
    return message.result.value;
  }

  async respond(rpcId, payload) {
    const surface = await this.waitForClientSurface();
    const response = await this.fetch(new URL("api/respond", surface), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-response", rpcId, result: { ok: true, value: payload } }),
    });
    if (!response.ok) {
      const error = new Error(`DSH Web 响应提交失败（HTTP ${response.status}）`);
      error.code = "DSH_WEB_RESPOND_HTTP_ERROR";
      throw error;
    }
    const receipt = await response.json();
    if (receipt?.accepted !== true && !(receipt?.accepted === false && typeof receipt.reason === "string")) {
      const error = new Error("DSH Web 响应提交返回了无效回执");
      error.code = "DSH_WEB_RESPOND_INVALID_RECEIPT";
      throw error;
    }
    return receipt;
  }

  /** Wait for the official loopback DSH Web client mounted in this child. */
  async waitForClientSurface() {
    await this.start();
    if (this.clientSurface) return this.clientSurface;
    if (this.clientSurfaceError) throw this.clientSurfaceError;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.off("client-surface", ready);
        this.off("client-surface-error", failed);
        this.off("exit", exited);
      };
      const ready = (surface) => { cleanup(); resolve(surface); };
      const failed = (error) => { cleanup(); reject(error); };
      const exited = () => {
        const error = new Error("DSH 运行时在客户端界面就绪前退出");
        error.code = "DSH_CLIENT_SURFACE_EXITED";
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => {
        const error = new Error("DSH 客户端界面启动超时");
        error.code = "DSH_CLIENT_SURFACE_TIMEOUT";
        cleanup();
        reject(error);
      }, CLIENT_SURFACE_TIMEOUT_MS);
      timer.unref?.();
      this.once("client-surface", ready);
      this.once("client-surface-error", failed);
      this.once("exit", exited);
    });
  }

  async close() {
    this.closing = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.#stopEventStreams();
    const child = this.child;
    if (child?.connected) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      const timeout = new AbortController();
      child.send({ type: "shutdown" }, () => {});
      try {
        await Promise.race([exited, abortableDelay(CLOSE_TIMEOUT_MS, timeout.signal)]);
      } finally {
        timeout.abort();
      }
      if (child.connected) child.disconnect();
      if (this.child === child) child.kill();
    }
    await this.productHostDispatcher.dispose?.();
  }

  /** Restart the Profile tree after its ordered Bundle list changes. */
  async restart() {
    if (this.closing) {
      const error = new Error("DSH 运行时正在关闭，不能重启 Profile");
      error.code = "DSH_RUNTIME_CLOSING";
      throw error;
    }
    this.restarting = true;
    try {
      this.#stopEventStreams();
      const child = this.child;
      if (child) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        const timeout = new AbortController();
        try {
          await Promise.race([exited, abortableDelay(CLOSE_TIMEOUT_MS, timeout.signal)]);
        } finally {
          timeout.abort();
        }
        if (this.child === child) child.kill("SIGKILL");
      }
      this.child = null;
      this.clientSurface = null;
      await this.start();
      this.restartAttempt = 0;
      return this.reattachSessions();
    } finally {
      this.restarting = false;
    }
  }
}

let sharedClient = null;

export function getDshRuntimeClient() {
  sharedClient ||= new DshRuntimeClient();
  return sharedClient;
}

export function dshRuntimeStatus() {
  if (!dshRuntimeEnabled()) return { available: false, running: false, initialized: false };
  try {
    const resolved = resolveDshRuntimeDistribution();
    return {
      available: true,
      running: Boolean(sharedClient?.child?.connected),
      initialized: Boolean(sharedClient?.child?.connected),
      distribution: resolved.distribution,
      process_count: sharedClient?.child?.connected ? 1 : 0,
      error: null,
    };
  } catch (error) {
    return {
      available: false,
      running: false,
      initialized: false,
      process_count: 0,
      error: { code: error?.code || "DSH_RUNTIME_UNAVAILABLE", message: error?.message || String(error) },
    };
  }
}

export async function probeDshRuntime() {
  const client = getDshRuntimeClient();
  await client.start();
  const [host, catalog] = await Promise.all([
    client.request("host.describe", {}),
    client.request("llm.models", {}),
  ]);
  return {
    running: true,
    version: host.version,
    provider: host.provider || null,
    model: host.model || null,
    models: (catalog.groups || []).flatMap((group) => (
      (group.models || []).map((model) => ({ ...model, provider: group.id, provider_name: group.name }))
    )),
    failures: catalog.failures || [],
  };
}

export async function closeDshRuntimeClient() {
  const client = sharedClient;
  sharedClient = null;
  await client?.close();
}

export async function restartDshRuntimeClient() {
  if (!sharedClient?.child?.connected) return { restarted: false, sessions: [] };
  const sessions = await sharedClient.restart();
  return { restarted: true, sessions };
}

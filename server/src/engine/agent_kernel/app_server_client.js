import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { APP_DISPLAY_NAME } from "../../config/app_name.js";

function rpcError(payload = {}) {
  const error = new Error(payload.message || "Agent App Server 请求失败");
  error.code = payload.code ?? "AGENT_RUNTIME_RPC_ERROR";
  error.data = payload.data;
  return error;
}

function processExitError({ code, signal, stderr }) {
  const suffix = stderr ? `: ${stderr}` : "";
  const error = new Error(`Agent App Server 已退出(code=${code ?? "null"}, signal=${signal || "none"})${suffix}`);
  error.code = "AGENT_RUNTIME_EXITED";
  error.exitCode = code;
  error.signal = signal;
  return error;
}

export class AppServerClient extends EventEmitter {
  constructor({
    binary,
    args = ["app-server"],
    cwd = process.cwd(),
    env = process.env,
    requestTimeoutMs = 30_000,
    spawnFn = spawn,
  } = {}) {
    super();
    if (!binary) throw new Error("AppServerClient 需要 binary");
    this.binary = binary;
    this.args = [...args];
    this.cwd = cwd;
    this.env = { ...env };
    this.requestTimeoutMs = requestTimeoutMs;
    this.spawnFn = spawnFn;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.requestHandlers = new Map();
    this.stderrTail = [];
    this.stopping = false;
  }

  get running() {
    return Boolean(this.child && this.child.exitCode == null && !this.child.killed);
  }

  async start() {
    if (this.running) return this;
    this.stopping = false;
    const child = this.spawnFn(this.binary, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.child = child;
    child.once("error", (error) => this._fail(error));
    child.once("exit", (code, signal) => {
      const error = processExitError({ code, signal, stderr: this.stderrTail.join("\n") });
      this._fail(error);
      this.emit("exit", { code, signal, expected: this.stopping });
      this.child = null;
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity })
      .on("line", (line) => this._handleLine(line));
    createInterface({ input: child.stderr, crlfDelay: Infinity })
      .on("line", (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > 30) this.stderrTail.shift();
        this.emit("stderr", line);
      });
    await new Promise((resolvePromise, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolvePromise();
      };
      const onError = (error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
    return this;
  }

  handle(method, handler) {
    if (typeof handler !== "function") throw new TypeError(`Agent 请求处理器必须是函数: ${method}`);
    this.requestHandlers.set(method, handler);
    return () => this.requestHandlers.delete(method);
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs, signal } = {}) {
    if (!this.running) return Promise.reject(new Error("Agent App Server 尚未启动"));
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      let timer = null;
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        const error = new Error(`Agent 请求已取消: ${method}`);
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) return onAbort();
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      if (Number(timeoutMs) > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          signal?.removeEventListener("abort", onAbort);
          const error = new Error(`Agent 请求超时: ${method}`);
          error.code = "AGENT_RUNTIME_RPC_TIMEOUT";
          reject(error);
        }, Number(timeoutMs));
      }
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  respond(id, result) {
    this._send({ jsonrpc: "2.0", id, result });
  }

  respondError(id, error) {
    this._send({
      jsonrpc: "2.0",
      id,
      error: {
        code: Number.isInteger(error?.code) ? error.code : -32000,
        message: error?.message || String(error || "请求处理失败"),
      },
    });
  }

  async stop({ timeoutMs = 3_000 } = {}) {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    if (child.exitCode != null || child.killed) return;
    const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
    try { child.kill("SIGTERM"); } catch { return; }
    const timer = new Promise((resolvePromise) => {
      const id = setTimeout(resolvePromise, timeoutMs, "timeout");
      id.unref?.();
    });
    if (await Promise.race([exited, timer]) === "timeout") {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }
  }

  _send(message) {
    if (!this.running || !this.child.stdin.writable) throw new Error("Agent App Server 输入流不可用");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  _handleLine(line) {
    const text = String(line || "").trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.emit("protocolError", new Error(`Agent 返回了非 JSON 消息: ${text.slice(0, 500)}`));
      return;
    }
    if (message.id != null && ("result" in message || "error" in message) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(rpcError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.id != null && message.method) {
      void this._handleServerRequest(message);
      return;
    }
    if (message.method) {
      this.emit("notification", { method: message.method, params: message.params || {} });
      // EventEmitter treats an unhandled `error` event as an uncaught exception.
      // App Server uses "error" as a normal JSON-RPC notification method, so it
      // must stay on the generic notification channel unless a listener exists.
      if (message.method !== "error" || this.listenerCount("error") > 0) {
        this.emit(message.method, message.params || {});
      }
    }
  }

  async _handleServerRequest(message) {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.respondError(message.id, Object.assign(new Error(`${APP_DISPLAY_NAME}未处理 Agent 请求: ${message.method}`), { code: -32601 }));
      return;
    }
    try {
      this.respond(message.id, await handler(message.params || {}, message));
    } catch (error) {
      this.respondError(message.id, error);
    }
  }

  _fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.emit("failure", error);
  }
}

export default AppServerClient;

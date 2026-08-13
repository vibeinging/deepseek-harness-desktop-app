import { AgentKernel } from "./kernel.js";
import { resolveAgentRuntimeBinary } from "./runtime_binary.js";
import { stopChatCompletionsAdapter } from "./chat_completions_adapter.js";
import { agentRuntimeHome, userSkillsRoot } from "../../config/paths.js";

const runtimes = new Map();

export function agentRuntimeStatus() {
  let binary = null;
  let available = false;
  let error = null;
  try {
    binary = resolveAgentRuntimeBinary();
    available = true;
  } catch (cause) {
    error = { code: cause.code || "AGENT_RUNTIME_BINARY_NOT_FOUND", message: cause.message };
  }
  return {
    available,
    running: [...runtimes.values()].some((runtime) => runtime?.client?.running),
    initialized: [...runtimes.values()].some((runtime) => runtime?.initialized),
    process_count: runtimes.size,
    ...(process.env.DSH_EVAL_VERBOSE === "1" ? { runtime_keys: [...runtimes.keys()] } : {}),
    error,
  };
}

export function getAgentRuntime({ runtimeKey = "account", ...options } = {}) {
  const key = String(runtimeKey || "account");
  if (!runtimes.has(key)) {
    const runtimeEnv = {
      ...process.env,
      ...(options.env || {}),
      ...(process.env.DSH_AGENT_RUNTIME_HOME
        ? { HOME: agentRuntimeHome(), USERPROFILE: agentRuntimeHome() }
        : {}),
      CODEX_HOME: options.env?.CODEX_HOME || agentRuntimeHome(),
    };
    // This secret authenticates Electron-main attachment consent to the local
    // Server. It must never enter Codex commands, MCP servers, or child agents.
    delete runtimeEnv.DSH_ATTACHMENT_GRANT_SECRET;
    runtimes.set(key, new AgentKernel({
      ...options,
      skillExtraRoots: options.skillExtraRoots || [userSkillsRoot()],
      env: runtimeEnv,
    }));
  }
  return runtimes.get(key);
}

/** Find the already-running model runtime that owns an app-server Thread. */
export function findAgentRuntimeByThread(threadId) {
  const id = String(threadId || "").trim();
  if (!id) return null;
  for (const runtime of runtimes.values()) {
    if (runtime?.hasThread?.(id) || runtime?.toolBridges?.has(id)) return runtime;
  }
  return null;
}

export async function releaseAgentRuntimeIfIdle(runtime) {
  if (!runtime
    || runtime.activeTurns?.size > 0
    || runtime.serverRequests?.size > 0
    || [...(runtime.mcpOauthAttempts?.values?.() || [])].some((attempt) => !attempt?.outcome)) return false;
  const entry = [...runtimes.entries()].find(([, candidate]) => candidate === runtime);
  if (!entry) return false;
  runtimes.delete(entry[0]);
  await runtime.stop().catch(() => null);
  return true;
}

export async function probeAgentRuntime(options = {}) {
  return getAgentRuntime(options).probe();
}

export async function writeAgentSkillConfig(params, {
  runtimeKey = "skill-catalog",
  ...runtimeOptions
} = {}) {
  const writer = getAgentRuntime({ runtimeKey, ...runtimeOptions });
  const result = await writer.setSkillEnabled(params);
  const peers = [...runtimes.values()].filter((runtime) => runtime !== writer);
  for (const runtime of peers) {
    await runtime.setSkillEnabled(params).catch(() => {});
  }
  return result;
}

export async function reloadAgentMcpServers({ exclude = null } = {}) {
  const active = [...runtimes.values()].filter((runtime) => runtime !== exclude && runtime?.client?.running);
  return Promise.allSettled(active.map((runtime) => runtime.reloadMcpServers()));
}

export async function stopAgentRuntime() {
  const active = [...runtimes.values()];
  runtimes.clear();
  await Promise.allSettled(active.map((runtime) => runtime.stop()));
  await stopChatCompletionsAdapter();
}

export function resetAgentRuntimeForTests() {
  runtimes.clear();
}

export default getAgentRuntime;

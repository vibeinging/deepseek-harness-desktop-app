import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_DISPLAY_NAME } from "../../config/app_name.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(HERE, "../../..");

const TARGETS = Object.freeze({
  "darwin-arm64": { package: "codex-darwin-arm64", triple: "aarch64-apple-darwin", executable: "codex" },
  "darwin-x64": { package: "codex-darwin-x64", triple: "x86_64-apple-darwin", executable: "codex" },
  "linux-arm64": { package: "codex-linux-arm64", triple: "aarch64-unknown-linux-musl", executable: "codex" },
  "linux-x64": { package: "codex-linux-x64", triple: "x86_64-unknown-linux-musl", executable: "codex" },
  "win32-arm64": { package: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc", executable: "codex.exe" },
  "win32-x64": { package: "codex-win32-x64", triple: "x86_64-pc-windows-msvc", executable: "codex.exe" },
});

function existing(path) {
  return path && existsSync(path) ? resolve(path) : null;
}

export function agentRuntimeTarget(platform = process.platform, arch = process.arch) {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) {
    const error = new Error(`Agent 不支持当前平台: ${platform}/${arch}`);
    error.code = "AGENT_RUNTIME_PLATFORM_UNSUPPORTED";
    throw error;
  }
  return target;
}

export function agentRuntimeBinaryCandidates({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  serverRoot = SERVER_ROOT,
  resourcesPath = process.resourcesPath,
} = {}) {
  const target = agentRuntimeTarget(platform, arch);
  return [
    env.DSH_AGENT_RUNTIME_BIN,
    resourcesPath ? join(resourcesPath, "server", "node_modules", "@openai", target.package, "vendor", target.triple, "bin", target.executable) : null,
    join(serverRoot, "node_modules", "@openai", target.package, "vendor", target.triple, "bin", target.executable),
  ].filter(Boolean);
}

export function agentRuntimeRipgrepCandidates({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  serverRoot = SERVER_ROOT,
  resourcesPath = process.resourcesPath,
} = {}) {
  const target = agentRuntimeTarget(platform, arch);
  const executable = platform === "win32" ? "rg.exe" : "rg";
  return [
    env.DSH_AGENT_RG_BIN,
    resourcesPath
      ? join(resourcesPath, "server", "node_modules", "@openai", target.package, "vendor", target.triple, "codex-path", executable)
      : null,
    join(serverRoot, "node_modules", "@openai", target.package, "vendor", target.triple, "codex-path", executable),
  ].filter(Boolean);
}

export function resolveAgentRuntimeBinary(options = {}) {
  const candidates = agentRuntimeBinaryCandidates(options);
  const binary = candidates.map(existing).find(Boolean);
  if (binary) return binary;
  const error = new Error(
    `找不到 Agent 运行时，请重新安装${APP_DISPLAY_NAME}`,
  );
  error.code = "AGENT_RUNTIME_BINARY_NOT_FOUND";
  error.candidates = candidates;
  throw error;
}

export function resolveAgentRuntimeRipgrep(options = {}) {
  const candidates = agentRuntimeRipgrepCandidates(options);
  const binary = candidates.map(existing).find(Boolean);
  if (binary) return binary;
  const error = new Error(`找不到 Agent 随包文件搜索工具，请重新安装${APP_DISPLAY_NAME}`);
  error.code = "AGENT_RUNTIME_RG_NOT_FOUND";
  error.candidates = candidates;
  throw error;
}

export default resolveAgentRuntimeBinary;

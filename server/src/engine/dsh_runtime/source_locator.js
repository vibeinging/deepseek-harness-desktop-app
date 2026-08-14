import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const DEFAULT_SOURCE_ROOT = resolve(APP_ROOT, "../test-vibeinging");

function runtimeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function existingFile(path, message, code) {
  if (!existsSync(path)) throw runtimeError(message, code);
  return realpathSync(path);
}

function resolveAppBootEntry(require, message, code) {
  try {
    return existingFile(require.resolve("@deepseek-ai/dsh-app-boot"), message, code);
  } catch (error) {
    if (error?.code === code) throw error;
    throw runtimeError(message, code);
  }
}

function sourceDistribution(root) {
  const sourceRoot = realpathSync(root);
  const manifestPath = existingFile(
    join(sourceRoot, "apps/cli/package.json"),
    `DSH 源码目录不完整：${sourceRoot} 缺少 apps/cli/package.json`,
    "DSH_SOURCE_INVALID",
  );
  const profileBootPath = existingFile(
    join(sourceRoot, "apps/cli/src/profile-boot.ts"),
    `DSH 源码目录不完整：${sourceRoot} 缺少 apps/cli/src/profile-boot.ts`,
    "DSH_SOURCE_INVALID",
  );
  const entryPath = existingFile(
    join(sourceRoot, "apps/cli/src/bin.ts"),
    `DSH 源码目录不完整：${sourceRoot} 缺少 apps/cli/src/bin.ts`,
    "DSH_SOURCE_INVALID",
  );
  const require = createRequire(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const appBootPath = resolveAppBootEntry(
    require,
    `DSH 源码依赖尚未构建：${sourceRoot} 缺少 @deepseek-ai/dsh-app-boot 入口`,
    "DSH_SOURCE_DEPENDENCIES_MISSING",
  );
  let tsxImportPath;
  try {
    tsxImportPath = require.resolve("tsx/esm");
  } catch {
    throw runtimeError(
      `DSH 源码依赖尚未安装：请先在 ${sourceRoot} 执行 pnpm install`,
      "DSH_SOURCE_DEPENDENCIES_MISSING",
    );
  }
  return Object.freeze({
    distribution: "source",
    launch: "embed",
    root: sourceRoot,
    appBootPath,
    entryPath,
    installAnchor: manifestPath,
    profileBootPath,
    version: typeof manifest.version === "string" ? manifest.version : null,
    execArgv: ["--import", tsxImportPath],
  });
}

function npmDistribution(appRoot, env) {
  const serverManifest = join(appRoot, "server", "package.json");
  const require = createRequire(existsSync(serverManifest) ? serverManifest : join(appRoot, "package.json"));
  let manifestPath;
  const configuredRoot = String(env.DSH_NPM_PACKAGE_ROOT || "").trim();
  if (configuredRoot) {
    manifestPath = existingFile(
      join(resolve(configuredRoot), "package.json"),
      `DSH npm 包目录不完整：${configuredRoot} 缺少 package.json`,
      "DSH_NPM_PACKAGE_INVALID",
    );
  } else {
    try {
      manifestPath = require.resolve("@deepseek-ai/dsh/package.json");
    } catch {
      throw runtimeError(
        "没有找到 @deepseek-ai/dsh；请在 dsh-work Server 中安装固定版本的公开 npm 包",
        "DSH_NPM_PACKAGE_MISSING",
      );
    }
  }
  const root = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@deepseek-ai/dsh") {
    throw runtimeError(`DSH npm 包名不匹配：${manifest.name || "unknown"}`, "DSH_NPM_PACKAGE_INVALID");
  }
  const declaredBin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.dsh;
  const entryPath = existingFile(
    resolve(root, declaredBin || "lib/bin.js"),
    "当前 @deepseek-ai/dsh 包缺少稳定的 dsh CLI 入口",
    "DSH_NPM_CLI_ENTRY_MISSING",
  );
  const appBootPath = resolveAppBootEntry(
    createRequire(manifestPath),
    "当前 @deepseek-ai/dsh 包缺少正式的 Profile 管理入口",
    "DSH_NPM_PROFILE_ENTRY_MISSING",
  );
  return Object.freeze({
    distribution: "npm",
    launch: "cli",
    root,
    appBootPath,
    entryPath,
    installAnchor: manifestPath,
    version: typeof manifest.version === "string" ? manifest.version : null,
    execArgv: [],
  });
}

/**
 * Resolve the DSH installation used by the desktop runtime child.
 * Source mode uses the typed profile boot for development. npm mode launches
 * the package's public CLI entry and never imports a hashed private bundle.
 */
export function resolveDshRuntimeDistribution({ env = process.env, appRoot = APP_ROOT } = {}) {
  const distribution = String(env.DSH_RUNTIME_DISTRIBUTION || "").trim().toLowerCase();
  if (!distribution) return null;
  if (distribution === "source") {
    const sourceRoot = resolve(env.DSH_SOURCE_ROOT || resolve(appRoot, "../test-vibeinging"));
    if (!existsSync(sourceRoot)) {
      throw runtimeError(
        `没有找到 DSH 源码目录：${sourceRoot}。请设置 DSH_SOURCE_ROOT 指向 ${DEFAULT_SOURCE_ROOT}`,
        "DSH_SOURCE_NOT_FOUND",
      );
    }
    return sourceDistribution(sourceRoot);
  }
  if (distribution === "npm") return npmDistribution(appRoot, env);
  throw runtimeError(
    `不支持的 DSH_RUNTIME_DISTRIBUTION：${distribution}；只支持 source 或 npm`,
    "DSH_RUNTIME_DISTRIBUTION_INVALID",
  );
}

export function dshRuntimeEnabled(env = process.env) {
  return Boolean(String(env.DSH_RUNTIME_DISTRIBUTION || "").trim());
}

export const DSH_SOURCE_DEFAULT_ROOT = DEFAULT_SOURCE_ROOT;

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { dataRoot } from "../../config/paths.js";
import { resolveDshRuntimeDistribution } from "./source_locator.js";
import {
  prepareTrustedProfilePlugins,
  trustedDshProfilePluginNames,
} from "./trusted_client_plugins.js";
import {
  aggregateProfileThemes,
  readProfileThemeDescriptor,
} from "./profile_theme_manifest.js";

const execFileAsync = promisify(execFile);
const PROFILE_NAME = "web";
const SYSTEM_BUNDLES = new Set(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]);
const DSH_WORK_WORKBENCH_SLOT = "agent.workbench.tool";
const DSH_WORK_HOST_COMPONENTS = new Map([
  ["review", "dsh-work/review"],
  ["browser", "dsh-work/browser"],
  ["files", "dsh-work/files"],
  ["artifacts", "dsh-work/artifacts"],
  ["sites", "dsh-work/sites"],
]);
const DSH_WORK_HOST_ICONS = new Set(["archive", "dashboard", "file", "terminal", "world"]);
const CURRENT_DSH_SDK_VERSION = "0.1.0-rc.2";
const CURRENT_CORDIS_VERSION = "4.0.1";
const EXACT_REGISTRY_SPEC = /^(?<name>(?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+)@(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const EXACT_EXTERNAL_GIT_SPEC = /^github:dsh-external\/(?<repo>[a-z0-9._-]+)#(?<commit>[0-9a-f]{40})$/i;

function profileError(message, code, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function inside(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function readJson(path, code = "DSH_PROFILE_MANIFEST_INVALID") {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("必须是 JSON 对象");
    return parsed;
  } catch (error) {
    throw profileError(`无法读取 DSH Profile 包清单：${path}（${error?.message || error}）`, code);
  }
}

/** Validate the versioned dsh-work product descriptor at its package boundary. */
export function validateDshWorkProductDescriptor(descriptor, {
  packageName = "候选插件",
  allowHostComponents = false,
} = {}) {
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    throw profileError(`${packageName} 的产品描述必须是对象`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
  }
  if (descriptor.schema_version !== 1) {
    throw profileError(`${packageName} 的产品描述版本必须是 1`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
  }
  if (descriptor.contributions === undefined) return descriptor;
  if (!Array.isArray(descriptor.contributions)) {
    throw profileError(`${packageName} 的产品贡献必须是数组`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
  }
  const ids = new Set();
  descriptor.contributions.forEach((contribution, index) => {
    if (!contribution || typeof contribution !== "object" || Array.isArray(contribution)) {
      throw profileError(`${packageName} 的第 ${index + 1} 个产品贡献必须是对象`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
    }
    const required = ["slot", "id", "component", "label", "icon"];
    for (const field of required) {
      if (typeof contribution[field] !== "string" || !contribution[field].trim()) {
        throw profileError(`${packageName} 的第 ${index + 1} 个产品贡献缺少 ${field}`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
      }
    }
    if (contribution.slot !== DSH_WORK_WORKBENCH_SLOT) {
      throw profileError(`${packageName} 使用了不支持的产品位置：${contribution.slot}`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
    }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(contribution.id)) {
      throw profileError(`${packageName} 的产品贡献 id 无效：${contribution.id}`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
    }
    if (ids.has(contribution.id)) {
      throw profileError(`${packageName} 的产品贡献 id 重复：${contribution.id}`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
    }
    if (contribution.order !== undefined && !Number.isSafeInteger(contribution.order)) {
      throw profileError(`${packageName} 的产品贡献 order 必须是整数`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
    }
    if (!allowHostComponents) {
      throw profileError(
        `${packageName} 不能请求 dsh-work 宿主组件；社区页面贡献必须使用尚未开放的沙箱类型`,
        "DSH_PRODUCT_HOST_COMPONENT_FORBIDDEN",
      );
    }
    if (DSH_WORK_HOST_COMPONENTS.get(contribution.id) !== contribution.component) {
      throw profileError(`${packageName} 请求了未知的 dsh-work 宿主组件：${contribution.component}`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
    }
    if (!DSH_WORK_HOST_ICONS.has(contribution.icon)) {
      throw profileError(`${packageName} 请求了未知的工作台图标：${contribution.icon}`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
    }
    ids.add(contribution.id);
  });
  return descriptor;
}

function readProductDescriptor(packageDir, manifest, { allowHostComponents = false } = {}) {
  const declared = manifest?.dshWork?.product;
  if (declared === undefined) return null;
  if (typeof declared !== "string" || !declared.startsWith("./")) {
    throw profileError(`${manifest.name} 的 dshWork.product 必须是包内相对路径`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
  }
  const descriptorPath = realpathSync(resolve(packageDir, declared));
  if (!inside(packageDir, descriptorPath)) {
    throw profileError(`${manifest.name} 的产品描述不能越过包目录`, "DSH_PRODUCT_DESCRIPTOR_INVALID");
  }
  const descriptor = readJson(descriptorPath, "DSH_PRODUCT_DESCRIPTOR_INVALID");
  return validateDshWorkProductDescriptor(descriptor, {
    packageName: manifest.name,
    allowHostComponents,
  });
}

function productInterface(manifest, descriptor) {
  const value = descriptor?.interface || manifest?.dshWork?.interface;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sourceView(packageName, spec, packageDir, managed) {
  if (managed === "app" || managed === "system") {
    return { type: managed, path: packageDir, label: managed === "app" ? "随 dsh-work 提供" : "DSH 内置" };
  }
  if (/^(?:github:|git\+|https?:.*\.git)/i.test(spec)) return { type: "git", spec, label: "Git 固定版本" };
  if (/^(?:file:|link:|\/|[A-Za-z]:[\\/])/.test(spec)) return { type: "local", path: packageDir, spec, label: "本地 Bundle" };
  return { type: "npm", package: packageName, version: spec, label: "npm 固定版本" };
}

function bundleView({ packageName, packageDir, manifest, dependencySpec, index, descriptor, managed, themeCount }) {
  const ui = productInterface(manifest, descriptor);
  const source = sourceView(packageName, dependencySpec || "", packageDir, managed);
  const version = typeof manifest.version === "string" ? manifest.version : null;
  return {
    id: packageName,
    name: packageName,
    display_name: String(ui.display_name || ui.displayName || manifest.displayName || packageName),
    description: String(ui.description || manifest.description || "DSH Profile Bundle"),
    long_description: String(ui.long_description || ui.longDescription || manifest.description || ""),
    developer_name: String(ui.developer_name || ui.developerName || ""),
    category: String(ui.category || "DSH Profile"),
    capabilities: Array.isArray(ui.capabilities) ? ui.capabilities.map(String) : [],
    version,
    local_version: version,
    available_version: version,
    update_available: false,
    installed: true,
    enabled: true,
    runtime_kind: "profile_bundle",
    profile_name: PROFILE_NAME,
    profile_order: index,
    managed_by: managed,
    product_plugin: Boolean(descriptor),
    profile_theme_count: themeCount,
    installation: managed === "system" || managed === "app" ? "INSTALLED_BY_DEFAULT" : "AVAILABLE",
    authentication: "ON_USE",
    availability: "AVAILABLE",
    source: source.type,
    source_details: source,
    marketplace_name: `profile:${PROFILE_NAME}`,
    marketplace_path: null,
    readonly: managed !== "user",
    can_install: false,
    can_update: false,
    can_toggle: false,
    can_uninstall: managed === "user",
    skills_count: 0,
    apps_count: 0,
    app_templates_count: 0,
    mcp_count: 0,
    hooks_count: 0,
    scheduled_tasks_count: 0,
    connection_state: "not_required",
    connected_apps_count: 0,
    apps_needing_connection_count: 0,
    product: descriptor,
  };
}

/** Reject mutable or unreviewable package selectors before pnpm sees them. */
export function normalizeProfileBundleSource(value, { allowLocal = false } = {}) {
  const source = String(value || "").trim();
  if (!source || source.startsWith("-")) {
    throw profileError("请输入带固定版本的 npm 包，或 dsh-external 的精确 Git commit", "DSH_PROFILE_SOURCE_REQUIRED");
  }
  if (EXACT_REGISTRY_SPEC.test(source) || EXACT_EXTERNAL_GIT_SPEC.test(source)) return source;
  const local = source.startsWith("file:") ? source.slice(5) : source;
  if (allowLocal && isAbsolute(local) && existsSync(join(resolve(local), "package.json"))) {
    return `file:${resolve(local)}`;
  }
  throw profileError(
    "来源必须是精确 npm 版本、github:dsh-external/<repo>#<40位commit>，或已允许的本地包目录",
    "DSH_PROFILE_SOURCE_NOT_PINNED",
  );
}

function currentReleaseRange(value, version) {
  return new RegExp(`^(?:\\^|~)?${version.replaceAll(".", "\\.")}$`).test(String(value || "").trim());
}

/** Require one coherent official SDK release before a Bundle reaches the live tree. */
export function validateProfileBundleSdk(manifest) {
  const dependencies = { ...manifest?.dependencies, ...manifest?.peerDependencies };
  if (dependencies.cordis) {
    throw profileError(
      `${manifest.name} 仍使用旧的 cordis 包，需要改用 @deepseek-ai/cordis@${CURRENT_CORDIS_VERSION}`,
      "DSH_PROFILE_LEGACY_SDK",
    );
  }
  if (dependencies["@deepseek-ai/cordis"]
    && !currentReleaseRange(dependencies["@deepseek-ai/cordis"], CURRENT_CORDIS_VERSION)) {
    throw profileError(
      `${manifest.name} 的 @deepseek-ai/cordis 版本不属于当前 ${CURRENT_CORDIS_VERSION} 发布线`,
      "DSH_PROFILE_LEGACY_SDK",
    );
  }
  const mismatchedDsh = Object.entries(dependencies).filter(([name, version]) => (
    name.startsWith("@deepseek-ai/dsh-") && !currentReleaseRange(version, CURRENT_DSH_SDK_VERSION)
  ));
  if (mismatchedDsh.length) {
    throw profileError(
      `${manifest.name} 依赖的 DSH SDK 不属于当前 ${CURRENT_DSH_SDK_VERSION} 发布线：${mismatchedDsh.map(([name, version]) => `${name}@${version}`).join("、")}`,
      "DSH_PROFILE_LEGACY_SDK",
    );
  }
}

async function defaultCommandRunner(resolved, args, env) {
  try {
    return await execFileAsync(process.execPath, [...resolved.execArgv, resolved.entryPath, ...args], {
      cwd: resolved.root,
      env: { ...process.env, ...env },
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = String(error?.stdout || "").trim();
    const stderr = String(error?.stderr || "").trim();
    const output = [stdout, stderr]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join("\n");
    if (/ERR_PNPM_FETCH_404/i.test(stdout) && /@deepseek-ai(?:%2f|\/)/i.test(stdout)) {
      const dependencies = [...new Set([...stdout.matchAll(/@deepseek-ai(?:%2f|\/)([a-z0-9._-]+)/ig)]
        .map((match) => `@deepseek-ai/${match[1]}`))];
      throw profileError(
        "候选插件依赖的 DSH SDK 包或版本无法从当前私有 registry 读取",
        "DSH_PROFILE_SDK_UNAVAILABLE",
        { exit_code: error?.code ?? null, dependencies, command_output: output },
      );
    }
    if (/ignored build scripts|blocked build scripts|approve-builds/i.test(stdout)) {
      throw profileError(
        "候选插件需要在安装时执行仓库构建脚本；dsh-work 不会自动授予这项主机代码执行权限",
        "DSH_PROFILE_BUILD_APPROVAL_REQUIRED",
        { exit_code: error?.code ?? null, command_output: output },
      );
    }
    throw profileError(
      output || String(error?.message || error).trim() || "DSH Profile 命令失败",
      "DSH_PROFILE_COMMAND_FAILED",
      { exit_code: error?.code ?? null, command_output: output || null },
    );
  }
}

export function inspectProfileBundleManifest(manifest, { builtEntryAvailable = true } = {}) {
  const issues = [];
  const packageName = String(manifest?.name || "候选插件");
  const patch = manifest?.dsh?.bundle?.patch;
  if (typeof patch !== "string" || !patch.startsWith("./")) {
    issues.push({
      code: "DSH_PROFILE_NOT_A_BUNDLE",
      message: `${packageName} 没有声明有效的 package.json#dsh.bundle.patch`,
    });
  }
  if (manifest?.dshClient !== undefined) {
    issues.push({
      code: "DSH_PROFILE_LEGACY_CLIENT_MANIFEST",
      message: `${packageName} 仍使用旧的 package.json#dshClient，需要迁移到当前 dsh.client 清单`,
    });
  }
  if (!builtEntryAvailable && typeof manifest?.scripts?.prepare === "string") {
    issues.push({
      code: "DSH_PROFILE_BUILD_APPROVAL_REQUIRED",
      message: `${packageName} 没有提交运行入口，Git 安装需要执行 prepare 构建脚本`,
    });
  }
  try {
    validateProfileBundleSdk(manifest);
  } catch (error) {
    const legacyCount = Object.entries({ ...manifest?.dependencies, ...manifest?.peerDependencies })
      .filter(([name, version]) => name.startsWith("@deepseek-ai/dsh-")
        && !currentReleaseRange(version, CURRENT_DSH_SDK_VERSION))
      .length;
    issues.push({
      code: error?.code || "DSH_PROFILE_LEGACY_SDK",
      message: legacyCount > 0
        ? `${packageName} 有 ${legacyCount} 个 DSH SDK 包不属于当前 ${CURRENT_DSH_SDK_VERSION} 发布线`
        : error?.message || String(error),
    });
  }
  return issues;
}

async function inspectPinnedExternalGitSource(source) {
  const match = EXACT_EXTERNAL_GIT_SPEC.exec(source);
  if (!match?.groups) return null;
  const root = mkdtempSync(join(tmpdir(), "dsh-work-plugin-inspect-"));
  const checkout = join(root, "repository");
  try {
    await execFileAsync("git", [
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      `https://github.com/dsh-external/${match.groups.repo}.git`,
      checkout,
    ], { maxBuffer: 8 * 1024 * 1024 });
    const { stdout } = await execFileAsync("git", [
      "-C", checkout, "show", `${match.groups.commit}:package.json`,
    ], { maxBuffer: 2 * 1024 * 1024 });
    let manifest;
    try {
      manifest = JSON.parse(stdout);
    } catch (error) {
      throw profileError(`候选插件 package.json 无效：${error?.message || error}`, "DSH_PROFILE_MANIFEST_INVALID");
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      throw profileError("候选插件 package.json 必须是 JSON 对象", "DSH_PROFILE_MANIFEST_INVALID");
    }
    const entry = typeof manifest.main === "string" && manifest.main.startsWith("./")
      ? manifest.main.slice(2)
      : typeof manifest.main === "string" ? manifest.main : "";
    let builtEntryAvailable = true;
    if (entry && !entry.startsWith("../") && !isAbsolute(entry)) {
      try {
        await execFileAsync("git", ["-C", checkout, "cat-file", "-e", `${match.groups.commit}:${entry}`]);
      } catch {
        builtEntryAvailable = false;
      }
    }
    return { manifest, builtEntryAvailable };
  } catch (error) {
    if (error?.code?.startsWith?.("DSH_")) throw error;
    throw profileError(
      `无法读取固定的 dsh-external 插件来源：${error?.stderr || error?.message || error}`,
      "DSH_PROFILE_SOURCE_UNAVAILABLE",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function preflightStatus(error) {
  if (error?.code === "DSH_PROFILE_BUILD_APPROVAL_REQUIRED") return "build_approval_required";
  if (error?.code === "DSH_PROFILE_SDK_UNAVAILABLE") return "sdk_unavailable";
  if (String(error?.code || "").startsWith("DSH_PROFILE_THEME_")) return "migration_required";
  if ([
    "DSH_PROFILE_NOT_A_BUNDLE",
    "DSH_PROFILE_LEGACY_CLIENT_MANIFEST",
    "DSH_PROFILE_LEGACY_SDK",
    "DSH_PRODUCT_DESCRIPTOR_INVALID",
    "DSH_PRODUCT_HOST_COMPONENT_FORBIDDEN",
    "DSH_PROFILE_CANDIDATE_INVALID",
  ].includes(error?.code)) return "migration_required";
  if (["DSH_PROFILE_SOURCE_REQUIRED", "DSH_PROFILE_SOURCE_NOT_PINNED"].includes(error?.code)) return "invalid_source";
  if (error?.code === "PLUGIN_ALREADY_INSTALLED") return "already_installed";
  return "unavailable";
}

function preflightFailure(source, error) {
  const issues = Array.isArray(error?.details?.issues) && error.details.issues.length > 0
    ? error.details.issues
    : [{ code: error?.code || "DSH_PROFILE_PREFLIGHT_FAILED", message: error?.message || String(error) }];
  return {
    source,
    status: preflightStatus(error),
    installable: false,
    package_name: error?.details?.package_name || null,
    version: error?.details?.version || null,
    blockers: issues,
  };
}

export class DshProfilePluginService {
  constructor({
    env = process.env,
    commandRunner = defaultCommandRunner,
    restartRuntime = async () => {
      const { restartDshRuntimeClient } = await import("./client.js");
      return restartDshRuntimeClient();
    },
  } = {}) {
    this.env = env;
    this.commandRunner = commandRunner;
    this.restartRuntime = restartRuntime;
    this.mutationQueue = Promise.resolve();
  }

  mutate(task) {
    const running = this.mutationQueue.catch(() => {}).then(task);
    this.mutationQueue = running;
    return running.finally(() => {
      if (this.mutationQueue === running) this.mutationQueue = Promise.resolve();
    });
  }

  distribution() {
    const resolved = resolveDshRuntimeDistribution({ env: this.env });
    if (!resolved) throw profileError("DSH 运行时未启用，无法管理 Profile Bundle", "DSH_RUNTIME_DISABLED");
    return resolved;
  }

  home() {
    return resolve(this.env.DSH_RUNTIME_HOME || this.env.DSH_HOME || dataRoot());
  }

  async profileApi(resolved) {
    return import(pathToFileURL(resolved.appBootPath).href);
  }

  async state() {
    const resolved = this.distribution();
    const dshHome = this.home();
    const prepared = await prepareTrustedProfilePlugins({
      appBootPath: resolved.appBootPath,
      env: { ...this.env, DSH_HOME: dshHome },
      runtimeRoot: resolved.root,
      dshHome,
    });
    const api = await this.profileApi(resolved);
    const manifest = api.readProfileManifest("dsh-work", prepared.profileDir);
    const dependencies = manifest.dependencies || {};
    const trusted = new Set(trustedDshProfilePluginNames());
    const themeBundles = [];
    const themeErrors = [];
    const plugins = prepared.bundles.map((packageName, index) => {
      const packageDir = realpathSync(api.resolveBundleDir(
        "dsh-work",
        packageName,
        resolved.installAnchor,
        prepared.profileDir,
      ));
      const packageManifest = readJson(join(packageDir, "package.json"));
      const managed = SYSTEM_BUNDLES.has(packageName) ? "system" : trusted.has(packageName) ? "app" : "user";
      const descriptor = readProductDescriptor(packageDir, packageManifest, {
        allowHostComponents: managed === "app",
      });
      let themeDescriptor = { manifest_path: null, themes: [] };
      try {
        themeDescriptor = readProfileThemeDescriptor(packageDir, packageManifest);
      } catch (error) {
        themeErrors.push(Object.freeze({
          code: error?.code || "DSH_PROFILE_THEME_INVALID",
          theme_id: null,
          manifest_id: null,
          message: error?.message || String(error),
          source_bundle: Object.freeze({
            package_name: packageName,
            name: String(packageManifest.displayName || packageName),
            version: typeof packageManifest.version === "string" ? packageManifest.version : null,
            manifest_path: typeof packageManifest?.dshWork?.themes === "string" ? packageManifest.dshWork.themes : null,
          }),
        }));
      }
      if (themeDescriptor.themes.length > 0) {
        themeBundles.push({
          package_name: packageName,
          display_name: String(packageManifest.displayName || packageName),
          version: typeof packageManifest.version === "string" ? packageManifest.version : null,
          manifest_path: themeDescriptor.manifest_path,
          themes: themeDescriptor.themes,
        });
      }
      return bundleView({
        packageName,
        packageDir,
        manifest: packageManifest,
        dependencySpec: dependencies[packageName],
        index,
        descriptor,
        managed,
        themeCount: themeDescriptor.themes.length,
      });
    });
    return {
      resolved,
      api,
      dshHome,
      profileDir: prepared.profileDir,
      manifest,
      plugins,
      themeBundles,
      themeErrors,
    };
  }

  async catalog() {
    const state = await this.state();
    const themes = aggregateProfileThemes(state.themeBundles, state.themeErrors);
    return {
      plugins: state.plugins,
      apps: [],
      mcp_servers: [],
      skills: [],
      marketplaces: [{
        id: `profile:${PROFILE_NAME}`,
        name: PROFILE_NAME,
        display_name: "DSH Web Profile",
        plugin_count: state.plugins.length,
        path: state.profileDir,
        source: "profile",
        readonly: true,
        can_upgrade: false,
        can_remove: false,
      }],
      featured_plugin_ids: [],
      profile_themes: themes.profile_themes,
      profile_theme_errors: themes.profile_theme_errors,
      catalog_warnings: [],
      catalog_errors: [],
      connection_errors: [],
    };
  }

  async read(packageName) {
    const state = await this.state();
    const plugin = state.plugins.find((item) => item.id === packageName);
    if (!plugin) throw profileError(`Profile Bundle 不存在：${packageName}`, "PLUGIN_NOT_FOUND");
    const themes = aggregateProfileThemes(
      state.themeBundles.filter((bundle) => bundle.package_name === packageName),
      state.themeErrors.filter((error) => error.source_bundle?.package_name === packageName),
    );
    return {
      plugin,
      skills: [],
      apps: [],
      app_templates: [],
      mcp_servers: [],
      hooks: [],
      scheduled_tasks: [],
      connection_errors: [],
      ...themes,
    };
  }

  async run(resolved, dshHome, args) {
    return this.commandRunner(resolved, args, {
      ...this.env,
      DSH_HOME: dshHome,
      DSH_TELEMETRY_DISABLED: this.env.DSH_TELEMETRY_DISABLED || "1",
    });
  }

  async validateCandidate(source, state) {
    const candidateName = `dsh-work-candidate-${randomUUID()}`;
    const candidateDir = state.api.resolveProfileDir(candidateName, state.dshHome);
    state.api.initProfile(candidateDir, state.api.PROFILE_TEMPLATES?.web || state.api.DEFAULT_PROFILE_BUNDLES);
    try {
      await this.run(state.resolved, state.dshHome, [
        "plugin", "--profile", candidateName, "add", "-w", source, "--save-exact", "--ignore-scripts",
      ]);
      const manifest = state.api.readProfileManifest("dsh-work", candidateDir);
      const dependencyNames = Object.keys(manifest.dependencies || {});
      if (dependencyNames.length !== 1) {
        throw profileError("候选 Profile 没有得到一个明确的 Bundle 包", "DSH_PROFILE_CANDIDATE_INVALID");
      }
      const packageName = dependencyNames[0];
      const packageDir = realpathSync(state.api.resolveBundleDir(
        "dsh-work",
        packageName,
        state.resolved.installAnchor,
        candidateDir,
      ));
      const packageManifest = readJson(join(packageDir, "package.json"));
      if (packageManifest.name !== packageName) {
        throw profileError("候选 Bundle 包名与 Profile 依赖不一致", "DSH_PROFILE_CANDIDATE_INVALID");
      }
      const issues = inspectProfileBundleManifest(packageManifest);
      const patch = packageManifest?.dsh?.bundle?.patch;
      if (typeof patch === "string" && patch.startsWith("./")) {
        try {
          const patchPath = realpathSync(resolve(packageDir, patch));
          if (!inside(packageDir, patchPath)) {
            issues.push({ code: "DSH_PROFILE_NOT_A_BUNDLE", message: `${packageName} 的 Bundle patch 越过了包目录` });
          }
        } catch (error) {
          issues.push({
            code: "DSH_PROFILE_NOT_A_BUNDLE",
            message: `${packageName} 的 Bundle patch 不存在或无法读取：${error?.message || error}`,
          });
        }
      }
      let descriptor = null;
      try {
        descriptor = readProductDescriptor(packageDir, packageManifest);
      } catch (error) {
        issues.push({ code: error?.code || "DSH_PRODUCT_DESCRIPTOR_INVALID", message: error?.message || String(error) });
      }
      let themeDescriptor = { themes: [] };
      try {
        themeDescriptor = readProfileThemeDescriptor(packageDir, packageManifest);
      } catch (error) {
        issues.push({ code: error?.code || "DSH_PROFILE_THEME_INVALID", message: error?.message || String(error) });
      }
      if (issues.length > 0) {
        throw profileError(issues[0].message, issues[0].code, {
          package_name: packageName,
          version: packageManifest.version || null,
          issues,
        });
      }
      await this.run(state.resolved, state.dshHome, ["--profile", candidateName, "--dump-config"]);
      return {
        packageName,
        version: packageManifest.version || null,
        surface: descriptor?.contributions?.length || themeDescriptor.themes.length
          ? "dsh_work"
          : packageManifest.dsh?.client ? "dsh_web" : "host",
      };
    } finally {
      const profilesRoot = state.api.resolveProfileDir(PROFILE_NAME, state.dshHome);
      const root = dirname(profilesRoot);
      if (inside(root, candidateDir) && candidateDir !== root) rmSync(candidateDir, { recursive: true, force: true });
    }
  }

  async install(value) {
    return this.mutate(() => this.installUnlocked(value));
  }

  async preflight(value) {
    return this.mutate(() => this.preflightUnlocked(value));
  }

  async preflightUnlocked(value) {
    let source;
    try {
      source = normalizeProfileBundleSource(value, {
        allowLocal: this.env.DSH_PROFILE_ALLOW_LOCAL_PLUGINS === "1",
      });
    } catch (error) {
      return preflightFailure(String(value || "").trim(), error);
    }
    try {
      const inspected = await inspectPinnedExternalGitSource(source);
      if (inspected) {
        const issues = inspectProfileBundleManifest(inspected.manifest, {
          builtEntryAvailable: inspected.builtEntryAvailable,
        });
        if (issues.length > 0) {
          return preflightFailure(source, profileError(issues[0].message, issues[0].code, {
            package_name: inspected.manifest.name || null,
            version: inspected.manifest.version || null,
            issues,
          }));
        }
      }
      const state = await this.state();
      const candidate = await this.validateCandidate(source, state);
      if (state.plugins.some((plugin) => plugin.id === candidate.packageName)) {
        return preflightFailure(source, profileError(
          `Profile Bundle 已安装：${candidate.packageName}`,
          "PLUGIN_ALREADY_INSTALLED",
          { package_name: candidate.packageName, version: candidate.version },
        ));
      }
      return {
        source,
        status: "ready",
        installable: true,
        package_name: candidate.packageName,
        version: candidate.version,
        surface: candidate.surface,
        blockers: [],
      };
    } catch (error) {
      return preflightFailure(source, error);
    }
  }

  async installUnlocked(value) {
    const source = normalizeProfileBundleSource(value, {
      allowLocal: this.env.DSH_PROFILE_ALLOW_LOCAL_PLUGINS === "1",
    });
    const state = await this.state();
    const candidate = await this.validateCandidate(source, state);
    if (state.plugins.some((plugin) => plugin.id === candidate.packageName)) {
      throw profileError(`Profile Bundle 已安装：${candidate.packageName}`, "PLUGIN_ALREADY_INSTALLED");
    }
    await this.run(state.resolved, state.dshHome, [
      "plugin", "--profile", PROFILE_NAME, "add", "-w", source, "--save-exact", "--ignore-scripts",
    ]);
    await prepareTrustedProfilePlugins({
      appBootPath: state.resolved.appBootPath,
      env: { ...this.env, DSH_HOME: state.dshHome },
      runtimeRoot: state.resolved.root,
      dshHome: state.dshHome,
    });
    await this.restartRuntime();
    return { id: candidate.packageName, pluginId: candidate.packageName, name: candidate.packageName, version: candidate.version };
  }

  async uninstall(packageName) {
    return this.mutate(() => this.uninstallUnlocked(packageName));
  }

  async uninstallUnlocked(packageName) {
    const state = await this.state();
    const plugin = state.plugins.find((item) => item.id === packageName);
    if (!plugin) throw profileError(`Profile Bundle 不存在：${packageName}`, "PLUGIN_NOT_FOUND");
    if (plugin.managed_by !== "user" || !Object.hasOwn(state.manifest.dependencies || {}, packageName)) {
      throw profileError(`由 ${plugin.managed_by === "app" ? "dsh-work" : "DSH"} 提供的 Bundle 不能卸载`, "PLUGIN_UNINSTALL_NOT_ALLOWED");
    }
    await this.run(state.resolved, state.dshHome, ["plugin", "--profile", PROFILE_NAME, "remove", packageName]);
    await this.restartRuntime();
    return { id: packageName, name: plugin.display_name };
  }
}

let defaultService = null;

export function getDshProfilePluginService() {
  defaultService ||= new DshProfilePluginService();
  return defaultService;
}

export function resetDshProfilePluginServiceForTests() {
  defaultService = null;
}

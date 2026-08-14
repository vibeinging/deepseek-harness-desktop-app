import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const TRUSTED_DSH_PLUGINS = Object.freeze([{
  name: "@deepseek-ai/dsh-product-bridge",
  envPath: "DSH_PRODUCT_BRIDGE_ROOT",
  appPackage: "packages/dsh-product-bridge",
  browser: false,
}, {
  name: "@deepseek-ai/dsh-theme-pack",
  envPath: "DSH_THEME_PACK_ROOT",
  appPackage: "packages/dsh-theme-pack",
  browser: false,
}, {
  name: "@deepseek-ai/dsh-work-shell",
  envPath: "DSH_WORK_SHELL_ROOT",
  appPackage: "packages/dsh-work-shell",
  browser: true,
}]);

const RETIRED_DSH_PLUGINS = Object.freeze([
  "@deepseek-ai/dsh-product-client",
  "@deepseek-ai/dsh-turn-navigator",
]);

const WEB_PROFILE = "web";

/** Return the bundle names that dsh-work owns inside the Web Profile. */
export function trustedDshProfilePluginNames() {
  return [
    ...TRUSTED_DSH_PLUGINS.map((plugin) => plugin.name),
    ...RETIRED_DSH_PLUGINS,
  ];
}

function inside(root, target) {
  const path = relative(root, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function defaultExport(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return typeof value.default === "string" ? value.default : null;
}

function resolvePackageFile(root, declared, label) {
  if (typeof declared !== "string" || !declared.startsWith("./")) {
    throw new Error(`${label} 必须是包内相对路径`);
  }
  const path = realpathSync(resolve(root, declared));
  if (!inside(root, path)) throw new Error(`${label} 不能越过插件目录`);
  return path;
}

function readTrustedPlugin(candidate, { name: expectedName, browser }) {
  const root = realpathSync(candidate);
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.name !== expectedName) {
    throw new Error(`受信任 DSH client plugin 包名不匹配：期望 ${expectedName}`);
  }
  if (browser && manifest?.dsh?.client?.platform !== "web") {
    throw new Error(`${expectedName} 没有声明 Web dsh.client`);
  }
  const patch = resolvePackageFile(root, manifest?.dsh?.bundle?.patch, `${expectedName} dsh.bundle.patch`);
  const entry = resolvePackageFile(root, manifest?.main, `${expectedName} main`);
  const client = browser
    ? resolvePackageFile(root, defaultExport(manifest?.exports?.["./client"]), `${expectedName} exports[\"./client\"]`)
    : null;
  return { name: expectedName, root, patch, entry, client };
}

function ensureLink(link, target) {
  mkdirSync(dirname(link), { recursive: true });
  if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
    const stat = lstatSync(link);
    if (!stat.isSymbolicLink()) {
      throw new Error(`DSH client plugin 解析位已被普通文件占用：${link}`);
    }
    const current = resolve(dirname(link), readlinkSync(link));
    if (current === target) return;
    rmSync(link);
  }
  symlinkSync(target, link, "junction");
}

function removeRetiredLinks(dshHome) {
  for (const name of RETIRED_DSH_PLUGINS) {
    const link = join(resolve(dshHome), "profiles", "node_modules", ...name.split("/"));
    const stat = lstatSync(link, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isSymbolicLink()) {
      throw new Error(`退役 DSH plugin 解析位被普通文件占用：${link}`);
    }
    rmSync(link);
  }
}

function candidatePath(spec, { appRoot, env, runtimeRoot }) {
  const configured = String(env[spec.envPath] || "").trim();
  if (configured) return { path: resolve(configured), required: true };
  if (spec.appPackage) return { path: resolve(appRoot, spec.appPackage), required: false };
  if (env.DSH_RUNTIME_DISTRIBUTION !== "source") return null;
  return { path: resolve(runtimeRoot, "..", spec.sourceSibling), required: false };
}

/**
 * Validate and expose app-reviewed DSH plugins to one profile boot.
 * Only the fixed allowlist can enter the profile module resolver. An explicit
 * path fails loud; a missing source sibling means that optional local plugin
 * is not mounted.
 */
export function prepareTrustedClientPlugins({
  appRoot = APP_ROOT,
  env = process.env,
  runtimeRoot = process.cwd(),
  dshHome = env.DSH_HOME,
} = {}) {
  if (!dshHome) throw new Error("缺少 DSH_HOME，无法准备受信任 client plugin");
  removeRetiredLinks(dshHome);
  const prepared = [];
  for (const spec of TRUSTED_DSH_PLUGINS) {
    const candidate = candidatePath(spec, { appRoot, env, runtimeRoot });
    if (!candidate) continue;
    if (!existsSync(candidate.path)) {
      if (candidate.required) throw new Error(`受信任 DSH client plugin 不存在：${candidate.path}`);
      continue;
    }
    const plugin = readTrustedPlugin(candidate.path, spec);
    const link = join(resolve(dshHome), "profiles", "node_modules", ...plugin.name.split("/"));
    ensureLink(link, plugin.root);
    prepared.push(plugin);
  }
  return prepared;
}

function readProfileBundles(manifest, profileDir) {
  if (manifest?.dsh?.bundle) {
    throw new Error(`DSH Profile manifest 不能同时声明 dsh.bundle：${profileDir}`);
  }
  const bundles = manifest?.dsh?.profile?.bundles;
  if (bundles === undefined) return [];
  if (!Array.isArray(bundles) || bundles.some((name) => typeof name !== "string" || !name.trim())) {
    throw new Error(`DSH Profile bundles 必须是非空包名数组：${profileDir}`);
  }
  return bundles;
}

function sameBundles(left, right) {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function readInstalledPlugin(api, packageName, installAnchor, profileDir) {
  const root = realpathSync(api.resolveBundleDir(
    "dsh-work",
    packageName,
    installAnchor,
    profileDir,
  ));
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return Object.freeze({ name: packageName, root, manifest });
}

async function loadProfileApi(appBootPath, profileApi) {
  if (profileApi) return profileApi;
  if (!appBootPath) throw new Error("缺少 DSH app-boot 入口，无法更新 Profile");
  return import(pathToFileURL(appBootPath).href);
}

/**
 * Mount the app-reviewed DSH bundles through the official Profile manifest.
 * The flat resolver links expose package roots; `dsh.profile.bundles` owns
 * composition order. Missing optional packages are removed from the fixed
 * allowlist slice. User-installed browser bundles remain installed but are
 * removed from the active graph until the desktop renderer isolates them.
 */
export async function prepareTrustedProfilePlugins({
  appBootPath,
  installAnchor,
  profileApi,
  profileName = WEB_PROFILE,
  appRoot = APP_ROOT,
  env = process.env,
  runtimeRoot = process.cwd(),
  dshHome = env.DSH_HOME,
} = {}) {
  if (!dshHome) throw new Error("缺少 DSH_HOME，无法准备受信任 Profile plugin");
  const api = await loadProfileApi(appBootPath, profileApi);
  const template = api.PROFILE_TEMPLATES?.[profileName] ?? api.DEFAULT_PROFILE_BUNDLES;
  if (!Array.isArray(template)) throw new Error(`DSH 没有可用的 Profile 模板：${profileName}`);
  const profileDir = api.resolveProfileDir(profileName, resolve(dshHome));
  api.initProfile(profileDir, template);

  const plugins = prepareTrustedClientPlugins({ appRoot, env, runtimeRoot, dshHome });
  const manifest = api.readProfileManifest("dsh-work", profileDir);
  const currentBundles = readProfileBundles(manifest, profileDir);
  const currentDependencies = manifest.dependencies || {};
  const dependencies = Object.fromEntries(Object.entries(currentDependencies)
    .filter(([name]) => !RETIRED_DSH_PLUGINS.includes(name)));
  const managedNames = new Set([
    ...TRUSTED_DSH_PLUGINS.map((plugin) => plugin.name),
    ...RETIRED_DSH_PLUGINS,
  ]);
  const reviewedNames = new Set([...template, ...managedNames]);
  const inspectionAnchor = installAnchor || env.DSH_RUNTIME_INSTALL_ANCHOR || appBootPath;
  if (!inspectionAnchor || typeof api.resolveBundleDir !== "function") {
    throw new Error("DSH Profile API 无法检查社区 Client Bundle 隔离");
  }
  const userNames = [...new Set([
    ...currentBundles,
    ...Object.keys(dependencies),
  ])].filter((name) => !reviewedNames.has(name));
  const quarantined = userNames
    .map((name) => readInstalledPlugin(api, name, inspectionAnchor, profileDir))
    .filter((plugin) => plugin.manifest?.dsh?.client !== undefined);
  const quarantinedNames = new Set(quarantined.map((plugin) => plugin.name));
  const bundles = [
    ...currentBundles.filter((name) => !managedNames.has(name) && !quarantinedNames.has(name)),
    ...plugins.map((plugin) => plugin.name),
  ];
  const changed = !sameBundles(currentBundles, bundles)
    || Object.keys(dependencies).length !== Object.keys(currentDependencies).length;
  if (changed) {
    api.writeProfileManifest(profileDir, {
      ...manifest,
      dependencies,
      dsh: {
        ...manifest.dsh,
        profile: {
          ...manifest.dsh?.profile,
          bundles,
        },
      },
    });
  }
  return Object.freeze({ profileName, profileDir, plugins, bundles, quarantined, changed });
}

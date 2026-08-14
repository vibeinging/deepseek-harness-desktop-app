import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DshProfilePluginService,
  inspectCommunityClientIsolation,
  inspectProfileBundleManifest,
  normalizeProfileBundleSource,
  validateDshWorkProductDescriptor,
  validateProfileBundleSdk,
} from "../../server/src/engine/dsh_runtime/profile_plugin_service.js";
import {
  normalizeProfileThemeDescriptor,
  profileThemeRuntimeId,
  readProfileThemeDescriptor,
} from "../../server/src/engine/dsh_runtime/profile_theme_manifest.js";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DSH_NPM_ROOT = resolve(APP_ROOT, "server/node_modules/@deepseek-ai/dsh");

test("Profile Bundle sources must be immutable or explicitly local", () => {
  assert.equal(
    normalizeProfileBundleSource("@example/dsh-report@1.2.3"),
    "@example/dsh-report@1.2.3",
  );
  assert.equal(
    normalizeProfileBundleSource(`github:dsh-external/dsh-report#${"a".repeat(40)}`),
    `github:dsh-external/dsh-report#${"a".repeat(40)}`,
  );
  assert.throws(
    () => normalizeProfileBundleSource("@example/dsh-report@latest"),
    { code: "DSH_PROFILE_SOURCE_NOT_PINNED" },
  );
  assert.throws(
    () => normalizeProfileBundleSource("github:dsh-external/dsh-report#main"),
    { code: "DSH_PROFILE_SOURCE_NOT_PINNED" },
  );
  assert.throws(
    () => normalizeProfileBundleSource(APP_ROOT),
    { code: "DSH_PROFILE_SOURCE_NOT_PINNED" },
  );
  assert.equal(
    normalizeProfileBundleSource(APP_ROOT, { allowLocal: true }),
    `file:${APP_ROOT}`,
  );
});

test("Profile Bundle validation rejects the retired pre-release SDK shape", () => {
  assert.throws(() => validateProfileBundleSdk({
    name: "@example/legacy",
    peerDependencies: { "@deepseek-ai/cordis": "4.0.1-rc.1" },
  }), { code: "DSH_PROFILE_LEGACY_SDK" });
  assert.throws(() => validateProfileBundleSdk({
    name: "@example/legacy-rc",
    peerDependencies: {
      cordis: "^4.0.0-rc.7",
      "@deepseek-ai/dsh-tools": "0.0.1-rc.2",
    },
  }), { code: "DSH_PROFILE_LEGACY_SDK" });
  assert.doesNotThrow(() => validateProfileBundleSdk({
    name: "@example/current",
    peerDependencies: {
      "@deepseek-ai/cordis": "^4.0.1",
      "@deepseek-ai/dsh-tools": "^0.1.0-rc.6",
    },
  }));
  assert.doesNotThrow(() => validateProfileBundleSdk({
    name: "@example/current-with-optional-legacy-peer",
    peerDependencies: {
      "@deepseek-ai/cordis": "^4.0.1",
      "@deepseek-ai/dsh-tools": "^0.1.0-rc.6",
      cordis: "^4.0.0-rc.7",
    },
    peerDependenciesMeta: { cordis: { optional: true } },
  }));
  assert.throws(() => validateProfileBundleSdk({
    name: "@example/legacy-runtime-cordis",
    dependencies: {
      "@deepseek-ai/cordis": "^4.0.1",
      cordis: "^4.0.0-rc.7",
    },
  }), { code: "DSH_PROFILE_LEGACY_SDK" });
});

test("community plugin manifests report every current DSH migration blocker", () => {
  assert.deepEqual(inspectProfileBundleManifest({
    name: "dsh-better-sidebar",
    version: "0.9.0",
    dsh: { client: { inject: ["@deepseek-ai/dsh-client-runtime"] } },
    peerDependencies: {
      "@deepseek-ai/dsh-client-runtime": "^0.0.1-rc.1",
      cordis: "^4.0.0-rc.7",
    },
  }), [
    {
      code: "DSH_PROFILE_NOT_A_BUNDLE",
      message: "dsh-better-sidebar 没有声明有效的 package.json#dsh.bundle.patch",
    },
    {
      code: "DSH_PROFILE_CLIENT_MANIFEST_INVALID",
      message: "dsh-better-sidebar 的 package.json#dsh.client 必须声明 web platform，并使用字符串 inject 列表",
    },
    {
      code: "DSH_PROFILE_LEGACY_SDK",
      message: "dsh-better-sidebar 有 1 个 DSH SDK 包不属于当前 0.1.0-rc.6 发布线",
    },
  ]);
  assert.deepEqual(inspectProfileBundleManifest({
    name: "dsh-source-only",
    main: "lib/index.js",
    scripts: { prepare: "tsdown" },
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  }, { builtEntryAvailable: false }), [{
    code: "DSH_PROFILE_BUILD_APPROVAL_REQUIRED",
    message: "dsh-source-only 没有提交运行入口，Git 安装需要执行 prepare 构建脚本",
  }]);
});

test("current DSH browser plugins declare one verifiable client bundle", () => {
  assert.deepEqual(inspectProfileBundleManifest({
    name: "dsh-browser-plugin",
    dsh: {
      bundle: { patch: "./cordis.patch.yml" },
      client: {
        platform: "web",
        inject: ["@deepseek-ai/dsh-client-runtime"],
      },
    },
    exports: { "./client": { default: "./lib/client.js" } },
    peerDependencies: {
      "@deepseek-ai/cordis": "^4.0.1",
      "@deepseek-ai/dsh-client-runtime": "^0.1.0-rc.6",
    },
  }), []);
  assert.deepEqual(inspectProfileBundleManifest({
    name: "dsh-browser-plugin",
    dsh: {
      bundle: { patch: "./cordis.patch.yml" },
      client: { platform: "web" },
    },
    exports: { "./client": "./lib/client.js" },
  }, { clientEntryAvailable: false }), [{
    code: "DSH_PROFILE_CLIENT_BUNDLE_MISSING",
    message: "dsh-browser-plugin 没有提交 exports[\"./client\"] 指向的浏览器构建产物",
  }]);
});

test("community dsh.client Bundles stay out of the privileged Electron renderer", () => {
  assert.deepEqual(inspectCommunityClientIsolation({
    name: "@example/community-ui",
    dsh: { client: { platform: "web" } },
  }), [{
    code: "DSH_PROFILE_CLIENT_ISOLATION_REQUIRED",
    message: "@example/community-ui 包含 dsh.client 浏览器代码；当前主窗口尚未把社区 UI 与 Electron API 隔离，只能安装 Host 侧 Bundle",
  }]);
  assert.deepEqual(inspectCommunityClientIsolation({
    name: "@example/host-only",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  }), []);
});

test("only app-managed Bundles may request dsh-work host components", () => {
  const descriptor = {
    schema_version: 1,
    contributions: [{
      slot: "agent.workbench.tool",
      id: "browser",
      component: "dsh-work/browser",
      label: "浏览器",
      icon: "world",
      order: 20,
    }],
  };
  assert.throws(
    () => validateDshWorkProductDescriptor(descriptor, { packageName: "@example/community" }),
    { code: "DSH_PRODUCT_HOST_COMPONENT_FORBIDDEN" },
  );
  assert.doesNotThrow(() => validateDshWorkProductDescriptor(descriptor, {
    packageName: "@deepseek-ai/dsh-product-bridge",
    allowHostComponents: true,
  }));
});

test("Profile theme descriptors keep a narrow renderer-safe contract", () => {
  const colors = [
    "#eef5fb", "#dceaf5", "#bad5eb", "#98c0e0", "#76abd6",
    "#5496cc", "#336699", "#294f77", "#1f3c5a", "#15283c",
  ];
  const [theme] = normalizeProfileThemeDescriptor({
    schema_version: 1,
    themes: [{
      id: "ocean",
      name: "Ocean",
      vars: { "--el-color-primary": "#369" },
      mantineColors: colors,
      appearance: { bgImage: "deep-sea", panelOpacity: 80 },
    }],
  });
  assert.equal(theme.vars["--el-color-primary"], "#336699");
  assert.equal(profileThemeRuntimeId("@demo/theme-pack", "ocean"), "profile:%40demo%2Ftheme-pack:ocean");
  assert.throws(() => normalizeProfileThemeDescriptor({
    schema_version: 1,
    themes: [{ id: "unsafe", name: "Unsafe", extraCss: "body { display: none }" }],
  }), { code: "DSH_PROFILE_THEME_RAW_CSS_FORBIDDEN" });
  assert.throws(() => normalizeProfileThemeDescriptor({
    schema_version: 1,
    themes: [{ id: "unsafe", name: "Unsafe", appearance: { panelOpacity: 20 } }],
  }), { code: "DSH_PROFILE_THEME_INVALID" });
});

test("Profile theme paths stay inside their Bundle", () => {
  const fixture = resolve(APP_ROOT, "eval", "fixtures", "dsh-profile-bundle");
  const manifest = JSON.parse(readFileSync(join(fixture, "package.json"), "utf8"));
  assert.equal(readProfileThemeDescriptor(fixture, manifest).themes[0].manifest_id, "fixture-ocean");
  assert.throws(() => readProfileThemeDescriptor(fixture, {
    name: "outside-theme",
    dshWork: { themes: "./../package.json" },
  }), { code: "DSH_PROFILE_THEME_PATH_OUTSIDE_ROOT" });
});

test("Profile Bundle preflight rejects mutable sources without touching DSH", async () => {
  const service = new DshProfilePluginService({
    env: {},
    commandRunner: async () => { throw new Error("command runner must not be called"); },
  });
  assert.deepEqual(await service.preflight("github:dsh-external/DSH-better-sidebar#main"), {
    source: "github:dsh-external/DSH-better-sidebar#main",
    status: "invalid_source",
    installable: false,
    package_name: null,
    version: null,
    blockers: [{
      code: "DSH_PROFILE_SOURCE_NOT_PINNED",
      message: "来源必须是精确 npm 版本、github:dsh-external/<repo>#<40位commit>，或已允许的本地包目录",
    }],
  });
});

test("the app-owned Profile Bundles use the current public SDK names", () => {
  for (const packageDir of ["dsh-product-bridge", "dsh-theme-pack", "dsh-work-shell"]) {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, "packages", packageDir, "package.json"), "utf8"));
    assert.doesNotThrow(() => validateProfileBundleSdk(manifest));
    assert.equal(manifest.peerDependencies["@deepseek-ai/cordis"], "^4.0.1");
    assert.equal(manifest.peerDependencies.cordis, undefined);
  }
  const themePackRoot = join(APP_ROOT, "packages", "dsh-theme-pack");
  const themePackManifest = JSON.parse(readFileSync(join(themePackRoot, "package.json"), "utf8"));
  const themes = readProfileThemeDescriptor(themePackRoot, themePackManifest).themes;
  assert.deepEqual(themes.map((theme) => theme.manifest_id), ["professional-blue", "anime-blue"]);
  const professional = themes.find((theme) => theme.manifest_id === "professional-blue");
  assert.equal(professional.vars["--el-color-primary"], "#405fd2");
  assert.equal(professional.dark.vars["--el-color-primary"], "#7b9cff");
  assert.deepEqual(professional.appearance, {
    bgColor: "#f4f6fc",
    panelOpacity: 96,
    dark: { bgColor: "#111827", panelOpacity: 94 },
  });
  const anime = themes.find((theme) => theme.manifest_id === "anime-blue");
  assert.equal(anime.vars["--el-color-primary"], "#5b8def");
  assert.equal(anime.dark.vars["--el-color-primary"], "#86b2ff");
});

test("a current local Bundle passes the real isolated Profile preflight", {
  timeout: 30_000,
  skip: existsSync(join(DSH_NPM_ROOT, "package.json"))
    ? false
    : `missing app-pinned DSH package: ${DSH_NPM_ROOT}`,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-work-profile-preflight-"));
  try {
    const service = new DshProfilePluginService({
      env: {
        ...process.env,
        DSH_RUNTIME_DISTRIBUTION: "npm",
        DSH_RUNTIME_HOME: home,
        DSH_HOME: home,
        DSH_PROFILE_ALLOW_LOCAL_PLUGINS: "1",
      },
      restartRuntime: async () => ({ restarted: false, sessions: [] }),
    });
    const source = resolve(APP_ROOT, "eval", "fixtures", "dsh-profile-bundle");
    assert.deepEqual(await service.preflight(source), {
      source: `file:${source}`,
      status: "ready",
      installable: true,
      package_name: "dsh-work-profile-fixture",
      version: "1.0.0",
      surface: "dsh_work",
      blockers: [],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an installed Profile Bundle projects its themes through the catalog", {
  timeout: 30_000,
  skip: existsSync(join(DSH_NPM_ROOT, "package.json"))
    ? false
    : `missing app-pinned DSH package: ${DSH_NPM_ROOT}`,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-work-profile-themes-"));
  try {
    const service = new DshProfilePluginService({
      env: {
        ...process.env,
        DSH_RUNTIME_DISTRIBUTION: "npm",
        DSH_RUNTIME_HOME: home,
        DSH_HOME: home,
        DSH_PROFILE_ALLOW_LOCAL_PLUGINS: "1",
      },
      restartRuntime: async () => ({ restarted: false, sessions: [] }),
    });
    const source = resolve(APP_ROOT, "eval", "fixtures", "dsh-profile-bundle");
    await service.install(source);
    const catalog = await service.catalog();
    assert.equal(catalog.profile_theme_errors.length, 0);
    assert.deepEqual(catalog.profile_themes
      .filter((theme) => theme.source_bundle.package_name === "dsh-work-profile-fixture")
      .map((theme) => ({
      id: theme.id,
      source: theme.source,
      package_name: theme.source_bundle.package_name,
      })), [{
      id: "profile:dsh-work-profile-fixture:fixture-ocean",
      source: "profile",
      package_name: "dsh-work-profile-fixture",
    }]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("known dsh-external samples are refused until their SDK pins are updated", {
  skip: ["dsh-agent-budget", "dsh-tool-search"].every((name) => (
    existsSync(resolve(APP_ROOT, "..", name, "package.json"))
  )) ? false : "dsh-external sample checkouts are not present",
}, () => {
  for (const packageDir of ["dsh-agent-budget", "dsh-tool-search"]) {
    const manifest = JSON.parse(readFileSync(resolve(APP_ROOT, "..", packageDir, "package.json"), "utf8"));
    assert.throws(() => validateProfileBundleSdk(manifest), { code: "DSH_PROFILE_LEGACY_SDK" });
  }
});

test("the Profile catalog is projected from the official Web Profile order", {
  timeout: 30_000,
  skip: existsSync(join(DSH_NPM_ROOT, "package.json"))
    ? false
    : `missing app-pinned DSH package: ${DSH_NPM_ROOT}`,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-work-profile-catalog-"));
  try {
    const service = new DshProfilePluginService({
      env: {
        ...process.env,
        DSH_RUNTIME_DISTRIBUTION: "npm",
        DSH_RUNTIME_HOME: home,
        DSH_HOME: home,
      },
      restartRuntime: async () => ({ restarted: false, sessions: [] }),
    });
    const catalog = await service.catalog();
    assert.deepEqual(catalog.plugins.slice(0, 2).map((plugin) => plugin.id), [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
    ]);
    const productBridge = catalog.plugins.find((plugin) => plugin.id === "@deepseek-ai/dsh-product-bridge");
    assert.equal(productBridge.runtime_kind, "profile_bundle");
    assert.equal(productBridge.managed_by, "app");
    assert.equal(productBridge.can_uninstall, false);
    assert.deepEqual(
      productBridge.product.contributions.map((item) => item.id),
      ["review", "browser", "files", "artifacts", "sites"],
    );
    const themePack = catalog.plugins.find((plugin) => plugin.id === "@deepseek-ai/dsh-theme-pack");
    assert.equal(themePack.runtime_kind, "profile_bundle");
    assert.equal(themePack.managed_by, "app");
    assert.equal(themePack.profile_theme_count, 2);
    assert.deepEqual(catalog.profile_themes.map((theme) => ({
      id: theme.id,
      manifest_id: theme.manifest_id,
      package_name: theme.source_bundle.package_name,
    })), [{
      id: "profile:%40deepseek-ai%2Fdsh-theme-pack:professional-blue",
      manifest_id: "professional-blue",
      package_name: "@deepseek-ai/dsh-theme-pack",
    }, {
      id: "profile:%40deepseek-ai%2Fdsh-theme-pack:anime-blue",
      manifest_id: "anime-blue",
      package_name: "@deepseek-ai/dsh-theme-pack",
    }]);
    assert.equal(catalog.plugins.at(-1).id, "@deepseek-ai/dsh-work-shell");
    assert.equal(catalog.plugins.at(-1).managed_by, "app");
    assert.deepEqual(catalog.plugins.at(-1).ui_runtime, {
      kind: "dsh_client",
      client_graph: true,
      host_supported_slots: ["settings.section", "shell.overlay", "sidebar.footer.action", "conversation.composer.dock"],
      host_unmapped_slots: ["sidebar", "conversation", "details"],
    });
    const state = await service.state();
    const profile = state.api.loadProfile("dsh-work-test", "web", state.resolved.installAnchor, home);
    const rows = state.api.composeEntries([
      profile.layers.flatMap((layer) => layer.patches),
      profile.patches,
    ]);
    assert.equal(rows.find((row) => row.id === "ui-layout")?.disabled, true);
    assert.equal(rows.find((row) => row.id === "ui-settings-general")?.disabled, true);
    assert.equal(rows.find((row) => row.id === "dsh-work-shell")?.name, "@deepseek-ai/dsh-work-shell");
    assert.equal(catalog.marketplaces[0].name, "web");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("an older community dsh.client stays removable without entering the active graph", {
  timeout: 30_000,
  skip: existsSync(join(DSH_NPM_ROOT, "package.json"))
    ? false
    : `missing app-pinned DSH package: ${DSH_NPM_ROOT}`,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-work-profile-quarantine-"));
  const profileDir = join(home, "profiles", "web");
  const packageDir = join(profileDir, "node_modules", "@example", "community-client");
  try {
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "package.json"), `${JSON.stringify({
      name: "@example/community-client",
      version: "1.0.0",
      description: "Existing community Client fixture",
      dsh: {
        bundle: { patch: "./cordis.patch.yml" },
        client: { platform: "web" },
      },
      exports: { "./client": "./client.js" },
    }, null, 2)}\n`);
    await writeFile(join(packageDir, "cordis.patch.yml"), "- insert: []\n");
    await writeFile(join(packageDir, "client.js"), "export default function apply() {}\n");
    await writeFile(join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      dependencies: { "@example/community-client": "1.0.0" },
      dsh: { profile: { bundles: [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@example/community-client",
      ] } },
    }, null, 2)}\n`);

    const service = new DshProfilePluginService({
      env: {
        ...process.env,
        DSH_RUNTIME_DISTRIBUTION: "npm",
        DSH_RUNTIME_HOME: home,
        DSH_HOME: home,
      },
      restartRuntime: async () => ({ restarted: false, sessions: [] }),
    });
    const catalog = await service.catalog();
    const plugin = catalog.plugins.find((item) => item.id === "@example/community-client");
    assert.equal(plugin.enabled, false);
    assert.equal(plugin.can_uninstall, true);
    assert.equal(plugin.ui_runtime.client_graph, false);
    assert.equal(plugin.ui_runtime.isolation, "quarantined");
    assert.match(plugin.blocked_reason, /主窗口运行图隔离/);

    const stored = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
    assert.equal(stored.dsh.profile.bundles.includes("@example/community-client"), false);
    assert.equal(stored.dependencies["@example/community-client"], "1.0.0");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

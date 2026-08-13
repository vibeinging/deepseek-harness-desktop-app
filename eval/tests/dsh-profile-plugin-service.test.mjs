import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DshProfilePluginService,
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
      "@deepseek-ai/dsh-tools": "^0.1.0-rc.2",
    },
  }));
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
      code: "DSH_PROFILE_LEGACY_SDK",
      message: "dsh-better-sidebar 有 1 个 DSH SDK 包不属于当前 0.1.0-rc.2 发布线",
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
  for (const packageDir of ["dsh-product-bridge"]) {
    const manifest = JSON.parse(readFileSync(join(APP_ROOT, "packages", packageDir, "package.json"), "utf8"));
    assert.doesNotThrow(() => validateProfileBundleSdk(manifest));
    assert.equal(manifest.peerDependencies["@deepseek-ai/cordis"], "^4.0.1");
    assert.equal(manifest.peerDependencies.cordis, undefined);
  }
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
    assert.deepEqual(catalog.profile_themes.map((theme) => ({
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
    assert.equal(catalog.plugins.at(-1).id, "@deepseek-ai/dsh-product-bridge");
    assert.equal(catalog.plugins.at(-1).runtime_kind, "profile_bundle");
    assert.equal(catalog.plugins.at(-1).managed_by, "app");
    assert.equal(catalog.plugins.at(-1).can_uninstall, false);
    assert.deepEqual(
      catalog.plugins.at(-1).product.contributions.map((item) => item.id),
      ["review", "browser", "files", "artifacts", "sites"],
    );
    assert.equal(catalog.marketplaces[0].name, "web");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

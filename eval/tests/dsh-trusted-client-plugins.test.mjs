import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import {
  prepareTrustedClientPlugins,
  prepareTrustedProfilePlugins,
} from "../../server/src/engine/dsh_runtime/trusted_client_plugins.js";

async function fixture(root, name = "@deepseek-ai/dsh-product-bridge", { client = false } = {}) {
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "index.js"), "export default function apply() {}\n");
  await writeFile(join(root, "cordis.patch.yml"), "- insert: []\n");
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name,
    type: "module",
    main: "./src/index.js",
    dsh: {
      bundle: { patch: "./cordis.patch.yml" },
      ...(client ? { client: { platform: "web" } } : {}),
    },
  }, null, 2)}\n`);
}

function profileApi() {
  return {
    PROFILE_TEMPLATES: {
      web: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
    },
    DEFAULT_PROFILE_BUNDLES: ["@deepseek-ai/dsh-base"],
    resolveProfileDir(name, home) {
      return join(home, "profiles", name);
    },
    initProfile(dir, bundles) {
      mkdirSync(dir, { recursive: true });
      const path = join(dir, "package.json");
      if (!existsSync(path)) {
        writeFileSync(path, `${JSON.stringify({
          name: "dsh-profile-web",
          private: true,
          dependencies: {},
          dsh: { profile: { bundles: [...bundles] } },
        }, null, 2)}\n`);
      }
    },
    readProfileManifest(_name, dir) {
      return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    },
    writeProfileManifest(dir, manifest) {
      writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    },
    resolveBundleDir(_name, packageName, _installAnchor, dir) {
      return join(dir, "node_modules", ...packageName.split("/"));
    },
  };
}

test("trusted DSH plugins use an exact allowlist and profile resolver link", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-trusted-client-"));
  const pluginRoot = join(root, "plugin");
  const dshHome = join(root, "home");
  try {
    await fixture(pluginRoot);
    const retiredLink = join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh-turn-navigator");
    await mkdir(dirname(retiredLink), { recursive: true });
    await symlink(pluginRoot, retiredLink, "junction");
    const prepared = prepareTrustedClientPlugins({
      appRoot: join(root, "app"),
      env: { DSH_HOME: dshHome, DSH_PRODUCT_BRIDGE_ROOT: pluginRoot },
      runtimeRoot: join(root, "runtime"),
      dshHome,
    });
    const realPluginRoot = await realpath(pluginRoot);
    assert.equal(prepared.length, 1);
    assert.equal(prepared[0].name, "@deepseek-ai/dsh-product-bridge");
    assert.equal(prepared[0].patch, resolve(realPluginRoot, "cordis.patch.yml"));
    assert.equal(prepared[0].entry, resolve(realPluginRoot, "src/index.js"));
    const link = join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh-product-bridge");
    assert.equal((await lstat(link)).isSymbolicLink(), true);
    assert.equal(resolve(dirname(link), await readlink(link)), realPluginRoot);
    assert.equal(existsSync(retiredLink), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted client plugins reject a configured package with the wrong identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-trusted-client-bad-"));
  const pluginRoot = join(root, "plugin");
  try {
    await fixture(pluginRoot, "@example/not-trusted");
    assert.throws(() => prepareTrustedClientPlugins({
      appRoot: join(root, "app"),
      env: { DSH_HOME: join(root, "home"), DSH_PRODUCT_BRIDGE_ROOT: pluginRoot },
      runtimeRoot: join(root, "runtime"),
    }), /包名不匹配/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing optional app package leaves the profile unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-trusted-client-missing-"));
  try {
    assert.deepEqual(prepareTrustedClientPlugins({
      appRoot: join(root, "app"),
      env: { DSH_HOME: join(root, "home"), DSH_RUNTIME_DISTRIBUTION: "source" },
      runtimeRoot: join(root, "runtime"),
    }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted DSH plugins are composed by the official Profile bundle list", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-trusted-profile-"));
  const pluginRoot = join(root, "plugin");
  const dshHome = join(root, "home");
  const profileDir = join(dshHome, "profiles", "web");
  try {
    await fixture(pluginRoot);
    await mkdir(profileDir, { recursive: true });
    await fixture(join(profileDir, "node_modules", "@example", "user-bundle"), "@example/user-bundle");
    await fixture(
      join(profileDir, "node_modules", "@example", "community-ui"),
      "@example/community-ui",
      { client: true },
    );
    await writeFile(join(profileDir, "package.json"), `${JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      dependencies: {
        "@deepseek-ai/dsh-product-client": "file:/retired-product-client",
        "@deepseek-ai/dsh-turn-navigator": "file:/retired-turn-navigator",
        "@example/user-bundle": "1.0.0",
        "@example/community-ui": "1.0.0",
      },
      dsh: { profile: { bundles: [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@deepseek-ai/dsh-product-client",
        "@deepseek-ai/dsh-turn-navigator",
        "@example/user-bundle",
        "@example/community-ui",
      ] } },
    }, null, 2)}\n`);

    const first = await prepareTrustedProfilePlugins({
      profileApi: profileApi(),
      installAnchor: join(root, "dsh", "package.json"),
      appRoot: join(root, "app"),
      env: { DSH_HOME: dshHome, DSH_PRODUCT_BRIDGE_ROOT: pluginRoot },
      runtimeRoot: join(root, "runtime"),
      dshHome,
    });
    assert.equal(first.changed, true);
    assert.deepEqual(first.bundles, [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      "@example/user-bundle",
      "@deepseek-ai/dsh-product-bridge",
    ]);
    assert.deepEqual(first.quarantined.map((plugin) => plugin.name), ["@example/community-ui"]);
    const stored = JSON.parse(await readFile(join(profileDir, "package.json"), "utf8"));
    assert.deepEqual(stored.dependencies, {
      "@example/user-bundle": "1.0.0",
      "@example/community-ui": "1.0.0",
    });
    assert.deepEqual(stored.dsh.profile.bundles, first.bundles);

    const second = await prepareTrustedProfilePlugins({
      profileApi: profileApi(),
      installAnchor: join(root, "dsh", "package.json"),
      appRoot: join(root, "app"),
      env: { DSH_HOME: dshHome, DSH_PRODUCT_BRIDGE_ROOT: pluginRoot },
      runtimeRoot: join(root, "runtime"),
      dshHome,
    });
    assert.equal(second.changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

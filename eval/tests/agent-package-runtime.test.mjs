import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function packageFixture(t, plugins) {
  const root = await mkdtemp(join(tmpdir(), "dsh-package-plugins-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceServerDir = join(root, "source-server");
  const stagedServerDir = join(root, "staged-server");
  const marketplace = { name: "package-test", plugins };
  await writeJson(join(sourceServerDir, ".agents", "plugins", "marketplace.json"), marketplace);
  await writeJson(join(stagedServerDir, ".agents", "plugins", "marketplace.json"), marketplace);
  return { sourceServerDir, stagedServerDir };
}

async function writePlugin(serverDir, path, name) {
  await writeJson(join(serverDir, path, "plugin.json"), { name, version: "1.0.0" });
}

test("desktop package preparation installs the Agent runtime and verifies every local marketplace Plugin", () => {
  const source = readFileSync("electron/scripts/prepare-package.mjs", "utf8");
  assert.match(source, /--include=optional/);
  assert.match(source, /`--cpu=\$\{targetArch\}`/);
  assert.match(source, /`--os=\$\{targetPlatform\}`/);
  assert.match(source, /codex-cli 0\\\.147\\\.0/);
  assert.match(source, /Agent .*原生运行时没有进入安装包/);
  assert.match(source, /includes\(['"]\.runtime['"]\)/);
  assert.doesNotMatch(source, /parts\[pluginsIndex \+ 1\] === ['"]pdf-facts['"]/);
  assert.match(source, /verifyPackagedBuiltinPlugins/);
  assert.match(source, /marketplace\.plugins/);
  assert.doesNotMatch(source, /packagedPdfFactsFiles|PDF Facts 正式产品文件/);

  const marketplace = JSON.parse(readFileSync("server/.agents/plugins/marketplace.json", "utf8"));
  for (const plugin of marketplace.plugins.filter((item) => item?.source?.source === "local")) {
    const manifest = join("server", plugin.source.path, "plugin.json");
    assert.equal(existsSync(manifest), true, `内置 Plugin manifest 不存在: ${manifest}`);
    assert.equal(JSON.parse(readFileSync(manifest, "utf8")).name, plugin.name);
  }
});

test("desktop packager declares both Codex local marketplace source forms", () => {
  const source = readFileSync("electron/scripts/prepare-package.mjs", "utf8");
  assert.match(source, /typeof plugin\.source === ['"]string['"]/);
  assert.match(source, /plugin\.source\.source === ['"]local['"]/);
});

test("desktop packager still runs its CLI entrypoint when executed directly", () => {
  const result = spawnSync(process.execPath, [
    "electron/scripts/prepare-package.mjs",
    "--platform",
    "invalid-test-platform",
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DSH_PACKAGE_NODE_REEXEC: "1" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不支持的目标平台: invalid-test-platform/);
});

test("packaged Plugin validation accepts string shorthand and object local sources", async (t) => {
  const { verifyPackagedBuiltinPlugins } = await import("../../electron/scripts/prepare-package.mjs");
  const entries = [
    { name: "string-plugin", source: "./plugins/string-plugin" },
    { name: "object-plugin", source: { source: "local", path: "./plugins/object-plugin" } },
  ];
  const fixture = await packageFixture(t, entries);
  for (const entry of entries) {
    const path = typeof entry.source === "string" ? entry.source : entry.source.path;
    await writePlugin(fixture.sourceServerDir, path, entry.name);
    await writePlugin(fixture.stagedServerDir, path, entry.name);
  }

  assert.deepEqual(
    await verifyPackagedBuiltinPlugins(fixture),
    ["string-plugin", "object-plugin"],
  );
});

test("packaged Plugin validation rejects a missing local source directory", async (t) => {
  const { verifyPackagedBuiltinPlugins } = await import("../../electron/scripts/prepare-package.mjs");
  const fixture = await packageFixture(t, [{
    name: "missing-plugin",
    source: "./plugins/missing-plugin",
  }]);

  await assert.rejects(
    verifyPackagedBuiltinPlugins(fixture),
    /内置 Plugin 源目录不存在: missing-plugin/,
  );
});

test("packaged Plugin validation rejects a local Plugin omitted from the staged package", async (t) => {
  const { verifyPackagedBuiltinPlugins } = await import("../../electron/scripts/prepare-package.mjs");
  const fixture = await packageFixture(t, [{
    name: "not-copied",
    source: { source: "local", path: "./plugins/not-copied" },
  }]);
  await writePlugin(fixture.sourceServerDir, "./plugins/not-copied", "not-copied");

  await assert.rejects(
    verifyPackagedBuiltinPlugins(fixture),
    /内置 Plugin 没有进入安装包: not-copied/,
  );
});

test("packaged Plugin validation rejects a copied manifest with a different name", async (t) => {
  const { verifyPackagedBuiltinPlugins } = await import("../../electron/scripts/prepare-package.mjs");
  const fixture = await packageFixture(t, [{
    name: "expected-name",
    source: "./plugins/expected-name",
  }]);
  await writePlugin(fixture.sourceServerDir, "./plugins/expected-name", "expected-name");
  await writePlugin(fixture.stagedServerDir, "./plugins/expected-name", "wrong-name");

  await assert.rejects(
    verifyPackagedBuiltinPlugins(fixture),
    /内置 Plugin 名称不一致: expected-name/,
  );
});

test("packaged Plugin validation rejects source or staged Plugin symlinks", async (t) => {
  if (process.platform === "win32") return t.skip("Windows symlink creation requires extra privileges");
  const { verifyPackagedBuiltinPlugins } = await import("../../electron/scripts/prepare-package.mjs");
  const fixture = await packageFixture(t, [{
    name: "linked-plugin",
    source: "./plugins/linked-plugin",
  }]);
  const external = join(await mkdtemp(join(tmpdir(), "dsh-package-external-")), "linked-plugin");
  t.after(() => rm(dirname(external), { recursive: true, force: true }));
  await writePlugin(dirname(external), "linked-plugin", "linked-plugin");
  await mkdir(join(fixture.sourceServerDir, "plugins"), { recursive: true });
  await mkdir(join(fixture.stagedServerDir, "plugins"), { recursive: true });
  await symlink(external, join(fixture.sourceServerDir, "plugins", "linked-plugin"));
  await symlink(external, join(fixture.stagedServerDir, "plugins", "linked-plugin"));

  await assert.rejects(
    verifyPackagedBuiltinPlugins(fixture),
    /符号链接/,
  );
});

test("desktop package includes the Agent Apache license", () => {
  const pkg = JSON.parse(readFileSync("electron/package.json", "utf8"));
  assert.ok(pkg.build.extraResources.some((entry) => entry.to === "legal/openai-agent-runtime-LICENSE.txt"));
});

test("Electron package files include every local main-process dependency", () => {
  const pkg = JSON.parse(readFileSync("electron/package.json", "utf8"));
  const packaged = new Set(pkg.build.files);
  const pending = ["main.js"];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(join("electron", file), "utf8");
    for (const match of source.matchAll(/require\(["'](\.\/[^"']+)["']\)/g)) {
      const dependencyPath = match[1].endsWith(".js") ? match[1] : `${match[1]}.js`;
      const dependency = relative("electron", join("electron", dirname(file), dependencyPath));
      assert.equal(existsSync(join("electron", dependency)), true, `${file} 依赖不存在: ${dependency}`);
      assert.equal(packaged.has(dependency), true, `${file} 的依赖未进入安装包: ${dependency}`);
      pending.push(dependency);
    }
  }
});

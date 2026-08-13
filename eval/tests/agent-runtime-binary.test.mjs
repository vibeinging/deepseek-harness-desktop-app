import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentRuntimeTarget, resolveAgentRuntimeBinary } from "../../server/src/engine/agent_kernel/runtime_binary.js";

test("Agent binary resolver honors an explicit runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-agent_runtime-bin-"));
  const binary = join(dir, "agent_runtime");
  await writeFile(binary, "test");
  assert.equal(resolveAgentRuntimeBinary({ env: { DSH_AGENT_RUNTIME_BIN: binary }, platform: "darwin", arch: "arm64" }), binary);
});

test("Agent binary target maps supported desktop platforms", () => {
  assert.equal(agentRuntimeTarget("darwin", "arm64").triple, "aarch64-apple-darwin");
  assert.equal(agentRuntimeTarget("win32", "x64").executable, "codex.exe");
  assert.throws(() => agentRuntimeTarget("freebsd", "x64"), { code: "AGENT_RUNTIME_PLATFORM_UNSUPPORTED" });
});

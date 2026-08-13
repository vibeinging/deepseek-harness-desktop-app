import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { AgentKernel } from "../../server/src/engine/agent_kernel/kernel.js";

test("the pinned app-server accepts the unattended local automation thread contract", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "darwin") {
    t.skip("bundled native app-server smoke currently runs on macOS");
    return;
  }
  const binary = [
    resolve("server/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"),
    resolve("server/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex"),
  ].find(existsSync);
  if (!binary) {
    t.skip("bundled app-server binary is unavailable");
    return;
  }

  const runtimeHome = await mkdtemp(join(tmpdir(), "dsh-native-automation-"));
  const kernel = new AgentKernel({
    binary,
    cwd: process.cwd(),
    env: { ...process.env, CODEX_HOME: runtimeHome },
    requestTimeoutMs: 15_000,
  });
  try {
    const started = await kernel.startThread({
      ephemeral: false,
      tools: [],
      approvalPolicy: "never",
      approvalsReviewer: "auto_review",
      sandbox: "workspace-write",
      developerInstructions: [
        "You are running a local scheduled task in DSH.",
        "Do not ask synchronous questions. Stay inside the current sandbox.",
      ].join("\n"),
    });
    assert.ok(started.thread.id);
    const read = await kernel.readThread(started.thread.id, { includeTurns: false });
    assert.equal(read.thread.id, started.thread.id);
  } finally {
    await kernel.stop();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

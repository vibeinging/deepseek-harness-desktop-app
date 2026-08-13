import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AppServerClient } from "../../server/src/engine/agent_kernel/app_server_client.js";

function fakeProcess(onMessage) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, signal === "SIGTERM" ? null : signal));
    return true;
  };
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) onMessage(JSON.parse(line), child);
      newline = buffer.indexOf("\n");
    }
  });
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

test("AppServerClient exchanges JSON-RPC requests and notifications", async () => {
  const sent = [];
  const client = new AppServerClient({
    binary: "/fake/agent_runtime",
    spawnFn: () => fakeProcess((message, child) => {
      sent.push(message);
      if (message.method === "initialize") {
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { userAgent: "agent_runtime-test" } })}\n`);
      }
    }),
  });
  await client.start();
  const initialized = await client.request("initialize", { clientInfo: { name: "test", version: "1" } });
  assert.equal(initialized.userAgent, "agent_runtime-test");

  const notification = new Promise((resolve) => client.once("turn/started", resolve));
  client.child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { turn: { id: "t1" } } })}\n`);
  assert.equal((await notification).turn.id, "t1");
  assert.equal(sent[0].method, "initialize");
  await client.stop();
});

test("AppServerClient keeps runtime error notifications off EventEmitter's fatal error path", async () => {
  const client = new AppServerClient({
    binary: "/fake/agent_runtime",
    spawnFn: () => fakeProcess(() => {}),
  });
  await client.start();
  const notification = new Promise((resolve) => client.once("notification", resolve));
  client.child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "error",
    params: { error: { message: "Reconnecting" }, willRetry: true },
  })}\n`);
  assert.deepEqual(await notification, {
    method: "error",
    params: { error: { message: "Reconnecting" }, willRetry: true },
  });
  await client.stop();
});

test("AppServerClient handles App Server requests", async () => {
  let response;
  const client = new AppServerClient({
    binary: "/fake/agent_runtime",
    spawnFn: () => fakeProcess((message) => {
      if (message.id === 91 && !message.method) response = message;
    }),
  });
  client.handle("item/tool/call", async (params) => ({
    success: true,
    contentItems: [{ type: "inputText", text: String(params.arguments.value) }],
  }));
  await client.start();
  client.child.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 91,
    method: "item/tool/call",
    params: { threadId: "th", turnId: "tu", callId: "c", tool: "echo", arguments: { value: 7 } },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(response.result.success, true);
  assert.equal(response.result.contentItems[0].text, "7");
  await client.stop();
});

test("AppServerClient rejects timed out requests", async () => {
  const client = new AppServerClient({
    binary: "/fake/agent_runtime",
    requestTimeoutMs: 10,
    spawnFn: () => fakeProcess(() => {}),
  });
  await client.start();
  await assert.rejects(client.request("never/replies"), { code: "AGENT_RUNTIME_RPC_TIMEOUT" });
  await client.stop();
});

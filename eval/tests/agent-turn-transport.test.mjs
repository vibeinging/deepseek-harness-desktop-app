import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emitAgentRpc, resolveAgentUserInput, steerAgentTurn } from "../../server/src/app/chat/agent_turns.js";
import { pendingDecisions, redactUserInputAnswers } from "../../server/src/app/chat/agent_misc.js";
import { finalizeTerminalContentItems, persistAssistantSnapshot } from "../../server/src/app/chat/agent_chat.js";
import {
  activeRunSnapshot,
  clearActiveRunsForTests,
  claimActiveSession,
  registerActiveRun,
  steerActiveRun,
  stopActiveRun,
} from "../../server/src/engine/agents/active_run_registry.js";
import {
  projectNativeTurnHistory,
  rebuildInterruptedTurnsFromNative,
} from "../../server/src/engine/agent_kernel/native_turn_history_recovery.js";

test("agent turn transport emits Agent Runtime JSON-RPC notifications", () => {
  const frames = [];
  const emit = emitAgentRpc((frame) => frames.push(frame));
  emit({
    type: "item/agentMessage/delta",
    thread_id: "thread-1",
    turn_id: "turn-1",
    item_id: "item-1",
    seq: 4,
    ts: "2026-07-30T00:00:00.000Z",
    payload: { delta: "你好" },
  });
  assert.deepEqual(frames, [{
    jsonrpc: "2.0",
    method: "item/agentMessage/delta",
    params: {
      delta: "你好",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      _meta: { seq: 4, ts: "2026-07-30T00:00:00.000Z" },
    },
  }]);
});

test("secret request_user_input answers are removed before history persistence", () => {
  const redacted = redactUserInputAnswers([
    { id: "account", isSecret: false },
    { id: "token", isSecret: true },
  ], {
    account: { answers: ["team"] },
    token: { answers: ["sk-live-secret"] },
  });
  assert.deepEqual(redacted, {
    account: { answers: ["team"] },
    token: { answers: [], answered: true, secret: true },
  });
  assert.equal(JSON.stringify(redacted).includes("sk-live-secret"), false);
});

test("interrupted turns persist open item snapshots as stopped", () => {
  const items = [
    { id: "tool-1", type: "tool", title: "running", metadata: { tool_name: "command" }, is_complete: false },
    { id: "file-1", type: "file_change", title: "running", content: JSON.stringify({ status: "inProgress", changes: [] }), metadata: {} },
    { id: "confirm:1", type: "confirm", title: "MCP 工具确认", content: "调用外部工具", metadata: { approval_request: { kind: "mcp_tool_call" } } },
    { id: "user_input:1", type: "user_input", title: "requested", content: JSON.stringify({ questions: [] }), metadata: { status: "requested" } },
    { id: "done-1", type: "tool", title: "done", metadata: { tool_name: "read" } },
  ];
  finalizeTerminalContentItems(items, "interrupted");
  assert.equal(items[0].title, "stopped");
  assert.equal(items[0].metadata.status, "interrupted");
  assert.equal(items[0].is_complete, true);
  assert.equal(items[1].title, "stopped");
  assert.equal(JSON.parse(items[1].content).status, "interrupted");
  assert.equal(items[2].title, "stopped");
  assert.equal(items[2].metadata.status, "interrupted");
  assert.equal(items[3].title, "stopped");
  assert.equal(JSON.parse(items[3].content).status, "interrupted");
  assert.equal(items[4].title, "done");
});

test("assistant snapshots are incrementally upserted without inflating message count", async () => {
  let exists = false;
  let messageCountIncrements = 0;
  let storedItems = null;
  let storedMetadata = null;
  const ctx = {
    queryOne: async () => ({ m: exists ? 2 : 1 }),
    query: async (sql, params) => {
      if (sql.includes("INSERT INTO session_messages")) {
        if (exists) return [];
        exists = true;
        storedItems = params[2];
        storedMetadata = params[3];
        return [{ id: params[0] }];
      }
      if (sql.includes("message_count=COALESCE(message_count,0)+1")) messageCountIncrements += 1;
      if (sql.includes("SET content_items=$1")) {
        storedItems = params[0];
        storedMetadata = params[1];
      }
      return [];
    },
  };

  const first = await persistAssistantSnapshot(ctx, {
    sessionId: "session-partial",
    assistantMessageId: "assistant:run-partial",
    items: [{ id: "commentary", type: "agentMessage", phase: "commentary", content: "检查中" }],
    metadata: { turn_status: "inProgress", partial: true },
  });
  const second = await persistAssistantSnapshot(ctx, {
    sessionId: "session-partial",
    assistantMessageId: "assistant:run-partial",
    items: [{ id: "answer", type: "agentMessage", phase: "final_answer", content: "完成" }],
    metadata: { turn_status: "completed", partial: false },
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(messageCountIncrements, 1);
  assert.equal(JSON.parse(storedItems)[0].phase, "final_answer");
  assert.equal(JSON.parse(storedMetadata).turn_status, "completed");
});

test("native thread/read history is projected with phase and inline tool output", async () => {
  const projected = await projectNativeTurnHistory({
    id: "native-turn-1",
    items: [
      { id: "progress", type: "agentMessage", phase: "commentary", text: "正在检查" },
      {
        id: "command-1",
        type: "commandExecution",
        status: "completed",
        command: "npm test",
        aggregatedOutput: "12 tests passed",
      },
      { id: "answer", type: "agentMessage", phase: "final_answer", text: "修复完成" },
    ],
  }, { threadId: "native-thread-1", messageId: "assistant:run-1" });

  assert.equal(projected.find((item) => item.id === "progress")?.metadata?.phase, "commentary");
  assert.equal(projected.find((item) => item.id === "answer")?.metadata?.phase, "final_answer");
  assert.equal(projected.find((item) => item.id === "command-1")?.metadata?.trace_output, "12 tests passed");
});

test("interrupted runs rebuild their exact native turn into the persisted assistant snapshot", async () => {
  let stored = null;
  const ctx = {
    queryOne: async (sql) => {
      if (sql.includes("FROM agent_runs ar")) {
        return {
          id: "run-native-recovery",
          session_id: "session-native-recovery",
          turn_id: "turn-native-recovery",
          status: "interrupted",
          session_config: JSON.stringify({ agent_runtime_thread_id: "thread-native-recovery" }),
        };
      }
      if (sql.includes("FROM session_messages")) {
        return {
          id: "assistant:run-native-recovery",
          content_items: JSON.stringify([{ id: "partial", type: "markdown", phase: "commentary", content: "本地快照" }]),
          message_metadata: JSON.stringify({ turn_status: "inProgress", partial: true }),
        };
      }
      return null;
    },
    query: async (sql, params) => {
      if (sql.includes("UPDATE session_messages")) stored = { items: params[0], metadata: params[1] };
      return [];
    },
  };
  const runtime = {
    readThread: async (threadId, options) => {
      assert.equal(threadId, "thread-native-recovery");
      assert.deepEqual(options, { includeTurns: true });
      return {
        thread: {
          turns: [{
            id: "turn-native-recovery",
            status: "interrupted",
            items: [{ id: "native-answer", type: "agentMessage", phase: "final_answer", text: "已生成的结果" }],
          }],
        },
      };
    },
  };

  const results = await rebuildInterruptedTurnsFromNative(ctx, {
    runIds: ["run-native-recovery"],
    runtime,
  });

  assert.equal(results[0].status, "rebuilt");
  assert.equal(JSON.parse(stored.items).find((item) => item.id === "native-answer")?.metadata?.phase, "final_answer");
  assert.equal(JSON.parse(stored.metadata).recovery_source, "native_thread_read");
  assert.equal(JSON.parse(stored.metadata).turn_status, "interrupted");
});

test("active turn accepts steer and explicit interrupt", async () => {
  clearActiveRunsForTests();
  const calls = [];
  registerActiveRun("turn-1", {
    sessionId: "thread-1",
    steer: async (input) => calls.push(["steer", input]),
    cancel: async (reason) => calls.push(["cancel", reason]),
  });
  const steered = await steerActiveRun("turn-1", { input: [{ type: "text", text: "补充" }] });
  assert.equal(steered.accepted, true);
  const stopped = await stopActiveRun("turn-1", "user_stop");
  assert.equal(stopped.stopped, true);
  assert.deepEqual(calls, [
    ["steer", { input: [{ type: "text", text: "补充" }] }],
    ["cancel", "user_stop"],
  ]);
  clearActiveRunsForTests();
});

test("explicit interrupt can wait for the persisted terminal settlement", async () => {
  clearActiveRunsForTests();
  let settle;
  const settlement = new Promise((resolve) => { settle = resolve; });
  registerActiveRun("turn-settlement", {
    sessionId: "thread-settlement",
    cancel: async () => {
      setImmediate(() => settle({ status: "interrupted", persisted: true }));
    },
    waitForSettlement: () => settlement,
  });

  const stopped = await stopActiveRun("turn-settlement", "user_stop", { waitForSettlementMs: 1_000 });

  assert.equal(stopped.stopped, true);
  assert.equal(stopped.settled, true);
  assert.deepEqual(stopped.settlement, { status: "interrupted", persisted: true });
  clearActiveRunsForTests();
});

test("an unsettled stop keeps its live registry entry until the runtime actually settles", async () => {
  clearActiveRunsForTests();
  let settle;
  const settlement = new Promise((resolve) => { settle = resolve; });
  registerActiveRun("turn-slow-settlement", {
    sessionId: "thread-slow-settlement",
    cancel: async () => {},
    waitForSettlement: () => settlement,
  });
  const keepAlive = setTimeout(() => {}, 50);
  const stopped = await stopActiveRun("turn-slow-settlement", "user_stop", { waitForSettlementMs: 2 });
  clearTimeout(keepAlive);

  assert.equal(stopped.settled, false);
  assert.equal(activeRunSnapshot("turn-slow-settlement")?.session_id, "thread-slow-settlement");
  settle({ status: "interrupted", persisted: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activeRunSnapshot("turn-slow-settlement"), null);
  clearActiveRunsForTests();
});

test("one session can own only one active turn at a time", () => {
  clearActiveRunsForTests();
  const release = claimActiveSession("session-one");
  assert.equal(typeof release, "function");
  assert.equal(claimActiveSession("session-one"), null);
  release();
  const second = claimActiveSession("session-one");
  assert.equal(typeof second, "function");
  second();
});

test("steered user input is reserved before delivery and repeated client ids are idempotent", async () => {
  clearActiveRunsForTests();
  const order = [];
  let steerCount = 0;
  registerActiveRun("turn-steer", {
    sessionId: "session-steer",
    projectId: "project-1",
    runId: "agent-run-steer",
    steer: async () => {
      steerCount += 1;
      order.push("steer");
      return { accepted: true };
    },
  });
  const writes = [];
  const insertedIds = new Set();
  const metadataById = new Map();
  const ctx = {
    userId: "user-1",
    queryOne: async (sql, params) => {
      if (sql.includes("MAX(sequence_number)")) return { m: 4 };
      if (sql.includes("FROM session_messages")) {
        return insertedIds.has(params[0])
          ? { id: params[0], message_metadata: metadataById.get(params[0]) || "{}" }
          : null;
      }
      return { id: "session-steer" };
    },
    query: async (sql, params) => {
      writes.push({ sql, params });
      if (sql.includes("INSERT INTO session_messages")) {
        if (insertedIds.has(params[0])) return [];
        order.push("persist");
        insertedIds.add(params[0]);
        metadataById.set(params[0], params[3]);
        return [{ id: params[0] }];
      }
      if (sql.includes("UPDATE session_messages")) metadataById.set(params[1], params[0]);
      return [];
    },
  };
  const request = {
    params: { threadId: "session-steer", turnId: "turn-steer" },
    body: {
      input: [{ type: "text", text: "补充筛选华东地区" }],
      clientUserMessageId: "user:steer-1",
      attachments: [],
    },
  };
  const result = await steerAgentTurn(
    ctx,
    request,
  );
  const duplicate = await steerAgentTurn(
    ctx,
    request,
  );

  assert.equal(result.data.accepted, true);
  assert.equal(result.data.persisted, true);
  assert.equal(duplicate.data.persisted, true);
  assert.equal(duplicate.data.idempotent, true);
  assert.equal(steerCount, 1);
  assert.deepEqual(order, ["persist", "steer"]);
  assert.match(writes[0].sql, /ON CONFLICT\(id\) DO NOTHING/);
  assert.equal(writes[0].params[0], "steer:session-steer:user:steer-1");
  assert.match(writes[0].params[2], /补充筛选华东地区/);
  assert.match(writes[1].sql, /message_count=COALESCE\(message_count,0\)\+1/);
  assert.equal(writes.filter(({ sql }) => sql.includes("message_count=COALESCE(message_count,0)+1")).length, 1);
  assert.ok(writes.some(({ sql, params }) => (
    sql.includes("SET sequence_number") && params[1] === "assistant:agent-run-steer"
  )));
  clearActiveRunsForTests();
});

test("a rejected steer rolls back its reserved history row", async () => {
  clearActiveRunsForTests();
  registerActiveRun("turn-steer-rejected", {
    sessionId: "session-steer-rejected",
    projectId: "project-1",
    steer: async () => { throw new Error("turn closed"); },
  });
  const insertedIds = new Set();
  let messageCount = 1;
  const ctx = {
    userId: "user-1",
    queryOne: async (sql) => {
      if (sql.includes("MAX(sequence_number)")) return { m: 1 };
      return { id: "session-steer-rejected", action_type: "agentic_chat" };
    },
    query: async (sql, params) => {
      if (sql.includes("INSERT INTO session_messages")) {
        insertedIds.add(params[0]);
        return [{ id: params[0] }];
      }
      if (sql.includes("message_count=COALESCE(message_count,0)+1")) messageCount += 1;
      if (sql.includes("DELETE FROM session_messages")) {
        const removed = insertedIds.delete(params[0]);
        return removed ? [{ id: params[0] }] : [];
      }
      if (sql.includes("message_count=MAX")) messageCount -= 1;
      return [];
    },
  };

  await assert.rejects(
    steerAgentTurn(ctx, {
      params: { threadId: "session-steer-rejected", turnId: "turn-steer-rejected" },
      body: {
        input: [{ type: "text", text: "已经太晚的补充" }],
        clientUserMessageId: "user:steer-rejected",
        attachments: [],
      },
    }),
    /turn closed/,
  );
  assert.equal(insertedIds.size, 0);
  assert.equal(messageCount, 1);
  clearActiveRunsForTests();
});

test("steer rejects a caller who does not own the active session", async () => {
  clearActiveRunsForTests();
  let steered = false;
  registerActiveRun("turn-private", {
    sessionId: "session-private",
    steer: async () => { steered = true; },
  });

  await assert.rejects(
    steerAgentTurn(
      { userId: "other-user", queryOne: async () => null },
      {
        params: { threadId: "session-private", turnId: "turn-private" },
        body: { input: [{ type: "text", text: "不应接受" }] },
      },
    ),
    (error) => error?.status === 403,
  );
  assert.equal(steered, false);
  clearActiveRunsForTests();
});

test("current Chat turn entrypoint does not fall back to legacy chat orchestrators", async () => {
  const [source, routes] = await Promise.all([readFile(
    new URL("../../server/src/app/chat/agent_turns.js", import.meta.url),
    "utf8",
  ), readFile(
    new URL("../../server/src/transport/registry.chat.js", import.meta.url),
    "utf8",
  )]);
  assert.match(source, /import \{ agentChat \} from "\.\/agent_chat\.js"/);
  assert.doesNotMatch(source, /from "\.\/query_chat\.js"/);
  assert.doesNotMatch(routes, /sessions\/:sid\/chat/);
  assert.doesNotMatch(routes, /query_chat\.js/);
  assert.match(routes, /items\/:itemId\/user-input/);
});

test("runtime notifications stay native while product notifications are namespaced", async () => {
  const source = await readFile(
    new URL("../../server/src/app/chat/agent_chat.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /method: method\.startsWith\("dsh\/"\) \? method : `dsh\/\$\{method\}`/);
  assert.match(source, /source: "dsh-extension"/);
  assert.match(source, /source: "app-server"/);
  assert.match(source, /method === "turn\/diff\/updated" && typeof params\.diff === "string"/);
  assert.match(source, /turn_diff: latestTurnDiff/);
});

test("native request_user_input answer returns to the same App Server request", async () => {
  let resolved = null;
  pendingDecisions.set("question-1", {
    kind: "user_input",
    sessionId: "session-1",
    threadId: "runtime-thread-1",
    turnId: "runtime-turn-1",
    resolve: (value) => { resolved = value; },
  });
  const result = await resolveAgentUserInput(
    { userId: "user-1", queryOne: async () => ({ id: "session-1" }) },
    {
      params: { threadId: "runtime-thread-1", turnId: "runtime-turn-1", itemId: "question-1" },
      body: { answers: { choice: { answers: ["A"] } } },
    },
  );
  assert.deepEqual(resolved, { answers: { choice: { answers: ["A"] } } });
  assert.deepEqual(result.data.answers, { choice: { answers: ["A"] } });
  assert.equal(pendingDecisions.has("question-1"), false);
});

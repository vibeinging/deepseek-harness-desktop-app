// Tests for dsh_history_adapter: DSH session.history events → dsh-app messages.
// Verifies:
//   - events fold into assistant/user messages by turn
//   - item ids match DshEventAdapter's live ids (id stability for dedup)
//   - projections (todos/title) are injected into message_metadata
//   - tool/call + tool/result carry dshView from HistoryEntry.view
//   - pending turns (no turn/end) still flush

import test from "node:test";
import assert from "node:assert/strict";
import { dshEventsToMessages } from "../../server/src/engine/dsh_runtime/dsh_history_adapter.js";
import { loadAllDshHistoryPages, mergeProductProjection } from "../../server/src/app/reads/reads_session.js";
import { assistantItemId, turnIdFrom, toolCallItemId } from "../../server/src/engine/dsh_runtime/event_adapter.js";

const SID = "dsh-session-1";

function entry(seq, type, data, view, time) {
  return { event: { seq, type, data, time: time || seq * 1000 }, ...(view ? { view } : {}) };
}

test("history pagination walks backward and returns one ordered complete log", async () => {
  const calls = [];
  const pages = new Map([
    ["tail", { events: [entry(5, "turn/start", { turn: 2 }), entry(6, "turn/end", { turn: 2 })], hasMore: true, projections: { asOfSeq: 6, values: { title: "latest" } } }],
    ["5", { events: [entry(1, "turn/start", { turn: 1 }), entry(4, "turn/end", { turn: 1 })], hasMore: false }],
  ]);
  const client = {
    request: async (method, payload) => {
      assert.equal(method, "session.history");
      calls.push(payload);
      return pages.get(payload.beforeSeq === undefined ? "tail" : String(payload.beforeSeq));
    },
  };
  const result = await loadAllDshHistoryPages(client, { dshSessionId: SID });
  assert.deepEqual(result.entries.map((item) => item.event.seq), [1, 4, 5, 6]);
  assert.equal(result.projections.values.title, "latest");
  assert.deepEqual(calls.map((call) => call.beforeSeq), [undefined, 5]);
});

test("folds a complete turn (user → assistant message → tool → turn/end) into two messages", () => {
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(1, "user/message", {
        message: { content: [{ type: "text", text: "hello" }] },
        source: { kind: "user", rpcId: "user:request-1" },
      }),
      entry(2, "turn/start", { turn: 1 }),
      entry(3, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "hi back" }] } }),
      entry(4, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[0].message_metadata.dsh_prompt_rpc_id, "user:request-1");
  assert.equal(result.messages[1].role, "assistant");
  assert.equal(result.messages[1].message_metadata.turn_status, "completed");
});

test("cold history projects DSH image references as authorized attachment blocks", () => {
  const digest = "a".repeat(64);
  const result = dshEventsToMessages({
    sessionId: SID,
    appSessionId: "app-session-1",
    entries: [entry(1, "user/message", {
      content: [{
        type: "image",
        attachment: {
          attachmentId: `sha256:${digest}`,
          mediaType: "image/png",
          bytes: 68,
          width: 1,
          height: 1,
          name: "screen.png",
        },
      }],
      source: { kind: "user", rpcId: "user:image" },
    })],
  });
  const image = result.messages[0].content_items[0];
  assert.equal(image.type, "attachment");
  assert.equal(image.metadata.dsh_app_session_id, "app-session-1");
  assert.equal(image.metadata.dsh_attachment_id, `sha256:${digest}`);
  assert.equal(image.metadata.sha256, digest);
  assert.equal(image.metadata.path, `dsh-attachment:sha256:${digest}`);
});

test("product blocks merge by DSH request and Turn identity instead of role order", () => {
  const authoritative = [
    {
      id: "dsh-user",
      role: "user",
      content_items: [{ type: "inputText", text: "same" }],
      message_metadata: { dsh_prompt_rpc_id: "user:exact" },
    },
    {
      id: "dsh-turn:2",
      role: "assistant",
      content_items: [{ type: "agentMessage", content: "done" }],
      message_metadata: { turn_id: "dsh-turn:2" },
    },
  ];
  const product = [
    {
      id: "user:decoy",
      role: "user",
      content_items: JSON.stringify([{ type: "attachment", name: "wrong.png" }]),
      message_metadata: JSON.stringify({ dsh_prompt_rpc_id: "user:decoy" }),
    },
    {
      id: "user:exact",
      role: "user",
      content_items: JSON.stringify([{ type: "attachment", name: "right.png" }]),
      message_metadata: JSON.stringify({ dsh_prompt_rpc_id: "user:exact" }),
    },
    {
      id: "assistant:decoy",
      role: "assistant",
      content_items: JSON.stringify([{ type: "workspace_event", content: "wrong" }]),
      message_metadata: JSON.stringify({ turn_id: "dsh-turn:1" }),
    },
    {
      id: "assistant:exact",
      role: "assistant",
      content_items: JSON.stringify([{ type: "workspace_event", content: "right" }]),
      message_metadata: JSON.stringify({ turn_id: "dsh-turn:2" }),
    },
  ];
  const merged = mergeProductProjection(authoritative, product);
  assert.equal(merged[0].content_items[0].name, "right.png");
  assert.equal(merged[1].content_items[0].content, "right");
});

test("a local image projection replaces the matching DSH attachment preview without duplication", () => {
  const digest = "b".repeat(64);
  const authoritative = [{
    id: "dsh-user",
    role: "user",
    content_items: [{
      id: "dsh-image",
      type: "attachment",
      metadata: { dsh_attachment_id: `sha256:${digest}`, sha256: digest },
    }],
    message_metadata: { dsh_prompt_rpc_id: "user:exact" },
  }];
  const product = [{
    id: "user:exact",
    role: "user",
    content_items: JSON.stringify([{
      id: "local-image",
      type: "attachment",
      metadata: { path: "/tmp/screen.png", sha256: digest },
    }]),
    message_metadata: JSON.stringify({ dsh_prompt_rpc_id: "user:exact" }),
  }];
  const merged = mergeProductProjection(authoritative, product);
  assert.equal(merged[0].content_items.length, 1);
  assert.equal(merged[0].content_items[0].id, "local-image");
});

test("user and steer messages inside one DSH turn do not split the assistant result", () => {
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(1, "turn/start", { turn: 1 }),
      entry(2, "user/message", { content: [{ type: "text", text: "initial" }], source: { kind: "user" } }),
      entry(3, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "working" }] } }),
      entry(4, "user/message", { content: [{ type: "text", text: "steer" }], source: { kind: "user" } }),
      entry(5, "assistant/message", { turn: 1, step: 2, message: { content: [{ type: "text", text: "done" }] } }),
      entry(6, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });

  assert.deepEqual(result.messages.map((message) => message.role), ["user", "user", "assistant"]);
  assert.equal(result.messages.filter((message) => message.role === "assistant").length, 1);
  assert.equal(result.messages[2].message_metadata.turn_status, "completed");
  assert.deepEqual(
    result.messages[2].content_items.filter((item) => item.type === "agentMessage").map((item) => item.content),
    ["working", "done"],
  );
});

test("tool/call item id matches the live DshEventAdapter id for the same event", () => {
  const callEvent = { seq: 5, type: "tool/call", data: { turn: 1, callId: "call-1", name: "project_list", arguments: "{}" } };
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      { event: callEvent, view: { for: "call", view: { card: "generic", title: "List projects" } } },
      entry(6, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  const toolItem = result.messages[0].content_items.find((it) => it.type === "dynamicToolCall");
  assert.ok(toolItem, "tool/call item exists");
  // The id must match what toolCallItemId produces (same function DshEventAdapter uses).
  assert.equal(toolItem.id, toolCallItemId(callEvent));
  assert.equal(toolItem.dshView.view.card, "generic");
});

test("assistant/message item id matches the live DshEventAdapter id", () => {
  const msgEvent = { seq: 3, type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "answer" }] } }, time: 3000 };
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      { event: msgEvent },
      entry(4, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  const msgItem = result.messages[0].content_items.find((it) => it.type === "agentMessage");
  assert.ok(msgItem);
  assert.equal(msgItem.id, assistantItemId(SID, msgEvent));
});

test("assistant reasoning survives cold history as the same thinking block shown live", () => {
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      entry(3, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "reasoning", text: "inspect" }, { type: "text", text: "answer" }] } }),
      entry(4, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  const thinking = result.messages[0].content_items.find((item) => item.type === "thinking");
  assert.equal(thinking.content, "inspect");
});

test("repeated assistant snapshots for one DSH step replace stable items", () => {
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      entry(3, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "reasoning", text: "partial" }, { type: "text", text: "draft" }] } }),
      entry(4, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "reasoning", text: "complete" }, { type: "text", text: "answer" }] } }),
      entry(5, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  const items = result.messages[0].content_items;
  assert.equal(items.filter((item) => item.type === "thinking").length, 1);
  assert.equal(items.filter((item) => item.type === "agentMessage").length, 1);
  assert.equal(items.find((item) => item.type === "thinking").content, "complete");
  assert.equal(items.find((item) => item.type === "agentMessage").content, "answer");
});

test("projections.todos is injected into message_metadata for plan recovery", () => {
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      entry(3, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "done" }] } }),
      entry(4, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
    projections: {
      asOfSeq: 4,
      values: {
        todos: [{ content: "step 1", status: "completed" }, { content: "step 2", status: "in_progress" }],
        title: "My Session",
      },
    },
  });
  assert.deepEqual(result.planTodos, [{ content: "step 1", status: "completed" }, { content: "step 2", status: "in_progress" }]);
  assert.equal(result.title, "My Session");
  // The last assistant message carries the plan todos for renderer recovery.
  assert.deepEqual(result.messages[result.messages.length - 1].message_metadata.dsh_plan_todos, result.planTodos);
});

test("a turn without turn/end (mid-turn history) still flushes as inProgress", () => {
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      entry(3, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "partial" }] } }),
    ],
  });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].message_metadata.turn_status, "inProgress");
});

test("lastSeq tracks the highest event seq seen", () => {
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      entry(10, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  assert.equal(result.lastSeq, 10);
});

test("turn/end with aborted reason maps to interrupted status", () => {
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      entry(5, "turn/end", { turn: 1, reason: { kind: "aborted" } }),
    ],
  });
  assert.equal(result.messages[0].message_metadata.turn_status, "interrupted");
});

test("todo/write event produces a plan content_item", () => {
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      entry(3, "todo/write", { todos: [{ content: "do thing", status: "completed" }] }),
      entry(4, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  const planItem = result.messages[0].content_items.find((it) => it.type === "plan");
  assert.ok(planItem, "plan content_item exists");
  assert.deepEqual(planItem.steps, [{ step: "do thing", status: "completed" }]);
});

test("tool/result carries dshView and output text", () => {
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      entry(3, "tool/call", { turn: 1, callId: "c1", name: "project_list", arguments: "{}" }, { for: "call", view: { card: "generic", title: "List" } }),
      entry(4, "tool/result", { turn: 1, message: { source: { callId: "c1" }, content: [{ type: "tool-result", content: [{ type: "text", text: "result text" }] }] } }, { for: "result", view: { card: "search", shape: "paths", paths: ["a.ts"], truncated: false, total: 1 } }),
      entry(5, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  const items = result.messages[0].content_items;
  const resultItem = items.find((it) => it.id === "c1" && it.status === "completed");
  assert.equal(items.filter((it) => it.id === "c1").length, 1, "call and result fold into one item");
  assert.ok(resultItem, "tool/result item exists");
  assert.equal(resultItem.dshView.view.card, "search");
  assert.equal(resultItem.dshCallView.view.title, "List");
  assert.equal(resultItem.tool, "project_list");
  assert.equal(resultItem.contentItems[0].text, "result text");
});

test("Office write history retains a hidden workspace event beside the folded tool", () => {
  const value = {
    success: true,
    artifact: {
      id: "artifact-1",
      project_id: "project-1",
      current_version: { source_session_id: "app-session-1" },
    },
  };
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      entry(3, "tool/call", {
        turn: 1,
        callId: "office-call",
        name: "artifact_office_create",
        arguments: '{"format":"pptx"}',
      }),
      entry(4, "tool/result", {
        turn: 1,
        message: {
          source: { callId: "office-call" },
          content: [{ type: "tool-result", content: [{ type: "text", text: JSON.stringify(value) }] }],
        },
      }),
      entry(5, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  const workspace = result.messages[0].content_items.find((item) => item.type === "workspace_event");
  assert.ok(workspace);
  assert.equal(workspace.metadata.display, false);
  assert.equal(workspace.metadata.workspace_event.event, "artifact_published");
});

// ─── Real-shape regressions (bugs found against live DSH session.history) ──

test("user/message with real DSH shape (no message wrapper) extracts content", () => {
  // Real DSH user/message: content is at data.content, NOT data.message.content.
  // There is no `message` wrapper. source.kind tells the origin.
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(7, "user/message", {
        content: [{ type: "text", text: "你好" }],
        source: { kind: "user", rpcId: "rpc-1" },
        role: "user",
        id: "msg-1",
      }),
      entry(8, "turn/start", { turn: 1 }),
      entry(9, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "你好！我是 AI 助手" }] } }),
      entry(10, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[0].content_items[0].text, "你好");
  assert.equal(result.messages[1].role, "assistant");
});

test("user/message with source.kind !== user is filtered (system context)", () => {
  // DSH injects runtime-context snapshots (source.kind="plugin") and skill
  // reminders (source.kind="skill-catalog") as user-role messages. These must
  // NOT appear as fake user bubbles in chat history.
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(7, "user/message", {
        content: [{ type: "text", text: "你好" }],
        source: { kind: "user" },
        role: "user",
      }),
      entry(8, "user/message", {
        content: [{ type: "text", text: "Current runtime context..." }],
        source: { kind: "plugin" },
        role: "user",
      }),
      entry(9, "user/message", {
        content: [{ type: "text", text: "<system-reminder>A skill is..." }],
        source: { kind: "skill-catalog" },
        role: "user",
      }),
      entry(10, "turn/start", { turn: 1 }),
      entry(11, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "response" }] } }),
      entry(12, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  const userMsgs = result.messages.filter((m) => m.role === "user");
  assert.equal(userMsgs.length, 1, "only the real user message survives");
  assert.equal(userMsgs[0].content_items[0].text, "你好");
});

test("user/message without source.kind is kept (backward compat)", () => {
  // Older DSH events or the legacy test shape may omit source.kind entirely.
  // These should still be treated as real user messages.
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(1, "user/message", { message: { content: [{ type: "text", text: "legacy" }] } }),
    ],
  });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "user");
  assert.equal(result.messages[0].content_items[0].text, "legacy");
});

test("pre-turn setup events do not produce empty assistant bubbles", () => {
  // Real DSH sessions emit permission/preset, sandbox/mode, approval/policy,
  // agent/inbox/spliced BEFORE the first turn/start. The adapter must not
  // turn these into empty assistant messages.
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(0, "permission/preset", { preset: "workspace-write" }),
      entry(1, "sandbox/mode", { mode: "workspace-write" }),
      entry(2, "approval/policy", { policy: "ask" }),
      entry(3, "agent/inbox/spliced", { target: "next-turn", inserted: [] }),
      entry(4, "turn/start", { turn: 1 }),
      entry(5, "assistant/message", { turn: 1, step: 1, message: { content: [{ type: "text", text: "real answer" }] } }),
      entry(6, "turn/end", { turn: 1, reason: { kind: "completed" } }),
    ],
  });
  // Only the one real assistant turn should appear — no empty bubbles.
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, "assistant");
  assert.equal(result.messages[0].content_items[0].content, "real answer");
});

test("real turn with 0 items (interrupted before output) is kept for status display", () => {
  // A turn that started but was aborted before producing any content still
  // carries a legitimate interrupted status the renderer needs.
  const result = dshEventsToMessages({
    sessionId: SID,
    entries: [
      entry(2, "turn/start", { turn: 1 }),
      entry(5, "turn/end", { turn: 1, reason: { kind: "aborted" } }),
    ],
  });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].message_metadata.turn_status, "interrupted");
});

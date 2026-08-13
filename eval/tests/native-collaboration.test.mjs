import assert from "node:assert/strict";
import test from "node:test";

import {
  nativeCollaborationRunEvent,
  summarizeNativeCollaborationEvents,
  withNativeCollaborationConfig,
} from "../../server/src/engine/agent_kernel/native_collaboration.js";

test("native collaboration config enables only the pinned app-server agent controls", () => {
  assert.deepEqual(withNativeCollaborationConfig({ model_provider: "local" }, { maxConcurrentThreads: 12 }), {
    model_provider: "local",
    agents: {
      enabled: true,
      max_concurrent_threads_per_session: 8,
      interrupt_message: true,
    },
  });
  assert.equal(withNativeCollaborationConfig({ agents: { interrupt_message: false } }).agents.interrupt_message, false);
  assert.equal(withNativeCollaborationConfig({
    agents: { max_concurrent_threads_per_session: 3 },
  }).agents.max_concurrent_threads_per_session, 3);
});

test("native collaboration events preserve app-server parent and child thread facts", () => {
  const started = nativeCollaborationRunEvent("item/started", {
    threadId: "parent-1",
    turnId: "turn-1",
    item: {
      id: "call-1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "inProgress",
      senderThreadId: "parent-1",
      receiverThreadIds: ["child-1"],
      prompt: "检查安全问题",
      agentsStates: { "child-1": { status: "running", message: null } },
    },
  });
  const completed = nativeCollaborationRunEvent("item/completed", {
    threadId: "parent-1",
    turnId: "turn-1",
    item: {
      id: "call-1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "completed",
      senderThreadId: "parent-1",
      receiverThreadIds: ["child-1"],
      prompt: "检查安全问题",
      agentsStates: { "child-1": { status: "errored", message: "检查进程失败" } },
    },
  });
  assert.equal(started.eventType, "native_collaboration_started");
  assert.equal(completed.status, "failed");

  const records = summarizeNativeCollaborationEvents([
    { ...started, event_type: started.eventType, call_id: started.callId, metadata: started.metadata, created_at: "2026-08-01T00:00:00.000Z" },
    { ...completed, event_type: completed.eventType, call_id: completed.callId, metadata: completed.metadata, created_at: "2026-08-01T00:00:01.000Z" },
  ]);
  assert.deepEqual(records, [{
    thread_id: "child-1",
    parent_thread_id: "parent-1",
    call_id: "call-1",
    title: "创建子任务",
    tool: "spawnAgent",
    prompt: "检查安全问题",
    model: null,
    reasoning_effort: null,
    status: "failed",
    message: "检查进程失败",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:01.000Z",
  }]);
});

test("old query subtask records are not accepted as native collaboration", () => {
  assert.equal(nativeCollaborationRunEvent("item/completed", {
    item: { id: "old-1", type: "subtask", status: "completed" },
  }), null);
});

test("native collaboration history keeps the original spawn task after wait updates", () => {
  const records = summarizeNativeCollaborationEvents([
    {
      event_type: "native_collaboration_completed",
      call_id: "spawn-1",
      status: "running",
      metadata_json: JSON.stringify({
        item_type: "collabAgentToolCall",
        item_id: "spawn-1",
        tool: "spawnAgent",
        title: "创建子任务",
        prompt: "检查接口",
        sender_thread_id: "parent-1",
        child_thread_ids: ["child-1"],
        agents_states: { "child-1": { status: "running" } },
      }),
      created_at: "2026-08-01T00:00:00.000Z",
    },
    {
      event_type: "native_collaboration_completed",
      call_id: "wait-1",
      status: "completed",
      metadata_json: JSON.stringify({
        item_type: "collabAgentToolCall",
        item_id: "wait-1",
        tool: "wait",
        title: "等待子任务",
        sender_thread_id: "parent-1",
        child_thread_ids: ["child-1"],
        agents_states: { "child-1": { status: "completed", message: "检查完成" } },
      }),
      created_at: "2026-08-01T00:00:01.000Z",
    },
  ]);
  assert.deepEqual(records[0], {
    thread_id: "child-1",
    parent_thread_id: "parent-1",
    call_id: "spawn-1",
    title: "创建子任务",
    tool: "spawnAgent",
    prompt: "检查接口",
    model: null,
    reasoning_effort: null,
    status: "completed",
    message: "检查完成",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:01.000Z",
  });
});

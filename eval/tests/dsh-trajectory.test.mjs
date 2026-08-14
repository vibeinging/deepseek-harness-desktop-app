import assert from "node:assert/strict";
import { test } from "node:test";

import { getDshTrajectory } from "../../server/src/app/chat/dsh_protocol.js";

function fixture() {
  const calls = [];
  const row = {
    id: "app-session-1",
    project_id: "project-1",
    created_by: "user-1",
    session_config: JSON.stringify({
      dsh_runtime_session_id: "dsh-session-1",
      dsh_runtime_cwd: "/workspace",
    }),
  };
  const ctx = {
    userId: "user-1",
    queryOne: async () => row,
  };
  const events = [
    { event: { type: "turn/start", seq: 3, time: 100, data: { turn: 1 } } },
    {
      event: {
        type: "tool/call",
        seq: 4,
        time: 110,
        data: { turn: 1, step: 1, callId: "call-1", name: "read", arguments: '{"path":"README.md"}' },
      },
      view: { for: "call", view: { card: "generic", title: "读取 README.md", kind: "read" } },
    },
  ];
  const projections = {
    asOfSeq: 4,
    values: { permissions: { currentValue: "workspace-write", options: [] } },
  };
  const client = {
    start: async () => {},
    registerProductHostSession: () => {},
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (method === "workspace.create") return { workspace: { workspaceId: "workspace-1", path: "/workspace" } };
      if (method === "session.create") return { sessionId: "dsh-session-1" };
      if (method === "session.history") return { events, hasMore: false, projections };
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { calls, client, ctx, events, projections };
}

test("the review workbench receives canonical DSH history entries and tool views", async () => {
  const { calls, client, ctx, events, projections } = fixture();
  const result = await getDshTrajectory(ctx, {
    params: { pid: "project-1", threadId: "app-session-1" },
  }, { client });

  assert.equal(result.data.source, "session.history");
  assert.equal(result.data.appSessionId, "app-session-1");
  assert.equal(result.data.dshSessionId, "dsh-session-1");
  assert.equal(result.data.lastSeq, 4);
  assert.deepEqual(result.data.events, events);
  assert.deepEqual(result.data.projections, projections);
  assert.deepEqual(calls.filter((call) => call.method === "session.history"), [{
    method: "session.history",
    payload: { sessionId: "dsh-session-1", maxMessages: 50 },
  }]);
});

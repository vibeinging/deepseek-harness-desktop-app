import assert from "node:assert/strict";
import { test } from "node:test";

import { setDshPlanMode } from "../../server/src/app/chat/dsh_protocol.js";

let fixtureId = 0;

function fixture({ active = false, includeProjection = true, delayReads = 0 } = {}) {
  fixtureId += 1;
  const appSessionId = `app-plan-${fixtureId}`;
  const dshSessionId = `dsh-plan-${fixtureId}`;
  let current = active;
  let pending = null;
  let remaining = 0;
  let seq = 2;
  const calls = [];
  const ctx = {
    userId: "user-1",
    queryOne: async () => ({
      id: appSessionId,
      project_id: "project-1",
      created_by: "user-1",
      session_config: JSON.stringify({
        dsh_runtime_session_id: dshSessionId,
        dsh_runtime_cwd: "/workspace",
      }),
    }),
  };
  const client = {
    start: async () => {},
    registerProductHostSession: () => {},
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (method === "workspace.create") return { workspace: { workspaceId: "workspace-1", path: "/workspace" } };
      if (method === "session.create") return { sessionId: dshSessionId };
      if (method === "session.history") {
        if (pending !== null && remaining <= 0) {
          current = pending;
          pending = null;
          seq += 1;
        } else if (pending !== null) {
          remaining -= 1;
        }
        return {
          entries: [],
          projections: {
            asOfSeq: seq,
            values: includeProjection ? { plan: { active: current, pending: false } } : {},
          },
        };
      }
      if (method === "command.execute") {
        pending = payload.line === "/plan";
        remaining = delayReads;
        return { matched: true };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { appSessionId, calls, client, ctx, dshSessionId };
}

test("Plan changes use the DSH command and confirmed projection", async () => {
  const { appSessionId, calls, client, ctx, dshSessionId } = fixture({ delayReads: 1 });
  const result = await setDshPlanMode(ctx, {
    params: { pid: "project-1", threadId: appSessionId },
    body: { mode: "plan" },
  }, { client });

  assert.equal(result.data.projections.plan.active, true);
  assert.deepEqual(calls.filter((call) => call.method === "command.execute"), [{
    method: "command.execute",
    payload: { sessionId: dshSessionId, line: "/plan" },
  }]);
});

test("Plan changes do not emit a command when DSH already matches", async () => {
  const { appSessionId, calls, client, ctx } = fixture({ active: true });
  const result = await setDshPlanMode(ctx, {
    params: { pid: "project-1", threadId: appSessionId },
    body: { mode: "plan" },
  }, { client });

  assert.equal(result.data.projections.plan.active, true);
  assert.equal(calls.some((call) => call.method === "command.execute"), false);
});

test("Plan changes fail when the Profile does not expose the projection", async () => {
  const { appSessionId, calls, client, ctx } = fixture({ includeProjection: false });
  await assert.rejects(
    setDshPlanMode(ctx, {
      params: { pid: "project-1", threadId: appSessionId },
      body: { mode: "plan" },
    }, { client }),
    /没有提供 Plan 投影/,
  );
  assert.equal(calls.some((call) => call.method === "command.execute"), false);
});

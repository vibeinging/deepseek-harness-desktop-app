import assert from "node:assert/strict";
import { test } from "node:test";

import { setDshPermission } from "../../server/src/app/chat/dsh_protocol.js";

function fixture({ appSessionId, dshSessionId, preset = "workspace-write", projectionDelayReads = 0 }) {
  let current = preset;
  let seq = 3;
  let pendingPreset = null;
  let remainingDelayReads = 0;
  const calls = [];
  const row = {
    id: appSessionId,
    project_id: "project-1",
    created_by: "user-1",
    session_config: JSON.stringify({
      dsh_runtime_session_id: dshSessionId,
      dsh_runtime_cwd: "/workspace",
    }),
  };
  const ctx = {
    userId: "user-1",
    queryOne: async () => row,
  };
  const client = {
    start: async () => {},
    registerProductHostSession: () => {},
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (method === "workspace.create") {
        return { workspace: { workspaceId: "workspace-1", path: "/workspace" } };
      }
      if (method === "session.create") return { sessionId: dshSessionId };
      if (method === "session.history") {
        if (pendingPreset && remainingDelayReads <= 0) {
          current = pendingPreset;
          pendingPreset = null;
          seq += 3;
        } else if (pendingPreset) {
          remainingDelayReads -= 1;
        }
        return {
          entries: [],
          projections: {
            asOfSeq: seq,
            values: {
              permissions: {
                currentValue: current,
                options: [
                  { value: "workspace-write", name: "Workspace Write" },
                  { value: "danger-full-access", name: "Full Access" },
                ],
              },
            },
          },
        };
      }
      if (method === "command.execute") {
        pendingPreset = String(payload.line).replace(/^\/permission\s+/, "");
        remainingDelayReads = projectionDelayReads;
        return { matched: true, commandId: "command-1" };
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
  return { calls, client, ctx };
}

test("permission changes use the DSH projection and logged command path", async () => {
  const appSessionId = "app-permission-1";
  const { calls, client, ctx } = fixture({ appSessionId, dshSessionId: "dsh-permission-1" });
  const result = await setDshPermission(ctx, {
    params: { pid: "project-1", threadId: appSessionId },
    body: { preset: "danger-full-access" },
  }, { client });

  assert.equal(result.data.projections.permissions.currentValue, "danger-full-access");
  assert.deepEqual(calls.filter((call) => call.method === "command.execute"), [{
    method: "command.execute",
    payload: { sessionId: "dsh-permission-1", line: "/permission danger-full-access" },
  }]);
  assert.equal(calls.filter((call) => call.method === "session.history").length, 2);
});

test("permission changes wait for the DSH projection instead of returning stale success", async () => {
  const appSessionId = "app-permission-delayed";
  const { calls, client, ctx } = fixture({
    appSessionId,
    dshSessionId: "dsh-permission-delayed",
    projectionDelayReads: 2,
  });
  const result = await setDshPermission(ctx, {
    params: { pid: "project-1", threadId: appSessionId },
    body: { preset: "danger-full-access" },
  }, { client });

  assert.equal(result.data.projections.permissions.currentValue, "danger-full-access");
  assert.equal(calls.filter((call) => call.method === "session.history").length, 4);
});

test("permission changes reject values absent from the DSH projection", async () => {
  const appSessionId = "app-permission-2";
  const { calls, client, ctx } = fixture({ appSessionId, dshSessionId: "dsh-permission-2" });
  await assert.rejects(
    setDshPermission(ctx, {
      params: { pid: "project-1", threadId: appSessionId },
      body: { preset: "unknown" },
    }, { client }),
    /不在 DSH 当前允许的范围内/,
  );
  assert.equal(calls.some((call) => call.method === "command.execute"), false);
});

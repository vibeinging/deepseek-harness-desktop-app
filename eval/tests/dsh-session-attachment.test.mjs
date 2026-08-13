import test from "node:test";
import assert from "node:assert/strict";
import { ensureDshWorkspaceSession } from "../../server/src/engine/dsh_runtime/session_attachment.js";

test("DSH session attachment adopts the App cwd and accounts the Session under that Workspace", async () => {
  const calls = [];
  const client = {
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (method === "workspace.create") {
        return { workspace: { workspaceId: "workspace-1", path: payload.path } };
      }
      if (method === "session.create") return { sessionId: payload.sessionId || "dsh-new" };
      throw new Error(`unexpected ${method}`);
    },
  };

  const result = await ensureDshWorkspaceSession(client, {
    sessionId: "dsh-1",
    cwd: "/repo",
  });

  assert.equal(result.sessionId, "dsh-1");
  assert.deepEqual(calls, [
    { method: "workspace.create", payload: { path: "/repo" } },
    { method: "session.create", payload: { workspaceId: "workspace-1", sessionId: "dsh-1" } },
  ]);
});

test("DSH session attachment fails before creating a Session when the Workspace response is incomplete", async () => {
  const client = { request: async () => ({ workspace: {} }) };
  await assert.rejects(
    ensureDshWorkspaceSession(client, { sessionId: "dsh-1", cwd: "/repo" }),
    (error) => error?.code === "DSH_WORKSPACE_ID_MISSING",
  );
});

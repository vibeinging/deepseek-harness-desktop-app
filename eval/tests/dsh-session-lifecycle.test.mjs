import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveDshSessionBeforeDelete,
  assertDshSessionCanMove,
  syncDshSessionUpdate,
} from "../../server/src/engine/dsh_runtime/session_lifecycle.js";

function bindingDb() {
  return {
    queryOne: async () => ({
      id: "app-1",
      project_id: "project-1",
      created_by: "user-1",
      session_config: JSON.stringify({ dsh_runtime_session_id: "dsh-1", dsh_runtime_cwd: "/repo" }),
    }),
  };
}

function fakeClient({ archived = [] } = {}) {
  const calls = [];
  return {
    calls,
    start: async () => {},
    registerProductHostSession: (payload) => calls.push({ method: "product-host.register", payload }),
    unregisterProductHostSession: (sessionId) => calls.push({ method: "product-host.unregister", payload: { sessionId } }),
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (method === "workspace.create") {
        return { workspace: { workspaceId: "workspace-1", path: payload.path } };
      }
      if (method === "session.create") return { sessionId: payload.sessionId };
      if (method === "workspace.list") return { items: [], archivedSessionIds: archived };
      if (method === "session.rename") return { title: payload.title, seq: 1 };
      if (method === "workspace.archiveSession") return { archivedSessionIds: [payload.sessionId] };
      throw new Error(`unexpected ${method}`);
    },
  };
}

test("rename and archive mutate DSH before the local session row", async () => {
  const client = fakeClient();
  await syncDshSessionUpdate(bindingDb(), "app-1", { title: "New", status: "archived" }, client);
  assert.deepEqual(client.calls.map((call) => call.method), [
    "workspace.create", "session.create", "product-host.register",
    "session.rename", "workspace.archiveSession", "product-host.unregister",
  ]);
});

test("an archived DSH session cannot be locally unarchived without a DSH protocol", async () => {
  const client = fakeClient({ archived: ["dsh-1"] });
  await assert.rejects(
    syncDshSessionUpdate(bindingDb(), "app-1", { status: "active" }, client),
    (error) => error?.status === 409 || error?.statusCode === 409 || error?.code === 409,
  );
});

test("delete first archives the bound DSH session", async () => {
  const client = fakeClient();
  await archiveDshSessionBeforeDelete(bindingDb(), "app-1", client);
  assert.deepEqual(client.calls.slice(-2).map((call) => call.method), [
    "workspace.archiveSession", "product-host.unregister",
  ]);
});

test("moving a bound DSH session is rejected", async () => {
  await assert.rejects(
    assertDshSessionCanMove(bindingDb(), "app-1"),
    /不支持把已有对话移动到另一个项目/,
  );
});

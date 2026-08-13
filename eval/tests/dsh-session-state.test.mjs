import test from "node:test";
import assert from "node:assert/strict";
import {
  applyDshMuxFrame,
  applyDshProjectionBaseline,
  bindDshSessionState,
  listDshSessionBindings,
  resolveDshSessionIdentity,
  snapshotDshSessionState,
  subscribeDshSessionState,
} from "../../server/src/engine/dsh_runtime/session_state.js";
import { recoverMissingDshSessionCwds } from "../../server/src/engine/dsh_runtime/session_binding.js";

test("replacing an App Session binding removes the stale DSH runtime state", () => {
  const stamp = Date.now();
  const appSessionId = `app-state-${stamp}-rebind`;
  const oldDshSessionId = `dsh-state-${stamp}-old`;
  const newDshSessionId = `dsh-state-${stamp}-new`;
  bindDshSessionState({ dshSessionId: oldDshSessionId, appSessionId, cwd: "/old" });
  bindDshSessionState({ dshSessionId: newDshSessionId, appSessionId, cwd: "/stable" });

  assert.equal(snapshotDshSessionState(appSessionId).dshSessionId, newDshSessionId);
  assert.equal(listDshSessionBindings().some((binding) => binding.dshSessionId === oldDshSessionId), false);
});

test("the approval identity resolver observes a binding added after startup", () => {
  const stamp = Date.now();
  const dshSessionId = `dsh-state-${stamp}-identity`;
  bindDshSessionState({
    dshSessionId,
    appSessionId: `app-state-${stamp}-identity`,
    projectId: "project-live",
    userId: "user-live",
    cwd: "/repo",
  });
  assert.deepEqual(resolveDshSessionIdentity(dshSessionId), {
    dshSessionId,
    appSessionId: `app-state-${stamp}-identity`,
    projectId: "project-live",
    userId: "user-live",
    cwd: "/repo",
  });
});

test("missing App cwd is recovered only from the exact DSH Session header", async () => {
  const stamp = Date.now();
  const appSessionId = `app-cwd-recovery-${stamp}`;
  const dshSessionId = `dsh-cwd-recovery-${stamp}`;
  const row = {
    id: appSessionId,
    project_id: "project-cwd-recovery",
    created_by: "user-cwd-recovery",
    session_config: JSON.stringify({ dsh_runtime_session_id: dshSessionId }),
  };
  let savedConfig = null;
  const db = {
    queryOne: async () => ({
      project_id: row.project_id,
      created_by: row.created_by,
      session_config: row.session_config,
    }),
    query: async (_sql, params) => { savedConfig = JSON.parse(params[0]); },
  };
  const client = {
    request: async (method) => {
      assert.equal(method, "session.list");
      return { items: [
        { sessionId: dshSessionId, cwd: "/exact/dsh/workspace" },
        { sessionId: "different-session", cwd: "/wrong/workspace" },
      ] };
    },
  };

  assert.deepEqual(await recoverMissingDshSessionCwds(db, client, [row]), {
    recovered: 1,
    unresolved: [],
  });
  assert.equal(savedConfig.dsh_runtime_session_id, dshSessionId);
  assert.equal(savedConfig.dsh_runtime_cwd, "/exact/dsh/workspace");
  assert.equal(row.session_config.dsh_runtime_cwd, "/exact/dsh/workspace");
});

test("DSH queue frames replace the complete queue snapshot", () => {
  const dshSessionId = `dsh-state-${Date.now()}-queue`;
  const appSessionId = `app-state-${Date.now()}-queue`;
  bindDshSessionState({ dshSessionId, appSessionId, cwd: "/repo" });
  applyDshMuxFrame({ payload: { type: "session/subscribed", sessionId: dshSessionId, lastSeq: 4 } });
  applyDshMuxFrame({ payload: {
    type: "session/queue",
    sessionId: dshSessionId,
    items: [
      { id: "q1", placement: "queued", message: { content: [{ type: "text", text: "first" }] } },
      { id: "q2", placement: "steering", message: { content: [{ type: "image", url: "x" }] } },
    ],
  } });
  let state = snapshotDshSessionState(appSessionId);
  assert.equal(state.queueKnown, true);
  assert.deepEqual(state.queue.map((item) => item.id), ["q1", "q2"]);
  assert.equal(state.queue[0].text, "first");
  assert.equal(state.queue[1].text, null);
  applyDshMuxFrame({ payload: { type: "session/queue", sessionId: dshSessionId, items: [] } });
  state = snapshotDshSessionState(appSessionId);
  assert.deepEqual(state.queue, []);
});

test("projection state is higher-seq-wins across history baseline and live frames", () => {
  const dshSessionId = `dsh-state-${Date.now()}-projection`;
  const appSessionId = `app-state-${Date.now()}-projection`;
  bindDshSessionState({ dshSessionId, appSessionId, cwd: "/repo" });
  applyDshProjectionBaseline(dshSessionId, { asOfSeq: 5, values: { title: "five", todos: [] } });
  applyDshMuxFrame({ payload: { type: "session/projection", sessionId: dshSessionId, key: "title", value: "four", seq: 4 } });
  applyDshMuxFrame({ payload: { type: "session/projection", sessionId: dshSessionId, key: "title", value: "six", seq: 6 } });
  const state = snapshotDshSessionState(appSessionId);
  assert.equal(state.projections.title, "six");
  assert.equal(state.projectionSeq.title, 6);
});

test("subscribers receive state and the original mux frame", () => {
  const dshSessionId = `dsh-state-${Date.now()}-subscriber`;
  const appSessionId = `app-state-${Date.now()}-subscriber`;
  bindDshSessionState({ dshSessionId, appSessionId, cwd: "/repo" });
  const updates = [];
  const dispose = subscribeDshSessionState(appSessionId, (update) => updates.push(update));
  applyDshMuxFrame({ payload: { type: "session/event", sessionId: dshSessionId, event: { seq: 9, type: "turn/start" } } });
  dispose();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].state.lastSeq, 9);
  assert.equal(updates[0].frame.payload.type, "session/event");
});

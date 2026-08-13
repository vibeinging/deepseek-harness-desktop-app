// Tests for the resident mux baseline subscriber: idempotent recovery of
// pending approval/question frames, exit-resilience (resident listener stays
// mounted), and the resolve → client.respond forwarding.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createMuxBaselineSubscriber,
  createApprovalRegistrar,
  createQuestionRegistrar,
} from "../../server/src/engine/dsh_runtime/mux_baseline_subscriber.js";

function makeMockClient() {
  const client = new EventEmitter();
  client.start = async () => {};
  client.respond = async (rpcId, payload) => { client._responds = client._responds || []; client._responds.push({ rpcId, payload }); };
  return client;
}

test("subscriber recovers a pending approval frame into pendingDecisions", async () => {
  const client = makeMockClient();
  const pendingDecisions = new Map();
  const approvalRegistrar = createApprovalRegistrar({
    pendingDecisions, client,
    createBlock: (p) => ({ id: p.approvalId, type: "confirm" }),
  });
  const sub = createMuxBaselineSubscriber({
    client, isPending: (k) => pendingDecisions.has(k),
    registerPendingApproval: approvalRegistrar,
    registerPendingQuestion: () => {},
  });
  await sub.start();
  client.emit("mux", {
    rpcId: "rpc-1",
    payload: { type: "approval/requested", sessionId: "s1", approvalId: "a1", toolName: "bash" },
  });
  assert.ok(pendingDecisions.has("a1"), "approval registered under approvalId");
  const entry = pendingDecisions.get("a1");
  assert.equal(entry.kind, "approval");
  assert.equal(entry.itemId, "a1");
  assert.equal(entry.publicInteraction.kind, "approval");
});

test("subscriber recovers a pending question frame into pendingDecisions", async () => {
  const client = makeMockClient();
  const pendingDecisions = new Map();
  const questionRegistrar = createQuestionRegistrar({
    pendingDecisions, client,
    createBlock: (p) => ({ id: "q", type: "user_input", content: JSON.stringify(p.questions) }),
  });
  const sub = createMuxBaselineSubscriber({
    client, isPending: (k) => pendingDecisions.has(k),
    registerPendingApproval: () => {},
    registerPendingQuestion: questionRegistrar,
  });
  await sub.start();
  client.emit("mux", {
    rpcId: "rpc-q1",
    payload: { type: "question/requested", sessionId: "s1", questions: [{ id: "q1", question: "name?" }] },
  });
  assert.ok(pendingDecisions.has("rpc-q1"), "question registered under rpcId");
  const entry = pendingDecisions.get("rpc-q1");
  assert.equal(entry.kind, "user_input");
  assert.equal(entry.itemId, "rpc-q1");
});

test("idempotent: duplicate approval frame is skipped (Turn handler already registered)", async () => {
  const client = makeMockClient();
  const pendingDecisions = new Map();
  // Simulate Turn handler already having registered approvalId "a1".
  pendingDecisions.set("a1", { kind: "approval", resolve: () => {} });
  const approvalRegistrar = createApprovalRegistrar({
    pendingDecisions, client, createBlock: () => ({ type: "confirm" }),
  });
  let callCount = 0;
  const sub = createMuxBaselineSubscriber({
    client, isPending: (k) => pendingDecisions.has(k),
    registerPendingApproval: (frame) => { callCount++; approvalRegistrar(frame); },
    registerPendingQuestion: () => {},
  });
  await sub.start();
  client.emit("mux", { rpcId: "rpc-1", payload: { type: "approval/requested", sessionId: "s1", approvalId: "a1" } });
  assert.equal(callCount, 0, "registrar not called — Turn handler's entry wins");
});

test("approval resolve callback forwards to client.respond with the original rpcId", async () => {
  const client = makeMockClient();
  const pendingDecisions = new Map();
  const approvalRegistrar = createApprovalRegistrar({
    pendingDecisions, client,
    createBlock: (p) => ({ id: p.approvalId, type: "confirm" }),
  });
  const sub = createMuxBaselineSubscriber({
    client, isPending: (k) => pendingDecisions.has(k),
    registerPendingApproval: approvalRegistrar,
    registerPendingQuestion: () => {},
  });
  await sub.start();
  client.emit("mux", { rpcId: "rpc-approve-1", payload: { type: "approval/requested", sessionId: "s1", approvalId: "a1" } });
  const entry = pendingDecisions.get("a1");
  assert.ok(entry, "entry exists");
  entry.resolve(true); // approved
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(client._responds, "respond was called");
  assert.equal(client._responds[0].rpcId, "rpc-approve-1");
  assert.equal(client._responds[0].payload.approvalId, "a1");
  assert.equal(client._responds[0].payload.outcome, "allowed-once");
});

test("question resolve callback forwards to client.respond with answers", async () => {
  const client = makeMockClient();
  const pendingDecisions = new Map();
  const questionRegistrar = createQuestionRegistrar({
    pendingDecisions, client,
    createBlock: (p) => ({ id: "q", type: "user_input" }),
  });
  const sub = createMuxBaselineSubscriber({
    client, isPending: (k) => pendingDecisions.has(k),
    registerPendingApproval: () => {},
    registerPendingQuestion: questionRegistrar,
  });
  await sub.start();
  client.emit("mux", { rpcId: "rpc-q1", payload: { type: "question/requested", sessionId: "s1", questions: [{ id: "q1", question: "continue?" }] } });
  const entry = pendingDecisions.get("rpc-q1");
  assert.ok(entry, "entry exists");
  entry.resolve({ answers: { q1: { answers: ["yes"] } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(client._responds[0].rpcId, "rpc-q1");
  assert.deepEqual(client._responds[0].payload.answer.answers, [{ id: "q1", selected: [], custom: "yes" }]);
});

test("approval decline string is rejected instead of treated as truthy", async () => {
  const client = makeMockClient();
  const pendingDecisions = new Map();
  const approvalRegistrar = createApprovalRegistrar({
    pendingDecisions, client,
    createBlock: (p) => ({ id: p.approvalId, type: "confirm" }),
  });
  const sub = createMuxBaselineSubscriber({
    client, isPending: (key) => pendingDecisions.has(key),
    registerPendingApproval: approvalRegistrar,
    registerPendingQuestion: () => {},
  });
  await sub.start();
  client.emit("mux", { rpcId: "rpc-decline", payload: { type: "approval/requested", sessionId: "s1", approvalId: "a-decline" } });
  pendingDecisions.get("a-decline").resolve("decline");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(client._responds[0].payload.outcome, "rejected");
});

test("non-pending frame types (session/subscribed, session/event) are ignored", async () => {
  const client = makeMockClient();
  let approvalCalls = 0;
  let questionCalls = 0;
  const sub = createMuxBaselineSubscriber({
    client, isPending: () => false,
    registerPendingApproval: () => { approvalCalls++; },
    registerPendingQuestion: () => { questionCalls++; },
  });
  await sub.start();
  client.emit("mux", { rpcId: "r", payload: { type: "session/subscribed", sessionId: "s1", lastSeq: 5 } });
  client.emit("mux", { rpcId: "r", payload: { type: "session/event", sessionId: "s1", event: { type: "turn/start" } } });
  client.emit("mux", { rpcId: "r", payload: { type: "approval/resolved", sessionId: "s1" } });
  assert.equal(approvalCalls, 0);
  assert.equal(questionCalls, 0);
});

test("stop() removes the mux listener", () => {
  const client = makeMockClient();
  const sub = createMuxBaselineSubscriber({
    client, isPending: () => false,
    registerPendingApproval: () => {}, registerPendingQuestion: () => {},
  });
  const beforeCount = client.listenerCount("mux");
  // start() is async but we only care about the listener registration.
  // createMuxBaselineSubscriber does not auto-start; simulate by emitting directly.
  // The subscriber only mounts onMux during start(). Call start() then stop().
  return sub.start().then(() => {
    assert.ok(client.listenerCount("mux") > 0, "mux listener mounted after start");
    sub.stop();
    assert.equal(client.listenerCount("mux"), 0, "mux listener removed after stop");
  });
});

test("approval registrar injects userId/projectId from resolveIdentity", async () => {
  const client = makeMockClient();
  const pendingDecisions = new Map();
  // Identity map: DSH session "dsh-sid-1" → dsh-app user/project/session.
  const identityMap = new Map([["dsh-sid-1", { userId: "user-42", projectId: "proj-7", appSessionId: "app-sess-1" }]]);
  const approvalRegistrar = createApprovalRegistrar({
    pendingDecisions, client, resolveIdentity: (sid) => identityMap.get(sid),
    createBlock: (p) => ({ id: p.approvalId, type: "confirm" }),
  });
  const sub = createMuxBaselineSubscriber({
    client, isPending: (k) => pendingDecisions.has(k),
    registerPendingApproval: approvalRegistrar,
    registerPendingQuestion: () => {},
  });
  await sub.start();
  client.emit("mux", { rpcId: "rpc-1", payload: { type: "approval/requested", sessionId: "dsh-sid-1", approvalId: "a1" } });
  const entry = pendingDecisions.get("a1");
  assert.equal(entry.userId, "user-42", "userId injected from identity map");
  assert.equal(entry.projectId, "proj-7", "projectId injected from identity map");
  assert.equal(entry.sessionId, "app-sess-1", "sessionId is the dsh-app session id");
  // publicInteraction also carries the injected identity so listLivePendingInteractions finds it.
  assert.equal(entry.publicInteraction.session_id, "app-sess-1");
  assert.equal(entry.publicInteraction.run_id, "app-sess-1");
});

test("approval registrar tolerates missing identity (resolveIdentity returns null)", async () => {
  const client = makeMockClient();
  const pendingDecisions = new Map();
  const approvalRegistrar = createApprovalRegistrar({
    pendingDecisions, client, resolveIdentity: () => null,
    createBlock: (p) => ({ id: p.approvalId, type: "confirm" }),
  });
  const sub = createMuxBaselineSubscriber({
    client, isPending: (k) => pendingDecisions.has(k),
    registerPendingApproval: approvalRegistrar,
    registerPendingQuestion: () => {},
  });
  await sub.start();
  client.emit("mux", { rpcId: "rpc-1", payload: { type: "approval/requested", sessionId: "unknown-sid", approvalId: "a2" } });
  const entry = pendingDecisions.get("a2");
  assert.ok(entry, "entry still created");
  assert.equal(entry.userId, null, "userId null when identity unknown");
  assert.equal(entry.projectId, null);
  assert.equal(entry.sessionId, "unknown-sid", "falls back to DSH session id");
});

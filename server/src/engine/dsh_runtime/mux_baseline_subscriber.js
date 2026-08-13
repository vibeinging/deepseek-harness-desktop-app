// Resident mux baseline subscriber: a Turn-independent listener that receives
// DSH mux-stream baseline replays of pending approval/question frames and
// restores them into dsh-work's pendingDecisions Map so the renderer can show
// the approval/question cards again after a refresh or server restart.
//
// Without this subscriber, pending approvals/questions are lost on refresh
// because:
//   - The workspace_runtime's mux listener only lives inside execute() (Turn
//     scope) and is removed in the finally block.
//   - pendingDecisions is an in-memory Map that does not survive a server
//     restart.
//
// The subscriber owns the full "pending → respond" lifecycle for frames it
// recovers: it registers the entry in pendingDecisions with a resolve callback
// that calls client.respond(rpcId, ...) directly, so the HTTP /respond endpoints
// (resolveAgentApproval / resolveAgentUserInput) work without a live Turn.

import { acceptedDshDecision, dshQuestionAnswers } from "./interaction_wire.js";

/**
 * Create a resident mux baseline subscriber.
 *
 * @param {object} deps
 * @param {object} deps.client - DshRuntimeClient (getDshRuntimeClient() singleton).
 * @param {function} deps.isPending - (key) => boolean; check whether pendingDecisions already has this key (Turn-time handler wins).
 * @param {function} deps.registerPendingApproval - (frame) => void; idempotent registration of a recovered approval into pendingDecisions.
 * @param {function} deps.registerPendingQuestion - (frame) => void; idempotent registration of a recovered question.
 * @returns {{ start(): Promise<void>, stop(): void }}
 */
export function createMuxBaselineSubscriber({
  client,
  isPending,
  registerPendingApproval,
  registerPendingQuestion,
  applyStateFrame = () => {},
  applyHostFrame = () => {},
  resolvePendingApproval = () => {},
  resolvePendingQuestion = () => {},
  markStreamError = () => {},
}) {
  let started = false;
  let stopped = false;

  const onMux = (frame) => {
    const payload = frame?.payload;
    if (!payload || typeof payload !== "object") return;

    try { applyStateFrame(frame); } catch (error) {
      console.error("[mux-baseline] applyStateFrame failed:", error?.message || error);
    }

    if (payload.type === "approval/resolved") {
      resolvePendingApproval(String(payload.approvalId || ""));
      return;
    }

    if (payload.type === "question/resolved") {
      resolvePendingQuestion(String(payload.questionRpcId || ""));
      return;
    }

    if (payload.type === "approval/requested") {
      // approval: pendingDecisions key is approvalId. Turn-time #handleApproval
      // registers first (it receives the frame live during the Turn); the
      // subscriber only recovers frames the Turn handler did NOT catch
      // (e.g. after a refresh, when the Turn is over but DSH still waits).
      const approvalId = String(payload.approvalId || "").trim();
      if (!approvalId || isPending(approvalId)) return;
      try { registerPendingApproval(frame); } catch (error) {
        console.error("[mux-baseline] registerPendingApproval failed:", error?.message || error);
      }
      return;
    }

    if (payload.type === "question/requested") {
      // question: pendingDecisions key is rpcId. Same idempotency contract.
      const rpcId = String(frame.rpcId || "").trim();
      if (!rpcId || isPending(rpcId)) return;
      try { registerPendingQuestion(frame); } catch (error) {
        console.error("[mux-baseline] registerPendingQuestion failed:", error?.message || error);
      }
      return;
    }

    // State-only frames were already applied above. Session events continue to
    // the Turn listener and the renderer's resident DSH protocol stream.
  };

  const onStreamError = ({ error }) => {
    try { markStreamError(error); } catch (stateError) {
      console.error("[mux-baseline] markStreamError failed:", stateError?.message || stateError);
    }
  };

  const onHost = (frame) => {
    try { applyHostFrame(frame); } catch (error) {
      console.error("[mux-baseline] applyHostFrame failed:", error?.message || error);
    }
  };

  const onExit = () => {
    // The child exited. client.start() is idempotent and will restart the
    // child on the next request. When the new child opens its mux stream,
    // DSH replays the baseline again and onMux picks it up — but only if
    // the subscriber is still mounted (it is: we never remove onMux on exit).
    // Nothing to do here except log; the resident listener stays mounted.
    console.log("[mux-baseline] DSH child exited; resident listener stays mounted for reconnect");
  };

  return {
    async start() {
      if (started || stopped) return;
      started = true;
      client.on("mux", onMux);
      client.on("exit", onExit);
      client.on("stream-error", onStreamError);
      client.on("host", onHost);
      // Start the child so the mux stream opens and the baseline replays.
      await client.start().catch((error) => {
        console.error("[mux-baseline] client.start failed:", error?.message || error);
      });
      console.log("[mux-baseline] resident subscriber mounted");
    },

    stop() {
      if (stopped) return;
      stopped = true;
      client.off("mux", onMux);
      client.off("exit", onExit);
      client.off("stream-error", onStreamError);
      client.off("host", onHost);
    },
  };
}

/**
 * Build the registerPendingApproval callback that writes a recovered approval
 * into pendingDecisions with a resolve that calls client.respond.
 *
 * @param {object} deps
 * @param {Map} deps.pendingDecisions - the ObservablePendingDecisionMap singleton.
 * @param {object} deps.client - DshRuntimeClient.
 * @param {function} deps.createBlock - (frame) => block object for the publicInteraction card.
 * @returns {function} (frame) => void
 */
export function createApprovalRegistrar({ pendingDecisions, client, createBlock, resolveIdentity }) {
  return (frame) => {
    const payload = frame.payload;
    const approvalId = String(payload.approvalId || "").trim();
    const sessionId = String(payload.sessionId || "").trim();
    if (!approvalId || !sessionId) return;
    // Double-check idempotency (isPending already checked, but race-safe).
    if (pendingDecisions.has(approvalId)) return;
    const block = createBlock(payload);
    // Resolve dsh-work identity (userId/projectId) from the DSH session id so
    // listLivePendingInteractions can find this entry. Without this, the
    // three-tuple filter (userId+projectId+sessionId) returns nothing.
    const identity = typeof resolveIdentity === "function" ? (resolveIdentity(sessionId) || {}) : {};
    const entry = {
      resolve: (decision) => {
        const outcome = acceptedDshDecision(decision) ? "allowed-once" : "rejected";
        client.respond(frame.rpcId, { sessionId, approvalId, outcome }).catch((error) => {
          console.error("[mux-baseline] approval respond failed:", error?.message || error);
        });
      },
      sessionId: identity.appSessionId || sessionId,
      projectId: identity.projectId || null,
      userId: identity.userId || null,
      runId: identity.runId || identity.appSessionId || null,
      threadId: sessionId,
      turnId: null,
      itemId: approvalId,
      method: "dsh/approval",
      availableDecisions: ["accept", "decline"],
      kind: "approval",
      returnsDecision: true,
      createdAt: new Date().toISOString(),
      publicInteraction: null,
    };
    pendingDecisions.set(approvalId, entry);
    if (block && typeof block === "object") {
      entry.publicInteraction = createBaselinePublicInteraction(entry, { requestId: approvalId, block });
    }
  };
}

/**
 * Build the registerPendingQuestion callback that writes a recovered question
 * into pendingDecisions with a resolve that calls client.respond.
 *
 * @param {object} deps
 * @param {Map} deps.pendingDecisions
 * @param {object} deps.client
 * @param {function} deps.createBlock - (frame) => block object for the user_input card.
 * @returns {function} (frame) => void
 */
export function createQuestionRegistrar({ pendingDecisions, client, createBlock, resolveIdentity }) {
  return (frame) => {
    const payload = frame.payload;
    const rpcId = String(frame.rpcId || "").trim();
    const sessionId = String(payload.sessionId || "").trim();
    if (!rpcId || !sessionId) return;
    if (pendingDecisions.has(rpcId)) return;
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    const block = createBlock(payload);
    const identity = typeof resolveIdentity === "function" ? (resolveIdentity(sessionId) || {}) : {};
    const entry = {
      resolve: (response) => {
        client.respond(frame.rpcId, { sessionId, answer: { answers: dshQuestionAnswers(questions, response) } }).catch((error) => {
          console.error("[mux-baseline] question respond failed:", error?.message || error);
        });
      },
      sessionId: identity.appSessionId || sessionId,
      projectId: identity.projectId || null,
      userId: identity.userId || null,
      runId: identity.runId || identity.appSessionId || null,
      threadId: sessionId,
      turnId: null,
      itemId: rpcId,
      kind: "user_input",
      createdAt: new Date().toISOString(),
      publicInteraction: null,
    };
    pendingDecisions.set(rpcId, entry);
    if (block && typeof block === "object") {
      entry.publicInteraction = createBaselinePublicInteraction(entry, { requestId: rpcId, block, request: { questions } });
    }
  };
}

/**
 * Minimal publicInteraction builder for recovered pendings. Mirrors the shape
 * createLivePendingInteraction produces so listLivePendingInteractions and the
 * renderer's mergeNativePendingInteractions can consume it.
 */
function createBaselinePublicInteraction(entry, { requestId, block, request = null }) {
  const id = String(requestId || entry.itemId || "").trim();
  const runId = String(entry.runId || "dsh-recovered").trim();
  const sessionId = String(entry.sessionId || "").trim();
  if (!(id && sessionId && block)) return null;
  const kind = entry.kind === "user_input" ? "user_input" : "approval";
  return {
    version: 1,
    kind,
    status: "pending",
    request_id: id,
    run_id: runId,
    session_id: sessionId,
    resolution: {
      type: "native_turn",
      thread_id: String(entry.threadId || sessionId).trim() || null,
      turn_id: String(entry.turnId || "").trim() || null,
      item_id: String(entry.itemId || id).trim() || id,
    },
    ...(request && kind === "user_input" ? { request } : {}),
    block: structuredClone(block),
    created_at: entry.createdAt || new Date().toISOString(),
  };
}

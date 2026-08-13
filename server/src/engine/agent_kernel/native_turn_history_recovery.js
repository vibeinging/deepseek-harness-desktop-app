import { finalizeRecoveredConversationTurn } from "../agents/run_fact_store.js";
import { createAgentStreamEmitter } from "../stream/agent_stream_emitter.js";
import { AgentStreamAdapter } from "./stream_adapter.js";
import {
  getAgentRuntime,
  releaseAgentRuntimeIfIdle,
} from "./agent_runtime.js";

function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function upsert(items, item) {
  if (!item?.id) return;
  const index = items.findIndex((candidate) => candidate?.id === item.id);
  if (index >= 0) items[index] = { ...items[index], ...item };
  else items.push(item);
}

/** Re-project the exact native Turn through the same adapter used by the live stream. */
export async function projectNativeTurnHistory(turn, {
  threadId,
  messageId,
} = {}) {
  const turnId = String(turn?.id || "").trim();
  if (!turnId) return [];
  const projectedItems = [];
  const stream = createAgentStreamEmitter({
    emit: () => {},
    threadId: String(threadId || "").trim() || null,
    turnId,
    messageId: String(messageId || "").trim() || `assistant:${turnId}`,
  });
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options = {}) => {
      const projected = stream.content(content, options);
      upsert(projectedItems, projected.item);
      return projected.contentId;
    },
  });
  for (const item of Array.isArray(turn.items) ? turn.items : []) {
    if (!item?.id) continue;
    const params = { threadId, turnId, item };
    await adapter.handle("item/started", params);
    await adapter.handle("item/completed", params);
  }
  return projectedItems;
}

/**
 * Best-effort crash recovery from Codex' durable Thread. Incremental local
 * snapshots remain the fallback when the native rollout is unavailable.
 */
export async function rebuildInterruptedTurnsFromNative(ctx, {
  runIds = [],
  runtime = null,
} = {}) {
  const ids = [...new Set((Array.isArray(runIds) ? runIds : []).map(String).filter(Boolean))];
  if (!ids.length) return [];
  let reader = runtime;
  let ownsReader = false;
  const results = [];
  try {
    for (const runId of ids) {
      const run = await ctx.queryOne(
        `SELECT ar.id,ar.session_id,ar.turn_id,ar.status,s.session_config
           FROM agent_runs ar
           JOIN sessions s ON s.id=ar.session_id AND s.deleted_at IS NULL
          WHERE ar.id=$1 AND ar.deleted_at IS NULL AND ar.status IN ('interrupted','failed')
          LIMIT 1`,
        [runId],
      ).catch(() => null);
      if (!run) {
        results.push({ run_id: runId, status: "skipped", reason: "run_not_found" });
        continue;
      }
      const config = parseJson(run.session_config, {});
      const snapshot = await ctx.queryOne(
        `SELECT message_metadata
           FROM session_messages
          WHERE id=$1 AND session_id=$2 AND role='assistant' AND deleted_at IS NULL
          LIMIT 1`,
        [`assistant:${runId}`, run.session_id],
      ).catch(() => null);
      const snapshotMetadata = parseJson(snapshot?.message_metadata, {});
      const snapshotThreadId = String(snapshotMetadata.thread_id || "").trim();
      const threadId = String(
        snapshotMetadata.runtime_thread_id
        || config.agent_runtime_thread_id
        || (snapshotThreadId && snapshotThreadId !== String(run.session_id || "") ? snapshotThreadId : "")
        || "",
      ).trim();
      const turnId = String(snapshotMetadata.turn_id || run.turn_id || "").trim();
      if (!(threadId && turnId)) {
        results.push({ run_id: runId, status: "skipped", reason: "native_identity_missing" });
        continue;
      }
      if (!reader) {
        reader = getAgentRuntime({
          runtimeKey: "conversation-history-recovery",
          requestTimeoutMs: 10_000,
        });
        ownsReader = true;
      }
      try {
        const response = await reader.readThread(threadId, { includeTurns: true });
        const turn = (Array.isArray(response?.thread?.turns) ? response.thread.turns : [])
          .find((candidate) => String(candidate?.id || "") === turnId);
        if (!turn) {
          results.push({ run_id: runId, status: "skipped", reason: "native_turn_not_found" });
          continue;
        }
        const recoveredItems = await projectNativeTurnHistory(turn, {
          threadId,
          messageId: `assistant:${runId}`,
        });
        await finalizeRecoveredConversationTurn(ctx, {
          runId,
          sessionId: run.session_id,
          status: run.status === "failed" ? "failed" : "interrupted",
          reason: "native_thread_read_after_restart",
          recoveredItems,
          runtimeThreadId: threadId,
          runtimeTurnId: turnId,
        });
        results.push({
          run_id: runId,
          status: "rebuilt",
          thread_id: threadId,
          turn_id: turnId,
          item_count: recoveredItems.length,
        });
      } catch (error) {
        results.push({
          run_id: runId,
          status: "failed",
          reason: error?.code || "native_thread_read_failed",
          error: error?.message || String(error),
        });
      }
    }
  } finally {
    if (ownsReader && reader) await releaseAgentRuntimeIfIdle(reader).catch(() => false);
  }
  return results;
}

export default { projectNativeTurnHistory, rebuildInterruptedTurnsFromNative };

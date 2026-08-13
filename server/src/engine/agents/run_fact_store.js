import { randomUUID } from "node:crypto";
import { removeRunnerRunDirectory } from "../runner/run_paths.js";
import { finalizeTerminalContentItems } from "../core/turn_finalizer.js";
import { publishConversationStatusChanged } from "./conversation_status_events.js";

export const RUN_STATUSES = Object.freeze([
  "queued",
  "running",
  "waiting_approval",
  "waiting_user_input",
  "interrupted",
  "failed",
  "completed",
  "recovering",
  "expired",
]);

const TERMINAL_STATUSES = new Set(["failed", "completed", "interrupted", "expired"]);
const REVIEWABLE_TERMINAL_STATUSES = new Set(["failed", "completed", "interrupted", "expired"]);
const ACTIVE_STATUSES = new Set([
  "queued",
  "running",
  "waiting_approval",
  "waiting_user_input",
  "recovering",
]);
const TRANSITIONS = new Map([
  ["queued", new Set(["running", "interrupted", "failed", "expired"])],
  ["running", new Set(["waiting_approval", "waiting_user_input", "interrupted", "failed", "completed", "recovering", "expired"])],
  ["waiting_approval", new Set(["running", "interrupted", "failed", "recovering", "expired"])],
  ["waiting_user_input", new Set(["running", "interrupted", "failed", "recovering", "expired"])],
  ["interrupted", new Set(["running", "recovering", "failed", "expired"])],
  ["recovering", new Set(["running", "waiting_approval", "waiting_user_input", "interrupted", "failed", "completed", "expired"])],
  ["failed", new Set(["recovering"])],
  ["completed", new Set()],
  ["expired", new Set()],
]);

const locks = new Map();

function nowIso() {
  return new Date().toISOString();
}

function addMs(value, ms) {
  return new Date(new Date(value).getTime() + ms).toISOString();
}

function normalizeText(value, max = 4_000) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

function jsonText(value, max = 256 * 1024) {
  try {
    const text = JSON.stringify(value ?? null);
    return Buffer.byteLength(text, "utf8") <= max ? text : null;
  } catch {
    return null;
  }
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function errorCode(error, fallback = "AGENT_TOOL_FAILED") {
  return normalizeText(error?.code || fallback, 160) || fallback;
}

function isRunStatusEvent(eventType, metadata) {
  if (eventType === "run_created") return true;
  if (!String(eventType || "").startsWith("run_")) return false;
  if (metadata && typeof metadata === "object" && "from" in metadata && "to" in metadata) return true;
  return [
    "run_recovery_waiting_approval",
    "run_recovery_waiting_input",
    "run_recovery_ready",
    "run_recovery_interrupted",
  ].includes(eventType);
}

function assertDb(ctx) {
  if (!(ctx?.query && ctx?.queryOne)) {
    const error = new Error("运行事实存储缺少 query/queryOne");
    error.code = "AGENT_RUN_STORE_UNAVAILABLE";
    throw error;
  }
}

async function runExclusive(runId, fn) {
  const key = String(runId || "");
  const previous = (locks.get(key) || Promise.resolve()).catch(() => {});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export function normalizeRunStatus(value) {
  const status = String(value || "").trim();
  if (status === "suspended") return "waiting_user_input";
  if (status === "resumed") return "recovering";
  return RUN_STATUSES.includes(status) ? status : "queued";
}

export function canTransitionRun(from, to) {
  const current = normalizeRunStatus(from);
  const next = normalizeRunStatus(to);
  return current === next || Boolean(TRANSITIONS.get(current)?.has(next));
}

function transitionError(from, to) {
  const error = new Error(`不允许的运行状态变化：${from} -> ${to}`);
  error.code = "AGENT_RUN_INVALID_TRANSITION";
  error.detail = { from, to };
  return error;
}

async function appendEventUnlocked(ctx, {
  runId,
  turnId = null,
  callId = null,
  eventType,
  status = null,
  inputSummary = null,
  outputSummary = null,
  artifactId = null,
  errorCode: eventErrorCode = null,
  retryCount = 0,
  metadata = null,
  createdAt = nowIso(),
} = {}) {
  const run = await ctx.queryOne(
    `SELECT ar.id, ar.turn_id, ar.last_event_seq, ar.session_id, ar.status,
            COALESCE(ar.project_id,s.project_id) AS conversation_project_id,
            COALESCE(ar.user_id,s.created_by) AS conversation_user_id
       FROM agent_runs ar
       LEFT JOIN sessions s ON s.id=ar.session_id AND s.deleted_at IS NULL
      WHERE ar.id=$1 AND ar.deleted_at IS NULL
      LIMIT 1`,
    [runId],
  );
  if (!run) {
    const error = new Error(`运行不存在：${runId}`);
    error.code = "AGENT_RUN_NOT_FOUND";
    throw error;
  }
  const maxRow = await ctx.queryOne(
    `SELECT COALESCE(MAX(seq),0) AS max_seq FROM agent_run_events WHERE run_id=$1`,
    [runId],
  );
  const seq = Math.max(Number(run.last_event_seq || 0), Number(maxRow?.max_seq || 0)) + 1;
  const id = randomUUID();
  await ctx.query(
    `INSERT INTO agent_run_events (
       id, run_id, turn_id, call_id, seq, event_type, status,
       input_summary, output_summary, artifact_id, error_code,
       retry_count, metadata_json, created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      runId,
      turnId || run.turn_id || null,
      callId,
      seq,
      eventType,
      status,
      inputSummary == null ? null : normalizeText(inputSummary),
      outputSummary == null ? null : normalizeText(outputSummary),
      artifactId,
      eventErrorCode,
      Number(retryCount || 0),
      metadata == null ? null : jsonText(metadata),
      createdAt,
    ],
  );
  const statusEvent = isRunStatusEvent(eventType, metadata);
  await ctx.query(
    `UPDATE agent_runs
        SET last_event_seq=$2, updated_at=$3${statusEvent ? ", status_changed_at=$3" : ""}
      WHERE id=$1`,
    [runId, seq, createdAt],
  );
  if (statusEvent) {
    publishConversationStatusChanged({
      userId: run.conversation_user_id,
      projectId: run.conversation_project_id,
      sessionId: run.session_id,
      runId,
      reason: eventType,
    });
  }
  return { id, run_id: runId, seq, event_type: eventType, status, created_at: createdAt };
}

export async function appendRunEvent(ctx, event = {}) {
  assertDb(ctx);
  if (!(event.runId && event.eventType)) {
    const error = new Error("运行事件缺少 runId 或 eventType");
    error.code = "AGENT_RUN_EVENT_INVALID";
    throw error;
  }
  return runExclusive(event.runId, () => appendEventUnlocked(ctx, event));
}

export async function transitionAgentRun(ctx, {
  runId,
  status,
  checkpoint = undefined,
  metadata = undefined,
  eventType = "run_status_changed",
  eventMetadata = null,
  finished = undefined,
  leaseOwner = undefined,
  leaseExpiresAt = undefined,
  heartbeatAt = undefined,
  runnerPid = undefined,
  recoverable = undefined,
} = {}) {
  assertDb(ctx);
  return runExclusive(runId, async () => {
    const row = await ctx.queryOne(
      `SELECT * FROM agent_runs WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
      [runId],
    );
    if (!row) {
      const error = new Error(`运行不存在：${runId}`);
      error.code = "AGENT_RUN_NOT_FOUND";
      throw error;
    }
    const from = normalizeRunStatus(row.status);
    const to = normalizeRunStatus(status);
    if (!canTransitionRun(from, to)) throw transitionError(from, to);
    const sets = ["status=$2", "updated_at=$3"];
    const params = [runId, to, nowIso()];
    const setValue = (column, value) => {
      if (value === undefined) return;
      params.push(value);
      sets.push(`${column}=$${params.length}`);
    };
    setValue("checkpoint_json", checkpoint === undefined ? undefined : jsonText(checkpoint));
    setValue("metadata_json", metadata === undefined ? undefined : jsonText(metadata));
    setValue("lease_owner", leaseOwner);
    setValue("lease_expires_at", leaseExpiresAt);
    setValue("heartbeat_at", heartbeatAt);
    setValue("runner_pid", runnerPid);
    setValue("recoverable", recoverable === undefined ? undefined : recoverable ? 1 : 0);
    sets.push("status_changed_at=$3");
    if (!REVIEWABLE_TERMINAL_STATUSES.has(to)) {
      sets.push("viewed_at=NULL", "finished_at=NULL");
    }
    const shouldFinish = finished === undefined ? TERMINAL_STATUSES.has(to) : Boolean(finished);
    if (shouldFinish) sets.push("finished_at=COALESCE(finished_at,now())");
    if (TERMINAL_STATUSES.has(to)) {
      sets.push("lease_owner=NULL", "lease_expires_at=NULL", "runner_pid=NULL");
    }
    await ctx.query(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id=$1`, params);
    if (from !== to || eventType) {
      await appendEventUnlocked(ctx, {
        runId,
        eventType,
        status: to,
        metadata: { from, to, ...(eventMetadata || {}) },
      });
    }
    return { run_id: runId, previous_status: from, status: to };
  });
}

export async function saveRunCheckpoint(ctx, {
  runId,
  checkpoint = {},
  metadata = null,
} = {}) {
  assertDb(ctx);
  return runExclusive(runId, async () => {
    const row = await ctx.queryOne(
      `SELECT status FROM agent_runs WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
      [runId],
    );
    if (!row) {
      const error = new Error(`运行不存在：${runId}`);
      error.code = "AGENT_RUN_NOT_FOUND";
      throw error;
    }
    const status = normalizeRunStatus(row.status);
    if (TERMINAL_STATUSES.has(status)) return { run_id: runId, status, saved: false };
    await ctx.query(
      `UPDATE agent_runs
          SET checkpoint_json=$2, recoverable=1, updated_at=now()
        WHERE id=$1`,
      [runId, jsonText(checkpoint)],
    );
    const event = await appendEventUnlocked(ctx, {
      runId,
      eventType: "run_checkpoint_saved",
      status,
      metadata,
    });
    return { run_id: runId, status, saved: true, seq: event.seq };
  });
}

export async function acquireRunLease(ctx, {
  runId,
  owner,
  ttlMs = 15_000,
  runnerPid = null,
} = {}) {
  assertDb(ctx);
  return runExclusive(runId, async () => {
    const row = await ctx.queryOne(`SELECT * FROM agent_runs WHERE id=$1 AND deleted_at IS NULL LIMIT 1`, [runId]);
    if (!row) return { acquired: false, reason: "missing" };
    const now = nowIso();
    const expires = row.lease_expires_at ? new Date(row.lease_expires_at).getTime() : 0;
    if (row.lease_owner && row.lease_owner !== owner && Number.isFinite(expires) && expires > Date.now()) {
      return { acquired: false, reason: "leased", owner: row.lease_owner, expires_at: row.lease_expires_at };
    }
    const leaseExpiresAt = addMs(now, ttlMs);
    await ctx.query(
      `UPDATE agent_runs
          SET lease_owner=$2, lease_expires_at=$3, heartbeat_at=$4, runner_pid=$5, updated_at=$4
        WHERE id=$1`,
      [runId, owner, leaseExpiresAt, now, runnerPid],
    );
    await appendEventUnlocked(ctx, {
      runId,
      eventType: "run_lease_acquired",
      status: normalizeRunStatus(row.status),
      metadata: { owner, lease_expires_at: leaseExpiresAt, runner_pid: runnerPid },
    });
    return { acquired: true, owner, expires_at: leaseExpiresAt };
  });
}

export async function heartbeatRunLease(ctx, {
  runId,
  owner,
  ttlMs = 15_000,
  runnerPid = null,
} = {}) {
  assertDb(ctx);
  const now = nowIso();
  const leaseExpiresAt = addMs(now, ttlMs);
  await ctx.query(
    `UPDATE agent_runs
        SET heartbeat_at=$3, lease_expires_at=$4, runner_pid=$5, updated_at=$3
      WHERE id=$1 AND lease_owner=$2 AND deleted_at IS NULL`,
    [runId, owner, now, leaseExpiresAt, runnerPid],
  );
  return { run_id: runId, owner, heartbeat_at: now, lease_expires_at: leaseExpiresAt };
}

export async function releaseRunLease(ctx, { runId, owner } = {}) {
  assertDb(ctx);
  await ctx.query(
    `UPDATE agent_runs
        SET lease_owner=NULL, lease_expires_at=NULL, runner_pid=NULL, updated_at=now()
      WHERE id=$1 AND ($2 IS NULL OR lease_owner=$2)`,
    [runId, owner || null],
  );
}

export async function beginToolCall(ctx, {
  runId,
  turnId = null,
  callId,
  toolName,
  accessMode = "read",
  input = null,
  inputSummary = null,
} = {}) {
  assertDb(ctx);
  return runExclusive(runId, async () => {
    const existing = await ctx.queryOne(
      `SELECT * FROM agent_tool_calls WHERE run_id=$1 AND call_id=$2 LIMIT 1`,
      [runId, callId],
    );
    const effectful = accessMode !== "read";
    if (existing?.status === "completed") {
      const result = parseJson(existing.result_json, null);
      await appendEventUnlocked(ctx, {
        runId,
        turnId,
        callId,
        eventType: "tool_call_replayed",
        status: "completed",
        retryCount: Math.max(0, Number(existing.attempt_count || 1) - 1),
        metadata: { tool_name: toolName, access_mode: accessMode, stored_result: result != null },
      });
      return result == null
        ? { action: "blocked", code: "AGENT_TOOL_RESULT_UNAVAILABLE", record: existing }
        : { action: "replay", result, record: existing };
    }
    if (existing && effectful) {
      await appendEventUnlocked(ctx, {
        runId,
        turnId,
        callId,
        eventType: "tool_call_outcome_unknown",
        status: existing.status,
        errorCode: "AGENT_TOOL_OUTCOME_UNKNOWN",
        metadata: { tool_name: toolName, access_mode: accessMode },
      });
      return { action: "blocked", code: "AGENT_TOOL_OUTCOME_UNKNOWN", record: existing };
    }

    const at = nowIso();
    const attempt = Number(existing?.attempt_count || 0) + 1;
    const inputJson = jsonText(input);
    if (existing) {
      await ctx.query(
        `UPDATE agent_tool_calls
            SET status='running', attempt_count=$3, input_json=$4, input_summary=$5,
                error_code=NULL, started_at=$6, finished_at=NULL, updated_at=$6
          WHERE run_id=$1 AND call_id=$2`,
        [runId, callId, attempt, inputJson, normalizeText(inputSummary || inputJson || ""), at],
      );
    } else {
      await ctx.query(
        `INSERT INTO agent_tool_calls (
           id, run_id, turn_id, call_id, tool_name, access_mode, status,
           attempt_count, input_json, input_summary, started_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'running',1,$7,$8,$9,$9,$9)`,
        [
          randomUUID(), runId, turnId, callId, toolName, accessMode,
          inputJson, normalizeText(inputSummary || inputJson || ""), at,
        ],
      );
    }
    await appendEventUnlocked(ctx, {
      runId,
      turnId,
      callId,
      eventType: existing ? "tool_call_retried" : "tool_call_started",
      status: "running",
      inputSummary: inputSummary || inputJson,
      retryCount: attempt - 1,
      metadata: { tool_name: toolName, access_mode: accessMode },
    });
    return { action: "execute", attempt };
  });
}

export async function finishToolCall(ctx, {
  runId,
  turnId = null,
  callId,
  toolName,
  ok,
  result = null,
  outputSummary = null,
  logPath = null,
  error = null,
} = {}) {
  assertDb(ctx);
  return runExclusive(runId, async () => {
    const at = nowIso();
    const status = ok ? "completed" : "failed";
    const resultJson = ok ? jsonText(result) : null;
    const code = ok ? null : errorCode(error);
    await ctx.query(
      `UPDATE agent_tool_calls
          SET status=$3, result_json=$4, output_summary=$5, log_path=$6,
              error_code=$7, finished_at=$8, updated_at=$8
        WHERE run_id=$1 AND call_id=$2`,
      [runId, callId, status, resultJson, normalizeText(outputSummary || resultJson || error?.message || ""), logPath, code, at],
    );
    await appendEventUnlocked(ctx, {
      runId,
      turnId,
      callId,
      eventType: ok ? "tool_call_completed" : "tool_call_failed",
      status,
      outputSummary: outputSummary || resultJson || error?.message,
      errorCode: code,
      metadata: { tool_name: toolName, result_stored: resultJson != null, log_path: logPath },
    });
    return { run_id: runId, call_id: callId, status, result_stored: resultJson != null };
  });
}

export async function recordRunArtifact(ctx, {
  runId,
  callId = null,
  kind = "file",
  path = null,
  mimeType = null,
  sizeBytes = null,
  sha256 = null,
  metadata = null,
} = {}) {
  assertDb(ctx);
  return runExclusive(runId, async () => {
    const id = randomUUID();
    await ctx.query(
      `INSERT INTO agent_artifacts (
         id, run_id, call_id, kind, path, mime_type, size_bytes, sha256, metadata_json, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, runId, callId, kind, path, mimeType, sizeBytes, sha256, jsonText(metadata), nowIso()],
    );
    await appendEventUnlocked(ctx, {
      runId,
      callId,
      eventType: "artifact_recorded",
      status: "completed",
      artifactId: id,
      outputSummary: path,
      metadata: { kind, mime_type: mimeType, size_bytes: sizeBytes, sha256 },
    });
    return { id, run_id: runId, call_id: callId, kind, path };
  });
}

export async function finalizeRecoveredConversationTurn(ctx, {
  runId,
  sessionId,
  status = "interrupted",
  at = nowIso(),
  reason = "server_restart",
  recoveredItems = null,
  runtimeThreadId = null,
  runtimeTurnId = null,
} = {}) {
  const id = String(runId || "").trim();
  const sid = String(sessionId || "").trim();
  if (!(id && sid)) return { updated: false, created: false };
  const messageId = `assistant:${id}`;
  const existing = await ctx.queryOne(
    `SELECT id,content_items,message_metadata
       FROM session_messages
      WHERE id=$1 AND session_id=$2 AND role='assistant' AND deleted_at IS NULL
      LIMIT 1`,
    [messageId, sid],
  ).catch(() => null);
  const items = parseJson(existing?.content_items, []);
  const contentItems = Array.isArray(items) ? items : [];
  for (const recoveredItem of Array.isArray(recoveredItems) ? recoveredItems : []) {
    if (!recoveredItem?.id) continue;
    const index = contentItems.findIndex((item) => item?.id === recoveredItem.id);
    if (index >= 0) contentItems[index] = { ...contentItems[index], ...recoveredItem };
    else contentItems.push(recoveredItem);
  }
  finalizeTerminalContentItems(contentItems, status);
  if (!contentItems.some((item) => item?.id === `recovery:${id}`)) {
    contentItems.push({
      id: `recovery:${id}`,
      type: "error",
      title: status === "failed" ? "error" : "stopped",
      content: status === "failed"
        ? "任务恢复失败，已保留中断前的过程。"
        : "任务因应用重启而中断，已保留中断前的过程。",
      metadata: { status, recovery_reason: reason },
      is_complete: true,
      display_type: "error",
    });
  }
  const metadata = {
    ...parseJson(existing?.message_metadata, {}),
    run_id: id,
    message_id: messageId,
    turn_status: status,
    partial: false,
    recovery_state: status === "failed" ? "recovery_failed" : "interrupted_after_restart",
    recovery_reason: reason,
    ...(runtimeThreadId ? { thread_id: runtimeThreadId, runtime_thread_id: runtimeThreadId } : {}),
    ...(runtimeTurnId ? { turn_id: runtimeTurnId } : {}),
    ...(Array.isArray(recoveredItems) ? { recovery_source: "native_thread_read" } : {}),
    answer_status: "missing",
    answer_item_id: null,
    answer_source: null,
    answer_rejection_code: status === "failed" ? "TURN_RECOVERY_FAILED" : "TURN_INTERRUPTED",
    completed_at: at,
  };
  if (existing) {
    await ctx.query(
      `UPDATE session_messages
          SET content_items=$1,message_metadata=$2,updated_at=$3
        WHERE id=$4 AND session_id=$5 AND role='assistant' AND deleted_at IS NULL`,
      [JSON.stringify(contentItems), JSON.stringify(metadata), at, messageId, sid],
    );
    return { updated: true, created: false };
  }
  const seq = await ctx.queryOne(
    "SELECT COALESCE(MAX(sequence_number),0) AS m FROM session_messages WHERE session_id=$1",
    [sid],
  ).catch(() => ({ m: 0 }));
  const inserted = await ctx.query(
    `INSERT INTO session_messages
       (id,session_id,role,content_items,message_metadata,sequence_number,created_at,updated_at)
     VALUES ($1,$2,'assistant',$3,$4,$5,$6,$6)
     ON CONFLICT(id) DO NOTHING
     RETURNING id`,
    [messageId, sid, JSON.stringify(contentItems), JSON.stringify(metadata), Number(seq?.m || 0) + 1, at],
  );
  const created = Array.isArray(inserted) && inserted.length > 0;
  if (created) {
    await ctx.query(
      "UPDATE sessions SET updated_at=$2,message_count=COALESCE(message_count,0)+1 WHERE id=$1",
      [sid, at],
    );
  }
  return { updated: created, created };
}

async function durablePendingInteraction(ctx, runId, status, now) {
  const inputType = status === "waiting_approval" ? "approval" : "user_input";
  return ctx.queryOne(
    `SELECT id,request_id,input_type,status
       FROM agent_pending_inputs
      WHERE run_id=$1 AND input_type=$2 AND status='pending' AND deleted_at IS NULL
        AND (resume_expires_at IS NULL OR resume_expires_at>$3)
      ORDER BY updated_at DESC LIMIT 1`,
    [runId, inputType, now],
  ).catch(() => null);
}

export async function recoverStaleAgentRuns(ctx, {
  now = nowIso(),
  includeUnexpiredLeases = false,
} = {}) {
  assertDb(ctx);
  const rows = await ctx.query(
    `SELECT * FROM agent_runs
      WHERE deleted_at IS NULL
        AND status IN ('queued','running','waiting_approval','waiting_user_input','recovering','suspended','resumed')
        ${includeUnexpiredLeases ? "" : "AND (lease_expires_at IS NULL OR lease_expires_at <= $1)"}
      ORDER BY COALESCE(updated_at, created_at) ASC`,
    includeUnexpiredLeases ? [] : [now],
  );
  const results = [];
  for (const row of rows) {
    const status = normalizeRunStatus(row.status);
    if (status === "waiting_user_input" || status === "waiting_approval") {
      const waitingStatus = status === "waiting_approval" ? "waiting_approval" : "waiting_user_input";
      const pending = await durablePendingInteraction(ctx, row.id, waitingStatus, now);
      if (!pending) {
        await ctx.query(
          `UPDATE agent_runs
              SET status='interrupted', recoverable=0,
                  lease_owner=NULL, lease_expires_at=NULL, runner_pid=NULL,
                  heartbeat_at=NULL, viewed_at=NULL, finished_at=$2,
                  status_changed_at=$2, updated_at=$2
            WHERE id=$1`,
          [row.id, now],
        );
        await appendRunEvent(ctx, {
          runId: row.id,
          eventType: "run_recovery_interrupted",
          status: "interrupted",
          errorCode: "AGENT_PENDING_INTERACTION_MISSING",
          metadata: { previous_status: row.status, reason: "pending_record_missing_or_expired" },
        });
        await finalizeRecoveredConversationTurn(ctx, {
          runId: row.id,
          sessionId: row.session_id,
          status: "interrupted",
          at: now,
          reason: "pending_interaction_missing_after_restart",
        }).catch((error) => {
          console.error("[agent recovery message]", error?.message || error);
        });
        results.push({ run_id: row.id, status: "interrupted", action: "interrupt_missing_pending" });
        continue;
      }
      await ctx.query(
        `UPDATE agent_runs
            SET status=$2, lease_owner=NULL, lease_expires_at=NULL,
                runner_pid=NULL, viewed_at=NULL, finished_at=NULL,
                status_changed_at=$3, updated_at=$3
          WHERE id=$1`,
        [row.id, waitingStatus, now],
      );
      await appendRunEvent(ctx, {
        runId: row.id,
        eventType: status === "waiting_approval"
          ? "run_recovery_waiting_approval"
          : "run_recovery_waiting_input",
        status,
        metadata: { previous_status: row.status },
      });
      results.push({ run_id: row.id, status, action: "kept_waiting" });
      continue;
    }
    const uncertainWrite = await ctx.queryOne(
      `SELECT call_id, tool_name, status FROM agent_tool_calls
        WHERE run_id=$1 AND access_mode<>'read' AND status IN ('pending','running','failed')
        ORDER BY updated_at DESC LIMIT 1`,
      [row.id],
    );
    const checkpoint = parseJson(row.checkpoint_json, {});
    const hasCheckpoint = checkpoint && typeof checkpoint === "object" && Object.keys(checkpoint).length > 0;
    const recoverable = !uncertainWrite && (Boolean(row.recoverable) || hasCheckpoint || status === "recovering");
    const next = recoverable ? "recovering" : "interrupted";
    await ctx.query(
      `UPDATE agent_runs
          SET status=$2, recoverable=$3, lease_owner=NULL, lease_expires_at=NULL,
              runner_pid=NULL, heartbeat_at=NULL,
              ${next === "recovering" ? "viewed_at=NULL, finished_at=NULL," : ""}
              status_changed_at=$4, updated_at=$4
        WHERE id=$1`,
      [row.id, next, recoverable ? 1 : 0, now],
    );
    await appendRunEvent(ctx, {
      runId: row.id,
      eventType: recoverable ? "run_recovery_ready" : "run_recovery_interrupted",
      status: next,
      errorCode: uncertainWrite ? "AGENT_TOOL_OUTCOME_UNKNOWN" : null,
      metadata: {
        previous_status: row.status,
        uncertain_call_id: uncertainWrite?.call_id || null,
        uncertain_tool: uncertainWrite?.tool_name || null,
      },
    });
    if (!recoverable) {
      await finalizeRecoveredConversationTurn(ctx, {
        runId: row.id,
        sessionId: row.session_id,
        status: "interrupted",
        at: now,
        reason: uncertainWrite ? "write_outcome_unknown_after_restart" : "server_restart",
      }).catch((error) => {
        console.error("[agent recovery message]", error?.message || error);
      });
    }
    results.push({ run_id: row.id, status: next, action: recoverable ? "recover" : "interrupt" });
  }
  return results;
}

export async function cleanupExpiredRunFacts(ctx, {
  now = nowIso(),
  removeRunDirectory = removeRunnerRunDirectory,
  runIds = null,
} = {}) {
  assertDb(ctx);
  const scopedRunIds = [...new Set((Array.isArray(runIds) ? runIds : []).map(String).filter(Boolean))];
  const params = [now, ...scopedRunIds];
  const scope = scopedRunIds.length
    ? `AND ar.id IN (${scopedRunIds.map((_, index) => `$${index + 2}`).join(",")})`
    : "";
  const rows = await ctx.query(
    `SELECT ar.id, ar.session_id,
            COALESCE(ar.project_id,s.project_id) AS conversation_project_id,
            COALESCE(ar.user_id,s.created_by) AS conversation_user_id
       FROM agent_runs ar
       LEFT JOIN sessions s ON s.id=ar.session_id AND s.deleted_at IS NULL
      WHERE ar.retention_until IS NOT NULL AND ar.retention_until <= $1
        AND ar.deleted_at IS NULL
        AND ar.archived_at IS NULL
        AND ar.status IN ('failed','completed','interrupted','expired')
        ${scope}`,
    params,
  );
  const cleanedRunIds = [];
  const protectedRunIds = [];
  const failures = [];
  for (const row of rows) {
    const evidence = await ctx.queryOne(
      `SELECT COUNT(*) AS count FROM agent_evidence_bundles
        WHERE run_id=$1 AND deleted_at IS NULL`,
      [row.id],
    );
    if (Number(evidence?.count || 0) > 0) {
      protectedRunIds.push(row.id);
      continue;
    }
    try {
      await removeRunDirectory(row.id);
    } catch (error) {
      failures.push({
        run_id: row.id,
        code: error?.code || "AGENT_RUN_RETENTION_CLEANUP_FAILED",
        error: error?.message || String(error),
      });
      continue;
    }
    const childRuns = await ctx.query(
      `SELECT run_id FROM agent_subtask_runs WHERE parent_run_id=$1`,
      [row.id],
    );
    for (const child of childRuns) {
      for (const table of ["agent_pending_inputs", "agent_run_events", "agent_tool_calls", "agent_artifacts", "agent_evidence_bundles"]) {
        await ctx.query(`DELETE FROM ${table} WHERE run_id=$1`, [child.run_id]);
      }
      await ctx.query(
        `UPDATE agent_runs
            SET checkpoint_json=NULL, metadata_json=NULL, last_event_seq=0,
                deleted_at=COALESCE(deleted_at,$2), deleted_by=COALESCE(deleted_by,'retention')
          WHERE id=$1`,
        [child.run_id, now],
      );
    }
    await ctx.query(`DELETE FROM agent_subtask_runs WHERE parent_run_id=$1`, [row.id]);
    const queryExecutions = await ctx.query(`SELECT id FROM query_executions WHERE parent_run_id=$1`, [row.id]);
    for (const execution of queryExecutions) {
      await ctx.query(`DELETE FROM query_executions WHERE id=$1`, [execution.id]);
    }
    await ctx.query(`DELETE FROM agent_pending_inputs WHERE run_id=$1`, [row.id]);
    await ctx.query(`DELETE FROM agent_run_events WHERE run_id=$1`, [row.id]);
    await ctx.query(`DELETE FROM agent_tool_calls WHERE run_id=$1`, [row.id]);
    await ctx.query(`DELETE FROM agent_artifacts WHERE run_id=$1`, [row.id]);
    await ctx.query(`DELETE FROM agent_evidence_bundles WHERE run_id=$1`, [row.id]);
    await ctx.query(
      `UPDATE agent_runs
          SET checkpoint_json=NULL, metadata_json=NULL, last_event_seq=0,
              deleted_at=COALESCE(deleted_at,$2), deleted_by=COALESCE(deleted_by,'retention')
        WHERE id=$1`,
      [row.id, now],
    );
    cleanedRunIds.push(row.id);
    publishConversationStatusChanged({
      userId: row.conversation_user_id,
      projectId: row.conversation_project_id,
      sessionId: row.session_id,
      runId: row.id,
      reason: "run_retention_deleted",
    });
  }
  return {
    scanned_runs: rows.length,
    cleaned_runs: cleanedRunIds.length,
    cleaned_run_ids: cleanedRunIds,
    protected_runs: protectedRunIds.length,
    protected_run_ids: protectedRunIds,
    failed_runs: failures,
  };
}

export function wrapToolsWithRunFacts(tools, runtime, {
  classify = () => "read",
  summarizeInput = (value) => jsonText(value, 4_000) || "",
  summarizeOutput = (value) => jsonText(value, 4_000) || "",
} = {}) {
  if (!runtime?.beginToolCall || !runtime?.finishToolCall) return tools;
  return tools.map((tool) => {
    if (!tool?.name || typeof tool.execute !== "function") return tool;
    const execute = tool.execute.bind(tool);
    return {
      ...tool,
      async execute(callId, ...args) {
        const accessMode = classify(tool.name, tool);
        const factInput = typeof tool.redactInput === "function"
          ? tool.redactInput(args[0] || {})
          : args[0] || {};
        const started = await runtime.beginToolCall({
          callId,
          toolName: tool.name,
          accessMode,
          input: factInput,
          inputSummary: summarizeInput(factInput),
        });
        if (started?.action === "replay") return started.result;
        if (started?.action === "blocked") {
          return {
            content: [{
              type: "text",
              text: started.code === "AGENT_TOOL_OUTCOME_UNKNOWN"
                ? "上一次写入/执行的结果不确定，为避免重复修改，本次没有重跑。请检查运行记录后再决定。"
                : "上一次工具结果没有可安全复用的记录，本次没有重跑。",
            }],
            details: { code: started.code, call_id: callId },
            isError: true,
          };
        }
        try {
          const result = await execute(callId, ...args);
          const ok = !result?.isError;
          const factResult = typeof tool.redactResult === "function" ? tool.redactResult(result) : result;
          await runtime.finishToolCall({
            callId,
            toolName: tool.name,
            ok,
            result: factResult,
            outputSummary: summarizeOutput(factResult),
            error: ok ? null : { code: result?.details?.code || "AGENT_TOOL_FAILED", message: summarizeOutput(factResult) },
          });
          return result;
        } catch (error) {
          const safeErrorPayload = typeof tool.redactResult === "function"
            ? tool.redactResult({ message: error?.message || String(error), code: error?.code || null })
            : { message: error?.message || String(error), code: error?.code || null };
          const safeError = typeof tool.redactResult === "function"
            ? Object.assign(new Error(safeErrorPayload?.message || "工具执行失败"), { code: safeErrorPayload?.code || error?.code })
            : error;
          await runtime.finishToolCall({
            callId,
            toolName: tool.name,
            ok: false,
            error: safeError,
            outputSummary: safeError?.message || String(safeError),
          });
          throw safeError;
        }
      },
    };
  });
}

export default {
  RUN_STATUSES,
  normalizeRunStatus,
  canTransitionRun,
  appendRunEvent,
  transitionAgentRun,
  saveRunCheckpoint,
  acquireRunLease,
  heartbeatRunLease,
  releaseRunLease,
  beginToolCall,
  finishToolCall,
  recordRunArtifact,
  recoverStaleAgentRuns,
  cleanupExpiredRunFacts,
  wrapToolsWithRunFacts,
};

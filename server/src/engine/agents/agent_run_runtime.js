import { randomUUID } from "node:crypto";
import {
  acquireRunLease,
  appendRunEvent,
  beginToolCall,
  finishToolCall,
  heartbeatRunLease,
  normalizeRunStatus,
  recordRunArtifact,
  releaseRunLease,
  saveRunCheckpoint,
  transitionAgentRun,
} from "./run_fact_store.js";
import { createEvidenceBundle } from "./evidence_bundle_store.js";
import { agentRunWorkspacePaths, ensureAgentRunWorkspace } from "../runner/run_workspace.js";
import { captureRunEnvironmentSnapshot, environmentSnapshotRef } from "./run_environment_snapshot.js";
import { completeRunWriteback, stageRunWriteback } from "./run_writeback_store.js";

export const DEFAULT_RESUME_VALIDITY_DAYS = 30;
export const DEFAULT_PENDING_RECORD_DAYS = 3650;
const SERVER_LEASE_OWNER = `server:${process.pid}:${randomUUID()}`;

function nowIso() {
  return new Date().toISOString();
}

function addDays(days) {
  const n = Number(days);
  const safeDays = Number.isFinite(n) && n > 0 ? n : DEFAULT_RESUME_VALIDITY_DAYS;
  return new Date(Date.now() + safeDays * 24 * 60 * 60 * 1000).toISOString();
}

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value && typeof value === "object" ? value : fallback;
}

function normalizeId(value, fallback = "") {
  const text = String(value || "").trim();
  return text || fallback;
}

export function createResumeHandle({ runId, sessionId, requestId } = {}) {
  const run_id = normalizeId(runId);
  const session_id = normalizeId(sessionId);
  const request_id = normalizeId(requestId);
  if (!(run_id && session_id && request_id)) return null;
  return {
    type: "user_input_resume",
    run_id,
    session_id,
    request_id,
    version: 1,
  };
}

export function createApprovalResumeHandle({ runId, sessionId, requestId } = {}) {
  const handle = createResumeHandle({ runId, sessionId, requestId });
  return handle ? { ...handle, type: "approval_resume" } : null;
}

export async function createAgentRun(ctx, {
  runId,
  sessionId,
  projectId,
  userId = null,
  status = "running",
  skill = null,
  mode = "agent",
  checkpoint = undefined,
  metadata = undefined,
  turnId = runId,
  leaseOwner = SERVER_LEASE_OWNER,
  runsRoot = undefined,
} = {}) {
  if (!(ctx?.query && ctx?.queryOne && runId && sessionId)) return null;
  try {
    const canonicalStatus = normalizeRunStatus(status);
    const workspace = await ensureAgentRunWorkspace({
      runId,
      sessionId,
      projectId,
      userId,
      mode,
      skill,
      ...(runsRoot ? { runsRoot } : {}),
    });
    const existing = await ctx.queryOne(
      `SELECT * FROM agent_runs WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
      [runId],
    );
    if (!existing) {
      await ctx.query(
        `INSERT INTO agent_runs (
            id, session_id, project_id, user_id, status, skill_name, mode,
            checkpoint_json, metadata_json, turn_id, recoverable,
            workspace_path, manifest_path, workspace_version, manifest_hash,
            retention_until, created_at, updated_at
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14,$15,now(),now())`,
        [
          runId,
          sessionId,
          projectId || null,
          userId || null,
          canonicalStatus,
          skill,
          mode,
          JSON.stringify(checkpoint || {}),
          JSON.stringify(metadata || {}),
          turnId || runId,
          workspace.root,
          workspace.manifest,
          workspace.version,
          workspace.manifest_hash,
          addDays(30),
        ],
      );
      await appendRunEvent(ctx, {
        runId,
        turnId,
        eventType: "run_created",
        status: canonicalStatus,
        metadata: {
          session_id: sessionId,
          project_id: projectId || null,
          mode,
          skill_name: skill,
          workspace_path: workspace.root,
          workspace_version: workspace.version,
          manifest_hash: workspace.manifest_hash,
        },
      });
    } else {
      const sets = [
        "session_id=$2",
        "project_id=$3",
        "user_id=$4",
        "skill_name=$5",
        "mode=$6",
        "turn_id=COALESCE($7,turn_id)",
        "workspace_path=$8",
        "manifest_path=$9",
        "workspace_version=$10",
        "manifest_hash=$11",
        "updated_at=now()",
      ];
      const params = [
        runId, sessionId, projectId || null, userId || null, skill, mode, turnId || runId,
        workspace.root, workspace.manifest, workspace.version, workspace.manifest_hash,
      ];
      if (checkpoint !== undefined) {
        params.push(JSON.stringify(checkpoint || {}));
        sets.push(`checkpoint_json=$${params.length}`);
      }
      if (metadata !== undefined) {
        params.push(JSON.stringify(metadata || {}));
        sets.push(`metadata_json=$${params.length}`);
      }
      await ctx.query(`UPDATE agent_runs SET ${sets.join(", ")} WHERE id=$1`, params);
      await transitionAgentRun(ctx, {
        runId,
        status: canonicalStatus,
        eventType: "run_resumed",
        eventMetadata: { requested_status: status },
      });
    }
    await acquireRunLease(ctx, { runId, owner: leaseOwner });
    return {
      run_id: runId,
      status: canonicalStatus,
      lease_owner: leaseOwner,
      workspace_path: workspace.root,
      manifest_path: workspace.manifest,
      workspace_version: workspace.version,
      manifest_hash: workspace.manifest_hash,
    };
  } catch (error) {
    console.error("[agent_runs create]", error?.message || error);
    return null;
  }
}

export async function updateAgentRunStatus(ctx, {
  runId,
  status,
  checkpoint = undefined,
  metadata = undefined,
  finished = false,
} = {}) {
  if (!(ctx?.query && ctx?.queryOne && runId && status)) return null;
  return transitionAgentRun(ctx, {
    runId,
    status,
    checkpoint,
    metadata,
    finished,
    eventType: "run_status_changed",
  }).catch((error) => {
    console.error("[agent_runs update]", error?.message || error);
    return null;
  });
}

export async function suspendRunForUserInput(ctx, {
  runId,
  sessionId,
  projectId,
  userId = null,
  requestId,
  payload = {},
  checkpoint = {},
  resumeValidityDays = DEFAULT_RESUME_VALIDITY_DAYS,
  recordRetentionDays = DEFAULT_PENDING_RECORD_DAYS,
} = {}) {
  if (!(ctx?.query && runId && sessionId && requestId)) return null;
  const resumeHandle = createResumeHandle({ runId, sessionId, requestId });
  const payloadWithHandle = {
    ...payload,
    request_id: requestId,
    run_id: runId,
    resume_handle: resumeHandle,
  };
  const resumeExpiresAt = addDays(resumeValidityDays);
  const recordExpiresAt = addDays(recordRetentionDays);
  await ctx.query(
    `INSERT INTO agent_pending_inputs (
        id, run_id, session_id, project_id, user_id, request_id,
        input_type, status, payload_json, response_json, resume_handle_json,
        resume_expires_at, record_expires_at, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,'user_input','pending',$7,NULL,$8,$9,$10,now(),now())
      ON CONFLICT(request_id) DO UPDATE SET
        status='pending',
        payload_json=excluded.payload_json,
        resume_handle_json=excluded.resume_handle_json,
        resume_expires_at=excluded.resume_expires_at,
        record_expires_at=excluded.record_expires_at,
        updated_at=now()`,
    [
      randomUUID(),
      runId,
      sessionId,
      projectId || null,
      userId || null,
      requestId,
      JSON.stringify(payloadWithHandle),
      JSON.stringify(resumeHandle),
      resumeExpiresAt,
      recordExpiresAt,
    ],
  ).catch(() => null);
  await updateAgentRunStatus(ctx, {
    runId,
    status: "waiting_user_input",
    checkpoint: {
      ...checkpoint,
      suspended_at: nowIso(),
      waiting_for: { type: "user_input", request_id: requestId },
    },
  });
  await releaseRunLease(ctx, { runId, owner: null }).catch(() => {});
  return {
    request_id: requestId,
    run_id: runId,
    session_id: sessionId,
    status: "pending",
    payload: payloadWithHandle,
    resume_handle: resumeHandle,
    resume_expires_at: resumeExpiresAt,
  };
}

export async function suspendRunForApproval(ctx, {
  runId,
  sessionId,
  projectId,
  userId = null,
  requestId,
  payload = {},
  checkpoint = {},
  resumeValidityDays = DEFAULT_RESUME_VALIDITY_DAYS,
  recordRetentionDays = DEFAULT_PENDING_RECORD_DAYS,
} = {}) {
  if (!(ctx?.query && ctx?.queryOne && runId && sessionId && requestId)) return null;
  const resumeHandle = createApprovalResumeHandle({ runId, sessionId, requestId });
  const current = await ctx.queryOne(
    `SELECT checkpoint_json FROM agent_runs WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
    [runId],
  ).catch(() => null);
  const mergedCheckpoint = {
    ...safeJson(current?.checkpoint_json, {}),
    ...checkpoint,
    suspended_at: nowIso(),
    waiting_for: { type: "approval", request_id: requestId },
  };
  const payloadWithHandle = {
    ...payload,
    request_id: requestId,
    run_id: runId,
    resume_handle: resumeHandle,
  };
  const resumeExpiresAt = addDays(resumeValidityDays);
  const recordExpiresAt = addDays(recordRetentionDays);
  await ctx.query(
    `INSERT INTO agent_pending_inputs (
        id, run_id, session_id, project_id, user_id, request_id,
        input_type, status, payload_json, response_json, resume_handle_json,
        resume_expires_at, record_expires_at, created_at, updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,'approval','pending',$7,NULL,$8,$9,$10,now(),now())
      ON CONFLICT(request_id) DO UPDATE SET
        status='pending',
        payload_json=excluded.payload_json,
        response_json=NULL,
        resume_handle_json=excluded.resume_handle_json,
        resume_expires_at=excluded.resume_expires_at,
        record_expires_at=excluded.record_expires_at,
        updated_at=now()`,
    [
      randomUUID(),
      runId,
      sessionId,
      projectId || null,
      userId || null,
      requestId,
      JSON.stringify(payloadWithHandle),
      JSON.stringify(resumeHandle),
      resumeExpiresAt,
      recordExpiresAt,
    ],
  );
  await updateAgentRunStatus(ctx, {
    runId,
    status: "waiting_approval",
    checkpoint: mergedCheckpoint,
  });
  await releaseRunLease(ctx, { runId, owner: null }).catch(() => {});
  return {
    request_id: requestId,
    run_id: runId,
    session_id: sessionId,
    status: "pending",
    payload: payloadWithHandle,
    resume_handle: resumeHandle,
    resume_expires_at: resumeExpiresAt,
  };
}

export async function resolvePendingUserInput(ctx, {
  sessionId,
  requestId,
  runId = null,
  value,
  userId = null,
} = {}) {
  if (!(ctx?.query && ctx?.queryOne && sessionId && requestId)) {
    return { status: "missing", recorded: false };
  }
  const row = await ctx.queryOne(
    `SELECT * FROM agent_pending_inputs
      WHERE request_id=$1 AND session_id=$2 AND input_type='user_input' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [requestId, sessionId],
  ).catch(() => null);
  if (!row) return { status: "missing", recorded: false };
  if (runId && row.run_id && String(row.run_id) !== String(runId)) {
    return { status: "mismatched", recorded: false, pending: row };
  }

  const currentStatus = String(row.status || "pending");
  const response = safeJson(row.response_json, null);
  if (currentStatus === "answered") {
    return {
      status: "answered",
      recorded: false,
      idempotent: true,
      chosen_value: response?.value ?? value,
      pending: row,
      payload: safeJson(row.payload_json),
      resume_handle: safeJson(row.resume_handle_json, null),
    };
  }

  const resumeExpiresAt = row.resume_expires_at ? new Date(row.resume_expires_at).getTime() : null;
  const isExpired = Number.isFinite(resumeExpiresAt) && resumeExpiresAt > 0 && resumeExpiresAt < Date.now();
  if (isExpired) {
    await ctx.query(
      `UPDATE agent_pending_inputs
          SET status='expired', response_json=$3, responded_by=$4, responded_at=now(), updated_at=now()
        WHERE id=$1 AND request_id=$2`,
      [
        row.id,
        requestId,
        JSON.stringify({ value, expired: true, responded_at: nowIso() }),
        userId || null,
      ],
    ).catch(() => null);
    await updateAgentRunStatus(ctx, { runId: row.run_id, status: "expired", finished: true });
    return {
      status: "expired",
      recorded: false,
      chosen_value: value,
      pending: row,
      payload: safeJson(row.payload_json),
      resume_handle: safeJson(row.resume_handle_json, null),
    };
  }

  const responseJson = {
    value,
    responded_at: nowIso(),
    resume_mode: "handle",
  };
  const claimed = await ctx.queryOne(
    `UPDATE agent_pending_inputs
        SET status='answered', response_json=$3, responded_by=$4, responded_at=now(), updated_at=now()
      WHERE id=$1 AND request_id=$2 AND status='pending'
      RETURNING *`,
    [row.id, requestId, JSON.stringify(responseJson), userId || null],
  ).catch(() => null);
  if (!claimed) {
    const latest = await ctx.queryOne(
      `SELECT * FROM agent_pending_inputs WHERE id=$1 AND request_id=$2 LIMIT 1`,
      [row.id, requestId],
    ).catch(() => row);
    const latestResponse = safeJson(latest?.response_json, response);
    return {
      status: String(latest?.status || 'pending'),
      recorded: false,
      idempotent: String(latest?.status || '') === 'answered',
      chosen_value: latestResponse?.value ?? value,
      pending: latest,
      payload: safeJson(latest?.payload_json),
      resume_handle: safeJson(latest?.resume_handle_json, null),
      run_id: latest?.run_id || row.run_id,
    };
  }
  const run = await ctx.queryOne(
    `SELECT * FROM agent_runs WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
    [row.run_id],
  ).catch(() => null);
  const checkpoint = safeJson(run?.checkpoint_json, {});
  await updateAgentRunStatus(ctx, {
    runId: row.run_id,
    status: "recovering",
    checkpoint: {
      ...checkpoint,
      resumed_at: nowIso(),
      resumed_from: { request_id: requestId, value },
    },
  });
  return {
    status: "answered",
    recorded: true,
    chosen_value: value,
    pending: claimed,
    run,
    checkpoint,
    payload: safeJson(row.payload_json),
    resume_handle: safeJson(row.resume_handle_json, null),
    run_id: row.run_id,
  };
}

export async function resolvePendingApproval(ctx, {
  sessionId,
  requestId,
  runId = null,
  approved = false,
  userId = null,
} = {}) {
  if (!(ctx?.query && ctx?.queryOne && sessionId && requestId)) {
    return { status: "missing", recorded: false };
  }
  const row = await ctx.queryOne(
    `SELECT * FROM agent_pending_inputs
      WHERE request_id=$1 AND session_id=$2 AND input_type='approval' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [requestId, sessionId],
  ).catch(() => null);
  if (!row) return { status: "missing", recorded: false };
  if (runId && row.run_id && String(row.run_id) !== String(runId)) {
    return { status: "mismatched", recorded: false, pending: row };
  }

  const payload = safeJson(row.payload_json, {});
  const response = safeJson(row.response_json, null);
  if (String(row.status || "pending") === "answered") {
    return {
      status: "answered",
      recorded: false,
      idempotent: true,
      approved: Boolean(response?.approved),
      pending: row,
      payload,
      resume_handle: safeJson(row.resume_handle_json, null),
      run_id: row.run_id,
    };
  }

  const resumeExpiresAt = row.resume_expires_at ? new Date(row.resume_expires_at).getTime() : null;
  const isExpired = Number.isFinite(resumeExpiresAt) && resumeExpiresAt > 0 && resumeExpiresAt < Date.now();
  if (isExpired) {
    await ctx.query(
      `UPDATE agent_pending_inputs
          SET status='expired', response_json=$3, responded_by=$4, responded_at=now(), updated_at=now()
        WHERE id=$1 AND request_id=$2`,
      [row.id, requestId, JSON.stringify({ approved: false, expired: true, responded_at: nowIso() }), userId || null],
    );
    await updateAgentRunStatus(ctx, { runId: row.run_id, status: "expired", finished: true });
    return {
      status: "expired",
      recorded: false,
      approved: false,
      pending: row,
      payload,
      resume_handle: safeJson(row.resume_handle_json, null),
      run_id: row.run_id,
    };
  }

  const responseJson = { approved: Boolean(approved), responded_at: nowIso(), resume_mode: "handle" };
  const claimed = await ctx.queryOne(
    `UPDATE agent_pending_inputs
        SET status='answered', response_json=$3, responded_by=$4, responded_at=now(), updated_at=now()
      WHERE id=$1 AND request_id=$2 AND status='pending'
      RETURNING *`,
    [row.id, requestId, JSON.stringify(responseJson), userId || null],
  );
  if (!claimed) {
    const latest = await ctx.queryOne(
      `SELECT * FROM agent_pending_inputs WHERE id=$1 AND request_id=$2 LIMIT 1`,
      [row.id, requestId],
    ).catch(() => row);
    const latestResponse = safeJson(latest?.response_json, response);
    return {
      status: String(latest?.status || "pending"),
      recorded: false,
      idempotent: String(latest?.status || "") === "answered",
      approved: Boolean(latestResponse?.approved),
      pending: latest,
      payload: safeJson(latest?.payload_json, payload),
      resume_handle: safeJson(latest?.resume_handle_json, null),
      run_id: latest?.run_id || row.run_id,
    };
  }
  const run = await ctx.queryOne(
    `SELECT * FROM agent_runs WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
    [row.run_id],
  ).catch(() => null);
  const checkpoint = safeJson(run?.checkpoint_json, {});
  await updateAgentRunStatus(ctx, {
    runId: row.run_id,
    status: "recovering",
    checkpoint: {
      ...checkpoint,
      resumed_at: nowIso(),
      resumed_from: { type: "approval", request_id: requestId, approved: Boolean(approved) },
    },
  });
  return {
    status: "answered",
    recorded: true,
    approved: Boolean(approved),
    pending: claimed,
    run,
    checkpoint,
    payload,
    resume_handle: safeJson(row.resume_handle_json, null),
    run_id: row.run_id,
  };
}

export function buildUserInputContinuationMessage({
  originalMessage = "",
  selectedValue = "",
  askPrompt = "",
  mode = "replayed",
} = {}) {
  const original = String(originalMessage || "").trim();
  const selected = String(selectedValue || "").trim();
  const prompt = String(askPrompt || "").trim();
  const lines = [
    "继续上一轮已挂起的任务。",
    mode === "handle" ? "用户已通过 resume handle 回复了等待中的确认。" : "用户已回复等待中的确认,请重新加载上下文后继续。",
    selected ? `用户选择: ${selected}` : "",
    prompt ? `当时的问题: ${prompt}` : "",
    original ? `原始任务: ${original}` : "",
    "请基于该选择继续完成原始任务,不要再次把该候选当作新的独立问题。",
  ].filter(Boolean);
  return lines.join("\n");
}

export function createAgentRuntime({
  ctx,
  stream,
  runId,
  sessionId,
  projectId,
  userId = null,
  skill = null,
  mode = "agent",
} = {}) {
  const dbctx = ctx?.query ? ctx : ctx?.db;
  const leaseOwner = SERVER_LEASE_OWNER;
  const workspace = agentRunWorkspacePaths(runId);
  let environmentSnapshot = null;
  return {
    runId,
    // 当前顶层 Agent 的一轮运行就是一轮 Turn；委托能力用它绑定稳定执行上下文。
    turnId: runId,
    sessionId,
    projectId,
    userId,
    leaseOwner,
    workspace,
    captureEnvironment: async (payload = {}) => {
      environmentSnapshot = await captureRunEnvironmentSnapshot(dbctx, {
        runId,
        sessionId,
        projectId,
        ...payload,
      });
      return environmentSnapshot;
    },
    createRun: () => createAgentRun(dbctx, { runId, sessionId, projectId, userId, skill, mode, leaseOwner }),
    resumeRun: async () => {
      const resumed = await transitionAgentRun(dbctx, {
        runId,
        status: "running",
        eventType: "run_resumed_in_agent_turn",
        eventMetadata: { runtime: "agent_app_server" },
      });
      return resumed || dbctx.queryOne(
        "SELECT * FROM agent_runs WHERE id=$1 AND deleted_at IS NULL LIMIT 1",
        [runId],
      );
    },
    completeRun: async (status = "completed") => {
      const result = await updateAgentRunStatus(dbctx, {
        runId,
        status,
        finished: status === "completed" || status === "failed",
      });
      await releaseRunLease(dbctx, { runId, owner: leaseOwner }).catch(() => {});
      return result;
    },
    interruptRun: async (reason = "user_stop") => {
      const result = await transitionAgentRun(dbctx, {
        runId,
        status: "interrupted",
        eventType: "run_interrupted",
        eventMetadata: { reason },
      }).catch(() => null);
      await releaseRunLease(dbctx, { runId, owner: leaseOwner }).catch(() => {});
      return result;
    },
    approvalState: (waiting, approval = null) => transitionAgentRun(dbctx, {
      runId,
      status: waiting ? "waiting_approval" : "running",
      eventType: waiting ? "run_waiting_approval" : "run_approval_resolved",
      eventMetadata: approval || null,
    }).catch(() => null),
    beginToolCall: (payload) => beginToolCall(dbctx, { runId, turnId: runId, ...payload }),
    finishToolCall: (payload) => finishToolCall(dbctx, { runId, turnId: runId, ...payload }),
    recordArtifact: (payload) => recordRunArtifact(dbctx, { runId, ...payload }),
    stageWriteback: async (payload = {}) => {
      const staged = await stageRunWriteback({
        workspace,
        runId,
        projectId,
        ...payload,
      });
      if (staged.created) {
        await recordRunArtifact(dbctx, {
          runId,
          callId: payload.callId || null,
          kind: "writeback_proposal",
          path: staged.path,
          mimeType: "application/json",
          sizeBytes: staged.size_bytes,
          sha256: staged.file_hash,
          metadata: {
            version: staged.version,
            proposal_hash: staged.proposal_hash,
            kind: staged.kind,
            target: staged.target,
          },
        });
      }
      return staged;
    },
    completeWriteback: async (payload = {}) => {
      const receipt = await completeRunWriteback({
        workspace,
        runId,
        projectId,
        ...payload,
      });
      if (receipt.created) {
        await recordRunArtifact(dbctx, {
          runId,
          callId: payload.callId || null,
          kind: "writeback_receipt",
          path: receipt.path,
          mimeType: "application/json",
          sizeBytes: receipt.size_bytes,
          sha256: receipt.file_hash,
          metadata: {
            version: receipt.version,
            proposal_hash: receipt.proposal_hash,
            receipt_hash: receipt.receipt_hash,
            kind: receipt.kind,
            target: receipt.target,
          },
        });
      }
      return receipt;
    },
    recordEvidenceBundle: (payload = {}) => createEvidenceBundle(dbctx, {
      runId,
      turnId: runId,
      sessionId,
      projectId,
      ...payload,
      metadata: {
        ...(payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {}),
        ...(environmentSnapshot ? { environment_snapshot_ref: environmentSnapshotRef(environmentSnapshot) } : {}),
      },
    }),
    recordEvent: (payload) => appendRunEvent(dbctx, { runId, turnId: runId, ...payload }),
    saveCheckpoint: (checkpoint, metadata = null) => saveRunCheckpoint(dbctx, {
      runId,
      checkpoint,
      metadata,
    }),
    runnerState: async ({ status, pid = null } = {}) => {
      if (status === "running" || status === "heartbeat") {
        return heartbeatRunLease(dbctx, { runId, owner: leaseOwner, runnerPid: pid }).catch(() => null);
      }
      if (status === "stopped") {
        return appendRunEvent(dbctx, {
          runId,
          turnId: runId,
          eventType: "runner_stopped",
          status: null,
          metadata: { pid },
        }).catch(() => null);
      }
      return null;
    },
    async requestUserInput(payload = {}, { requestId, checkpoint = {} } = {}) {
      const reqId = normalizeId(requestId || payload.request_id, `q_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
      const suspended = await suspendRunForUserInput(dbctx, {
        runId,
        sessionId,
        projectId,
        userId,
        requestId: reqId,
        payload: { ...payload, request_id: reqId },
        checkpoint,
      });
      stream?.runSuspended?.({
        reason: "user_input",
        request_id: reqId,
        resumable: true,
        resume_handle: suspended?.resume_handle || createResumeHandle({ runId, sessionId, requestId: reqId }),
        resume_expires_at: suspended?.resume_expires_at || null,
      });
      return suspended?.payload || { ...payload, request_id: reqId };
    },
    async requestApproval(payload = {}, { requestId, checkpoint = {} } = {}) {
      const reqId = normalizeId(requestId || payload.request_id, `approval_${randomUUID().replace(/-/g, "").slice(0, 16)}`);
      const suspended = await suspendRunForApproval(dbctx, {
        runId,
        sessionId,
        projectId,
        userId,
        requestId: reqId,
        payload: { ...payload, request_id: reqId },
        checkpoint,
      });
      stream?.runSuspended?.({
        reason: "approval",
        request_id: reqId,
        resumable: true,
        resume_handle: suspended?.resume_handle || createApprovalResumeHandle({ runId, sessionId, requestId: reqId }),
        resume_expires_at: suspended?.resume_expires_at || null,
      });
      return suspended?.payload || { ...payload, request_id: reqId };
    },
  };
}

export default {
  DEFAULT_RESUME_VALIDITY_DAYS,
  createResumeHandle,
  createApprovalResumeHandle,
  createAgentRun,
  updateAgentRunStatus,
  suspendRunForUserInput,
  suspendRunForApproval,
  resolvePendingUserInput,
  resolvePendingApproval,
  createAgentRuntime,
};

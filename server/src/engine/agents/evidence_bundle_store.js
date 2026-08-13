import { createHash, randomUUID } from "node:crypto";

export const EVIDENCE_BUNDLE_VERSION = "agent_evidence_bundle.v1";

function json(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function snapshotHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function uniqueObjects(items, key) {
  const values = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    const id = String(item?.[key] || "").trim();
    const identity = id || snapshotHash(item);
    if (seen.has(identity)) continue;
    seen.add(identity);
    values.push(item);
  }
  return values;
}

function publicToolCall(row) {
  return {
    id: row.id,
    call_id: row.call_id,
    tool_name: row.tool_name,
    access_mode: row.access_mode,
    status: row.status,
    attempt_count: Number(row.attempt_count || 0),
    input: json(row.input_json, null),
    result: json(row.result_json, null),
    error_code: row.error_code || null,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
  };
}

function publicArtifact(row) {
  return {
    id: row.id,
    call_id: row.call_id || null,
    kind: row.kind,
    path: row.path || null,
    mime_type: row.mime_type || null,
    size_bytes: row.size_bytes == null ? null : Number(row.size_bytes),
    sha256: row.sha256 || null,
    metadata: json(row.metadata_json, {}),
    created_at: row.created_at,
  };
}

function publicApproval(row) {
  return {
    id: row.id,
    request_id: row.request_id,
    status: row.status,
    request: json(row.payload_json, {}),
    response: json(row.response_json, null),
    responded_by: row.responded_by || null,
    responded_at: row.responded_at || null,
    created_at: row.created_at,
  };
}

function buildUncertainties({ evidence, validations, tools, approvals }) {
  const items = [];
  for (const item of evidence) {
    const status = String(item?.result?.status || "").toLowerCase();
    if (["failed", "partial"].includes(status) || item?.result?.partial === true) {
      items.push({ type: "query_result", evidence_id: item.evidence_id || null, status: status || "partial" });
    }
    const unresolvedReferences = item?.schema?.unresolved_table_references || item?.schema?.unresolved_references;
    if (Array.isArray(unresolvedReferences) && unresolvedReferences.length) {
      items.push({
        type: "unresolved_schema",
        evidence_id: item.evidence_id || null,
        references: unresolvedReferences,
      });
    }
  }
  for (const validation of validations) {
    if (String(validation?.status || "") !== "passed") {
      items.push({
        type: "validation",
        validation_id: validation?.validation_id || null,
        failed_checks: (validation?.checks || []).filter((check) => !check?.passed).map((check) => check.name),
      });
    }
  }
  for (const tool of tools) {
    if (String(tool?.status || "") === "failed") {
      items.push({ type: "tool_call", call_id: tool.call_id, tool_name: tool.tool_name, error_code: tool.error_code });
    }
  }
  for (const approval of approvals) {
    const approved = approval?.response?.approved;
    if (approval.status === "pending" || approved === false) {
      items.push({ type: "approval", request_id: approval.request_id, status: approval.status, approved });
    }
  }
  return items;
}

export function publicEvidenceBundle(row) {
  if (!row) return null;
  const payload = json(row.payload_json, {});
  return {
    id: row.id,
    version: row.bundle_version || EVIDENCE_BUNDLE_VERSION,
    run_id: row.run_id,
    turn_id: row.turn_id,
    session_id: row.session_id,
    project_id: row.project_id,
    final_item_id: row.final_item_id,
    status: row.status,
    snapshot_hash: row.snapshot_hash,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...payload,
  };
}

export async function createEvidenceBundle(ctx, {
  runId,
  turnId = runId,
  sessionId,
  projectId,
  finalItemId,
  answerText,
  evidence = [],
  validations = [],
  toolCallIds = [],
  artifactRefs = [],
  metadata = {},
} = {}) {
  if (!(ctx?.query && ctx?.queryOne && runId && sessionId && finalItemId)) return null;

  const existing = await ctx.queryOne(
    `SELECT * FROM agent_evidence_bundles
      WHERE run_id=$1 AND final_item_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [runId, finalItemId],
  );
  if (existing) return publicEvidenceBundle(existing);

  const [toolRows, artifactRows, approvalRows] = await Promise.all([
    ctx.query(`SELECT * FROM agent_tool_calls WHERE run_id=$1 ORDER BY created_at ASC`, [runId]),
    ctx.query(`SELECT * FROM agent_artifacts WHERE run_id=$1 ORDER BY created_at ASC`, [runId]),
    ctx.query(
      `SELECT * FROM agent_pending_inputs
        WHERE run_id=$1 AND input_type='approval' AND deleted_at IS NULL
        ORDER BY created_at ASC`,
      [runId],
    ),
  ]);
  const requestedCallIds = new Set((Array.isArray(toolCallIds) ? toolCallIds : []).map(String).filter(Boolean));
  const evidenceCallIds = (Array.isArray(evidence) ? evidence : [])
    .map((item) => String(item?.tool_call_id || ""))
    .filter(Boolean);
  evidenceCallIds.forEach((id) => requestedCallIds.add(id));
  const allTools = (toolRows || []).map(publicToolCall);
  const tools = requestedCallIds.size
    ? allTools.filter((tool) => requestedCallIds.has(String(tool.call_id)))
    : allTools;
  const dbArtifacts = (artifactRows || []).map(publicArtifact);
  const explicitArtifacts = (Array.isArray(artifactRefs) ? artifactRefs : []).map((artifact) => ({
    ...artifact,
    source: artifact.source || "answer",
  }));
  const artifacts = uniqueObjects([...dbArtifacts, ...explicitArtifacts], "id");
  const approvals = (approvalRows || []).map(publicApproval);
  const queryEvidence = uniqueObjects(evidence, "evidence_id");
  const queryValidations = uniqueObjects(validations, "validation_id");
  const uncertainties = buildUncertainties({ evidence: queryEvidence, validations: queryValidations, tools, approvals });
  const status = uncertainties.length
    ? "needs_attention"
    : queryEvidence.length && queryValidations.length
      ? "verified"
      : queryEvidence.length
        ? "evidence_available"
        : "unverified";
  const payload = {
    answer: {
      item_id: finalItemId,
      text: String(answerText || ""),
      text_hash: snapshotHash(String(answerText || "")),
    },
    evidence: queryEvidence,
    validations: queryValidations,
    tool_calls: tools,
    approvals,
    artifacts,
    uncertainty: { has_uncertainty: uncertainties.length > 0, items: uncertainties },
    metadata: metadata && typeof metadata === "object" ? metadata : {},
  };
  const hash = snapshotHash({
    version: EVIDENCE_BUNDLE_VERSION,
    run_id: runId,
    turn_id: turnId,
    session_id: sessionId,
    project_id: projectId || null,
    final_item_id: finalItemId,
    status,
    payload,
  });
  const id = randomUUID();
  await ctx.query(
    `INSERT INTO agent_evidence_bundles (
        id, run_id, turn_id, session_id, project_id, final_item_id,
        bundle_version, status, snapshot_hash, payload_json,
        created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
      ON CONFLICT(run_id, final_item_id) DO NOTHING`,
    [
      id,
      runId,
      turnId || runId,
      sessionId,
      projectId || null,
      finalItemId,
      EVIDENCE_BUNDLE_VERSION,
      status,
      hash,
      JSON.stringify(payload),
    ],
  );
  const stored = await ctx.queryOne(
    `SELECT * FROM agent_evidence_bundles
      WHERE run_id=$1 AND final_item_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [runId, finalItemId],
  );
  return publicEvidenceBundle(stored);
}

export async function getEvidenceBundle(ctx, bundleId) {
  if (!(ctx?.queryOne && bundleId)) return null;
  const row = await ctx.queryOne(
    `SELECT * FROM agent_evidence_bundles WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
    [bundleId],
  );
  return publicEvidenceBundle(row);
}

export async function listEvidenceBundlesForRun(ctx, runId) {
  if (!(ctx?.query && runId)) return [];
  const rows = await ctx.query(
    `SELECT * FROM agent_evidence_bundles
      WHERE run_id=$1 AND deleted_at IS NULL ORDER BY created_at ASC`,
    [runId],
  );
  return rows.map(publicEvidenceBundle);
}

export default {
  EVIDENCE_BUNDLE_VERSION,
  createEvidenceBundle,
  getEvidenceBundle,
  listEvidenceBundlesForRun,
  publicEvidenceBundle,
};

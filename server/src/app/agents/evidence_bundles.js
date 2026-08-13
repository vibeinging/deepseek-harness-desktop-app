import { ApiError } from "../../errors.js";
import {
  getEvidenceBundle,
  listEvidenceBundlesForRun,
} from "../../engine/agents/evidence_bundle_store.js";
import { rerunEvidenceBundle } from "../../engine/agents/evidence_bundle_rerun.js";

async function ownedRun(ctx, runId) {
  const row = await ctx.queryOne(
    `SELECT id, session_id, project_id, user_id FROM agent_runs
      WHERE id=$1 AND deleted_at IS NULL
        AND user_id=$2
        AND (project_id='__chat__' OR EXISTS (
          SELECT 1 FROM project_members pm
           WHERE pm.project_id=agent_runs.project_id AND pm.user_id=$2 AND pm.deleted_at IS NULL
        ))
      LIMIT 1`,
    [runId, ctx.userId || ""],
  );
  if (!row) throw new ApiError("运行不存在", 404);
  return row;
}

export async function listRunEvidenceBundles(ctx, input) {
  const run = await ownedRun(ctx, input.params.runId);
  const items = await listEvidenceBundlesForRun(ctx, run.id);
  return { data: { items }, message: "ok" };
}

export async function getRunEvidenceBundle(ctx, input) {
  const bundle = await getEvidenceBundle(ctx, input.params.bundleId);
  if (!bundle) throw new ApiError("证据包不存在", 404);
  await ownedRun(ctx, bundle.run_id);
  return { data: bundle, message: "ok" };
}

export async function rerunRunEvidenceBundle(ctx, input) {
  const bundle = await getEvidenceBundle(ctx, input.params.bundleId);
  if (!bundle) throw new ApiError("证据包不存在", 404);
  await ownedRun(ctx, bundle.run_id);
  try {
    const result = await rerunEvidenceBundle(ctx, { bundle, userId: ctx.userId || "" });
    return { data: result, message: "证据复跑完成" };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error?.message || "证据复跑失败", 500, error?.code || "EVIDENCE_RERUN_FAILED");
  }
}

export default { listRunEvidenceBundles, getRunEvidenceBundle, rerunRunEvidenceBundle };

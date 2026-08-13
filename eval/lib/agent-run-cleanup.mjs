const CLOSED_RUN_STATUSES = new Set(['completed', 'failed', 'expired', 'interrupted']);

function runItems(response) {
  return Array.isArray(response?.json?.data?.items) ? response.json.data.items : [];
}

/**
 * Best-effort cleanup for real-agent evals.
 *
 * A timed-out stream may never return its session id or run id to the caller, so
 * cleanup must discover runs from the project boundary. Any still-open run is
 * stopped before the normal impact-confirmed deletion API is used.
 */
export async function cleanupProjectAgentRuns(api, projectId, knownRunIds = []) {
  const projectRuns = await api(
    'GET',
    `/api/agents/projects/${encodeURIComponent(projectId)}/runs?limit=100`,
  ).catch(() => null);
  const listed = runItems(projectRuns);
  const statuses = new Map(listed.map((run) => [String(run.id || ''), String(run.status || '').toLowerCase()]));
  const runIds = [...new Set([
    ...knownRunIds,
    ...listed.map((run) => run.id),
  ].map(String).filter(Boolean))];
  const result = { discovered: runIds.length, stopped: [], deleted: [], failed: [] };

  for (const runId of runIds) {
    if (!CLOSED_RUN_STATUSES.has(statuses.get(runId) || '')) {
      const stopped = await api(
        'POST',
        `/api/agents/runs/${encodeURIComponent(runId)}/stop`,
        {},
      ).catch(() => null);
      if (stopped?.status >= 200 && stopped.status < 300) result.stopped.push(runId);
    }

    const impact = await api(
      'GET',
      `/api/agents/runs/${encodeURIComponent(runId)}/deletion-impact`,
    ).catch(() => null);
    const impactHash = impact?.json?.data?.impact_hash;
    if (!impactHash) {
      result.failed.push(runId);
      continue;
    }
    const deleted = await api(
      'DELETE',
      `/api/agents/runs/${encodeURIComponent(runId)}`,
      { impact_hash: impactHash, force: true },
    ).catch(() => null);
    if (deleted?.status >= 200 && deleted.status < 300) result.deleted.push(runId);
    else result.failed.push(runId);
  }
  return result;
}

import { cleanupExpiredRunFacts } from "../../engine/agents/run_fact_store.js";
import { enforceRunStoragePolicy } from "../../engine/agents/run_storage_policy.js";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

function intervalMs(value) {
  const number = Number(value || DEFAULT_INTERVAL_MS);
  return Number.isFinite(number) && number >= 60_000 ? Math.floor(number) : DEFAULT_INTERVAL_MS;
}

export function startAgentRunRetentionScheduler(ctx, {
  interval = process.env.DSH_AGENT_RUN_CLEANUP_INTERVAL_MS,
  cleanup = cleanupExpiredRunFacts,
  enforcePolicy = null,
  logger = console,
} = {}) {
  let stopped = false;
  let running = false;
  const runOnce = async () => {
    if (stopped || running) return null;
    running = true;
    try {
      const policyCheck = enforcePolicy || (cleanup === cleanupExpiredRunFacts ? enforceRunStoragePolicy : null);
      const policy = policyCheck ? await policyCheck(ctx, { cleanup }) : null;
      const result = await cleanup(ctx);
      if (result.cleaned_runs || result.failed_runs?.length) {
        logger.info?.(
          `[retention] Agent 运行清理完成: cleaned=${result.cleaned_runs || 0} failed=${result.failed_runs?.length || 0}`,
        );
      }
      return { ...result, storage_policy: policy };
    } catch (error) {
      logger.warn?.("[retention] Agent 运行清理失败:", error?.message || error);
      return null;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => { void runOnce(); }, intervalMs(interval));
  timer.unref?.();
  return {
    runOnce,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export default { startAgentRunRetentionScheduler };

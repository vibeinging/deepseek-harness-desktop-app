import { randomUUID } from "node:crypto";

import {
  executeAgentAutomation,
  recordSkippedAutomationOccurrence,
} from "./automation_executor.js";
import { listDueAutomations } from "./automations.js";
import { missedOccurrenceDecision } from "./automation_schedule.js";
import {
  finishAutomationEvent,
  leaseAutomationEvent,
  listPendingAutomationEvents,
  publishAutomationEvent,
} from "./automation_runtime_store.js";

const DEFAULT_INTERVAL_MS = 30_000;

export function createAgentAutomationScheduler({
  query,
  queryOne,
  intervalMs = DEFAULT_INTERVAL_MS,
  execute = executeAgentAutomation,
  recordSkipped = recordSkippedAutomationOccurrence,
  onError = (error) => console.warn("[automation] 本地任务运行失败:", error?.message || error),
} = {}) {
  const ctx = { query, queryOne, userId: "", signal: null };
  const schedulerId = `scheduler:${process.pid}:${randomUUID()}`;
  let timer = null;
  let ticking = false;
  let stopped = false;

  const tick = async ({ now = new Date().toISOString() } = {}) => {
    if (ticking || stopped) return [];
    ticking = true;
    const results = [];
    try {
      const due = await listDueAutomations(ctx, { now, limit: 20 });
      for (const automation of due) {
        const scheduledFor = automation.next_run_at;
        const decision = missedOccurrenceDecision(scheduledFor, now, automation.missed_policy);
        try {
          if (decision.action === "skip") {
            results.push(await recordSkipped(ctx, automation, {
              scheduledFor,
              now,
              reason: `错过排期 ${Math.floor(decision.lateness_ms / 60_000)} 分钟，已按任务设置跳过`,
            }));
          } else {
            results.push(await execute(ctx, automation.id, {
              trigger: "scheduled",
              trustedScheduler: true,
              scheduledFor,
              now,
              triggerContext: {
                scheduled_for: scheduledFor,
                recovered_after_sleep: decision.lateness_ms >= Math.max(intervalMs * 2, 60_000),
                lateness_ms: decision.lateness_ms,
              },
            }));
          }
        } catch (error) {
          onError(error, automation);
          results.push({ automation_id: automation.id, status: "scheduler_error", error: error?.message || String(error) });
        }
      }

      const pendingEvents = await listPendingAutomationEvents(ctx, { now, limit: 20 });
      for (const event of pendingEvents) {
        const leased = await leaseAutomationEvent(ctx, event.id, schedulerId, { now });
        if (!leased) continue;
        try {
          const result = await execute(ctx, leased.automation_id, {
            trigger: "event",
            trustedScheduler: true,
            now,
            triggerContext: {
              event_id: leased.id,
              event_name: leased.event_name,
              event_key: leased.event_key,
              occurred_at: leased.occurred_at,
              payload: leased.payload,
              fingerprint: leased.fingerprint,
            },
          });
          await finishAutomationEvent(ctx, leased.id, { status: "completed" });
          results.push(result);
        } catch (error) {
          const retry = Number(error?.status || 0) === 409;
          await finishAutomationEvent(ctx, leased.id, { status: retry ? "pending" : "failed", error });
          onError(error, leased);
          results.push({ automation_id: leased.automation_id, event_id: leased.id, status: retry ? "event_deferred" : "event_failed", error: error?.message || String(error) });
        }
      }
      return results;
    } finally {
      ticking = false;
    }
  };

  const schedule = () => {
    if (stopped || timer) return;
    timer = setInterval(() => { void tick(); }, Math.max(1_000, Number(intervalMs || DEFAULT_INTERVAL_MS)));
    timer.unref?.();
    setImmediate(() => {
      void publishAutomationEvent(ctx, {
        eventName: "app.started",
        eventKey: randomUUID(),
        payload: { local: true, pid: process.pid },
      }).catch((error) => onError(error));
      void tick();
    });
  };

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { start: schedule, stop, tick, get running() { return Boolean(timer) && !stopped; } };
}

export function startAgentAutomationScheduler(options = {}) {
  const scheduler = createAgentAutomationScheduler(options);
  scheduler.start();
  return scheduler;
}

export default { createAgentAutomationScheduler, startAgentAutomationScheduler };

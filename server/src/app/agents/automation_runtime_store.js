import { createHash, randomUUID } from "node:crypto";

const READY_QUERIES = new WeakMap();

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

export function automationFingerprint(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

export async function ensureAutomationRuntimeStore(ctx) {
  if (!ctx?.query) return;
  if (READY_QUERIES.has(ctx.query)) return READY_QUERIES.get(ctx.query);
  const ready = (async () => {
    await ctx.query(
      `CREATE TABLE IF NOT EXISTS agent_automation_events (
        id TEXT PRIMARY KEY,
        automation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        event_name TEXT NOT NULL,
        event_key TEXT,
        fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        lease_owner TEXT,
        lease_expires_at TEXT,
        occurred_at TEXT NOT NULL,
        processed_at TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(automation_id, fingerprint)
      )`,
    );
    await ctx.query(
      `CREATE TABLE IF NOT EXISTS agent_automation_run_contexts (
        automation_run_id TEXT PRIMARY KEY,
        trigger_type TEXT NOT NULL,
        scheduled_for TEXT,
        event_id TEXT,
        trigger_json TEXT NOT NULL,
        output_fingerprint TEXT,
        change_status TEXT,
        skill_snapshot_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    );
    await ctx.query(
      `CREATE TABLE IF NOT EXISTS agent_automation_state (
        automation_id TEXT NOT NULL,
        state_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (automation_id, state_key)
      )`,
    );
    await ctx.query(
      "CREATE INDEX IF NOT EXISTS idx_agent_automation_events_pending ON agent_automation_events(status, occurred_at)",
    );
    await ctx.query(
      "CREATE INDEX IF NOT EXISTS idx_agent_automation_run_contexts_event ON agent_automation_run_contexts(event_id)",
    );
  })().catch((error) => {
    READY_QUERIES.delete(ctx.query);
    throw error;
  });
  READY_QUERIES.set(ctx.query, ready);
  return ready;
}

function nestedValue(value, path) {
  return String(path || "").split(".").filter(Boolean).reduce((current, segment) => (
    current && typeof current === "object" ? current[segment] : undefined
  ), value);
}

export function automationEventMatches(match = {}, payload = {}) {
  if (!match || typeof match !== "object" || Array.isArray(match)) return true;
  return Object.entries(match).every(([path, expected]) => {
    const actual = nestedValue(payload, path);
    if (Array.isArray(expected)) return expected.some((candidate) => JSON.stringify(candidate) === JSON.stringify(actual));
    return JSON.stringify(expected) === JSON.stringify(actual);
  });
}

function eventSchedule(row) {
  const schedule = parseJson(row?.schedule_json, {});
  return schedule?.type === "event" ? schedule : null;
}

export async function publishAutomationEvent(ctx, {
  projectId = null,
  eventName,
  eventKey = null,
  payload = {},
  occurredAt = new Date().toISOString(),
  ownerUserId = null,
} = {}) {
  await ensureAutomationRuntimeStore(ctx);
  const name = String(eventName || "").trim();
  if (!name) throw new Error("eventName is required");
  const rows = await ctx.query(
    `SELECT * FROM agent_automations
      WHERE deleted_at IS NULL AND status='enabled'
        AND ($1='' OR project_id=$1)
        AND ($2='' OR user_id=$2)
      ORDER BY created_at ASC`,
    [String(projectId || ""), String(ownerUserId || "")],
  );
  const queued = [];
  const ignored = [];
  const occurredMs = new Date(occurredAt).getTime();
  for (const row of rows) {
    const schedule = eventSchedule(row);
    if (!schedule || schedule.event_name !== name || !automationEventMatches(schedule.match, payload)) continue;
    const debounceMs = Math.max(0, Number(schedule.debounce_seconds || 0) * 1_000);
    const bucket = eventKey
      ? String(eventKey)
      : debounceMs > 0
        ? String(Math.floor(occurredMs / debounceMs))
        : randomUUID();
    const fingerprint = automationFingerprint({
      automation_id: row.id,
      event_name: name,
      event_key: eventKey || null,
      payload,
      bucket,
    });
    const id = randomUUID();
    try {
      await ctx.query(
        `INSERT INTO agent_automation_events (
          id, automation_id, project_id, event_name, event_key, fingerprint,
          payload_json, status, occurred_at, created_at, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,now(),now())`,
        [id, row.id, row.project_id, name, eventKey || null, fingerprint, JSON.stringify(payload || {}), occurredAt],
      );
      queued.push({ id, automation_id: row.id, project_id: row.project_id, fingerprint });
    } catch (error) {
      if (/unique|constraint/i.test(String(error?.message || error))) {
        ignored.push({ automation_id: row.id, reason: "duplicate" });
        continue;
      }
      throw error;
    }
  }
  return { event_name: name, queued, ignored };
}

function eventShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    automation_id: row.automation_id,
    project_id: row.project_id,
    event_name: row.event_name,
    event_key: row.event_key || null,
    fingerprint: row.fingerprint,
    payload: parseJson(row.payload_json, {}),
    status: row.status,
    occurred_at: row.occurred_at,
    processed_at: row.processed_at || null,
    error_message: row.error_message || null,
  };
}

export async function listPendingAutomationEvents(ctx, { now = new Date().toISOString(), limit = 20 } = {}) {
  await ensureAutomationRuntimeStore(ctx);
  const rows = await ctx.query(
    `SELECT e.* FROM agent_automation_events e
      JOIN agent_automations a ON a.id=e.automation_id
      WHERE e.status='pending' AND a.deleted_at IS NULL AND a.status='enabled'
        AND (e.lease_expires_at IS NULL OR e.lease_expires_at <= $1)
      ORDER BY e.occurred_at ASC LIMIT $2`,
    [now, Math.max(1, Math.min(100, Number(limit || 20)))],
  );
  return rows.map(eventShape);
}

export async function leaseAutomationEvent(ctx, eventId, owner, {
  now = new Date().toISOString(),
  leaseMs = 10 * 60_000,
} = {}) {
  await ensureAutomationRuntimeStore(ctx);
  const expiresAt = new Date(new Date(now).getTime() + leaseMs).toISOString();
  return eventShape(await ctx.queryOne(
    `UPDATE agent_automation_events SET status='processing', lease_owner=$2,
       lease_expires_at=$3, updated_at=now()
      WHERE id=$1 AND status='pending'
        AND (lease_expires_at IS NULL OR lease_expires_at <= $4)
      RETURNING *`,
    [eventId, owner, expiresAt, now],
  ));
}

export async function finishAutomationEvent(ctx, eventId, {
  status = "completed",
  error = null,
} = {}) {
  await ensureAutomationRuntimeStore(ctx);
  await ctx.query(
    `UPDATE agent_automation_events SET status=$2, processed_at=now(),
       error_message=$3, lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
      WHERE id=$1`,
    [eventId, status, error ? String(error?.message || error).slice(0, 4_000) : null],
  );
}

export async function saveAutomationRunContext(ctx, {
  automationRunId,
  triggerType = "manual",
  scheduledFor = null,
  eventId = null,
  trigger = {},
  skillSnapshot = [],
} = {}) {
  await ensureAutomationRuntimeStore(ctx);
  await ctx.query(
    `INSERT INTO agent_automation_run_contexts (
      automation_run_id, trigger_type, scheduled_for, event_id, trigger_json,
      skill_snapshot_json, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,now(),now())
    ON CONFLICT(automation_run_id) DO UPDATE SET
      trigger_type=excluded.trigger_type, scheduled_for=excluded.scheduled_for,
      event_id=excluded.event_id, trigger_json=excluded.trigger_json,
      skill_snapshot_json=excluded.skill_snapshot_json, updated_at=now()`,
    [automationRunId, triggerType, scheduledFor, eventId, JSON.stringify(trigger || {}), JSON.stringify(skillSnapshot || [])],
  );
}

export async function updateAutomationRunChange(ctx, automationRunId, {
  outputFingerprint = null,
  changeStatus = null,
} = {}) {
  await ensureAutomationRuntimeStore(ctx);
  await ctx.query(
    `UPDATE agent_automation_run_contexts SET output_fingerprint=$2,
       change_status=$3, updated_at=now() WHERE automation_run_id=$1`,
    [automationRunId, outputFingerprint, changeStatus],
  );
}

export async function getAutomationRunContext(ctx, automationRunId) {
  await ensureAutomationRuntimeStore(ctx);
  const row = await ctx.queryOne(
    "SELECT * FROM agent_automation_run_contexts WHERE automation_run_id=$1 LIMIT 1",
    [automationRunId],
  );
  if (!row) return null;
  return {
    trigger_type: row.trigger_type,
    scheduled_for: row.scheduled_for || null,
    event_id: row.event_id || null,
    trigger: parseJson(row.trigger_json, {}),
    output_fingerprint: row.output_fingerprint || null,
    change_status: row.change_status || null,
    skill_snapshot: parseJson(row.skill_snapshot_json, []),
  };
}

export async function readAutomationState(ctx, automationId, key, fallback = null) {
  await ensureAutomationRuntimeStore(ctx);
  const row = await ctx.queryOne(
    "SELECT value_json FROM agent_automation_state WHERE automation_id=$1 AND state_key=$2 LIMIT 1",
    [automationId, key],
  );
  return row ? parseJson(row.value_json, fallback) : fallback;
}

export async function writeAutomationState(ctx, automationId, key, value) {
  await ensureAutomationRuntimeStore(ctx);
  await ctx.query(
    `INSERT INTO agent_automation_state (automation_id, state_key, value_json, updated_at)
      VALUES ($1,$2,$3,now())
      ON CONFLICT(automation_id,state_key) DO UPDATE SET value_json=excluded.value_json, updated_at=now()`,
    [automationId, key, JSON.stringify(value)],
  );
}

export default {
  automationEventMatches,
  automationFingerprint,
  ensureAutomationRuntimeStore,
  finishAutomationEvent,
  getAutomationRunContext,
  leaseAutomationEvent,
  listPendingAutomationEvents,
  publishAutomationEvent,
  readAutomationState,
  saveAutomationRunContext,
  updateAutomationRunChange,
  writeAutomationState,
};

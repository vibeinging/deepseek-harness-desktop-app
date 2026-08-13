import { query, queryOne } from "../../db.js";
import { ApiError } from "../../errors.js";
import { runSync } from "./connections.js";

const DEFAULT_SYNC_MODE = "registered_only";
const DEFAULT_CRON_UTC = "0 18 * * *"; // Daily at 02:00 Beijing time.

let schedulerTimer = null;
let schedulerKickTimer = null;
let schedulerRunning = false;

function nowIso() {
  return new Date().toISOString();
}

function randomId() {
  return crypto.randomUUID();
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  return value === true || value === 1 || value === "1" || value === "true";
}

function normalizeSyncMode(value) {
  return value === "all" ? "all" : DEFAULT_SYNC_MODE;
}

function normalizeCron(value) {
  if (value === undefined || value === null || value === "") return null;
  const cron = String(value).trim();
  if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(cron)) {
    throw new ApiError("cron 表达式需为 5 段: 分 时 日 月 周", 400);
  }
  return cron;
}

function shapeConfig(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    database_connection_id: row.database_connection_id,
    enabled: !!row.enabled,
    skip_cron: !!row.skip_cron,
    schedule_cron: row.schedule_cron || null,
    sync_mode: normalizeSyncMode(row.sync_mode),
    last_run_at: row.last_run_at || null,
    last_status: row.last_status || null,
    last_error: row.last_error || null,
    last_auto_run_at: row.last_auto_run_at || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

async function assertConnection(ctx, pid, cid) {
  const row = await ctx.queryOne(
    `SELECT id FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  );
  if (!row) throw new ApiError("数据库连接不存在", 404);
}

async function getOrCreateConfig(ctx, pid, cid) {
  await assertConnection(ctx, pid, cid);
  let row = await ctx.queryOne(
    `SELECT * FROM metadata_sync_configs
      WHERE project_id=$1 AND database_connection_id=$2 AND deleted_at IS NULL
      LIMIT 1`,
    [pid, cid],
  );
  if (row) return row;

  const id = randomId();
  await ctx.query(
    `INSERT INTO metadata_sync_configs
       (id, project_id, database_connection_id, enabled, skip_cron, schedule_cron, sync_mode, created_at, updated_at)
     VALUES ($1,$2,$3,0,0,NULL,$4,now(),now())`,
    [id, pid, cid, DEFAULT_SYNC_MODE],
  );
  return ctx.queryOne(`SELECT * FROM metadata_sync_configs WHERE id=$1`, [id]);
}

function normalizeTableNames(names) {
  if (!Array.isArray(names)) return null;
  const result = names
    .map((name) => {
      if (!name) return null;
      if (typeof name === "string") return name;
      const tableName = name.table_name || name.name;
      if (!tableName) return null;
      return { schema_name: name.schema_name || "default", table_name: tableName };
    })
    .filter(Boolean);
  return result.length ? result : null;
}

async function registeredTableNames(ctx, cid) {
  const rows = await ctx.query(
    `SELECT schema_name, table_name
       FROM table_metadata
      WHERE database_connection_id=$1 AND deleted_at IS NULL
      ORDER BY schema_name, table_name`,
    [cid],
  );
  return rows.map((row) => ({
    schema_name: row.schema_name || "default",
    table_name: row.table_name,
  }));
}

async function countSyncedMetadata(ctx, cid, explicitTables = null) {
  const rows = await ctx.query(
    `SELECT id, schema_name, table_name
       FROM table_metadata
      WHERE database_connection_id=$1 AND deleted_at IS NULL`,
    [cid],
  );
  const allowed = explicitTables?.length
    ? new Set(
        explicitTables.map((name) => {
          if (typeof name === "string") {
            if (name.includes("::")) return name;
            if (name.includes(".")) {
              const [schemaName, ...tableParts] = name.split(".");
              return `${schemaName || "default"}::${tableParts.join(".")}`;
            }
            return name;
          }
          return `${name.schema_name || "default"}::${name.table_name || name.name}`;
        }),
      )
    : null;
  const tableRows = allowed
    ? rows.filter((row) => allowed.has(row.table_name) || allowed.has(`${row.schema_name || "default"}::${row.table_name}`))
    : rows;
  if (!tableRows.length) return { tables: 0, columns: 0 };
  const tableIds = tableRows.map((row) => row.id);
  const columnRow = await ctx.queryOne(
    `SELECT count(*) AS c
       FROM column_metadata
      WHERE table_id = ANY($1::text[]) AND deleted_at IS NULL`,
    [tableIds],
  );
  return { tables: tableRows.length, columns: Number(columnRow?.c || 0) };
}

async function insertAudit(ctx, values) {
  await ctx.query(
    `INSERT INTO metadata_sync_audits
       (id, project_id, database_connection_id, trigger_source, status,
        tables_synced, columns_synced, duration_ms, error_msg, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())`,
    [
      values.id,
      values.pid,
      values.cid,
      values.trigger_source,
      values.status,
      values.tables_synced ?? null,
      values.columns_synced ?? null,
      values.duration_ms ?? null,
      values.error_msg ?? null,
    ],
  );
}

function auditStatusFromError(error) {
  const message = error?.message || String(error);
  return message ? message.slice(0, 2000) : "同步失败";
}

export async function getSyncConfig(ctx, input) {
  const { pid, cid } = input.params;
  const config = await getOrCreateConfig(ctx, pid, cid);
  const lastAudit = await ctx.queryOne(
    `SELECT id, trigger_source, status, tables_synced, columns_synced, duration_ms, error_msg, created_at
       FROM metadata_sync_audits
      WHERE project_id=$1 AND database_connection_id=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [pid, cid],
  );
  return { data: { ...shapeConfig(config), last_audit: lastAudit || null }, message: "获取同步配置成功" };
}

export async function updateSyncConfig(ctx, input) {
  const { pid, cid } = input.params;
  const existing = await getOrCreateConfig(ctx, pid, cid);
  const body = input.body || {};
  const enabled = boolValue(body.enabled, !!existing.enabled) ? 1 : 0;
  const skipCron = boolValue(body.skip_cron, false) ? 1 : 0;
  const scheduleCron = normalizeCron(body.schedule_cron);
  const syncMode = normalizeSyncMode(body.sync_mode);

  await ctx.query(
    `UPDATE metadata_sync_configs
        SET enabled=$1,
            skip_cron=$2,
            schedule_cron=$3,
            sync_mode=$4,
            updated_at=now()
      WHERE id=$5`,
    [enabled, skipCron, scheduleCron, syncMode, existing.id],
  );
  const config = await ctx.queryOne(`SELECT * FROM metadata_sync_configs WHERE id=$1`, [existing.id]);
  return { data: shapeConfig(config), message: "同步配置已保存" };
}

export async function triggerMetadataSync(ctx, input) {
  const { pid, cid } = input.params;
  const body = input.body || {};
  const startedAt = Date.now();
  const auditId = randomId();
  const triggerSource = body.trigger_source === "cron" ? "cron" : "manual";
  let config = null;

  try {
    config = await getOrCreateConfig(ctx, pid, cid);
    const bodyTableNames = normalizeTableNames(body.table_names || body.tables);
    const requestedMode = normalizeSyncMode(body.sync_mode || config.sync_mode);
    let tableNames = bodyTableNames;

    if (!tableNames && requestedMode === DEFAULT_SYNC_MODE) {
      const registered = await registeredTableNames(ctx, cid);
      tableNames = registered.length ? registered : null;
    }

    const result = await runSync(ctx, pid, cid, "metadata-sync", requestedMode === "all" ? null : tableNames);
    const counts = await countSyncedMetadata(ctx, cid, requestedMode === "all" ? null : tableNames);
    const durationMs = Date.now() - startedAt;
    await insertAudit(ctx, {
      id: auditId,
      pid,
      cid,
      trigger_source: triggerSource,
      status: "ok",
      tables_synced: counts.tables || result.data?.total_tables || 0,
      columns_synced: counts.columns,
      duration_ms: durationMs,
    });
    await ctx.query(
      `UPDATE metadata_sync_configs
          SET last_run_at=now(), last_status='ok', last_error=NULL, updated_at=now()
        WHERE id=$1`,
      [config.id],
    );
    return {
      data: {
        task_id: auditId,
        status: "ok",
        trigger_source: triggerSource,
        duration_ms: durationMs,
        tables_synced: counts.tables || result.data?.total_tables || 0,
        columns_synced: counts.columns,
        added_tables: result.data?.added_tables || 0,
        updated_tables: result.data?.updated_tables || 0,
        removed_tables: result.data?.removed_tables || 0,
      },
      message: "元数据同步完成",
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const errorMsg = auditStatusFromError(error);
    try {
      await insertAudit(ctx, {
        id: auditId,
        pid,
        cid,
        trigger_source: triggerSource,
        status: "error",
        duration_ms: durationMs,
        error_msg: errorMsg,
      });
      if (config?.id) {
        await ctx.query(
          `UPDATE metadata_sync_configs
              SET last_run_at=now(), last_status='error', last_error=$1, updated_at=now()
            WHERE id=$2`,
          [errorMsg, config.id],
        );
      }
    } catch (auditError) {
      console.warn("[metadata-sync] 写入同步记录失败:", auditError?.message || auditError);
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(errorMsg, 500);
  }
}

export async function listSyncAudits(ctx, input) {
  const { pid, cid } = input.params;
  await assertConnection(ctx, pid, cid);
  const limit = Math.min(Math.max(Number(input.query?.limit || 10), 1), 50);
  const offset = Math.max(Number(input.query?.offset || 0), 0);
  const status = input.query?.status;
  const params = [pid, cid];
  let where = `project_id=$1 AND database_connection_id=$2 AND deleted_at IS NULL`;
  if (status && status !== "all") {
    params.push(status);
    where += ` AND status=$${params.length}`;
  }
  params.push(limit + 1, offset);
  const rows = await ctx.query(
    `SELECT id, trigger_source, status, tables_synced, columns_synced, duration_ms, error_msg, created_at
       FROM metadata_sync_audits
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return {
    data: {
      items: rows.slice(0, limit),
      has_more: rows.length > limit,
    },
    message: "获取同步记录成功",
  };
}

function matchCronField(value, field, min, max) {
  if (field === "*") return true;
  return String(field)
    .split(",")
    .some((part) => {
      const [rangePart, stepPart] = part.split("/");
      const step = stepPart ? Number(stepPart) : 1;
      if (!Number.isFinite(step) || step <= 0) return false;
      if (rangePart === "*") return (value - min) % step === 0;
      if (rangePart.includes("-")) {
        const [start, end] = rangePart.split("-").map(Number);
        return Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end && (value - start) % step === 0;
      }
      const exact = Number(rangePart);
      return Number.isFinite(exact) && value === exact;
    });
}

function cronDue(cron, date) {
  const [minute, hour, day, month, weekday] = String(cron || DEFAULT_CRON_UTC).trim().split(/\s+/);
  return (
    matchCronField(date.getUTCMinutes(), minute, 0, 59) &&
    matchCronField(date.getUTCHours(), hour, 0, 23) &&
    matchCronField(date.getUTCDate(), day, 1, 31) &&
    matchCronField(date.getUTCMonth() + 1, month, 1, 12) &&
    matchCronField(date.getUTCDay(), weekday, 0, 6)
  );
}

function minuteBucket(date) {
  return date.toISOString().slice(0, 16);
}

export function startMetadataSyncScheduler() {
  if (schedulerTimer) return;
  const ctx = { query, queryOne, userId: "system" };
  const tick = async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    const now = new Date();
    const bucket = minuteBucket(now);
    try {
      const configs = await query(
        `SELECT *
           FROM metadata_sync_configs
          WHERE enabled=1 AND skip_cron=0 AND deleted_at IS NULL`,
      );
      for (const config of configs) {
        const lastBucket = config.last_auto_run_at ? String(config.last_auto_run_at).slice(0, 16) : null;
        if (lastBucket === bucket || !cronDue(config.schedule_cron || DEFAULT_CRON_UTC, now)) continue;
        await query(`UPDATE metadata_sync_configs SET last_auto_run_at=$1, updated_at=now() WHERE id=$2`, [nowIso(), config.id]);
        triggerMetadataSync(ctx, {
          params: { pid: config.project_id, cid: config.database_connection_id },
          body: { trigger_source: "cron", sync_mode: config.sync_mode || DEFAULT_SYNC_MODE },
        }).catch((error) => {
          console.warn(`[metadata-sync] 自动同步失败(${config.database_connection_id}):`, error?.message || error);
        });
      }
    } catch (error) {
      console.warn("[metadata-sync] 调度检查失败:", error?.message || error);
    } finally {
      schedulerRunning = false;
    }
  };
  schedulerTimer = setInterval(tick, 60_000);
  schedulerKickTimer = setTimeout(() => {
    schedulerKickTimer = null;
    void tick();
  }, 5_000);
}

export function stopMetadataSyncScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  if (schedulerKickTimer) clearTimeout(schedulerKickTimer);
  schedulerTimer = null;
  schedulerKickTimer = null;
}

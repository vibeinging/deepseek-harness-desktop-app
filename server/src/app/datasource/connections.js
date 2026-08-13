// L1 use-case layer for database connections and schema introspection, ported from routes/datasource_crud.js with line-by-line alignment.
// Signature remains async fn(ctx, input) -> { data, message } | throw ApiError; do not touch req/res directly.
//
// Covers: databases CRUD / meta.test-connection / meta.schemas.discover / sync-schema /
//        sync-tables / source-tables / upload-db-file.
//
// Note: app/datasource is one layer deeper than routes/; engine/db is under ../../.
import { join, extname, basename } from "node:path";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { PluginRegistry } from "../../engine/datasources/plugins/index.js";
import { enrichConnection } from "../../engine/semantic/enrich.js";
import { sqlite } from "../../db.js";
import { ApiError } from "../../errors.js";
import { dataPath } from "../../config/paths.js";
import { requireProjectDatabaseConnection } from "./project_database_access.js";

// ─────────────────────────────────────────────
// Plugin config shaping (connection metadata subset).
// ─────────────────────────────────────────────
const LOCAL_DATABASE_TYPES = new Set(["sqlite", "sqlite3", "duckdb"]);
const REDACTED_VALUE = "********";
const FORBIDDEN_CONFIG_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function configObject(value, { strict = false } = {}) {
  if (value == null || value === "") return {};
  let parsed = value;
  if (typeof value === "string") {
    try { parsed = JSON.parse(value); }
    catch {
      if (strict) throw new ApiError("extra_config 必须是有效的 JSON 对象", 400);
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (strict) throw new ApiError("extra_config 必须是 JSON 对象", 400);
    return {};
  }
  return parsed;
}

function mergeConfigValue(stored, patch) {
  if (patch === undefined || patch === REDACTED_VALUE) return stored;
  if (Array.isArray(patch)) {
    const base = Array.isArray(stored) ? stored : [];
    return patch.map((item, index) => mergeConfigValue(base[index], item));
  }
  if (patch && typeof patch === "object") {
    const result = stored && typeof stored === "object" && !Array.isArray(stored) ? { ...stored } : {};
    for (const [key, value] of Object.entries(patch)) {
      if (FORBIDDEN_CONFIG_KEYS.has(key)) continue;
      result[key] = mergeConfigValue(result[key], value);
    }
    return result;
  }
  return patch;
}

function mergeExtraConfig(stored, patch) {
  const base = configObject(stored);
  if (patch === undefined) return base;
  return mergeConfigValue(base, configObject(patch, { strict: true }));
}

function isLocalDatabaseType(value) {
  return LOCAL_DATABASE_TYPES.has(String(value || "").trim().toLowerCase());
}

function validateConnectionFields({ db_type, host, port, username, database }) {
  if (!db_type || !String(database || "").trim()) throw new ApiError("db_type, database 为必填项", 400);
  if (isLocalDatabaseType(db_type)) return;
  if (!String(host || "").trim()) throw new ApiError("host 为必填项", 400);
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) throw new ApiError("port 必须是 1-65535 的整数", 400);
  if (!String(username || "").trim()) throw new ApiError("username 为必填项", 400);
}

function sameConnectionIdentity(request, stored) {
  const normalizers = {
    db_type: (value) => String(value || "").trim().toLowerCase(),
    host: (value) => String(value || "").trim().toLowerCase(),
    port: (value) => Number(value),
    username: (value) => String(value || "").trim(),
    database: (value) => String(value || "").trim(),
  };
  return Object.entries(normalizers).every(([key, normalize]) => normalize(request[key]) === normalize(stored[key]));
}

function publicConnectionTestResult(value, secrets = []) {
  if (typeof value === "string") {
    return secrets.reduce((text, secret) => secret ? text.split(secret).join(REDACTED_VALUE) : text, value);
  }
  if (Array.isArray(value)) return value.map((item) => publicConnectionTestResult(item, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/password|secret|token|credential|authorization|api[_-]?key/i.test(key))
    .map(([key, item]) => [key, publicConnectionTestResult(item, secrets)]));
}

const pluginConfig = (o) => {
  const extraConfig = configObject(o.extra_config);
  return {
    db_type: o.db_type, host: o.host, port: o.port,
    username: o.username, password: o.password, database: o.database,
    extra_config: extraConfig,
    oracle_conn_type: extraConfig.oracle_conn_type,
  };
};

// ════════════════════════════════════════════
// Database connection CRUD.
// ════════════════════════════════════════════

// POST /api/projects/:pid/databases — create database connection
export async function createDatabase(ctx, input) {
  const { pid } = input.params;
  const {
    name, db_type, host, port, username, password, database,
    schema_config, extra_config, description,
  } = input.body || {};

  if (!name || !db_type || !database) {
    throw new ApiError("name, db_type, database 为必填项", 400);
  }
  validateConnectionFields({ db_type, host, port, username, database });
  const storedExtraConfig = extra_config === undefined ? null : mergeExtraConfig(null, extra_config);

  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO database_connections
       (id, project_id, created_by, name, db_type, is_virtual,
        host, port, username, password, database, description,
        schema_config, extra_config, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,false,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())`,
    [id, pid, ctx.userId, name, db_type,
     host ?? null, port ?? null, username ?? null, password ?? null,
     database, description ?? null,
     schema_config ?? null, storedExtraConfig],
  );

  const bound = await ctx.queryOne(
    `SELECT id FROM business_data_sources
      WHERE project_id=$1 AND source_type='database_connection' AND source_id=$2 AND deleted_at IS NULL`,
    [pid, id],
  );
  if (!bound) {
    await ctx.query(
      `INSERT INTO business_data_sources (id, project_id, source_type, source_id, created_at, updated_at)
       VALUES ($1, $2, 'database_connection', $3, now(), now())`,
      [crypto.randomUUID(), pid, id],
    );
  }

  const conn = await ctx.queryOne(
    `SELECT id, project_id, name, db_type, is_virtual, host, port, username,
            database AS db_name, description, schema_config, extra_config,
            business_rules, created_at, updated_at
       FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [id, pid],
  );
  return { data: conn, message: "创建数据库连接成功" };
}

// PUT /api/projects/:pid/databases/:cid — update database connection
export async function updateDatabase(ctx, input) {
  const { pid, cid } = input.params;
  const {
    name, host, port, username, password, database,
    description, schema_config, extra_config, business_rules,
  } = input.body || {};

  const existing = await ctx.queryOne(
    `SELECT id, db_type, host, port, username, database, extra_config
       FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  );
  if (!existing) throw new ApiError("数据库连接不存在", 404);

  validateConnectionFields({
    db_type: existing.db_type,
    host: host === undefined ? existing.host : host,
    port: port === undefined ? existing.port : port,
    username: username === undefined ? existing.username : username,
    database: database === undefined ? existing.database : database,
  });

  // Build dynamic SET clause.
  const sets = ["updated_at=now()"];
  const vals = [];
  let i = 1;
  const push = (col, val) => { sets.push(`${col}=$${i++}`); vals.push(val); };

  if (name !== undefined)           push("name", name);
  if (host !== undefined)           push("host", host);
  if (port !== undefined)           push("port", port);
  if (username !== undefined)       push("username", username);
  if (password !== undefined && password !== "") push("password", password);
  if (database !== undefined)       push("database", database);
  if (description !== undefined)    push("description", description);
  if (schema_config !== undefined)  push("schema_config", schema_config);
  if (extra_config !== undefined)   push("extra_config", mergeExtraConfig(existing.extra_config, extra_config));
  if (business_rules !== undefined) push("business_rules", business_rules);

  vals.push(cid, pid);
  await ctx.query(
    `UPDATE database_connections SET ${sets.join(",")} WHERE id=$${i} AND project_id=$${i + 1}`,
    vals,
  );

  const conn = await ctx.queryOne(
    `SELECT id, project_id, name, db_type, is_virtual, host, port, username,
            database AS db_name, description, schema_config, extra_config,
            business_rules, created_at, updated_at
       FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  );
  return { data: conn, message: "更新数据库连接成功" };
}

// DELETE /api/projects/:pid/databases/:cid — soft delete database connection
export async function deleteDatabase(ctx, input) {
  const { pid, cid } = input.params;
  const existing = await ctx.queryOne(
    `SELECT id FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  );
  if (!existing) throw new ApiError("数据库连接不存在", 404);
  await ctx.query(
    `UPDATE database_connections SET deleted_at=now() WHERE id=$1 AND project_id=$2`,
    [cid, pid],
  );
  return { data: null, message: "删除数据库连接成功" };
}

// ════════════════════════════════════════════
// External datasource connection and schema introspection (plugin adapters: PostgreSQL / MySQL …)
// ════════════════════════════════════════════

// POST .../meta/test-connection — test external database connection
export async function testConnection(ctx, input) {
  const body = input.body || {};
  const connectionId = String(body.connection_id || "").trim();
  let stored = null;
  if (connectionId) {
    stored = await ctx.queryOne(
      `SELECT id, db_type, host, port, username, password, database, extra_config
         FROM database_connections
        WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
      [connectionId, input.params.pid],
    );
    if (!stored) throw new ApiError("数据库连接不存在", 404);
  }
  const resolveField = (key) => body[key] === undefined ? stored?.[key] : body[key];
  const resolved = {
    db_type: resolveField("db_type"),
    host: resolveField("host"),
    port: resolveField("port"),
    username: resolveField("username"),
    password: body.password,
    database: resolveField("database"),
    extra_config: mergeExtraConfig(stored?.extra_config, body.extra_config),
  };
  validateConnectionFields(resolved);
  // UI 掩码 "********" 表示"未改"（与 mergeConfigValue 一致），试连时回退到已存密码。
  if (resolved.password === REDACTED_VALUE && stored) {
    resolved.password = stored.password;
  }
  if ((resolved.password == null || resolved.password === "") && stored) {
    if (!sameConnectionIdentity(resolved, stored)) {
      return { data: { success: false, message: "连接地址、类型、用户名或数据库已修改，请重新输入密码" }, message: "测试连接" };
    }
    resolved.password = stored.password;
  }
  const { db_type } = resolved;
  const plugin = PluginRegistry.get(db_type);
  if (!plugin) {
    return { data: { success: false, message: `暂不支持的数据库类型: ${db_type}(已支持: ${PluginRegistry.allTypes().join(", ")})` }, message: "测试连接" };
  }
  const cfg = pluginConfig(resolved);
  const result = await plugin.testConnection(cfg);
  // For multi-schema sources, include optional schema list on success for frontend selection.
  if (result.success && plugin.metadata.multiple_schema) {
    try { result.schemas = await plugin.getSchemas(cfg); } catch { /* best effort */ }
  }
  return { data: publicConnectionTestResult(result, [resolved.password]), message: "测试连接" };
}

// POST .../meta/schemas/discover — discover external schema list
export async function discoverSchemas(ctx, input) {
  const { db_type, host, port, username, password, database } = input.body || {};
  const plugin = PluginRegistry.get(db_type);
  const supports = !!plugin?.metadata.multiple_schema;
  if (!plugin) {
    return { data: { schemas: [], default_schema: "default", supports_multiple_schemas: false, warnings: [], errors: [`暂不支持的数据库类型: ${db_type}`] }, message: "发现 Schema" };
  }
  try {
    const schemas = await plugin.getSchemas(pluginConfig({ db_type, host, port, username, password, database }));
    const default_schema = supports ? (schemas.includes("public") ? "public" : schemas[0] || null) : "default";
    return { data: { schemas, default_schema, supports_multiple_schemas: supports, warnings: [], errors: [] }, message: "发现 Schema 成功" };
  } catch (e) {
    return { data: { schemas: [], default_schema: null, supports_multiple_schemas: supports, warnings: [], errors: [String(e?.message || e)] }, message: "发现 Schema" };
  }
}

// ── Sync schema into table_metadata / column_metadata (PRAGMA-driven introspection, tolerant to schema differences)──
// Note: the translated query() does not support PRAGMA (returns empty), so schema scanning uses raw sqlite directly.
const _colCache = {};
function tableCols(tbl) {
  if (!_colCache[tbl]) {
    _colCache[tbl] = new Set(sqlite.prepare(`PRAGMA table_info(${tbl})`).all().map((r) => r.name));
  }
  return _colCache[tbl];
}

async function syncColumns(ctx, tableId, columns, cmCols) {
  const existing = await ctx.query(
    `SELECT id, column_name FROM column_metadata WHERE table_id=$1` + (cmCols.has("deleted_at") ? " AND deleted_at IS NULL" : ""),
    [tableId],
  );
  const byName = new Map(existing.map((c) => [c.column_name, c.id]));
  const incoming = new Set();
  for (const col of columns) {
    incoming.add(col.column_name);
    const structural = {
      data_type: col.data_type, is_nullable: !!col.is_nullable, default_value: col.default_value ?? null,
      is_primary_key: !!col.is_primary_key, is_foreign_key: !!col.is_foreign_key,
      is_unique: !!col.is_unique, is_indexed: !!col.is_indexed,
      max_length: col.max_length ?? null, numeric_precision: col.numeric_precision ?? null, numeric_scale: col.numeric_scale ?? null,
    };
    const colId = byName.get(col.column_name);
    if (colId) {
      // Existing columns: only update structural fields; keep user-edited description / is_high_recall / example_values.
      const sets = [], vals = []; let i = 1;
      for (const [k, v] of Object.entries(structural)) if (cmCols.has(k)) { sets.push(`${k}=$${i++}`); vals.push(v); }
      if (cmCols.has("updated_at")) sets.push("updated_at=now()");
      if (sets.length) { vals.push(colId); await ctx.query(`UPDATE column_metadata SET ${sets.join(",")} WHERE id=$${i}`, vals); }
    } else {
      const cols = ["id", "table_id", "column_name"], vals = [crypto.randomUUID(), tableId, col.column_name];
      for (const [k, v] of Object.entries(structural)) if (cmCols.has(k)) { cols.push(k); vals.push(v); }
      if (cmCols.has("description")) { cols.push("description"); vals.push(col.description || ""); }
      const ph = vals.map((_, k) => `$${k + 1}`);
      if (cmCols.has("created_at")) { cols.push("created_at"); ph.push("now()"); }
      if (cmCols.has("updated_at")) { cols.push("updated_at"); ph.push("now()"); }
      await ctx.query(`INSERT INTO column_metadata (${cols.join(",")}) VALUES (${ph.join(",")})`, vals);
    }
  }
  if (cmCols.has("deleted_at")) {
    for (const [name, id] of byName) if (!incoming.has(name)) await ctx.query(`UPDATE column_metadata SET deleted_at=now() WHERE id=$1`, [id]);
  }
}

async function upsertSchema(ctx, cid, tables, onlyTableNames) {
  const tmCols = await tableCols("table_metadata");
  const cmCols = await tableCols("column_metadata");
  const filter = onlyTableNames && onlyTableNames.length
    ? new Set(
        onlyTableNames
          .map((name) => {
            if (!name) return null;
            if (typeof name === "string") {
              if (name.includes("::")) return name;
              if (name.includes(".")) {
                const [schemaName, ...tableParts] = name.split(".");
                return `${schemaName || "default"}::${tableParts.join(".")}`;
              }
              return name;
            }
            const tableName = name.table_name || name.name;
            if (!tableName) return null;
            return `${name.schema_name || "default"}::${tableName}`;
          })
          .filter(Boolean),
      )
    : null;
  const incoming = filter
    ? tables.filter((t) => filter.has(t.table_name) || filter.has(`${t.schema_name || "default"}::${t.table_name}`))
    : tables;

  const existingRows = await ctx.query(
    `SELECT id, schema_name, table_name FROM table_metadata WHERE database_connection_id=$1 AND deleted_at IS NULL`,
    [cid],
  );
  const existingByKey = new Map(existingRows.map((t) => [`${t.schema_name}::${t.table_name}`, t.id]));
  const incomingKeys = new Set();
  let added = 0, updated = 0;

  for (const tbl of incoming) {
    const schemaName = tbl.schema_name || "default";
    const key = `${schemaName}::${tbl.table_name}`;
    incomingKeys.add(key);
    const fields = { table_type: tbl.table_type || "TABLE", description: tbl.description || "", is_view: !!tbl.is_view, row_count: tbl.row_count ?? null };
    let tableId = existingByKey.get(key);
    if (tableId) {
      const sets = [], vals = []; let i = 1;
      for (const [k, v] of Object.entries(fields)) if (tmCols.has(k)) { sets.push(`${k}=$${i++}`); vals.push(v); }
      if (tmCols.has("updated_at")) sets.push("updated_at=now()");
      if (sets.length) { vals.push(tableId); await ctx.query(`UPDATE table_metadata SET ${sets.join(",")} WHERE id=$${i}`, vals); }
      updated++;
    } else {
      tableId = crypto.randomUUID();
      const cols = ["id", "database_connection_id", "schema_name", "table_name"], vals = [tableId, cid, schemaName, tbl.table_name];
      for (const [k, v] of Object.entries(fields)) if (tmCols.has(k)) { cols.push(k); vals.push(v); }
      const ph = vals.map((_, k) => `$${k + 1}`);
      if (tmCols.has("created_at")) { cols.push("created_at"); ph.push("now()"); }
      if (tmCols.has("updated_at")) { cols.push("updated_at"); ph.push("now()"); }
      await ctx.query(`INSERT INTO table_metadata (${cols.join(",")}) VALUES (${ph.join(",")})`, vals);
      added++;
    }
    await syncColumns(ctx, tableId, tbl.columns || [], cmCols);
  }

  // On full sync without filter, soft-delete tables that are missing from current scan result.
  let removed = 0;
  if (!filter) {
    for (const [key, id] of existingByKey) {
      if (!incomingKeys.has(key)) { await ctx.query(`UPDATE table_metadata SET deleted_at=now() WHERE id=$1`, [id]); removed++; }
    }
  }
  return { added_tables: added, updated_tables: updated, removed_tables: removed, total_tables: incoming.length };
}

// Read connection (including password) -> getSchemaInfo -> persist metadata.
export async function runSync(ctx, pid, cid, syncType, onlyTableNames) {
  const conn = await ctx.queryOne(
    `SELECT id, db_type, host, port, username, password, database, schema_config
       FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  );
  if (!conn) throw new ApiError("数据库连接不存在", 404);
  const plugin = PluginRegistry.get(conn.db_type);
  if (!plugin) throw new ApiError(`暂不支持的数据库类型: ${conn.db_type}`, 400);

  let selectedSchemas;
  if (conn.schema_config) {
    try {
      const sc = typeof conn.schema_config === "string" ? JSON.parse(conn.schema_config) : conn.schema_config;
      selectedSchemas = sc?.selected_schemas || sc?.available_schemas;
    } catch { /* ignore */ }
  }

  const info = await plugin.getSchemaInfo(
    { db_type: conn.db_type, host: conn.host, port: conn.port, username: conn.username, password: conn.password, database: conn.database },
    { selectedSchemas: Array.isArray(selectedSchemas) ? selectedSchemas : undefined },
  );
  if (info.error) throw new ApiError("Schema 内省失败: " + info.error, 500);

  const counts = await upsertSchema(ctx, cid, info.tables || [], onlyTableNames);
  // Asynchronous background enrichment does not block response: samples -> dedupe/enums -> column descriptions -> table descriptions -> vectors (shared orchestration with structured import).
  // Before enrichment completes, NL2SQL stays usable with no descriptions/examples; vector recall falls back to keyword search.
  // DB connection sync currently only runs sampling + vectors (descriptions:false); LLM descriptions run in explicit generate-columns-descriptions.
  // That call includes knowledge.md extra_notes and avoids duplicate concurrent LLM tasks.
  // Return immediately and continue in background; queueMicrotask preserves "start now, process later" semantics.
  queueMicrotask(() => {
    enrichConnection(cid, { projectId: pid, descriptions: false }).catch((e) => {
      console.warn(`[schema enrich] 连接 ${cid} 富化失败: ${e?.message ?? e}`);
    });
  });
  return { data: { ...counts, sync_type: syncType, message: "同步完成" }, message: "同步 Schema" };
}

// POST .../:cid/sync-schema — run full schema sync
export async function syncSchema(ctx, input) {
  return runSync(ctx, input.params.pid, input.params.cid, "schema", null);
}

// POST .../:cid/sync-tables — sync selected tables (optional body.table_names)
export async function syncTables(ctx, input) {
  const names = input.body?.table_names || input.body?.tables;
  return runSync(ctx, input.params.pid, input.params.cid, "tables", Array.isArray(names) ? names : null);
}

// GET /api/projects/:pid/databases/:cid/source-tables — list syncable tables from cache
export async function listSourceTables(ctx, input) {
  await requireProjectDatabaseConnection(ctx, input.params.pid, input.params.cid);
  const rows = await ctx.query(
    `SELECT id, database_connection_id, schema_name, table_name, table_type,
            description, is_view, row_count, created_at, updated_at
       FROM table_metadata WHERE database_connection_id=$1 AND deleted_at IS NULL
      ORDER BY schema_name, table_name`,
    [input.params.cid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取可同步表列表成功" };
}

// ════════════════════════════════════════════
// DB import: upload DB file (read local path directly; base64 fallback writes to disk; no multer).
// ════════════════════════════════════════════

// POST .../databases/upload-db-file — register local SQLite/DuckDB file for connection creation.
// Desktop convention (aligned with structured/unstructured): file is on local disk, backend reads local path directly without copy/upload.
// SQLite/DuckDB plugin opens with config.database=<local path> in place.
//   Main mode: body { file_path | path } -> validate extension + existence -> { path, filename, file_size }
//   Fallback: body { filename, content_base64 } -> write to ~/.dsh/uploads/<pid>/ -> { path }
export async function uploadDbFile(ctx, input) {
  const { pid } = input.params;
  const { filename, content_base64, content, file_path, path: bodyPath } = input.body || {};
  const ALLOWED = new Set([".db", ".sqlite", ".sqlite3", ".duckdb"]);
  try {
    // Main mode: direct local-path read (desktop native picker / eval-provided absolute path).
    const localPath = file_path || bodyPath;
    if (localPath) {
      const abs = String(localPath);
      const ext = extname(abs).toLowerCase();
      if (!ALLOWED.has(ext)) throw new ApiError(`不支持的文件格式: ${ext},支持: ${[...ALLOWED].join(", ")}`, 400);
      if (!existsSync(abs)) throw new ApiError(`文件不存在: ${abs}`, 400);
      return {
        data: {
          path: abs, filename: basename(abs), original_filename: basename(abs),
          file_size: statSync(abs).size,
        },
        message: "文件就绪",
      };
    }
    // Fallback: write base64 payload to disk.
    const b64 = content_base64 || content;
    if (filename && b64) {
      const ext = extname(filename).toLowerCase();
      if (!ALLOWED.has(ext)) throw new ApiError(`不支持的文件格式: ${ext},支持: ${[...ALLOWED].join(", ")}`, 400);
      const dir = dataPath("uploads", String(pid));
      mkdirSync(dir, { recursive: true });
      const safe = String(filename).replace(/[^A-Za-z0-9._一-龥-]/g, "_");
      const path = join(dir, safe);
      writeFileSync(path, Buffer.from(b64, "base64"));
      return { data: { path, filename: safe, original_filename: filename, file_size: statSync(path).size }, message: "上传成功" };
    }
    throw new ApiError("需提供 file_path(本地绝对路径)或 filename+content_base64", 400);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError("上传失败: " + (e?.message || String(e)), 500);
  }
}

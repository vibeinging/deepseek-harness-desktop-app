/**
 * 本地 SQLite 数据库(桌面端:下载即用,内置库,无远程依赖)。
 *
 * 设计:对外保持与原 PG 版完全一致的接口(query/queryOne 返回 rows / row|null),
 * 内部用 better-sqlite3(原生同步,Electron 友好),并在 query 时做 **PG → SQLite 方言翻译**,
 * 使迁移过来的 65 个引擎文件 + 路由所写的 PG 方言 SQL 一个字都不用改:
 *   - `$1,$2…` 占位符 → 位置 `?`(数组参数自动展开)
 *   - `col::text = ANY($n::text[])` / `ANY($n)` → `col IN (?,?,…)`(空数组→永假)
 *   - `::text / ::jsonb / ::uuid …` 类型转换 → 剥除(SQLite 比较不需要)
 *   - `ILIKE` → `LIKE`(SQLite LIKE 对 ASCII 本就大小写不敏感)
 *   - `now()` / `gen_random_uuid()` → 注册为 SQLite 自定义函数(SQL 文本不动)
 *   - `->>` / `->` JSON 取值 → SQLite 3.38+ 原生兼容
 *   - `RETURNING` → SQLite 3.35+ 原生支持
 *
 * 库文件路径:env DB_SQLITE_PATH,默认 ~/.dsh/local.db。
 */
import Database from "better-sqlite3"; // 原生同步驱动,Electron 友好(prebuilds + loadExtension);替代 node:sqlite(实验内置,Electron 捆的 Node 未必有)
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { platform, arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataPath } from "./config/paths.js";
import { explicitLegacyModelCapabilities } from "./engine/agent_kernel/legacy_model_capability_migration.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_SQLITE_PATH || dataPath("local.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
// 数据库包含本地项目与会话数据，收紧文件权限到仅当前用户可读写。
try {
  chmodSync(DB_PATH, 0o600);
} catch {
  /* 权限收紧失败不阻塞（Windows 无 POSIX 权限语义） */
}
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = OFF;"); // 迁移数据可能跨表先后插入,关闭外键约束更稳

// ── schema bootstrap:开机幂等自建表(下载即用,脱离远程 Vastbase)──
// 内置 DDL(db/schema.sql)。空库自建、已有库无副作用。
// 重新生成 DDL:node scripts/gen_schema.mjs(从一份完整 local.db 导出)。
(function bootstrapSchema() {
  try {
    const schemaPath = process.env.DB_SCHEMA_PATH || join(__dir, "..", "db", "schema.sql");
    if (!existsSync(schemaPath)) {
      console.warn(`[db] 内置 schema.sql 不存在(${schemaPath}),跳过自建表(假定库已就绪)`);
      return;
    }
    db.exec(readFileSync(schemaPath, "utf8"));
    const n = db.prepare("SELECT count(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().c;
    console.info(`[db] ✓ schema bootstrap:${n} 张表就绪`);
  } catch (e) {
    console.error(`[db] schema bootstrap 失败: ${e?.message ?? e}`);
  }
})();

// Normalize old data-preparation status names so callers cannot mistake a
// completed background job for a separate access gate.
(function migrateDataPreparationRunStatuses() {
  try {
    db.exec(`UPDATE project_data_preparation_revisions SET status='running' WHERE status='preparing'`);
    db.exec(`UPDATE project_data_preparation_revisions SET status='completed' WHERE status='ready'`);
  } catch (e) {
    console.error(`[db] 数据准备任务状态迁移失败: ${e?.message ?? e}`);
  }
})();

db.exec(`CREATE TABLE IF NOT EXISTS app_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
)`);

db.exec(`CREATE TABLE IF NOT EXISTS project_agent_settings (
  project_id TEXT PRIMARY KEY,
  reasoning_effort TEXT NOT NULL DEFAULT 'medium',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

// User-editable instructions apply to every local conversation. They
// are separate from built-in safety instructions and project instructions.
db.exec(`CREATE TABLE IF NOT EXISTS app_user_settings (
  user_id TEXT PRIMARY KEY,
  instructions TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

// Source folders are device-local project context. They are references only:
// removing a row must never delete the user's files on disk.
db.exec(`CREATE TABLE IF NOT EXISTS project_source_folders (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  local_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  access_mode TEXT NOT NULL DEFAULT 'read',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT,
  UNIQUE(project_id, local_path)
)`);

// Git worktrees created by dsh for isolated agent work. Each worktree is
// tied to a project and source folder (the write target it was branched from).
db.exec(`CREATE TABLE IF NOT EXISTS project_worktrees (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_folder_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  base_commit TEXT,
  active INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE(project_id, path)
)`);

// Reversible workspace mutations are recorded separately from chat messages so
// retries stay idempotent and a stale diff can never be applied twice.
db.exec(`CREATE TABLE IF NOT EXISTS workspace_action_records (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  target_item_id TEXT,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL,
  before_diff_hash TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`);

function migrationApplied(id) {
  return !!db.prepare(`SELECT 1 FROM app_schema_migrations WHERE id=?`).get(id);
}

function markMigrationApplied(id) {
  db.prepare(`INSERT OR IGNORE INTO app_schema_migrations(id, applied_at) VALUES(?, ?)`).run(id, new Date().toISOString());
}

function backupDatabaseBeforeMigration(id) {
  if (DB_PATH === ":memory:" || !existsSync(DB_PATH)) return null;
  const safeId = String(id).replace(/[^a-zA-Z0-9._-]+/g, "-");
  const backupPath = `${DB_PATH}.backup-${safeId}`;
  if (existsSync(backupPath)) return backupPath;
  db.pragma("wal_checkpoint(TRUNCATE)");
  copyFileSync(DB_PATH, backupPath);
  console.info(`[db] 迁移前备份已创建: ${backupPath}`);
  return backupPath;
}

// A project may read several local roots, but native Codex execution must have
// one unambiguous write target. Existing projects keep their previous primary
// folder by promoting the first active row once during migration.
(function migrateProjectSourceFolderAccessMode() {
  const migrationId = "2026-08-project-source-folder-access-v1";
  const columns = new Set(
    db.prepare(`PRAGMA table_info("project_source_folders")`).all().map((column) => column.name),
  );
  if (!columns.has("access_mode")) {
    db.exec(`ALTER TABLE "project_source_folders" ADD COLUMN "access_mode" TEXT NOT NULL DEFAULT 'read'`);
  }
  if (!migrationApplied(migrationId)) {
    db.exec(`
      UPDATE project_source_folders
         SET access_mode='write'
       WHERE deleted_at IS NULL
         AND id IN (
           SELECT first_folder.id
             FROM project_source_folders first_folder
            WHERE first_folder.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM project_source_folders earlier
                 WHERE earlier.project_id=first_folder.project_id
                   AND earlier.deleted_at IS NULL
                   AND (
                     earlier.sort_order < first_folder.sort_order
                     OR (earlier.sort_order=first_folder.sort_order AND earlier.created_at < first_folder.created_at)
                     OR (earlier.sort_order=first_folder.sort_order AND earlier.created_at=first_folder.created_at AND earlier.id < first_folder.id)
                   )
              )
         )
    `);
    markMigrationApplied(migrationId);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_source_folders_write_target
    ON project_source_folders(project_id)
    WHERE deleted_at IS NULL AND access_mode='write'`);
})();

(function removeLegacyPluginStorage() {
  const migrationId = "2026-08-remove-legacy-plugin-storage-v1";
  if (migrationApplied(migrationId)) return;
  const migrate = db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS project_plugin_mounts`);
    db.exec(`DROP TABLE IF EXISTS plugin_releases`);
    db.exec(`DROP TABLE IF EXISTS plugin_project_state`);
    markMigrationApplied(migrationId);
  });
  migrate();
})();

(function removeLegacyPluginSelections() {
  const migrationId = "2026-08-remove-legacy-plugin-selections-v1";
  if (migrationApplied(migrationId)) return;
  const rows = db.prepare(`SELECT id, session_config FROM sessions WHERE session_config IS NOT NULL`).all();
  const update = db.prepare(`UPDATE sessions SET session_config=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`);
  const migrate = db.transaction(() => {
    for (const row of rows) {
      let config;
      try {
        config = typeof row.session_config === "string" ? JSON.parse(row.session_config) : row.session_config;
      } catch {
        continue;
      }
      if (!config || typeof config !== "object" || Array.isArray(config)
        || !Object.hasOwn(config, "agent_capabilities")) continue;
      delete config.agent_capabilities;
      update.run(JSON.stringify(config), row.id);
    }
    markMigrationApplied(migrationId);
  });
  migrate();
})();

// Project instructions are general guidance for every conversation in one
// project. They are stored separately from legacy query/SQL/display rules.
(function migrateProjectInstructions() {
  const migrationId = "2026-07-project-instructions-v1";
  if (migrationApplied(migrationId)) return;
  const columns = db.prepare(`PRAGMA table_info("projects")`).all().map((column) => column.name);
  if (!columns.includes("instructions")) {
    db.exec(`ALTER TABLE "projects" ADD COLUMN "instructions" TEXT NOT NULL DEFAULT ''`);
  }
  markMigrationApplied(migrationId);
})();

// Project rules are workspace data, not configurable Agents or prompt
// templates. Preserve the three supported rule documents, then remove the old
// table so new and upgraded installations share one clean storage contract.
(function migrateProjectRules() {
  const migrationId = "2026-07-project-rules-v1";
  if (migrationApplied(migrationId)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS project_rules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    rule_type TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '1.0.0',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, rule_type)
  )`);
  const hasOldTable = !!db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type='table' AND name='agents'`,
  ).get();
  if (hasOldTable) backupDatabaseBeforeMigration(migrationId);
  const migrate = db.transaction(() => {
    if (hasOldTable) {
      db.exec(`
        INSERT INTO project_rules
          (id, project_id, rule_type, content, version, created_at, updated_at)
        SELECT lower(hex(randomblob(16))), project_id,
               CASE
                 WHEN agent_type='nl2sql' THEN 'sql'
                 WHEN agent_type='format' THEN 'format'
                 ELSE 'query'
               END,
               rules,
               COALESCE(NULLIF(version, ''), '1.0.0'),
               COALESCE(created_at, CURRENT_TIMESTAMP),
               COALESCE(updated_at, CURRENT_TIMESTAMP)
          FROM agents
         WHERE project_id IS NOT NULL
           AND TRIM(COALESCE(rules, '')) <> ''
           AND (agent_type IN ('query_agent', 'nl2sql', 'format') OR agent_type LIKE '%_query_agent')
        ON CONFLICT(project_id, rule_type) DO UPDATE SET
          content=excluded.content,
          version=excluded.version,
          updated_at=excluded.updated_at
      `);
      db.exec(`DROP TABLE agents`);
    }
    markMigrationApplied(migrationId);
  });
  migrate();
  if (hasOldTable) console.info("[db] ✓ 旧 Agent Prompt 表已迁移为项目规则");
})();

// Rename old public runtime keys without keeping the former product name in
// current APIs or configuration. Existing projects retain their Agent rules
// and model tuning values after upgrade.
(function migrateAgentRuntimeNaming() {
  const migrationId = "2026-07-agent-runtime-neutral-naming-v1";
  if (migrationApplied(migrationId)) return;
  backupDatabaseBeforeMigration(migrationId);
  const migrate = db.transaction(() => {
    db.exec(`
      UPDATE llm_models
         SET extra_config = (
           SELECT json_remove(
                    json_set(llm_models.extra_config, '$.agent_runtime', json(candidate.value)),
                    '$.' || candidate.key
                  )
             FROM json_each(llm_models.extra_config) AS candidate
            WHERE candidate.key <> 'agent_runtime'
              AND json_type(candidate.value) = 'object'
              AND (
                json_extract(candidate.value, '$.reasoning_effort') IS NOT NULL
                OR json_extract(candidate.value, '$.reasoning_summary') IS NOT NULL
                OR json_extract(candidate.value, '$.auto_compact_token_limit') IS NOT NULL
              )
            LIMIT 1
         )
       WHERE json_valid(extra_config)
         AND json_type(extra_config, '$.agent_runtime') IS NULL
         AND EXISTS (
           SELECT 1
             FROM json_each(llm_models.extra_config) AS candidate
            WHERE candidate.key <> 'agent_runtime'
              AND json_type(candidate.value) = 'object'
              AND (
                json_extract(candidate.value, '$.reasoning_effort') IS NOT NULL
                OR json_extract(candidate.value, '$.reasoning_summary') IS NOT NULL
                OR json_extract(candidate.value, '$.auto_compact_token_limit') IS NOT NULL
              )
         )
    `);
    markMigrationApplied(migrationId);
  });
  migrate();
})();

// Older releases inferred a small set of provider capabilities from the model
// name on every turn. Freeze those already-observed defaults into the saved
// model data once, then let the current runtime rely only on explicit config.
(function migrateLegacyInferredModelCapabilities() {
  const migrationId = "2026-08-explicit-legacy-model-capabilities-v1";
  if (migrationApplied(migrationId)) return;
  const rows = db.prepare(`
    SELECT id, model_name, extra_config
      FROM llm_models
     WHERE category='PRIMARY' AND deleted_at IS NULL
  `).all();
  const updates = rows.flatMap((row) => {
    let extraConfig = {};
    try {
      extraConfig = JSON.parse(String(row.extra_config || "{}"));
    } catch {
      // Some older API paths accepted arbitrary strings. If such a row used
      // a legacy model whose capabilities were previously inferred, migrate
      // from an empty object instead of permanently marking it as handled and
      // silently shrinking its context window on upgrade.
      const migrated = explicitLegacyModelCapabilities(row.model_name, {});
      if (!migrated.changed) return [];
      console.warn(`[db] 模型 ${row.id} 的 extra_config 不是有效 JSON，已用旧版显式能力替换`);
      return [{ id: row.id, extraConfig: migrated.extraConfig }];
    }
    const migrated = explicitLegacyModelCapabilities(row.model_name, extraConfig);
    return migrated.changed ? [{ id: row.id, extraConfig: migrated.extraConfig }] : [];
  });
  if (updates.length) backupDatabaseBeforeMigration(migrationId);
  const migrate = db.transaction(() => {
    // Capability normalization is metadata-only. Do not change updated_at:
    // model fallback ordering uses it and a migration must not change which
    // model becomes active later.
    const update = db.prepare("UPDATE llm_models SET extra_config=? WHERE id=?");
    for (const row of updates) update.run(JSON.stringify(row.extraConfig), row.id);
    markMigrationApplied(migrationId);
  });
  migrate();
  if (updates.length) console.info(`[db] ✓ 已将 ${updates.length} 个旧模型的推断能力固化为显式配置`);
})();

// ── Stage 0(去业务层 · 数据层)── 给「只有 business_id」的语义表补 project_id 列,并从 businesses 回填。
// 后续阶段 service/engine 改成按 project_id 查;business_id 列暂留(末阶段再清)。
// 幂等:列已存在则跳过;回填只填 NULL 行。加列是纯增量,不破坏已有数据。
(function migrateAddProjectId() {
  const tables = [
    "business_data_sources",
    "business_entity_configs",
    "entity_mapping_configs",
    "entity_mappings",
    "examples",
    "metric_definitions",
    "metric_view_definitions",
  ];
  let added = 0;
  let filled = 0;
  for (const t of tables) {
    try {
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
      if (!cols.includes("business_id")) continue; // 表不存在/结构异常,跳过
      if (!cols.includes("project_id")) {
        db.exec(`ALTER TABLE "${t}" ADD COLUMN "project_id" TEXT`);
        added++;
      }
      // businesses.id → businesses.project_id 回填(只填空,幂等)
      const before = db.prepare(`SELECT count(*) c FROM "${t}" WHERE project_id IS NULL AND business_id IS NOT NULL`).get().c;
      db.exec(
        `UPDATE "${t}" SET project_id = (SELECT b.project_id FROM businesses b WHERE b.id = "${t}".business_id)
          WHERE project_id IS NULL AND business_id IS NOT NULL`,
      );
      const after = db.prepare(`SELECT count(*) c FROM "${t}" WHERE project_id IS NULL AND business_id IS NOT NULL`).get().c;
      filled += before - after;
    } catch (e) {
      console.error(`[db] migrate project_id(${t})失败: ${e?.message ?? e}`);
    }
  }
  if (added || filled) console.info(`[db] ✓ Stage0 project_id 迁移:加列 ${added} 张,回填 ${filled} 行`);
})();

// ── Stage 1(去业务层 · 协议级)── sessions.source_type 从 'business' 迁到 'project'。
// 配合阶段 4 前端改动(createSession source_type 改 'project')。旧会话行批量更新,幂等。
// 桌面端 business 与 project 1:1,source_id 存的通常是 business_id(== project_id),
// 故顺带把 source_id 校正为 project_id(businesses 表 join),保证后续读取一致。
(function migrateSessionSourceType() {
  let updated = 0;
  try {
    // 仅迁移 source_type='business' 的旧行(新行已直接写 'project')
    const stale = db.prepare(`SELECT count(*) c FROM sessions WHERE source_type = 'business'`).get().c;
    if (stale > 0) {
      // 1) source_id 能在 businesses 表找到 → 用其 project_id 校正 source_id
      db.exec(
        `UPDATE sessions SET source_type = 'project',
           source_id = (SELECT b.project_id FROM businesses b WHERE b.id = sessions.source_id)
         WHERE source_type = 'business'
           AND source_id IN (SELECT id FROM businesses)`,
      );
      // 2) 兜底:source_id 不在 businesses 表(可能是 project_id 直存)→ 仅改 source_type
      db.exec(
        `UPDATE sessions SET source_type = 'project'
         WHERE source_type = 'business'`,
      );
      const remaining = db.prepare(`SELECT count(*) c FROM sessions WHERE source_type = 'business'`).get().c;
      updated = stale - remaining;
    }
  } catch (e) {
    console.error(`[db] migrate session source_type 失败: ${e?.message ?? e}`);
  }
  if (updated) console.info(`[db] ✓ Stage1 session source_type 迁移: ${updated} 行 business→project`);
})();

// ── Stage 2(去业务层 · schema 清理)── 删除语义表的 business_id 列。
// 破坏性:列删后不可回滚(需从备份恢复 local.db)。前置:Stage 0 回填 project_id 完成 + 所有读路径已切 project_id。
// 幂等:列不存在则跳过(SQLite ALTER DROP COLUMN 在列缺失时报错,故先 PRAGMA 检查)。
// 注:businesses / business_api_keys / business_publish_configs 表本身保留(阶段评估是否整体删表)。
(function migrateDropBusinessIdColumns() {
  const migrationId = "2026-07-drop-business-id-v1";
  if (migrationApplied(migrationId)) return;
  const tables = [
    "business_data_sources",
    "business_entity_configs",
    "entity_mapping_configs",
    "entity_mappings",
    "examples",
    "metric_definitions",
    "metric_view_definitions",
    "generated_reports",
    "llm_call_logs",
    "metric_view_recommendation_tasks",
    "disambiguation_resolutions",
  ];
  const targets = tables.filter((table) =>
    db.prepare(`PRAGMA table_info("${table}")`).all().some((column) => column.name === "business_id"),
  );
  for (const table of targets) {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name);
    if (!columns.includes("project_id")) continue;
    const unresolved = db.prepare(
      `SELECT count(*) AS count FROM "${table}" WHERE project_id IS NULL AND business_id IS NOT NULL`,
    ).get().count;
    if (unresolved > 0) {
      throw new Error(`Stage2 迁移已停止: ${table} 仍有 ${unresolved} 行 business_id 未回填到 project_id`);
    }
  }
  if (targets.length) backupDatabaseBeforeMigration(migrationId);
  const migrate = db.transaction(() => {
    for (const table of targets) db.exec(`ALTER TABLE "${table}" DROP COLUMN "business_id"`);
    markMigrationApplied(migrationId);
  });
  migrate();
  const dropped = targets.length;
  if (dropped) console.info(`[db] ✓ Stage2 删 business_id 列: ${dropped} 张表`);
})();

// Legacy data-analysis turn state. Keep these tables for existing local data
// and run-history cleanup, but no bundled Plugin creates new rows.
(function migrateTrackD() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "analysis_plan_steps" ("session_id" TEXT, "message_id" TEXT, "step_index" INTEGER, "task_id" TEXT, "title" TEXT, "source_kind" TEXT, "source_name" TEXT, "depends_on" TEXT, "output_alias" TEXT, "is_optional" INTEGER NOT NULL DEFAULT 0, "is_supporting" INTEGER NOT NULL DEFAULT 0, "validation_requirements" TEXT NOT NULL DEFAULT '{}', "status" TEXT, "intermediate_table" TEXT, "id" TEXT, "created_at" TEXT, "updated_at" TEXT, "deleted_at" TEXT, "deleted_by" TEXT, PRIMARY KEY ("id"))`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "session_intermediate_tables" ("session_id" TEXT, "message_id" TEXT, "query_execution_id" TEXT, "table_name" TEXT, "duckdb_path" TEXT, "description" TEXT, "row_count" INTEGER, "column_count" INTEGER, "columns" TEXT, "schema_preview" TEXT, "sub_query" TEXT, "sql_query" TEXT, "id" TEXT, "created_at" TEXT, "updated_at" TEXT, "deleted_at" TEXT, "deleted_by" TEXT, PRIMARY KEY ("id"))`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "query_executions" (
        "id" TEXT PRIMARY KEY,
        "execution_key" TEXT NOT NULL UNIQUE,
        "version" TEXT NOT NULL,
        "parent_run_id" TEXT NOT NULL,
        "turn_id" TEXT NOT NULL,
        "session_id" TEXT,
        "project_id" TEXT,
        "user_id" TEXT,
        "root_question" TEXT,
        "last_delegated_question" TEXT,
        "preparation_context_mode" TEXT,
        "preparation_status" TEXT,
        "preparation_revision_id" TEXT,
        "preparation_revision" INTEGER,
        "status" TEXT NOT NULL DEFAULT 'running',
        "delegated_call_count" INTEGER NOT NULL DEFAULT 0,
        "error_code" TEXT,
        "error_message" TEXT,
        "finished_at" TEXT,
        "created_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL
      )`,
    );
    const addColumnIfMissing = (table, name, definition) => {
      const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
      if (!columns.has(name)) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition}`);
    };
    addColumnIfMissing("agent_subtask_runs", "query_execution_id", "TEXT");
    addColumnIfMissing("analysis_plan_steps", "is_optional", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing("analysis_plan_steps", "is_supporting", "INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing("analysis_plan_steps", "validation_requirements", "TEXT NOT NULL DEFAULT '{}'");
    addColumnIfMissing("session_intermediate_tables", "query_execution_id", "TEXT");
    addColumnIfMissing("query_executions", "preparation_context_mode", "TEXT");
    addColumnIfMissing("query_executions", "preparation_status", "TEXT");
    addColumnIfMissing("query_executions", "preparation_revision_id", "TEXT");
    addColumnIfMissing("query_executions", "preparation_revision", "INTEGER");

    // 索引(schema.sql 不含索引,统一在此建;幂等)。partial index 走软删过滤,与查询口径一致。
    db.exec(`CREATE INDEX IF NOT EXISTS idx_plan_session_step ON "analysis_plan_steps"(session_id, step_index) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_inter_session ON "session_intermediate_tables"(session_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_query_execution_key ON "query_executions"(execution_key)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_query_execution_turn ON "query_executions"(parent_run_id, turn_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_subtask_query_execution ON "agent_subtask_runs"(query_execution_id, created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_inter_query_execution ON "session_intermediate_tables"(query_execution_id, created_at) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] Track D 迁移失败: ${e?.message ?? e}`);
  }
})();

// Entity auto-promotion provenance. The UI can now distinguish and safely revert generated entries.
(function migrateEntityAutoPromoted() {
  const migrationId = "2026-07-entity-auto-promoted-v1";
  if (migrationApplied(migrationId)) return;
  for (const table of ["entity_mapping_configs", "entity_mappings"]) {
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name);
    if (!columns.includes("auto_promoted")) {
      db.exec(`ALTER TABLE "${table}" ADD COLUMN "auto_promoted" INTEGER DEFAULT 0`);
    }
  }
  markMigrationApplied(migrationId);
})();

// A metric is the stable business definition; SQL/PDF/formula are execution
// plans. This migration copies the old inline execution fields once.
(function migrateMetricExecutionPlans() {
  const migrationId = "2026-08-metric-execution-plans-v1";
  db.exec(`CREATE TABLE IF NOT EXISTS "metric_execution_plans" (
    "id" TEXT PRIMARY KEY,
    "project_id" TEXT NOT NULL,
    "metric_id" TEXT NOT NULL,
    "plan_type" TEXT NOT NULL,
    "source_id" TEXT,
    "source_type" TEXT,
    "spec" TEXT,
    "evidence_policy" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_active" INTEGER NOT NULL DEFAULT 1,
    "created_at" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL,
    "deleted_at" TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS "idx_metric_execution_plans_metric"
    ON "metric_execution_plans" ("project_id", "metric_id", "is_active", "priority")`);
  if (migrationApplied(migrationId)) return;
  const columns = new Set(
    db.prepare(`PRAGMA table_info("metric_definitions")`).all().map((column) => column.name),
  );
  const field = (name, fallback = "NULL") => columns.has(name) ? `"${name}"` : fallback;
  const rows = db.prepare(
    `SELECT id, project_id,
            ${field("execution_type", "'sql'")} AS execution_type,
            ${field("execution_spec")} AS execution_spec,
            ${field("evidence_policy")} AS evidence_policy,
            ${field("sql_template")} AS sql_template,
            ${field("source_id")} AS source_id,
            ${field("source_type")} AS source_type,
            created_at, updated_at
       FROM metric_definitions
      WHERE deleted_at IS NULL AND project_id IS NOT NULL`,
  ).all();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO metric_execution_plans
       (id, project_id, metric_id, plan_type, source_id, source_type, spec,
        evidence_policy, priority, version, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, 1, 1, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const row of rows) {
    let spec = null;
    try { spec = row.execution_spec ? JSON.parse(row.execution_spec) : null; } catch { spec = null; }
    if ((row.execution_type || "sql") === "sql") {
      spec = { ...(spec || {}), sql_template: row.sql_template || spec?.sql_template || null };
    }
    insert.run(
      `default:${row.id}`,
      row.project_id,
      row.id,
      row.execution_type || "sql",
      row.source_id || null,
      row.source_type || null,
      spec ? JSON.stringify(spec) : null,
      row.evidence_policy || null,
      row.created_at || now,
      row.updated_at || now,
    );
  }
  markMigrationApplied(migrationId);
})();

// The copy above is the only compatibility step. Runtime storage has a hard
// boundary: definitions keep semantics; plans keep every execution detail.
(function migrateDropInlineMetricExecution() {
  const migrationId = "2026-08-drop-inline-metric-execution-v1";
  if (migrationApplied(migrationId)) return;
  const legacyNames = [
    "sql_template", "execution_type", "execution_spec", "evidence_policy", "source_id", "source_type",
  ];
  const columns = new Set(
    db.prepare(`PRAGMA table_info("metric_definitions")`).all().map((column) => column.name),
  );
  const targets = legacyNames.filter((name) => columns.has(name));
  const field = (name, fallback = "NULL") => columns.has(name) ? `"${name}"` : fallback;

  if (targets.length) {
    const rows = db.prepare(
      `SELECT m.id, m.project_id,
              ${field("execution_type", "'sql'")} AS execution_type,
              ${field("execution_spec")} AS execution_spec,
              ${field("evidence_policy")} AS evidence_policy,
              ${field("sql_template")} AS sql_template,
              ${field("source_id")} AS source_id,
              ${field("source_type")} AS source_type,
              m.created_at, m.updated_at
         FROM metric_definitions m
        WHERE m.deleted_at IS NULL AND m.project_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM metric_execution_plans p
             WHERE p.project_id=m.project_id AND p.metric_id=m.id AND p.deleted_at IS NULL
          )`,
    ).all();
    const insert = db.prepare(
      `INSERT INTO metric_execution_plans
         (id, project_id, metric_id, plan_type, source_id, source_type, spec,
          evidence_policy, priority, version, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 100, 1, 1, ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const row of rows) {
      let spec = null;
      try { spec = row.execution_spec ? JSON.parse(row.execution_spec) : null; } catch { spec = null; }
      const planType = row.execution_type || "sql";
      if (planType === "sql") spec = { ...(spec || {}), sql_template: row.sql_template || spec?.sql_template || null };
      insert.run(
        `default:${row.id}`, row.project_id, row.id, planType,
        row.source_id || null, row.source_type || null,
        JSON.stringify(spec || {}), row.evidence_policy || null,
        row.created_at || now, row.updated_at || now,
      );
    }
    const missing = db.prepare(
      `SELECT count(*) AS count
         FROM metric_definitions m
        WHERE m.deleted_at IS NULL AND m.project_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM metric_execution_plans p
             WHERE p.project_id=m.project_id AND p.metric_id=m.id AND p.deleted_at IS NULL
          )`,
    ).get().count;
    if (missing > 0) throw new Error(`指标执行计划迁移已停止: 仍有 ${missing} 个指标没有执行计划`);
    backupDatabaseBeforeMigration(migrationId);
  }
  const migrate = db.transaction(() => {
    for (const name of targets) db.exec(`ALTER TABLE "metric_definitions" DROP COLUMN "${name}"`);
    markMigrationApplied(migrationId);
  });
  migrate();
  if (targets.length) console.info(`[db] ✓ 指标执行字段已迁出定义表: ${targets.join(", ")}`);
})();

// Skill definitions and enablement are owned by Agent files/config.toml.
// These unreleased database tables are obsolete and must not survive upgrades.
(function dropDatabaseSkillStorage() {
  const migrationId = "2026-07-drop-database-skill-storage-v1";
  if (migrationApplied(migrationId)) return;
  db.exec(`DROP TABLE IF EXISTS "project_skills"; DROP TABLE IF EXISTS "app_skills";`);
  markMigrationApplied(migrationId);
})();

// ── Agent Runs ── 框架级运行记录、等待用户输入、审批和恢复句柄。
// pending action 长期入库;resume 是否仍可原地恢复由 resume_expires_at 与 checkpoint 决定。
(function migrateAgentSuspendedRuns() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_runs" (
        "id" TEXT PRIMARY KEY,
        "session_id" TEXT NOT NULL,
        "project_id" TEXT,
        "user_id" TEXT,
        "status" TEXT NOT NULL DEFAULT 'running',
        "skill_name" TEXT,
        "mode" TEXT,
        "checkpoint_json" TEXT,
        "metadata_json" TEXT,
        "finished_at" TEXT,
        "viewed_at" TEXT,
        "status_changed_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_pending_inputs" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "session_id" TEXT NOT NULL,
        "project_id" TEXT,
        "user_id" TEXT,
        "request_id" TEXT NOT NULL UNIQUE,
        "input_type" TEXT NOT NULL DEFAULT 'user_input',
        "status" TEXT NOT NULL DEFAULT 'pending',
        "payload_json" TEXT,
        "response_json" TEXT,
        "resume_handle_json" TEXT,
        "resume_expires_at" TEXT,
        "record_expires_at" TEXT,
        "responded_by" TEXT,
        "responded_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_session_status ON "agent_runs"(session_id, status) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_pending_session_status ON "agent_pending_inputs"(session_id, status) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_pending_run ON "agent_pending_inputs"(run_id) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] Agent Runs 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── Agent Run Facts── 追加事件、工具幂等、恢复 lease 和产物索引。
// 只做增量补表/补列，不覆盖上方或其他功能正在进行的迁移。
(function migrateAgentRunFacts() {
  try {
    const runColumns = new Map([
      ["turn_id", "TEXT"],
      ["last_event_seq", "INTEGER NOT NULL DEFAULT 0"],
      ["lease_owner", "TEXT"],
      ["lease_expires_at", "TEXT"],
      ["heartbeat_at", "TEXT"],
      ["runner_pid", "INTEGER"],
      ["recoverable", "INTEGER NOT NULL DEFAULT 0"],
      ["retention_until", "TEXT"],
      ["workspace_path", "TEXT"],
      ["manifest_path", "TEXT"],
      ["workspace_version", "TEXT"],
      ["manifest_hash", "TEXT"],
      ["environment_snapshot_path", "TEXT"],
      ["environment_snapshot_version", "TEXT"],
      ["environment_snapshot_hash", "TEXT"],
      ["archived_at", "TEXT"],
      ["archived_by", "TEXT"],
      ["viewed_at", "TEXT"],
      ["status_changed_at", "TEXT"],
    ]);
    const existing = new Set(db.prepare(`PRAGMA table_info("agent_runs")`).all().map((column) => column.name));
    for (const [name, type] of runColumns) {
      if (!existing.has(name)) db.exec(`ALTER TABLE "agent_runs" ADD COLUMN "${name}" ${type}`);
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_run_events" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "turn_id" TEXT,
        "call_id" TEXT,
        "seq" INTEGER NOT NULL,
        "event_type" TEXT NOT NULL,
        "status" TEXT,
        "input_summary" TEXT,
        "output_summary" TEXT,
        "artifact_id" TEXT,
        "error_code" TEXT,
        "retry_count" INTEGER NOT NULL DEFAULT 0,
        "metadata_json" TEXT,
        "created_at" TEXT NOT NULL,
        UNIQUE ("run_id", "seq")
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_tool_calls" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "turn_id" TEXT,
        "call_id" TEXT NOT NULL,
        "tool_name" TEXT NOT NULL,
        "access_mode" TEXT NOT NULL DEFAULT 'read',
        "status" TEXT NOT NULL DEFAULT 'pending',
        "attempt_count" INTEGER NOT NULL DEFAULT 0,
        "input_json" TEXT,
        "input_summary" TEXT,
        "result_json" TEXT,
        "output_summary" TEXT,
        "log_path" TEXT,
        "error_code" TEXT,
        "started_at" TEXT,
        "finished_at" TEXT,
        "created_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL,
        UNIQUE ("run_id", "call_id")
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_artifacts" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "call_id" TEXT,
        "kind" TEXT NOT NULL,
        "path" TEXT,
        "mime_type" TEXT,
        "size_bytes" INTEGER,
        "sha256" TEXT,
        "metadata_json" TEXT,
        "created_at" TEXT NOT NULL
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_evidence_bundles" (
        "id" TEXT PRIMARY KEY,
        "run_id" TEXT NOT NULL,
        "turn_id" TEXT,
        "session_id" TEXT NOT NULL,
        "project_id" TEXT,
        "final_item_id" TEXT NOT NULL,
        "bundle_version" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        "snapshot_hash" TEXT NOT NULL,
        "payload_json" TEXT NOT NULL,
        "created_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL,
        "deleted_at" TEXT,
        "deleted_by" TEXT,
        UNIQUE ("run_id", "final_item_id")
      )`,
    );
    db.exec(`UPDATE "agent_runs" SET status='waiting_user_input' WHERE status='suspended'`);
    db.exec(`UPDATE "agent_runs" SET status='recovering' WHERE status='resumed'`);
    const viewedAtBackfillMigrationId = "2026-08-agent-run-viewed-at-backfill-v1";
    if (!migrationApplied(viewedAtBackfillMigrationId)) {
      db.exec(`
        UPDATE "agent_runs"
           SET viewed_at=COALESCE(finished_at, updated_at, created_at, CURRENT_TIMESTAMP)
         WHERE viewed_at IS NULL
           AND status IN ('completed','failed','interrupted','expired')
      `);
      markMigrationApplied(viewedAtBackfillMigrationId);
    }
    const statusChangedAtMigrationId = "2026-08-agent-run-status-changed-at-v1";
    if (!migrationApplied(statusChangedAtMigrationId)) {
      db.exec(`
        UPDATE "agent_runs" AS ar
           SET status_changed_at=COALESCE(
             (
               SELECT MAX(e.created_at)
                 FROM "agent_run_events" e
                WHERE e.run_id=ar.id
                  AND (
                    e.event_type='run_created'
                    OR e.event_type IN (
                      'run_recovery_waiting_approval',
                      'run_recovery_waiting_input',
                      'run_recovery_ready',
                      'run_recovery_interrupted'
                    )
                    OR (
                      e.event_type GLOB 'run_*'
                      AND e.metadata_json LIKE '%"from"%'
                      AND e.metadata_json LIKE '%"to"%'
                    )
                  )
             ),
             CASE
               WHEN ar.status IN ('completed','failed','interrupted','expired')
                 THEN COALESCE(ar.finished_at, ar.created_at, ar.updated_at)
               ELSE COALESCE(ar.updated_at, ar.created_at)
             END,
             CURRENT_TIMESTAMP
           )
         WHERE ar.status_changed_at IS NULL
      `);
      markMigrationApplied(statusChangedAtMigrationId);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_run_events_seq ON "agent_run_events"(run_id, seq)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_run_events_call ON "agent_run_events"(run_id, call_id, seq)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tool_calls_call ON "agent_tool_calls"(run_id, call_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_status ON "agent_tool_calls"(run_id, status)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_artifacts_run ON "agent_artifacts"(run_id, created_at)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_evidence_bundle_answer ON "agent_evidence_bundles"(run_id, final_item_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_evidence_bundle_run ON "agent_evidence_bundles"(run_id, created_at)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_evidence_bundle_project ON "agent_evidence_bundles"(project_id, created_at) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_recovery ON "agent_runs"(status, lease_expires_at) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_runs_session_changed ON "agent_runs"(session_id, status_changed_at DESC, created_at DESC, id DESC) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] Agent Run Facts 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── Project Artifact Library ── 项目级稳定产物与不可变版本。
// This remains separate from run-scoped agent_artifacts.
(function migrateProjectArtifactLibrary() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "project_artifacts" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT NOT NULL,
        "source_locator" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "kind" TEXT NOT NULL DEFAULT 'file',
        "description" TEXT,
        "current_version_id" TEXT,
        "source_session_id" TEXT,
        "source_turn_id" TEXT,
        "source_run_id" TEXT,
        "source_item_id" TEXT,
        "source_tool_call_id" TEXT,
        "metadata_json" TEXT,
        "created_by" TEXT,
        "created_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "project_artifact_versions" (
        "id" TEXT PRIMARY KEY,
        "artifact_id" TEXT NOT NULL,
        "version_number" INTEGER NOT NULL,
        "snapshot_path" TEXT NOT NULL,
        "original_path" TEXT,
        "mime_type" TEXT,
        "size_bytes" INTEGER NOT NULL DEFAULT 0,
        "sha256" TEXT NOT NULL,
        "change_summary" TEXT,
        "source_session_id" TEXT,
        "source_turn_id" TEXT,
        "source_run_id" TEXT,
        "source_item_id" TEXT,
        "source_tool_call_id" TEXT,
        "restored_from_version_id" TEXT,
        "metadata_json" TEXT,
        "created_by" TEXT,
        "created_at" TEXT NOT NULL,
        UNIQUE ("artifact_id", "version_number")
      )`,
    );
    const ownerScopeMigrationId = "2026-08-project-artifact-owner-scope-v1";
    if (!migrationApplied(ownerScopeMigrationId)) {
      const tableSql = String(db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='project_artifacts'`,
      ).get()?.sql || "");
      const hasLegacyUniqueConstraint = /UNIQUE\s*\(\s*["']?project_id["']?\s*,\s*["']?source_locator["']?\s*\)/i.test(tableSql);
      if (hasLegacyUniqueConstraint) {
        backupDatabaseBeforeMigration(ownerScopeMigrationId);
        const migrate = db.transaction(() => {
          db.exec(`
            DROP TABLE IF EXISTS project_artifacts_owner_scope_v2;
            CREATE TABLE project_artifacts_owner_scope_v2 (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL,
              source_locator TEXT NOT NULL,
              name TEXT NOT NULL,
              kind TEXT NOT NULL DEFAULT 'file',
              description TEXT,
              current_version_id TEXT,
              source_session_id TEXT,
              source_turn_id TEXT,
              source_run_id TEXT,
              source_item_id TEXT,
              source_tool_call_id TEXT,
              metadata_json TEXT,
              created_by TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              deleted_at TEXT,
              deleted_by TEXT
            );
            INSERT INTO project_artifacts_owner_scope_v2
              (id,project_id,source_locator,name,kind,description,current_version_id,
               source_session_id,source_turn_id,source_run_id,source_item_id,source_tool_call_id,
               metadata_json,created_by,created_at,updated_at,deleted_at,deleted_by)
            SELECT id,project_id,source_locator,name,kind,description,current_version_id,
                   source_session_id,source_turn_id,source_run_id,source_item_id,source_tool_call_id,
                   metadata_json,created_by,created_at,updated_at,deleted_at,deleted_by
              FROM project_artifacts;
            DROP TABLE project_artifacts;
            ALTER TABLE project_artifacts_owner_scope_v2 RENAME TO project_artifacts;
          `);
          markMigrationApplied(ownerScopeMigrationId);
        });
        migrate();
      } else {
        markMigrationApplied(ownerScopeMigrationId);
      }
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_project_artifacts_project_updated ON "project_artifacts"(project_id, updated_at DESC) WHERE deleted_at IS NULL`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_artifacts_project_source
      ON "project_artifacts"(project_id, source_locator)
      WHERE project_id<>'__chat__'`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_artifacts_chat_owner_source
      ON "project_artifacts"(created_by, source_locator)
      WHERE project_id='__chat__'`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_project_artifact_versions_artifact ON "project_artifact_versions"(artifact_id, version_number DESC)`);
  } catch (e) {
    console.error(`[db] 项目产物库迁移失败: ${e?.message ?? e}`);
  }
})();

// ── Canvas Workspace ── 会话级长文本/代码工作区和不可变版本。
// Canvas 同时支持普通、项目和临时对话，不借用只属于真实项目的产物表。
(function migrateCanvasWorkspace() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_canvases" (
        "id" TEXT PRIMARY KEY,
        "session_id" TEXT NOT NULL,
        "project_id" TEXT NOT NULL,
        "user_id" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "kind" TEXT NOT NULL DEFAULT 'document',
        "language" TEXT,
        "current_version_id" TEXT,
        "source_message_id" TEXT,
        "source_item_id" TEXT,
        "source_turn_id" TEXT,
        "source_run_id" TEXT,
        "metadata_json" TEXT,
        "created_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL,
        "deleted_at" TEXT,
        "deleted_by" TEXT,
        UNIQUE ("session_id", "source_item_id")
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_canvas_versions" (
        "id" TEXT PRIMARY KEY,
        "canvas_id" TEXT NOT NULL,
        "version_number" INTEGER NOT NULL,
        "snapshot_path" TEXT NOT NULL,
        "size_bytes" INTEGER NOT NULL DEFAULT 0,
        "sha256" TEXT NOT NULL,
        "change_summary" TEXT,
        "parent_version_id" TEXT,
        "restored_from_version_id" TEXT,
        "source_type" TEXT NOT NULL DEFAULT 'user',
        "source_turn_id" TEXT,
        "source_run_id" TEXT,
        "source_item_id" TEXT,
        "source_tool_call_id" TEXT,
        "metadata_json" TEXT,
        "created_by" TEXT,
        "created_at" TEXT NOT NULL,
        UNIQUE ("canvas_id", "version_number")
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_canvas_suggestions" (
        "id" TEXT PRIMARY KEY,
        "canvas_id" TEXT NOT NULL,
        "base_version_id" TEXT NOT NULL,
        "start_offset" INTEGER NOT NULL,
        "end_offset" INTEGER NOT NULL,
        "selected_text" TEXT NOT NULL,
        "selected_text_hash" TEXT NOT NULL,
        "replacement_text" TEXT NOT NULL,
        "instruction" TEXT,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "accepted_version_id" TEXT,
        "source_turn_id" TEXT,
        "source_run_id" TEXT,
        "source_item_id" TEXT,
        "source_tool_call_id" TEXT,
        "created_by" TEXT,
        "created_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL
      )`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_canvases_session_updated ON "agent_canvases"(session_id, updated_at DESC) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_canvas_versions_canvas ON "agent_canvas_versions"(canvas_id, version_number DESC)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_canvas_suggestions_canvas ON "agent_canvas_suggestions"(canvas_id, status, created_at DESC)`);
  } catch (e) {
    console.error(`[db] Canvas 工作区迁移失败: ${e?.message ?? e}`);
  }
})();

// ── Agent Automations ── 通用后台任务定义和运行收件箱。
(function migrateAgentAutomations() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_automations" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT NOT NULL,
        "user_id" TEXT,
        "session_id" TEXT,
        "name" TEXT NOT NULL,
        "prompt" TEXT NOT NULL,
        "skill_name" TEXT,
        "model_id" TEXT,
        "model_name" TEXT,
        "reasoning_effort" TEXT,
        "allowed_tools_json" TEXT,
        "schedule_json" TEXT NOT NULL,
        "sandbox_policy_json" TEXT NOT NULL,
        "snapshot_policy_json" TEXT NOT NULL,
        "notification_policy_json" TEXT NOT NULL,
        "permission_policy_json" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'enabled',
        "next_run_at" TEXT,
        "last_run_at" TEXT,
        "last_status" TEXT,
        "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
        "max_consecutive_failures" INTEGER NOT NULL DEFAULT 3,
        "lease_owner" TEXT,
        "lease_expires_at" TEXT,
        "created_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    const automationColumns = new Set(db.prepare(`PRAGMA table_info("agent_automations")`).all().map((column) => column.name));
    for (const name of ["model_id", "model_name", "reasoning_effort"]) {
      if (!automationColumns.has(name)) db.exec(`ALTER TABLE "agent_automations" ADD COLUMN "${name}" TEXT`);
    }
    db.exec(
      `CREATE TABLE IF NOT EXISTS "agent_automation_runs" (
        "id" TEXT PRIMARY KEY,
        "automation_id" TEXT NOT NULL,
        "run_id" TEXT,
        "project_id" TEXT NOT NULL,
        "session_id" TEXT,
        "status" TEXT NOT NULL,
        "inbox_status" TEXT NOT NULL DEFAULT 'unread',
        "requires_attention" INTEGER NOT NULL DEFAULT 0,
        "summary" TEXT,
        "error_code" TEXT,
        "error_message" TEXT,
        "evidence_bundle_id" TEXT,
        "started_at" TEXT,
        "finished_at" TEXT,
        "created_at" TEXT NOT NULL,
        "updated_at" TEXT NOT NULL,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_automations_due ON "agent_automations"(status, next_run_at) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_automation_runs_inbox ON "agent_automation_runs"(inbox_status, created_at) WHERE deleted_at IS NULL`);
    const ownershipMigrationId = "2026-08-agent-owner-backfill-v1";
    if (!migrationApplied(ownershipMigrationId)) {
      db.exec(`
        UPDATE agent_runs
           SET user_id=(
             SELECT s.created_by FROM sessions s
              WHERE s.id=agent_runs.session_id AND s.deleted_at IS NULL
                AND s.created_by IS NOT NULL AND s.created_by<>''
              LIMIT 1
           )
         WHERE (user_id IS NULL OR user_id='')
           AND EXISTS (
             SELECT 1 FROM sessions s
              WHERE s.id=agent_runs.session_id AND s.deleted_at IS NULL
                AND s.created_by IS NOT NULL AND s.created_by<>''
           );

        UPDATE agent_automations
           SET user_id=COALESCE(
             (
               SELECT s.created_by FROM sessions s
                WHERE s.id=agent_automations.session_id AND s.deleted_at IS NULL
                  AND s.created_by IS NOT NULL AND s.created_by<>''
                LIMIT 1
             ),
             (
               SELECT pm.user_id FROM project_members pm
                WHERE pm.project_id=agent_automations.project_id
                  AND pm.is_owner=1 AND pm.deleted_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM project_members other
                     WHERE other.project_id=pm.project_id AND other.is_owner=1
                       AND other.deleted_at IS NULL AND other.id<>pm.id
                  )
                LIMIT 1
             )
           )
         WHERE user_id IS NULL OR user_id='';

        UPDATE agent_automations
           SET status='paused', next_run_at=NULL, last_status='needs_attention', updated_at=CURRENT_TIMESTAMP
         WHERE deleted_at IS NULL AND (
           user_id IS NULL OR user_id='' OR
           COALESCE(json_extract(sandbox_policy_json, '$.tool_scope'), 'project')='allowlist' OR
           COALESCE(allowed_tools_json, '[]') NOT IN ('', '[]')
         );
      `);
      markMigrationApplied(ownershipMigrationId);
    }
  } catch (e) {
    console.error(`[db] Agent Automations 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── IM Remote Gateway── 飞书/企微/未来 IM 通道统一远程控制模型。
// 通道(connector)、外部身份(identity)、远程上下文(context)、幂等事件、投递日志、pending 交互、
// worker 状态分离,避免把平台配置直接绑死到单一工作区或会话。
(function migrateImGateway() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_connectors" (
        "id" TEXT PRIMARY KEY,
        "provider" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "owner_user_id" TEXT NOT NULL,
        "default_workspace_id" TEXT,
        "allowed_workspace_ids" TEXT,
        "session_policy" TEXT DEFAULT 'per_user',
        "enabled" INTEGER DEFAULT 1,
        "credentials" TEXT,
        "settings" TEXT,
        "connection_status" TEXT DEFAULT 'disconnected',
        "last_error" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_remote_identities" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "external_user_id" TEXT NOT NULL,
        "external_union_id" TEXT,
        "app_user_id" TEXT,
        "display_name" TEXT,
        "status" TEXT DEFAULT 'pending',
        "pairing_code" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_remote_contexts" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "external_conversation_key" TEXT NOT NULL,
        "external_user_id" TEXT NOT NULL,
        "chat_id" TEXT,
        "chat_type" TEXT,
        "current_workspace_id" TEXT,
        "current_session_id" TEXT,
        "session_policy" TEXT DEFAULT 'per_user',
        "last_active_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_inbound_events" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "event_id" TEXT NOT NULL,
        "message_id" TEXT,
        "external_conversation_key" TEXT,
        "external_user_id" TEXT,
        "chat_id" TEXT,
        "chat_type" TEXT,
        "text" TEXT,
        "command" TEXT,
        "status" TEXT,
        "result_workspace_id" TEXT,
        "result_session_id" TEXT,
        "raw_event" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_outbound_messages" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "inbound_event_id" TEXT,
        "provider" TEXT NOT NULL,
        "target_key" TEXT,
        "message_type" TEXT DEFAULT 'markdown',
        "content" TEXT,
        "status" TEXT DEFAULT 'queued',
        "error_message" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_pending_interactions" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "external_conversation_key" TEXT NOT NULL,
        "external_user_id" TEXT NOT NULL,
        "workspace_id" TEXT,
        "session_id" TEXT,
        "run_id" TEXT,
        "request_id" TEXT,
        "type" TEXT,
        "payload" TEXT,
        "expires_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "im_worker_status" (
        "id" TEXT PRIMARY KEY,
        "connector_id" TEXT NOT NULL,
        "provider" TEXT NOT NULL,
        "status" TEXT DEFAULT 'disconnected',
        "heartbeat_at" TEXT,
        "last_error" TEXT,
        "pid" INTEGER,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_connectors_owner ON "im_connectors"(owner_user_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_identity_lookup ON "im_remote_identities"(connector_id, external_user_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_context_lookup ON "im_remote_contexts"(connector_id, external_conversation_key, external_user_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_inbound_dedupe ON "im_inbound_events"(connector_id, event_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_im_pending_lookup ON "im_pending_interactions"(connector_id, external_conversation_key, external_user_id) WHERE deleted_at IS NULL`);
    const explicitAccessMigrationId = "2026-08-im-remote-explicit-access-v1";
    if (!migrationApplied(explicitAccessMigrationId)) {
      db.exec(`
        UPDATE im_connectors
           SET enabled=0,
               last_error='远程执行权限规则已更新，请显式选择工作区并重新启用',
               settings=json_set(
                 CASE WHEN json_valid(settings) THEN settings ELSE '{}' END,
                 '$.execution_mode', 'record_only',
                 '$.approval', 'ask'
               ),
               updated_at=CURRENT_TIMESTAMP
         WHERE deleted_at IS NULL AND (
           NOT json_valid(allowed_workspace_ids) OR
           COALESCE(json_array_length(allowed_workspace_ids), 0)=0 OR
           COALESCE(json_extract(CASE WHEN json_valid(settings) THEN settings ELSE '{}' END, '$.execution_mode'), 'agent') <> 'record_only' OR
           COALESCE(json_extract(CASE WHEN json_valid(settings) THEN settings ELSE '{}' END, '$.approval'), 'full') = 'full'
         );
      `);
      markMigrationApplied(explicitAccessMigrationId);
    }
  } catch (e) {
    console.error(`[db] IM Gateway 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── 元数据同步策略 / 记录── 对齐源库数据库管理页的自动同步配置。
(function migrateMetadataSync() {
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS "metadata_sync_configs" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT NOT NULL,
        "database_connection_id" TEXT NOT NULL,
        "enabled" INTEGER DEFAULT 0,
        "skip_cron" INTEGER DEFAULT 0,
        "schedule_cron" TEXT,
        "sync_mode" TEXT DEFAULT 'registered_only',
        "last_run_at" TEXT,
        "last_status" TEXT,
        "last_error" TEXT,
        "last_auto_run_at" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(
      `CREATE TABLE IF NOT EXISTS "metadata_sync_audits" (
        "id" TEXT PRIMARY KEY,
        "project_id" TEXT NOT NULL,
        "database_connection_id" TEXT NOT NULL,
        "trigger_source" TEXT,
        "status" TEXT,
        "tables_synced" INTEGER,
        "columns_synced" INTEGER,
        "duration_ms" INTEGER,
        "error_msg" TEXT,
        "created_at" TEXT,
        "updated_at" TEXT,
        "deleted_at" TEXT,
        "deleted_by" TEXT
      )`,
    );
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_metadata_sync_config_conn ON "metadata_sync_configs"(project_id, database_connection_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_metadata_sync_audits_conn ON "metadata_sync_audits"(project_id, database_connection_id, created_at) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_table_metadata_connection_active ON "table_metadata"(database_connection_id) WHERE deleted_at IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_column_metadata_table_active ON "column_metadata"(table_id) WHERE deleted_at IS NULL`);
  } catch (e) {
    console.error(`[db] metadata sync 迁移失败: ${e?.message ?? e}`);
  }
})();

// ── vexdb_lite 向量扩展(HNSW ANN,供 schema/实体/指标的向量召回)──
// 加载失败不致命:相关服务自动降级为关键词/LIKE 召回。
export let vectorReady = false;
(function loadVectorExtension() {
  const plat = platform();
  const file = plat === "win32" ? "windows-x64/vexdb_lite.dll" : "macos/vexdb_lite.dylib";
  const extPath = process.env.VEXDB_EXT_PATH || join(__dir, "..", "vendor", "vexdb_lite", file);
  if (plat !== "darwin" && plat !== "win32") {
    console.warn(`[db] vexdb_lite 无 ${plat}/${arch()} 构建,向量召回降级为关键词`);
    return;
  }
  if (!existsSync(extPath)) {
    console.warn(`[db] vexdb_lite 扩展不存在(${extPath}),向量召回降级为关键词`);
    return;
  }
  try {
    db.loadExtension(extPath); // better-sqlite3 直接加载扩展,无需 enableLoadExtension(node:sqlite 才有)
    const v = db.prepare("SELECT vexdb_version() v").get().v;
    vectorReady = true;
    console.info(`[db] ✓ vexdb_lite 向量扩展已加载: ${v}`);
  } catch (e) {
    console.warn(`[db] vexdb_lite 加载失败(${e?.message ?? e}),向量召回降级为关键词`);
  }
})();

// ── PG 内置函数 → SQLite 自定义函数(避免改 SQL 文本)──
db.function("now", () => new Date().toISOString());
db.function("gen_random_uuid", () => randomUUID());
db.function("uuid_generate_v4", () => randomUUID());

/** 单个绑定值:PG 驱动接受 JS 对象/布尔/Date,SQLite 只接受 null/number/bigint/string/Buffer。 */
function normalizeParam(v) {
  if (v === undefined || v === null) return null;
  const t = typeof v;
  if (t === "boolean") return v ? 1 : 0;
  if (t === "number" || t === "bigint" || t === "string") return v;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v); // 对象/数组 → JSON 文本(对应 jsonb 列)
}

// 一次扫描同时处理:`= ANY($n)`→IN展开、`!=/<> ALL($n)`→NOT IN展开、标量 `$n`→`?`。
// String.replace(/g) 按出现顺序回调,保证 out 参数顺序与 ? 一致。
const ANY_ALL_PLACEHOLDER = /=\s*ANY\(\s*\$(\d+)(?:::[a-zA-Z_]+(?:\[\])?)?\s*\)|(?:!=|<>)\s*ALL\(\s*\$(\d+)(?:::[a-zA-Z_]+(?:\[\])?)?\s*\)|\$(\d+)/g;

/** PG SQL + 参数 → SQLite SQL + 位置参数。 */
function translate(sql, params) {
  const out = [];
  let translated = sql.replace(ANY_ALL_PLACEHOLDER, (m, anyN, allN, scalarN) => {
    if (anyN !== undefined || allN !== undefined) {
      const idx = anyN !== undefined ? anyN : allN;
      let arr = params[Number(idx) - 1];
      if (!Array.isArray(arr)) arr = arr == null ? [] : [arr];
      if (anyN !== undefined) {
        // = ANY(...) → IN(...);空数组永不命中
        if (arr.length === 0) return " IN (SELECT NULL WHERE 0)";
        for (const v of arr) out.push(normalizeParam(v));
        return " IN (" + arr.map(() => "?").join(",") + ")";
      }
      // != / <> ALL(...) → NOT IN(...);空数组 → NOT IN 空集 = 恒为真(无排除项)
      if (arr.length === 0) return " NOT IN (SELECT NULL WHERE 0)";
      for (const v of arr) out.push(normalizeParam(v));
      return " NOT IN (" + arr.map(() => "?").join(",") + ")";
    }
    out.push(normalizeParam(params[Number(scalarN) - 1]));
    return "?";
  });
  translated = translated.replace(/::[a-zA-Z_]+(\[\])?/g, ""); // 剥残留类型转换
  translated = translated.replace(/\bILIKE\b/gi, "LIKE");
  return { sql: translated, params: out };
}

const RETURNS_ROWS = /^\s*(select|with)\b/i;
const HAS_RETURNING = /\breturning\b/i;

/** 同步执行查询。事务回调只能使用同步接口，不能返回 Promise。 */
function querySync(sql, params = []) {
  const t = translate(sql, params);
  const stmt = db.prepare(t.sql);
  if (RETURNS_ROWS.test(t.sql) || HAS_RETURNING.test(t.sql)) {
    return stmt.all(...t.params);
  }
  stmt.run(...t.params);
  return [];
}

/** 执行查询,返回 rows(数组)。 */
export async function query(sql, params = []) {
  return querySync(sql, params);
}

/** 取单行(无则 null)。 */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

/**
 * 在同一个 SQLite 事务中执行一组同步数据库操作。
 * work 必须是同步函数；better-sqlite3 不允许事务回调返回 Promise。
 */
export function transaction(work, { mode = "deferred" } = {}) {
  if (typeof work !== "function") throw new TypeError("transaction 需要同步回调");
  const run = db.transaction(() => {
    const result = work({
      query: querySync,
      queryOne(sql, params = []) {
        return querySync(sql, params)[0] || null;
      },
      execute: querySync,
    });
    if (result && typeof result.then === "function") {
      throw new TypeError("transaction 回调不能是 async，也不能返回 Promise");
    }
    return result;
  });
  return String(mode || "").toLowerCase() === "immediate" ? run.immediate() : run();
}

/** 兼容部分迁移代码里用 ctx.execute 写库的调用。 */
export async function execute(sql, params = []) {
  return query(sql, params);
}

/** 原始 SQLite 句柄(供 schema 初始化 / 批量导入等底层操作)。 */
export const sqlite = db;

let databaseClosed = false;
export function closeDatabase() {
  if (databaseClosed || !db.open) return;
  databaseClosed = true;
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (e) {
    console.warn(`[db] WAL checkpoint 失败: ${e?.message ?? e}`);
  }
  db.close();
}

export default { query, queryOne, execute, transaction, sqlite, closeDatabase };

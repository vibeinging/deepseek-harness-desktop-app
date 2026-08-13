import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { listEnabledSkills } from "./skill_registry.js";
import { appendRunEvent } from "./run_fact_store.js";
import { readAgentRunWorkspace } from "../runner/run_workspace.js";

export const RUN_ENVIRONMENT_SNAPSHOT_VERSION = "agent_run_environment.v3";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

function snapshotConflict(message) {
  return Object.assign(new Error(message), { code: "AGENT_RUN_ENVIRONMENT_CONFLICT" });
}

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function compactRows(rows, fields) {
  return (Array.isArray(rows) ? rows : []).map((row) => Object.fromEntries(
    fields.map((field) => [field, row?.[field] ?? null]),
  ));
}

function selectedModelSnapshot(model) {
  if (!model || typeof model !== "object") return null;
  return {
    id: model.id || null,
    model_name: model.model_name || model.model || null,
    category: model.category || "PRIMARY",
    api_format: model.api_format || "chat_completions",
    context_window: model.context_window || model.contextWindow || null,
    extra_config_hash: hash(model.extra_config || {}),
  };
}

function skillSnapshot(skill) {
  return {
    id: skill?.id || null,
    name: skill?.name || null,
    source: skill?.source || null,
    runtime: skill?.runtime || null,
    side_effect: skill?.side_effect || null,
    required_tools: skill?.required_tools || skill?.tool_dependencies || [],
    definition_hash: hash({
      instructions: skill?.instructions || skill?.config?.instructions || "",
      config: skill?.config || {},
      updated_at: skill?.updated_at || null,
    }),
  };
}

async function rows(ctx, statement, params = []) {
  return ctx.query(statement, params).catch(() => []);
}

async function buildProjectEnvironment(ctx, projectId, selectedModel) {
  const [project, bindings, connections, tables, columns, projectRules, modelBindings, metrics, metricPlans, metricViews, entities, examples] = await Promise.all([
    ctx.queryOne(
      `SELECT id, name, description, status, updated_at FROM projects
        WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
      [projectId],
    ).catch(() => null),
    rows(ctx,
      `SELECT id, source_type, source_id, updated_at FROM business_data_sources
        WHERE project_id=$1 AND deleted_at IS NULL ORDER BY id`,
      [projectId]),
    rows(ctx,
      `SELECT id, name, db_type, database, host, schema_config, business_rules, updated_at FROM database_connections
        WHERE project_id=$1 AND deleted_at IS NULL ORDER BY id`,
      [projectId]),
    rows(ctx,
      `SELECT t.id, t.database_connection_id, t.schema_name, t.table_name, t.table_type,
              t.is_view, t.is_materialized
         FROM table_metadata t
         JOIN database_connections c ON c.id=t.database_connection_id AND c.deleted_at IS NULL
        WHERE c.project_id=$1 AND t.deleted_at IS NULL ORDER BY t.id`,
      [projectId]),
    rows(ctx,
      `SELECT c.id, c.table_id, c.column_name, c.data_type, c.is_nullable,
              c.is_primary_key, c.is_foreign_key, c.is_unique
         FROM column_metadata c
         JOIN table_metadata t ON t.id=c.table_id AND t.deleted_at IS NULL
         JOIN database_connections d ON d.id=t.database_connection_id AND d.deleted_at IS NULL
        WHERE d.project_id=$1 AND c.deleted_at IS NULL ORDER BY c.id`,
      [projectId]),
    rows(ctx,
      `SELECT id, rule_type, content, version, updated_at
         FROM project_rules WHERE project_id=$1 ORDER BY rule_type, id`,
      [projectId]),
    rows(ctx,
      `SELECT p.id, p.category, p.llm_model_id, p.updated_at,
              m.model_name, m.api_format, m.category AS model_category, m.updated_at AS model_updated_at
         FROM project_model_configs p
         LEFT JOIN llm_models m ON m.id=p.llm_model_id AND m.deleted_at IS NULL
        WHERE p.project_id=$1 AND p.deleted_at IS NULL ORDER BY p.category, p.id`,
      [projectId]),
    rows(ctx,
      `SELECT id, name, description, aliases, related_tables, related_columns,
              code_knowledge, is_active, updated_at
         FROM metric_definitions WHERE project_id=$1 AND deleted_at IS NULL ORDER BY id`,
      [projectId]),
    rows(ctx,
      `SELECT id, metric_id, plan_type, source_id, source_type, spec, evidence_policy,
              priority, version, is_active, updated_at
         FROM metric_execution_plans
        WHERE project_id=$1 AND deleted_at IS NULL ORDER BY metric_id, priority, id`,
      [projectId]),
    rows(ctx,
      `SELECT id, source_id, name, description, aliases, tables, fixed_predicates,
              query_dimensions, time_dimension, projections, group_by, sort_spec, status, updated_at
         FROM metric_view_definitions WHERE project_id=$1 AND deleted_at IS NULL ORDER BY id`,
      [projectId]),
    rows(ctx,
      `SELECT e.id, e.database_connection_id, e.source_id, e.source_type, e.table_name,
              e.column_name, e.schema_name, e.config_name, e.entity_type, e.metadata_fields,
              e.is_active, e.rule, e.updated_at
         FROM entity_mapping_configs e
         LEFT JOIN database_connections c ON c.id=e.database_connection_id AND c.deleted_at IS NULL
        WHERE e.deleted_at IS NULL AND (e.project_id=$1 OR c.project_id=$1) ORDER BY e.id`,
      [projectId]),
    rows(ctx,
      `SELECT id, example_type, question, content, description, is_active,
              source_id, source_type, updated_at
         FROM examples WHERE project_id=$1 AND deleted_at IS NULL ORDER BY id`,
      [projectId]),
  ]);
  const skills = await listEnabledSkills(ctx, projectId).catch(() => []);
  return {
    project: project ? compactRows([project], ["id", "name", "description", "status", "updated_at"])[0] : null,
    data_sources: {
      bindings: compactRows(bindings, ["id", "source_type", "source_id", "updated_at"]),
      connections: connections.map((connection) => ({
        ...Object.fromEntries(["id", "name", "db_type", "schema_config", "business_rules", "updated_at"].map((field) => [field, connection?.[field] ?? null])),
        location_hash: hash(connection?.database || connection?.host || connection?.id || null),
      })),
      tables: compactRows(tables, ["id", "database_connection_id", "schema_name", "table_name", "table_type", "is_view", "is_materialized"]),
      columns: compactRows(columns, ["id", "table_id", "column_name", "data_type", "is_nullable", "is_primary_key", "is_foreign_key", "is_unique"]),
    },
    project_rules: projectRules.map((rule) => ({
      id: rule.id,
      rule_type: rule.rule_type,
      content: rule.content || "",
      version: rule.version || null,
      updated_at: rule.updated_at || null,
    })),
    models: {
      selected: selectedModelSnapshot(selectedModel),
      bindings: compactRows(modelBindings, ["id", "category", "llm_model_id", "model_name", "api_format", "model_category", "updated_at", "model_updated_at"]),
    },
    skills: skills.map(skillSnapshot).sort((left, right) => String(left.name).localeCompare(String(right.name))),
    runtime: { kind: "dsh_profile", profile: "web" },
    semantic: {
      metrics: metrics.map((item) => ({
        ...item,
        aliases: parseJson(item.aliases, item.aliases),
        related_tables: parseJson(item.related_tables, item.related_tables),
        related_columns: parseJson(item.related_columns, item.related_columns),
      })),
      metric_execution_plans: metricPlans.map((item) => ({
        ...item,
        spec: parseJson(item.spec, item.spec),
        evidence_policy: parseJson(item.evidence_policy, item.evidence_policy),
      })),
      metric_views: metricViews.map((item) => ({
        ...item,
        aliases: parseJson(item.aliases, item.aliases),
        tables: parseJson(item.tables, item.tables),
        fixed_predicates: parseJson(item.fixed_predicates, item.fixed_predicates),
        query_dimensions: parseJson(item.query_dimensions, item.query_dimensions),
        projections: parseJson(item.projections, item.projections),
        group_by: parseJson(item.group_by, item.group_by),
        sort_spec: parseJson(item.sort_spec, item.sort_spec),
      })),
      entities: entities.map((item) => ({ ...item, metadata_fields: parseJson(item.metadata_fields, item.metadata_fields) })),
      examples,
    },
  };
}

function comparableSnapshot(snapshot) {
  return {
    version: snapshot?.version,
    project_id: snapshot?.project_id,
    environment: snapshot?.environment,
    permissions: snapshot?.permissions,
    automation: snapshot?.automation,
  };
}

export async function readRunEnvironmentSnapshot(runId) {
  const workspace = await readAgentRunWorkspace(runId);
  const path = join(workspace.input, "environment.snapshot.json");
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    throw snapshotConflict("运行环境快照不是有效的 JSON");
  }
  if (snapshot?.version !== RUN_ENVIRONMENT_SNAPSHOT_VERSION || snapshot?.run_id !== runId) {
    throw snapshotConflict("运行环境快照与当前运行不一致");
  }
  if (snapshot.snapshot_hash !== hash(comparableSnapshot(snapshot))) {
    throw snapshotConflict("运行环境快照指纹校验失败");
  }
  return { ...snapshot, path };
}

export async function captureRunEnvironmentSnapshot(ctx, {
  runId,
  sessionId,
  projectId,
  selectedModel = null,
  approvalMode = "ask",
  approvalPolicy = "on-request",
  approvalsReviewer = "user",
  sandboxPolicy = null,
  automation = null,
} = {}) {
  if (!(ctx?.query && ctx?.queryOne && runId && projectId)) return null;
  const workspace = await readAgentRunWorkspace(runId);
  const path = join(workspace.input, "environment.snapshot.json");
  try {
    const existing = await readRunEnvironmentSnapshot(runId);
    await ctx.query(
      `UPDATE agent_runs SET environment_snapshot_path=$2, environment_snapshot_version=$3,
         environment_snapshot_hash=$4, updated_at=now() WHERE id=$1`,
      [runId, path, RUN_ENVIRONMENT_SNAPSHOT_VERSION, existing.snapshot_hash],
    );
    return existing;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const environment = await buildProjectEnvironment(ctx, projectId, selectedModel);
  const comparable = {
    version: RUN_ENVIRONMENT_SNAPSHOT_VERSION,
    project_id: projectId,
    environment,
    permissions: {
      approval_mode: approvalMode || "ask",
      approval_policy: approvalPolicy || "ask",
      approvals_reviewer: approvalsReviewer || "user",
      sandbox: sandboxPolicy || {
        mode: "workspace-write",
        system_enforced: true,
        network: "blocked",
      },
    },
    automation: automation
      ? {
          version: automation.version || null,
          id: automation.id || null,
          name: automation.name || null,
          prompt: automation.prompt || null,
          destination: automation.destination || null,
          skills: Array.isArray(automation.skills) ? automation.skills : [],
          skill_snapshot: Array.isArray(automation.skill_snapshot) ? automation.skill_snapshot : [],
          schedule: automation.schedule || null,
          missed_policy: automation.missed_policy || null,
          monitor_policy: automation.monitor_policy || null,
          sandbox_policy: automation.sandbox_policy || null,
          snapshot_policy: automation.snapshot_policy || null,
          permission_policy: automation.permission_policy || null,
          trigger: automation.trigger || null,
          scheduled_for: automation.scheduled_for || null,
        }
      : null,
  };
  const snapshot = {
    ...comparable,
    run_id: runId,
    session_id: sessionId || null,
    captured_at: new Date().toISOString(),
    snapshot_hash: hash(comparable),
  };
  try {
    await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readRunEnvironmentSnapshot(runId);
    await ctx.query(
      `UPDATE agent_runs SET environment_snapshot_path=$2, environment_snapshot_version=$3,
         environment_snapshot_hash=$4, updated_at=now() WHERE id=$1`,
      [runId, path, RUN_ENVIRONMENT_SNAPSHOT_VERSION, existing.snapshot_hash],
    );
    return existing;
  }
  await ctx.query(
    `UPDATE agent_runs SET environment_snapshot_path=$2, environment_snapshot_version=$3,
       environment_snapshot_hash=$4, updated_at=now() WHERE id=$1`,
    [runId, path, RUN_ENVIRONMENT_SNAPSHOT_VERSION, snapshot.snapshot_hash],
  );
  await appendRunEvent(ctx, {
    runId,
    turnId: runId,
    eventType: "environment_snapshot_created",
    status: null,
    metadata: { version: RUN_ENVIRONMENT_SNAPSHOT_VERSION, path, snapshot_hash: snapshot.snapshot_hash },
  });
  return { ...snapshot, path };
}

export function environmentSnapshotRef(snapshot) {
  if (!snapshot) return null;
  return {
    version: snapshot.version || RUN_ENVIRONMENT_SNAPSHOT_VERSION,
    snapshot_hash: snapshot.snapshot_hash || null,
    captured_at: snapshot.captured_at || null,
  };
}

export default {
  RUN_ENVIRONMENT_SNAPSHOT_VERSION,
  captureRunEnvironmentSnapshot,
  environmentSnapshotRef,
  readRunEnvironmentSnapshot,
};

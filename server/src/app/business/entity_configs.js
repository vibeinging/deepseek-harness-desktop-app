// L1 use-case layer for Entity Refs / Entity Configs / Entity Mappings, aligned line-by-line with routes/business_crud.js.
// Signature is always async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
//
// Coverage (implemented):
//   Entity Refs: GET /GET available/POST/DELETE /entity_refs[/:refId], PATCH /:refId/active
//   Entity Configs: POST create/generate_embeddings, PUT/DELETE /entity_configs/:cid
//   Entity Mappings: create/search/import/test/revert/delete
//
// Note: app/business/ is one layer deeper than routes/, so engine/db uses ../../.
import { ApiError } from "../../errors.js";
import { DatabaseEntityService } from "../../engine/semantic/entity_service.js";
import { EntityServiceBase } from "../../engine/semantic/entity_service_base.js";
import { EntityAgentService } from "../../engine/semantic/entity_agent_service.js";
import { DatabaseDataSource } from "../../engine/datasources/database_data_source.js";
import { assertBusiness } from "./business.js";

// ════════════════════════════════════════════
// Entity Refs (business_entity_configs)
// ════════════════════════════════════════════

// GET /api/projects/:pid/businesses/:bid/entity_refs — list referenced entity configs
export async function listEntityRefs(ctx, input) {
  const { pid } = input.params;
  const rows = await ctx.query(
    `SELECT bec.id, bec.project_id, bec.entity_config_id, bec.is_active,
            bec.created_at, bec.updated_at,
            emc.config_name, emc.import_type, emc.source_id, emc.source_type,
            emc.table_name, emc.column_name, emc.entity_type, emc.rule,
            emc.is_active AS config_is_active
       FROM business_entity_configs bec
       JOIN entity_mapping_configs emc ON emc.id = bec.entity_config_id AND emc.deleted_at IS NULL
      WHERE bec.project_id=$1 AND bec.deleted_at IS NULL
      ORDER BY bec.created_at DESC`,
    [pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取实体引用成功" };
}

// GET /api/projects/:pid/businesses/:bid/entity_refs/available — available entity configs
export async function listAvailableEntityRefs(ctx, input) {
  const { pid } = input.params;
  // Get entity configs under project-bound database sources, excluding already referenced ones
  const alreadyReferenced = await ctx.query(
    `SELECT entity_config_id FROM business_entity_configs WHERE project_id=$1 AND deleted_at IS NULL`,
    [pid],
  );
  const refIds = alreadyReferenced.map((r) => r.entity_config_id);

  // Get database-type data sources for this project
  const dbSources = await ctx.query(
    `SELECT source_id FROM business_data_sources
      WHERE project_id=$1 AND source_type='database_connection' AND deleted_at IS NULL`,
    [pid],
  );
  const dbIds = dbSources.map((r) => r.source_id);
  if (!dbIds.length) return { data: { items: [], total: 0 }, message: "无可用实体配置" };

  let sql = `SELECT id, config_name, import_type, source_id, source_type,
                    table_name, column_name, entity_type, rule, is_active, created_at
               FROM entity_mapping_configs
              WHERE database_connection_id::text = ANY($1::text[]) AND deleted_at IS NULL AND import_type != 'excel'`;
  const params = [dbIds];
  if (refIds.length) {
    sql += ` AND id != ALL($2)`;
    params.push(refIds);
  }
  sql += ` ORDER BY created_at DESC`;
  const rows = await ctx.query(sql, params);
  return { data: { items: rows, total: rows.length }, message: "获取可用实体配置成功" };
}

// POST /api/projects/:pid/businesses/:bid/entity_refs — add entity refs
export async function addEntityRefs(ctx, input) {
  const { pid } = input.params;
  const b = await assertBusiness(pid, pid);
  if (!b) throw new ApiError("业务不存在", 404);
  const { entity_config_ids } = input.body || {};
  if (!Array.isArray(entity_config_ids) || !entity_config_ids.length)
    throw new ApiError("entity_config_ids 不能为空", 400);

  let added = 0;
  for (const configId of entity_config_ids) {
    const existing = await ctx.queryOne(
      `SELECT id FROM business_entity_configs
        WHERE project_id=$1 AND entity_config_id=$2 AND deleted_at IS NULL`,
      [pid, configId],
    );
    if (existing) continue;
    // Restore if there is a soft-deleted reference
    const softDeleted = await ctx.queryOne(
      `SELECT id FROM business_entity_configs
        WHERE project_id=$1 AND entity_config_id=$2 AND deleted_at IS NOT NULL`,
      [pid, configId],
    );
    if (softDeleted) {
      await ctx.query(
        `UPDATE business_entity_configs SET deleted_at=NULL, is_active=true, updated_at=now() WHERE id=$1`,
        [softDeleted.id],
      );
    } else {
      const id = crypto.randomUUID();
      await ctx.query(
        `INSERT INTO business_entity_configs (id, project_id, entity_config_id, is_active, created_at, updated_at)
         VALUES ($1,$2,$3,true,now(),now())`,
        [id, pid, configId],
      );
    }
    added++;
  }
  return { data: { added }, message: `成功添加 ${added} 个实体配置引用` };
}

// DELETE /api/projects/:pid/businesses/:bid/entity_refs/:refId — remove entity ref
export async function removeEntityRef(ctx, input) {
  const { pid, refId } = input.params;
  await ctx.query(
    `UPDATE business_entity_configs SET deleted_at=now(), updated_at=now()
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [refId, pid],
  );
  return { data: null, message: "移除实体配置引用成功" };
}

// PATCH /api/projects/:pid/businesses/:bid/entity_refs/:refId/active — toggle active state
export async function toggleEntityRefActive(ctx, input) {
  const { pid, refId } = input.params;
  const { is_active } = input.body || {};
  if (is_active === undefined) throw new ApiError("is_active 不能为空", 400);
  await ctx.query(
    `UPDATE business_entity_configs SET is_active=$1, updated_at=now()
      WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL`,
    [!!is_active, refId, pid],
  );
  return { data: { updated: true }, message: is_active ? "已启用" : "已禁用" };
}

// ════════════════════════════════════════════
// Entity Configs (entity_mapping_configs)
// ════════════════════════════════════════════

// POST /api/projects/:pid/businesses/:bid/entity_configs/generate_embeddings — generate entity embeddings per bound connection
export async function generateEntityConfigEmbeddings(ctx, input) {
  const { pid } = input.params;
  const configId = input.query?.config_id || input.body?.config_id || null;
  const svcCtx = { query: ctx.query, queryOne: ctx.queryOne };
  const params = [pid];
  let configFilter = "project_id=$1 AND deleted_at IS NULL AND is_active=true";
  if (configId) { params.push(configId); configFilter += ` AND id=$${params.length}`; }
  const configs = await ctx.query(
    `SELECT id, source_id FROM entity_mapping_configs WHERE ${configFilter}`,
    params,
  );
  if (configId && !configs.length) throw new ApiError("实体配置不存在", 404);
  let total = 0; let processed = 0;
  for (const config of configs) {
    const r = await DatabaseEntityService.generate_entity_embeddings(svcCtx, config.source_id, pid, { config_id: config.id });
    if (r.success === false) throw new ApiError(r.message || "实体向量生成失败", 503);
    total += r.total || 0; processed += r.processed || 0;
  }
  if (total === 0 && configs.length) {
    const pending = await ctx.queryOne(
      `SELECT COUNT(*) AS cnt FROM entity_mappings
        WHERE config_id::text = ANY($1::text[]) AND deleted_at IS NULL AND embedding IS NULL`,
      [configs.map((config) => config.id)],
    );
    total = Number(pending?.cnt || 0);
  }
  if (total > 0 && processed === 0) throw new ApiError("实体向量未生成，请检查向量模型配置", 503);
  return { data: { total, processed, configs: configs.length }, message: "实体向量生成" };
}

// POST /api/projects/:pid/entity_configs — extract column values from a bound database source.
export async function createEntityConfig(ctx, input) {
  const { pid } = input.params;
  const { source_id, source_type = "database", table_id, column_name, metadata_fields, rule } = input.body || {};
  if (!source_id || !table_id || !column_name) throw new ApiError("source_id、table_id 和 column_name 为必填项", 400);
  let connectionId = source_id;
  if (source_type === "structured") {
    const structured = await ctx.queryOne(
      `SELECT database_connection_id FROM structured_data_sources
        WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
      [source_id, pid],
    );
    if (!structured) throw new ApiError("结构化数据源未绑定到当前项目", 404);
    const table = await ctx.queryOne(
      `SELECT database_connection_id FROM table_metadata WHERE id=$1 AND deleted_at IS NULL`,
      [table_id],
    );
    if (!table?.database_connection_id) throw new ApiError("结构化表不存在", 404);
    if (String(table.database_connection_id) !== String(structured.database_connection_id)) {
      throw new ApiError("表与结构化数据源不匹配", 400);
    }
    connectionId = table.database_connection_id;
  } else {
    const connection = await ctx.queryOne(
      `SELECT id FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
      [source_id, pid],
    );
    if (!connection) throw new ApiError("数据库连接未绑定到当前项目", 404);
  }
  const dataSource = new DatabaseDataSource(null, pid, connectionId);
  const result = await DatabaseEntityService.extract_column_value_entities(
    { query: ctx.query, queryOne: ctx.queryOne, dataSource },
    source_id, source_type, table_id, column_name, pid, { metadata_fields, rule },
  );
  return { data: result, message: result.message || "实体抽取完成" };
}

// POST /api/projects/:pid/entity_mappings/column_names
export async function createColumnNameEntities(ctx, input) {
  const { pid } = input.params;
  const { table_id, source_type = "database", columns, rule } = input.body || {};
  if (!table_id || !Array.isArray(columns) || !columns.length) throw new ApiError("table_id 和 columns 不能为空", 400);
  const table = await ctx.queryOne(
    `SELECT t.id FROM table_metadata t JOIN database_connections dc ON dc.id=t.database_connection_id
      WHERE t.id=$1 AND dc.project_id=$2 AND t.deleted_at IS NULL AND dc.deleted_at IS NULL`,
    [table_id, pid],
  );
  if (!table) throw new ApiError("表不存在或不属于当前项目", 404);
  const result = await DatabaseEntityService.create_column_name_entities(
    { query: ctx.query, queryOne: ctx.queryOne }, pid, table_id, source_type, columns, { rule },
  );
  return { data: result, message: result.message || "字段名词创建完成" };
}

// POST /api/projects/:pid/entities/search
export async function searchEntities(ctx, input) {
  const { pid } = input.params;
  const queryText = String(input.body?.query || input.query?.query || "").trim();
  if (!queryText) throw new ApiError("query 不能为空", 400);
  const limit = Math.min(100, Math.max(1, Number(input.body?.limit || input.query?.limit || 10)));
  const configs = await ctx.query(
    `SELECT id FROM entity_mapping_configs WHERE project_id=$1 AND deleted_at IS NULL AND is_active=true`,
    [pid],
  );
  if (!configs.length) return { data: { items: [], total: 0 }, message: "当前项目没有可搜索的实体配置" };
  let items;
  try {
    items = await EntityServiceBase.search_similar_entities(
      { query: ctx.query, queryOne: ctx.queryOne }, null, queryText, pid,
      { config_ids: configs.map((row) => row.id), limit, throw_on_error: true },
    );
  } catch (error) {
    throw new ApiError(`实体搜索失败: ${error?.message || error}`, 503);
  }
  return { data: { items, total: items.length }, message: "实体搜索完成" };
}

// POST /api/projects/:pid/entity_mappings/test_agent
export async function testEntityAgent(ctx, input) {
  const { pid } = input.params;
  const question = String(input.body?.question || "").trim();
  if (!question) throw new ApiError("question 不能为空", 400);
  if (question.length > 2000) throw new ApiError("question 不能超过 2000 个字符", 400);
  const search = await searchEntities(ctx, { ...input, body: { query: question, limit: 30 } });
  try {
    const result = await EntityAgentService.run({
      projectId: pid,
      question,
      candidates: search.data.items,
    });
    return {
      data: result,
      message: result.entities.length ? "AI 实体识别和替换完成" : "未识别到明确实体",
    };
  } catch (error) {
    throw new ApiError(error?.message || "AI 实体识别失败", 503);
  }
}

// POST /api/projects/:pid/entities/import_excel — renderer sends parsed rows as JSON.
export async function importEntities(ctx, input) {
  const { pid } = input.params;
  const entities = input.body?.entities || input.body?.rows;
  const configName = String(input.body?.config_name || input.body?.name || "Excel 导入").trim();
  if (!Array.isArray(entities) || !entities.length) throw new ApiError("entities 不能为空", 400);
  const result = await DatabaseEntityService.import_entities_from_excel(
    { query: ctx.query, queryOne: ctx.queryOne }, pid, entities, configName, { rule: input.body?.rule || null },
  );
  return { data: result, message: result.message || "实体导入完成" };
}

// POST /api/projects/:pid/entity_mappings/revert_auto_promoted
export async function revertAutoPromoted(ctx, input) {
  const { pid } = input.params;
  const configs = await ctx.query(
    `SELECT id FROM entity_mapping_configs WHERE project_id=$1 AND auto_promoted=true AND deleted_at IS NULL`,
    [pid],
  );
  const configIds = configs.map((row) => row.id);
  if (configIds.length) {
    await ctx.query(
      `UPDATE entity_mappings SET deleted_at=now(), updated_at=now()
        WHERE config_id::text = ANY($1::text[]) AND deleted_at IS NULL`,
      [configIds],
    );
    await ctx.query(
      `UPDATE entity_mapping_configs SET deleted_at=now(), updated_at=now()
        WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
      [configIds],
    );
  }
  const loose = await ctx.query(
    `SELECT id FROM entity_mappings WHERE project_id=$1 AND auto_promoted=true AND deleted_at IS NULL`,
    [pid],
  );
  if (loose.length) {
    await ctx.query(
      `UPDATE entity_mappings SET deleted_at=now(), updated_at=now()
        WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
      [loose.map((row) => row.id)],
    );
  }
  return { data: { reverted_count: configIds.length + loose.length }, message: "已撤销自动生成的实体" };
}

// PUT /api/projects/:pid/businesses/:bid/entity_configs/:cid — update entity config
export async function updateEntityConfig(ctx, input) {
  const { pid, cid } = input.params;
  const { rule, is_active } = input.body || {};
  const sets = ["updated_at=now()"];
  const vals = [];
  if (rule !== undefined) { sets.push(`rule=$${vals.length + 1}`); vals.push(rule); }
  if (is_active !== undefined) { sets.push(`is_active=$${vals.length + 1}`); vals.push(!!is_active); }
  if (sets.length === 1) throw new ApiError("没有可更新的字段", 400);
  vals.push(cid, pid);
  await ctx.query(`UPDATE entity_mapping_configs SET ${sets.join(",")}
    WHERE id=$${vals.length - 1} AND project_id=$${vals.length} AND deleted_at IS NULL`, vals);
  return { data: { updated: true }, message: "更新成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/entity_configs/:cid — delete entity config
export async function deleteEntityConfig(ctx, input) {
  const { pid, cid } = input.params;
  // Delete references in business_entity_configs
  await ctx.query(
    `UPDATE business_entity_configs SET deleted_at=now(), updated_at=now()
      WHERE project_id=$1 AND entity_config_id=$2 AND deleted_at IS NULL`,
    [pid, cid],
  );
  // Soft delete the config record itself
  await ctx.query(
    `UPDATE entity_mapping_configs SET deleted_at=now(), updated_at=now()
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  );
  return { data: null, message: "删除配置成功" };
}

// ════════════════════════════════════════════
// Entity Mappings (entities)
// ════════════════════════════════════════════

// DELETE /api/projects/:pid/businesses/:bid/entities — batch delete entity mappings
export async function deleteEntities(ctx, input) {
  const { pid } = input.params;
  const { entity_ids } = input.body || {};
  if (!Array.isArray(entity_ids) || !entity_ids.length)
    throw new ApiError("entity_ids 不能为空", 400);
  const existing = await ctx.query(
    `SELECT id FROM entity_mappings WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
    [pid, entity_ids],
  );
  const deleted_count = existing.length;
  if (deleted_count) {
    await ctx.query(
      `UPDATE entity_mappings SET deleted_at=now(), updated_at=now()
        WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
      [pid, entity_ids],
    );
  }
  return { data: { deleted_count }, message: `成功删除 ${deleted_count} 个实体` };
}

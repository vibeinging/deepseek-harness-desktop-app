import { ApiError } from "../../errors.js";

function requiredId(value) {
  return String(value ?? "").trim();
}

export async function requireProjectDatabaseConnection(ctx, projectId, connectionId) {
  const pid = requiredId(projectId);
  const cid = requiredId(connectionId);
  if (!pid || !cid) throw new ApiError("数据库连接不存在", 404);
  const row = await ctx.queryOne(
    `SELECT id FROM database_connections
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [cid, pid],
  );
  if (!row) throw new ApiError("数据库连接不存在", 404);
  return row;
}

export async function requireProjectTable(ctx, projectId, connectionId, tableId) {
  const pid = requiredId(projectId);
  const cid = requiredId(connectionId);
  const tid = requiredId(tableId);
  if (!pid || !cid || !tid) throw new ApiError("表不存在", 404);
  const row = await ctx.queryOne(
    `SELECT t.id
       FROM table_metadata t
       JOIN database_connections d ON d.id=t.database_connection_id AND d.deleted_at IS NULL
      WHERE t.id=$1 AND t.database_connection_id=$2 AND d.project_id=$3
        AND t.deleted_at IS NULL`,
    [tid, cid, pid],
  );
  if (!row) throw new ApiError("表不存在", 404);
  return row;
}

export async function requireProjectTables(ctx, projectId, connectionId, tableIds) {
  const ids = [...new Set((tableIds || []).map(requiredId).filter(Boolean))];
  if (!ids.length) {
    await requireProjectDatabaseConnection(ctx, projectId, connectionId);
    return [];
  }
  const pid = requiredId(projectId);
  const cid = requiredId(connectionId);
  const rows = await ctx.query(
    `SELECT t.id
       FROM table_metadata t
       JOIN database_connections d ON d.id=t.database_connection_id AND d.deleted_at IS NULL
      WHERE t.id::text = ANY($1::text[]) AND t.database_connection_id=$2 AND d.project_id=$3
        AND t.deleted_at IS NULL`,
    [ids, cid, pid],
  );
  if (new Set(rows.map((row) => String(row.id))).size !== ids.length) {
    throw new ApiError("表不存在", 404);
  }
  return ids;
}

export async function requireProjectColumn(ctx, projectId, connectionId, columnId, tableId = null) {
  const pid = requiredId(projectId);
  const cid = requiredId(connectionId);
  const colid = requiredId(columnId);
  const tid = requiredId(tableId);
  if (!pid || !cid || !colid) throw new ApiError("列不存在", 404);
  const params = [colid, cid, pid];
  const tableFilter = tid ? ` AND t.id=$${params.push(tid)}` : "";
  const row = await ctx.queryOne(
    `SELECT c.id
       FROM column_metadata c
       JOIN table_metadata t ON t.id=c.table_id AND t.deleted_at IS NULL
       JOIN database_connections d ON d.id=t.database_connection_id AND d.deleted_at IS NULL
      WHERE c.id=$1 AND t.database_connection_id=$2 AND d.project_id=$3
        AND c.deleted_at IS NULL${tableFilter}`,
    params,
  );
  if (!row) throw new ApiError("列不存在", 404);
  return row;
}

export async function requireProjectRelationship(ctx, projectId, connectionId, relationshipId) {
  const pid = requiredId(projectId);
  const cid = requiredId(connectionId);
  const rid = requiredId(relationshipId);
  if (!pid || !cid || !rid) throw new ApiError("关系不存在", 404);
  const row = await ctx.queryOne(
    `SELECT r.id
       FROM relationship_metadata r
       JOIN database_connections d ON d.id=r.database_connection_id AND d.deleted_at IS NULL
      WHERE r.id=$1 AND r.database_connection_id=$2 AND d.project_id=$3
        AND r.deleted_at IS NULL`,
    [rid, cid, pid],
  );
  if (!row) throw new ApiError("关系不存在", 404);
  return row;
}

export async function requireProjectEntityConfig(ctx, projectId, connectionId, configId) {
  const pid = requiredId(projectId);
  const cid = requiredId(connectionId);
  const id = requiredId(configId);
  if (!pid || !cid || !id) throw new ApiError("实体配置不存在", 404);
  const row = await ctx.queryOne(
    `SELECT cfg.id
       FROM entity_mapping_configs cfg
       JOIN database_connections d ON d.id=cfg.source_id AND d.deleted_at IS NULL
      WHERE cfg.id=$1 AND cfg.source_id=$2 AND cfg.source_type='database'
        AND d.project_id=$3 AND COALESCE(cfg.project_id, d.project_id)=$3
        AND cfg.deleted_at IS NULL`,
    [id, cid, pid],
  );
  if (!row) throw new ApiError("实体配置不存在", 404);
  return row;
}

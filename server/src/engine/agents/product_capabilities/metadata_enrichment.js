import {
  generateColumnsDescriptionsUseCase,
  generateDatabaseDescription,
  storeVectors,
} from "../../../app/datasource/tables.js";

function clean(value, maxLength = 240) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function same(left, right) {
  return clean(left).toLowerCase() === clean(right).toLowerCase();
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function tableRef(row) {
  const schema = clean(row.schema_name, 128);
  return schema && !["default", "main"].includes(schema.toLowerCase())
    ? `${schema}.${row.table_name}`
    : row.table_name;
}

async function listProjectConnections(ctx, projectId, params = {}) {
  const rows = await ctx.query(
    `SELECT id, name, db_type, database AS database_name, description
       FROM database_connections
      WHERE project_id=$1 AND deleted_at IS NULL
      ORDER BY name, created_at`,
    [projectId],
  );
  const requestedId = clean(params.connection_id, 128);
  const requestedName = clean(params.connection_name || params.database_name, 240);
  return rows.filter((row) => {
    if (requestedId && String(row.id) !== requestedId) return false;
    if (requestedName && !same(row.name, requestedName) && !same(row.database_name, requestedName)) return false;
    return true;
  });
}

async function loadConnectionTables(ctx, connectionId) {
  const rows = await ctx.query(
    `SELECT t.id AS table_id, t.table_name, t.schema_name, t.description AS table_description,
            t.embedding AS table_embedding,
            c.id AS column_id, c.description AS column_description, c.embedding AS column_embedding
       FROM table_metadata t
       LEFT JOIN column_metadata c ON c.table_id=t.id AND c.deleted_at IS NULL
      WHERE t.database_connection_id=$1 AND t.deleted_at IS NULL
      ORDER BY t.schema_name, t.table_name, c.column_name`,
    [connectionId],
  );
  const byId = new Map();
  for (const row of rows) {
    const id = String(row.table_id);
    let table = byId.get(id);
    if (!table) {
      table = {
        table_id: id,
        table_name: row.table_name,
        table_ref: tableRef(row),
        schema_name: row.schema_name || null,
        has_description: hasValue(row.table_description),
        has_vector: hasValue(row.table_embedding),
        column_count: 0,
        columns_with_description: 0,
        columns_with_vector: 0,
      };
      byId.set(id, table);
    }
    if (row.column_id) {
      table.column_count += 1;
      if (hasValue(row.column_description)) table.columns_with_description += 1;
      if (hasValue(row.column_embedding)) table.columns_with_vector += 1;
    }
  }
  return [...byId.values()];
}

function selectTables(tables, params = {}) {
  const trustedIds = Array.isArray(params.table_ids)
    ? [...new Set(params.table_ids.map((item) => clean(item, 128)).filter(Boolean))]
    : [];
  if (trustedIds.length) {
    const byId = new Map(tables.map((table) => [table.table_id, table]));
    const selected = trustedIds.map((id) => byId.get(id)).filter(Boolean);
    if (selected.length !== trustedIds.length) throw new Error("table_ids 中包含不属于目标数据库的表");
    return selected;
  }
  const names = Array.isArray(params.table_names)
    ? [...new Set(params.table_names.map((item) => clean(item, 256)).filter(Boolean))]
    : [];
  if (!names.length) return tables;
  return tables.filter((table) => names.some((name) => same(name, table.table_name) || same(name, table.table_ref)));
}

function summarizeTables(tables) {
  return {
    table_count: tables.length,
    column_count: tables.reduce((sum, table) => sum + table.column_count, 0),
    tables_with_description: tables.filter((table) => table.has_description).length,
    columns_with_description: tables.reduce((sum, table) => sum + table.columns_with_description, 0),
    tables_with_vector: tables.filter((table) => table.has_vector).length,
    columns_with_vector: tables.reduce((sum, table) => sum + table.columns_with_vector, 0),
  };
}

export async function previewMetadataEnrichment(ctx, projectId, params = {}) {
  if (!projectId) throw new Error("缺少 project_id");
  const connections = await listProjectConnections(ctx, projectId, params);
  if (connections.length !== 1) {
    return {
      success: false,
      needs_clarification: true,
      error: connections.length ? "找到多个数据库，需要先确认目标" : "当前项目中没有找到目标数据库",
      candidates: connections.slice(0, 20).map((row) => ({
        connection_id: String(row.id),
        connection_name: row.name,
        database_name: row.database_name || "",
        db_type: row.db_type || "",
      })),
    };
  }
  const connection = connections[0];
  const allTables = await loadConnectionTables(ctx, connection.id);
  const requestedTableNames = Array.isArray(params.table_names)
    ? params.table_names.map((item) => clean(item, 256)).filter(Boolean)
    : [];
  const ambiguousTables = requestedTableNames.flatMap((name) => {
    const matches = allTables.filter((table) => same(name, table.table_name) || same(name, table.table_ref));
    return matches.length > 1 && !name.includes(".") ? matches : [];
  });
  if (ambiguousTables.length) {
    return {
      success: false,
      needs_clarification: true,
      error: "找到多个同名表，需要先确认 schema",
      candidates: ambiguousTables.slice(0, 50),
    };
  }
  const missingTableNames = requestedTableNames.filter((name) => (
    !allTables.some((table) => same(name, table.table_name) || same(name, table.table_ref))
  ));
  if (missingTableNames.length) {
    return {
      success: false,
      needs_clarification: true,
      error: `目标数据库中没有找到这些表: ${missingTableNames.join("、")}`,
      candidates: allTables.slice(0, 50),
    };
  }
  const selected = selectTables(allTables, params);
  if (!selected.length) {
    return {
      success: false,
      needs_clarification: true,
      error: "目标数据库中没有找到指定的表",
      candidates: allTables.slice(0, 50),
    };
  }
  return {
    success: true,
    needs_clarification: false,
    project_id: projectId,
    target: {
      connection_id: String(connection.id),
      connection_name: connection.name,
      database_name: connection.database_name || "",
      db_type: connection.db_type || "",
      has_database_description: hasValue(connection.description),
      table_ids: selected.map((table) => table.table_id),
      tables: selected,
      ...summarizeTables(selected),
    },
  };
}

function stepResult(status, data = null, error = null) {
  return { status, data, error };
}

async function runStep(fn) {
  try {
    const data = await fn();
    const reported = ["completed", "partial", "failed"].includes(data?.status)
      ? data.status
      : "completed";
    return stepResult(reported, data, reported === "failed" ? "底层流程未完成" : null);
  } catch (error) {
    return stepResult("failed", null, error?.message || String(error));
  }
}

export async function runMetadataEnrichment(
  ctx,
  projectId,
  params = {},
  {
    generateDescriptionsFn = generateColumnsDescriptionsUseCase,
    generateDatabaseDescriptionFn = generateDatabaseDescription,
    storeVectorsFn = storeVectors,
  } = {},
) {
  const connectionId = clean(params.connection_id, 128);
  if (!connectionId) throw new Error("connection_id 为必填项；请先调用 metadata_enrichment_preview");
  if (!Array.isArray(params.table_ids) || !params.table_ids.length) {
    throw new Error("table_ids 不能为空；请使用 metadata_enrichment_preview 返回的可信表 ID");
  }
  const preview = await previewMetadataEnrichment(ctx, projectId, {
    connection_id: connectionId,
    table_ids: params.table_ids,
  });
  if (!preview.success) throw new Error(preview.error || "目标数据库已经失效");
  if (params.connection_name && !same(params.connection_name, preview.target.connection_name)) {
    throw new Error("connection_name 与 connection_id 指向的真实数据库不一致");
  }

  const operation = clean(params.operation, 64);
  const validOperations = new Set([
    "table_column_descriptions",
    "database_description",
    "descriptions",
    "vectors",
    "all",
  ]);
  if (!validOperations.has(operation)) {
    throw new Error("operation 必须是 table_column_descriptions、database_description、descriptions、vectors 或 all");
  }
  const onlyPending = params.only_pending !== false;
  const tableIds = preview.target.table_ids;
  const steps = {};
  if (["table_column_descriptions", "descriptions", "all"].includes(operation)) {
    steps.table_and_column_descriptions = await runStep(async () => {
      const response = await generateDescriptionsFn(ctx, {
        params: { pid: projectId },
        query: {},
        body: {
          connection_id: connectionId,
          table_ids: tableIds,
          only_pending: onlyPending,
          extra_notes: clean(params.extra_notes, 2000) || null,
        },
      });
      return response?.data || response;
    });
  }
  if (["database_description", "descriptions", "all"].includes(operation)) {
    steps.database_description = await runStep(async () => {
      const response = await generateDatabaseDescriptionFn(ctx, {
        params: { pid: projectId, cid: connectionId },
        query: {},
        body: {},
      });
      return response?.data || response;
    });
  }
  if (["vectors", "all"].includes(operation)) {
    steps.schema_vectors = await runStep(async () => {
      const response = await storeVectorsFn(ctx, {
        params: { pid: projectId, cid: connectionId },
        query: {},
        body: { table_ids: tableIds, only_pending: onlyPending, scope: "all" },
      });
      return response?.data || response;
    });
  }

  const values = Object.values(steps);
  const completed = values.filter((step) => step.status === "completed").length;
  const failed = values.filter((step) => step.status === "failed").length;
  const status = completed === values.length
    ? "completed"
    : (failed === values.length ? "failed" : "partial");
  return {
    success: status !== "failed",
    status,
    project_id: projectId,
    operation,
    only_pending: onlyPending,
    target: preview.target,
    steps,
  };
}

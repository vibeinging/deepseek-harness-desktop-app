// L1 use-case layer for structured document import (local files -> DuckDB), aligned line-by-line with routes/structured_docs.js.
// Signature is always async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
// Desktop path uses local file_path (no upload): create registers path -> process parses into DuckDB
// + registers DuckDB connection + writes table_metadata/column_metadata -> list uses status polling.
import { randomUUID } from "node:crypto";
import { join, basename, extname } from "node:path";
import { existsSync } from "node:fs";
import { ApiError } from "../../errors.js";
import { duckImportFile, duckFormatForExt, sanitizeTableName } from "../../engine/datasources/duck.js";
import { enrichConnection } from "../../engine/semantic/enrich.js";
import { SchemaRetrievalService } from "../../engine/semantic/schema_retrieval_service.js";
import { resolveDataPreparationPolicy } from "../../engine/semantic/data_preparation_policy.js";
import { dataPath } from "../../config/paths.js";

const STRUCT_DIR = dataPath("structured");

function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  return [];
}

async function getStructuredConnection(ctx, pid, dsid) {
  if (!dsid) throw new ApiError("data_source_id 不能为空", 400);
  const ds = await ctx.queryOne(
    `SELECT id, database_connection_id FROM structured_data_sources
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  ).catch(() => null);
  if (!ds) throw new ApiError("结构化数据源不存在", 404);
  return ds.database_connection_id || null;
}

// Write DuckDB metadata (table_metadata + column_metadata) for query recall. Idempotent: same-name tables are rebuilt.
async function upsertDuckTable(ctx, connId, tableName, columns, rowCount) {
  const old = await ctx.queryOne(
    `SELECT id FROM table_metadata WHERE database_connection_id=$1 AND table_name=$2 AND deleted_at IS NULL`,
    [connId, tableName],
  );
  let tableId;
  if (old) {
    tableId = old.id;
    await ctx.query(`UPDATE table_metadata SET row_count=$1, updated_at=now() WHERE id=$2`, [rowCount ?? null, tableId]);
    await ctx.query(`UPDATE column_metadata SET deleted_at=now() WHERE table_id=$1 AND deleted_at IS NULL`, [tableId]);
  } else {
    tableId = randomUUID();
    await ctx.query(
      `INSERT INTO table_metadata (id, database_connection_id, schema_name, table_name, table_type, row_count, is_view, created_at, updated_at)
       VALUES ($1,$2,'main',$3,'BASE TABLE',$4,0,now(),now())`,
      [tableId, connId, tableName, rowCount ?? null],
    );
  }
  for (const col of columns || []) {
    await ctx.query(
      `INSERT INTO column_metadata (id, table_id, column_name, data_type, created_at, updated_at)
       VALUES ($1,$2,$3,$4,now(),now())`,
      [randomUUID(), tableId, col.name, col.type || null],
    ).catch(() => {});
  }
}

// ─────────────────────────────────────────
// POST /api/projects/:pid/structured-documents/create
//   register documents by local path
// ─────────────────────────────────────────
export async function createStructuredDocuments(ctx, input) {
  const { pid } = input.params;
  const b = input.body || {};
  const dsid = b.data_source_id;
  const filePaths = parseJsonArray(b.file_paths);
  if (!dsid) throw new ApiError("data_source_id 不能为空", 400);
  if (!filePaths.length) throw new ApiError("file_paths 不能为空", 400);
  const ds = await ctx.queryOne(`SELECT id FROM structured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`, [dsid, pid]);
  if (!ds) throw new ApiError("结构化数据源不存在", 404);

  const created = [];
  for (const fp of filePaths) {
    const ext = extname(fp).slice(1).toLowerCase();
    const docId = randomUUID();
    await ctx.query(
      `INSERT INTO structured_documents (id, project_id, structured_data_source_id, title, source, file_path, file_ext, status, progress, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'local',$5,$6,'pending',0,$7,now(),now())`,
      [docId, pid, dsid, basename(fp), fp, ext, ctx.userId],
    );
    created.push({ document_id: docId, file_path: fp, file_ext: ext });
  }
  return { data: { created_documents: created, count: created.length }, message: "登记文档成功" };
}

// ─────────────────────────────────────────
// POST /api/projects/:pid/structured-documents/process
//   parse into DuckDB + register connection + write metadata
// ─────────────────────────────────────────
export async function processStructuredDocuments(ctx, input) {
  const { pid } = input.params;
  const b = input.body || {};
  const dsid = b.data_source_id;
  const docIds = parseJsonArray(b.document_ids);
  if (!dsid) throw new ApiError("data_source_id 不能为空", 400);
  const ds = await ctx.queryOne(
    `SELECT id, name, duckdb_path, database_connection_id FROM structured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!ds) throw new ApiError("结构化数据源不存在", 404);

  // Data source CRUD may not set duckdb_path; fill and persist fallback path here.
  const duckdbPath = ds.duckdb_path || join(STRUCT_DIR, `${dsid}.duckdb`);
  if (!ds.duckdb_path) {
    await ctx.query(`UPDATE structured_data_sources SET duckdb_path=$1, updated_at=now() WHERE id=$2`, [duckdbPath, dsid]);
  }

  const docs = docIds.length
    ? await ctx.query(`SELECT id, file_path, file_ext, title FROM structured_documents WHERE structured_data_source_id=$1 AND id = ANY($2) AND deleted_at IS NULL`, [dsid, docIds])
    : await ctx.query(`SELECT id, file_path, file_ext, title FROM structured_documents WHERE structured_data_source_id=$1 AND deleted_at IS NULL`, [dsid]);

  // 1) Ensure DuckDB connection (host+database both use .duckdb path; aligned with DatabaseDataSource._resolve_duck_path)
  let connId = ds.database_connection_id;
  if (!connId) {
    connId = randomUUID();
    await ctx.query(
      `INSERT INTO database_connections (id, project_id, created_by, name, db_type, host, database, description, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'DuckDB',$5,$5,$6,now(),now())`,
      [connId, pid, ctx.userId, ds.name, duckdbPath, `结构化数据源 ${ds.name}`],
    );
    await ctx.query(`UPDATE structured_data_sources SET database_connection_id=$1, updated_at=now() WHERE id=$2`, [connId, dsid]);
  }

  // 1.5) Auto-bind data source to project (skip business layer write, keep business_id empty). Idempotent: no-op if already bound.
  //      BusinessDataSources engine looks up by project_id; imported data can be queried directly without extra business concepts.
  const bound = await ctx.queryOne(
    `SELECT id FROM business_data_sources WHERE project_id=$1 AND source_type='structured_data_source' AND source_id=$2 AND deleted_at IS NULL`,
    [pid, dsid],
  );
  if (!bound) {
    await ctx.query(
      `INSERT INTO business_data_sources (id, project_id, source_type, source_id, created_at, updated_at)
       VALUES ($1, $2, 'structured_data_source', $3, now(), now())`,
      [randomUUID(), pid, dsid],
    );
  }

  // 2) Import each file sequentially and write metadata
  const results = [];
  for (const doc of docs) {
    const fmt = duckFormatForExt(doc.file_ext);
    if (!fmt) {
      await ctx.query(`UPDATE structured_documents SET status='failed', error_msg=$1, updated_at=now() WHERE id=$2`, [`不支持的格式 .${doc.file_ext}`, doc.id]);
      results.push({ document_id: doc.id, status: "failed", error: `不支持 .${doc.file_ext}` });
      continue;
    }
    if (!doc.file_path || !existsSync(doc.file_path)) {
      await ctx.query(`UPDATE structured_documents SET status='failed', error_msg='文件不存在', updated_at=now() WHERE id=$1`, [doc.id]);
      results.push({ document_id: doc.id, status: "failed", error: "文件不存在" });
      continue;
    }
    try {
      const base = (doc.title || "").replace(/\.[^.]+$/, "") || `t_${doc.id.slice(0, 8)}`;
      const tableName = sanitizeTableName(base);
      const r = await duckImportFile(duckdbPath, tableName, doc.file_path, fmt);
      await upsertDuckTable(ctx, connId, r.table_name, r.columns, r.row_count);
      await ctx.query(`UPDATE structured_documents SET status='completed', chunk_count=$1, progress=100, error_msg=NULL, updated_at=now() WHERE id=$2`, [r.row_count, doc.id]);
      results.push({ document_id: doc.id, status: "completed", table_name: r.table_name, row_count: r.row_count });
    } catch (e) {
      await ctx.query(`UPDATE structured_documents SET status='failed', error_msg=$1, updated_at=now() WHERE id=$2`, [String(e?.message ?? e).slice(0, 500), doc.id]);
      results.push({ document_id: doc.id, status: "failed", error: String(e?.message ?? e) });
    }
  }

  // 3) 数据准备属于离线阶段。交互式导入默认只准备 Schema 采样/枚举/向量，
  //    不调用 LLM 生成表和字段描述；只有显式 full 模式才运行描述生成。
  //    eval/批量任务可用 none，由外部任务统一安排准备，避免与在线查数争抢模型。
  const preparation = resolveDataPreparationPolicy(b);
  if (preparation.enabled) {
    queueMicrotask(() => {
      enrichConnection(connId, {
        projectId: pid,
        descriptions: preparation.descriptions,
      }).catch((e) =>
        console.warn(`[structured prepare] 连接 ${connId} 离线准备失败: ${e?.message ?? e}`));
    });
  }

  return {
    data: {
      database_connection_id: connId,
      processed: results,
      success_count: results.filter((r) => r.status === "completed").length,
      preparation,
    },
    message: "处理完成",
  };
}

// ─────────────────────────────────────────
// GET /api/projects/:pid/structured-documents/list
//   list documents (poll status)
// ─────────────────────────────────────────
export async function listStructuredDocuments(ctx, input) {
  const { pid } = input.params;
  const dsid = input.query.data_source_id;
  const rows = await ctx.query(
    `SELECT id, id AS document_id, title, title AS file_name, file_ext, file_path, status, chunk_count, progress, error_msg, created_at, updated_at
       FROM structured_documents
      WHERE project_id=$1 ${dsid ? "AND structured_data_source_id=$2" : ""} AND deleted_at IS NULL
      ORDER BY created_at DESC`,
    dsid ? [pid, dsid] : [pid],
  ).catch(() => []);
  return { data: { items: rows, total: rows.length } };
}

export async function deleteStructuredDocument(ctx, input) {
  const { pid } = input.params;
  const documentId = input.body?.document_id || input.body?.id;
  if (!documentId) throw new ApiError("document_id 不能为空", 400);

  const row = await ctx.queryOne(
    `SELECT id
       FROM structured_documents
      WHERE project_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [pid, documentId],
  );
  if (!row) throw new ApiError("文档不存在", 404);

  await ctx.query(
    `UPDATE structured_documents
        SET deleted_at=now(), updated_at=now()
      WHERE project_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [pid, documentId],
  );

  return {
    data: { deleted_ids: [documentId], deleted_count: 1 },
    message: "删除成功",
  };
}

export async function deleteStructuredDocumentsBatch(ctx, input) {
  const { pid } = input.params;
  const documentIds = parseJsonArray(input.body?.document_ids).filter(Boolean);
  if (!documentIds.length) throw new ApiError("document_ids 不能为空", 400);

  const rows = await ctx.query(
    `SELECT id
       FROM structured_documents
      WHERE project_id=$1 AND id = ANY($2) AND deleted_at IS NULL`,
    [pid, documentIds],
  ).catch(() => []);
  const existingIds = rows.map((row) => row.id);

  if (existingIds.length) {
    await ctx.query(
      `UPDATE structured_documents
          SET deleted_at=now(), updated_at=now()
        WHERE project_id=$1 AND id = ANY($2) AND deleted_at IS NULL`,
      [pid, existingIds],
    );
  }

  return {
    data: { deleted_ids: existingIds, deleted_count: existingIds.length },
    message: "批量删除成功",
  };
}

export async function listStructuredTables(ctx, input) {
  const { pid } = input.params;
  const dsid = input.query?.data_source_id;
  const connId = await getStructuredConnection(ctx, pid, dsid);
  if (!connId) return { data: { items: [], total: 0 }, message: "结构化数据源尚未生成表" };
  const rows = await ctx.query(
    `SELECT id, database_connection_id, schema_name, table_name, table_type, description, keywords,
            row_count, is_view, is_materialized, is_high_recall, structured_document_id,
            created_at, updated_at
       FROM table_metadata
      WHERE database_connection_id=$1 AND deleted_at IS NULL
      ORDER BY schema_name, table_name`,
    [connId],
  ).catch(() => []);
  return { data: { items: rows, total: rows.length }, message: "获取表列表成功" };
}

export async function listStructuredTablesByDocument(ctx, input) {
  const { pid } = input.params;
  const documentId = input.query?.document_id;
  if (!documentId) throw new ApiError("document_id 不能为空", 400);
  const doc = await ctx.queryOne(
    `SELECT id, structured_data_source_id FROM structured_documents
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [documentId, pid],
  ).catch(() => null);
  if (!doc) throw new ApiError("文档不存在", 404);
  const connId = await getStructuredConnection(ctx, pid, doc.structured_data_source_id);
  if (!connId) return { data: { items: [], total: 0 }, message: "结构化文档尚未生成表" };

  const rows = await ctx.query(
    `SELECT id, database_connection_id, schema_name, table_name, table_type, description, keywords,
            row_count, is_view, is_materialized, is_high_recall, structured_document_id,
            created_at, updated_at
       FROM table_metadata
      WHERE database_connection_id=$1 AND deleted_at IS NULL
      ORDER BY schema_name, table_name`,
    [connId],
  ).catch(() => []);
  return { data: { items: rows, total: rows.length }, message: "获取文档表列表成功" };
}

export async function searchStructuredTables(ctx, input) {
  const { pid, dsid } = input.params;
  const connId = await getStructuredConnection(ctx, pid, dsid);
  if (!connId) return { data: { items: [], count: 0 }, message: "结构化数据源尚未生成表" };
  const question = input.body?.question || input.body?.query || "";
  if (!String(question).trim()) throw new ApiError("question 不能为空", 400);
  const limit = Number(input.body?.limit || input.body?.top_k || 5);
  const items = await SchemaRetrievalService.search_relevant_tables_with_columns(
    { query: ctx.query, queryOne: ctx.queryOne },
    connId,
    String(question),
    { project_id: pid, limit },
  );
  return { data: { items, count: items.length }, message: "召回完成" };
}

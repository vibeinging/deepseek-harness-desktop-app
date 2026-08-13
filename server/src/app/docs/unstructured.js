// L1 use-case layer for unstructured document management + RAG ingest, aligned line-by-line with routes/unstructured_docs.js.
// Signature is always async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
// Desktop: files are already local (Electron native picker provides file_path); backend reads local path directly, no multipart upload.
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { ApiError } from "../../errors.js";
import { UnstructuredDataSource } from "../../engine/datasources/unstructured_data_source.js";
import { enqueueProcessDocument } from "../../engine/datasources/unstructured/document_processing_service.js";
import { SUPPORTED_EXTS } from "../../engine/datasources/unstructured/document_loaders.js";
import {
  generateDocumentsDescriptions,
  generateDatasourceDescription,
} from "../../engine/datasources/unstructured/document_description_service.js";

// Create document from local file + process
export async function createDocument(ctx, input) {
  const { pid, dsid } = input.params;
  const body = input.body || {};
  const filePath = body.file_path || body.filePath || body.path;
  if (!filePath) throw new ApiError("缺少 file_path(本地文件路径)", 400);
  if (!existsSync(filePath)) throw new ApiError(`文件不存在: ${filePath}`, 400);
  const ext = extname(filePath).slice(1).toLowerCase();
  if (!SUPPORTED_EXTS.includes(ext)) {
    throw new ApiError(`不支持的文档类型 .${ext}(支持 ${SUPPORTED_EXTS.join('/')})`, 400);
  }
  const src = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  ).catch(() => null);
  if (!src) throw new ApiError("非结构化数据源不存在", 404);

  const bound = await ctx.queryOne(
    `SELECT id FROM business_data_sources
      WHERE project_id=$1 AND source_type='unstructured_data_source' AND source_id=$2 AND deleted_at IS NULL`,
    [pid, dsid],
  );
  if (!bound) {
    await ctx.query(
      `INSERT INTO business_data_sources (id, project_id, source_type, source_id, created_at, updated_at)
       VALUES ($1, $2, 'unstructured_data_source', $3, now(), now())`,
      [randomUUID(), pid, dsid],
    );
  }

  const docId = randomUUID();
  let size = 0;
  try { size = statSync(filePath).size; } catch { /* ignore */ }
  await ctx.query(
    `INSERT INTO unstructured_documents
       (id, project_id, unstructured_data_source_id, title, source, file_path, file_size, file_ext, status, progress, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'local',$5,$6,$7,'pending',0,$8,now(),now())`,
    [docId, pid, dsid, body.title || basename(filePath), filePath, size, ext, ctx.userId || ""],
  );
  // Process in background without blocking response: large documents load+split+embed may take tens of seconds or longer, sent to sequential queue.
  // Return immediately with status='pending'; frontend polls GET .../documents for status/progress (embedding stage can be incremental).
  enqueueProcessDocument(docId, { projectId: pid })
    .catch((e) => console.warn(`[unstructured] 文档 ${docId} 后台处理失败: ${e?.message ?? e}`));
  const doc = await ctx.queryOne(
    `SELECT id, title, file_ext, status, chunk_count, progress, error_msg, created_at FROM unstructured_documents WHERE id=$1`,
    [docId],
  );
  return { data: { document: doc }, message: "文档已提交,正在后台解析" };
}

// List documents for one data source
export async function listDocuments(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, id AS document_id, title, title AS file_name, file_ext, file_path,
            file_size, file_size AS size, description, status, chunk_count, progress,
            error_msg, created_at, updated_at,
            (SELECT COUNT(*) FROM unstructured_contents c
              WHERE c.document_id = d.id AND c.content_index >= 0
                AND c.deleted_at IS NULL AND c.embedding IS NOT NULL) AS embedded_chunk_count
       FROM unstructured_documents d
      WHERE d.unstructured_data_source_id=$1 AND d.project_id=$2 AND d.deleted_at IS NULL
      ORDER BY d.created_at DESC`,
    [input.params.dsid, input.params.pid],
  ).catch(() => []);
  const items = rows.map((row) => {
    const chunkCount = Number(row.chunk_count || 0);
    const embeddedChunkCount = Number(row.embedded_chunk_count || 0);
    return {
      ...row,
      embedded_chunk_count: embeddedChunkCount,
      embedding_coverage: chunkCount ? embeddedChunkCount / chunkCount : 0,
      retrieval_status: chunkCount > 0 && embeddedChunkCount === chunkCount ? 'hybrid_ready' : 'lexical_only',
    };
  });
  return { data: { items, total: items.length } };
}

// View document chunks
export async function listDocumentChunks(ctx, input) {
  const { pid, docId } = input.params;
  const page = Math.max(1, Number(input.query?.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(input.query?.page_size || input.query?.pageSize || 20)));
  const offset = (page - 1) * pageSize;
  const doc = await ctx.queryOne(
    `SELECT id FROM unstructured_documents WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [docId, pid],
  ).catch(() => null);
  if (!doc) throw new ApiError("文档不存在", 404);

  const rows = await ctx.query(
    `SELECT id, content_index, embedding_content, token_count, meta_info,
            CASE WHEN embedding IS NULL THEN false ELSE true END AS is_embedding
       FROM unstructured_contents
      WHERE document_id=$1 AND deleted_at IS NULL AND content_index >= 0
      ORDER BY content_index ASC
      LIMIT $2 OFFSET $3`,
    [docId, pageSize, offset],
  ).catch(() => []);
  const countRow = await ctx.queryOne(
    `SELECT COUNT(*) AS count
       FROM unstructured_contents
      WHERE document_id=$1 AND deleted_at IS NULL AND content_index >= 0`,
    [docId],
  ).catch(() => ({ count: rows.length }));

  const chunks = rows.map((row) => ({
    id: row.id,
    is_embedding: !!row.is_embedding,
    chunk_content: row.embedding_content || "",
    content_info: {
      content_index: Number(row.content_index || 0),
      content: row.embedding_content || "",
      token_count: row.token_count || 0,
      meta_info: row.meta_info || null,
    },
  }));

  return {
    data: { chunks, items: chunks, total: Number(countRow?.count || chunks.length), page, page_size: pageSize },
    message: "获取文档切片成功",
  };
}

// Reprocess document
export async function reprocessDocument(ctx, input) {
  const doc = await ctx.queryOne(
    `SELECT id FROM unstructured_documents WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [input.params.docId, input.params.pid],
  ).catch(() => null);
  if (!doc) throw new ApiError("文档不存在", 404);
  const body = input.body || {};
  const chunkSize = Number(body.chunk_size || body.chunkSize) > 0 ? Number(body.chunk_size || body.chunkSize) : 512;
  const chunkOverlap = Number(body.chunk_overlap || body.chunkOverlap) >= 0 ? Number(body.chunk_overlap || body.chunkOverlap) : 50;
  // Same as POST: background sequential processing, immediate return; frontend polls status/progress.
  await ctx.query(`UPDATE unstructured_documents SET status='pending', progress=0, error_msg=NULL, updated_at=now() WHERE id=$1`, [input.params.docId]).catch(() => {});
  enqueueProcessDocument(input.params.docId, { projectId: input.params.pid, chunkSize, chunkOverlap })
    .catch((e) => console.warn(`[unstructured] 文档 ${input.params.docId} 后台重处理失败: ${e?.message ?? e}`));
  return { data: { document_id: input.params.docId, status: "pending" }, message: "已提交重新处理,正在后台解析" };
}

// Delete document + chunks (soft-delete document, hard-delete chunks)
export async function deleteDocument(ctx, input) {
  await ctx.query(`UPDATE unstructured_documents SET deleted_at=now() WHERE id=$1 AND project_id=$2`, [input.params.docId, input.params.pid]).catch(() => {});
  await ctx.query(`DELETE FROM unstructured_contents WHERE document_id=$1`, [input.params.docId]).catch(() => {});
  return { data: { id: input.params.docId }, message: "已删除文档" };
}

export async function deleteDocumentsBatch(ctx, input) {
  const { pid } = input.params;
  const idsRaw = input.body?.document_ids || input.body?.ids || [];
  const documentIds = Array.isArray(idsRaw) ? idsRaw : (() => {
    try {
      const parsed = JSON.parse(String(idsRaw || "[]"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })();
  const ids = documentIds.filter(Boolean);
  if (!ids.length) throw new ApiError("document_ids 不能为空", 400);

  const rows = await ctx.query(
    `SELECT id FROM unstructured_documents WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
    [pid, ids],
  ).catch(() => []);
  const existingIds = rows.map((row) => row.id);
  if (existingIds.length) {
    await ctx.query(
      `UPDATE unstructured_documents SET deleted_at=now(), updated_at=now()
        WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
      [pid, existingIds],
    ).catch(() => {});
    await ctx.query(
      `DELETE FROM unstructured_contents WHERE document_id::text = ANY($1::text[])`,
      [existingIds],
    ).catch(() => {});
  }
  return { data: { deleted_ids: existingIds, deleted_count: existingIds.length }, message: "批量删除成功" };
}

// Search unstructured data source
export async function searchDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const queryText = input.body?.query || input.body?.search_query || "";
  const topK = Number(input.body?.top_k || input.body?.topK || 10);
  if (!String(queryText).trim()) throw new ApiError("query 不能为空", 400);

  const src = await ctx.queryOne(
    `SELECT id, name, description FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  ).catch(() => null);
  if (!src) throw new ApiError("非结构化数据源不存在", 404);

  const dataSource = new UnstructuredDataSource(null, pid, dsid);
  dataSource.datasource_name = src.name;
  dataSource.description = src.description;
  const result = await dataSource.query(String(queryText), { top_k: topK });
  if (!result.success) throw new ApiError(result.message || "搜索失败", 500);

  const docIds = [...new Set((result.data || []).map((item) => item.document_id).filter(Boolean))];
  const docs = docIds.length
    ? await ctx.query(
        `SELECT id, title, title AS file_name FROM unstructured_documents WHERE id::text = ANY($1::text[])`,
        [docIds],
      ).catch(() => [])
    : [];
  const docMap = new Map(docs.map((doc) => [doc.id, doc]));
  const items = (result.data || []).map((item) => ({
    ...item,
    score: item.similarity ?? item.score ?? 0,
    document: docMap.get(item.document_id) || null,
  }));
  return { data: items, message: "搜索完成" };
}

// Batch generate document descriptions (LLM-based from chunk content + description embedding). Sync execution and return result (aligned with structured side).
// body: { data_source_id, document_ids?, language? }
export async function generateDocumentDescriptions(ctx, input) {
  const { pid } = input.params;
  const body = input.body || {};
  const dataSourceId = body.data_source_id || body.dataSourceId;
  if (!dataSourceId) throw new ApiError("缺少 data_source_id 参数", 400);
  const src = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dataSourceId, pid],
  ).catch(() => null);
  if (!src) throw new ApiError("非结构化数据源不存在", 404);
  const documentIds = Array.isArray(body.document_ids) ? body.document_ids : null;
  try {
    const result = await generateDocumentsDescriptions({
      dataSourceId, projectId: pid, documentIds, language: body.language || "zh",
    });
    return { data: result, message: "文档描述生成完成" };
  } catch (e) {
    throw new ApiError("文档描述生成失败: " + (e?.message || String(e)), 500);
  }
}

// Generate datasource description by summarizing all document descriptions.
// body: { language? }
export async function generateDatasourceDescriptionDoc(ctx, input) {
  const { pid, dsid } = input.params;
  const src = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  ).catch(() => null);
  if (!src) throw new ApiError("非结构化数据源不存在", 404);
  try {
    const description = await generateDatasourceDescription({
      dataSourceId: dsid, projectId: pid, language: input.body?.language || "zh",
    });
    return { data: { data_source_id: dsid, description }, message: "数据源描述生成完成" };
  } catch (e) {
    throw new ApiError("数据源描述生成失败: " + (e?.message || String(e)), 500);
  }
}

// Manually edit document description
export async function updateDocumentDescription(ctx, input) {
  const { pid, docId } = input.params;
  const description = input.body?.description ?? "";
  const doc = await ctx.queryOne(
    `SELECT id FROM unstructured_documents WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [docId, pid],
  ).catch(() => null);
  if (!doc) throw new ApiError("文档不存在", 404);
  await ctx.query(`UPDATE unstructured_documents SET description=$1, updated_at=now() WHERE id=$2`, [description, docId]).catch(() => {});
  return { data: { document_id: docId, description }, message: "文档描述更新成功" };
}

// Manually edit datasource description
export async function updateDatasourceDescription(ctx, input) {
  const { pid, dsid } = input.params;
  const description = input.body?.description ?? "";
  const src = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  ).catch(() => null);
  if (!src) throw new ApiError("非结构化数据源不存在", 404);
  await ctx.query(`UPDATE unstructured_data_sources SET description=$1, updated_at=now() WHERE id=$2`, [description, dsid]).catch(() => {});
  return { data: { data_source_id: dsid, description }, message: "数据源描述更新成功" };
}

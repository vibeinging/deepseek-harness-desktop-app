// 迁移自 backend/dsh_kernel/semantic_catalogs/unstructured_data/document_description_service.py
//
// 基于文档 chunk 内容 LLM 生成「文档级描述」,再基于文档描述汇总生成「数据源级描述」。
// 文档描述会额外做一次 embed,以 content_index=-1 的特殊 chunk 存入 unstructured_contents,
// 使描述本身可参与向量召回(对齐 Python 行为)。Prompt 始终使用英文，不按 UI 语言切换。

import { randomUUID } from 'node:crypto';
import { chat, embed, ResponseExtractor } from '../../core/llm.js';
import { query, queryOne } from '../../../db.js';

const DOC_CONCURRENCY = 5;

// ── chunk 采样(移植 chunk_sampling.py) ──────────────────────────────
function uniformSample(items, count) {
  if (!items.length || count <= 0) return [];
  if (count >= items.length) return items.slice();
  const step = items.length / count;
  return Array.from({ length: count }, (_, i) => items[Math.floor(i * step)]);
}

function sampleChunks(chunks) {
  const total = chunks.length;
  if (total <= 10) return chunks.slice();

  let sampleCount;
  if (total <= 50) sampleCount = 10;
  else if (total <= 200) sampleCount = 15;
  else sampleCount = 20;

  const headCount = Math.max(2, Math.floor(sampleCount * 0.3));
  const tailCount = Math.max(2, Math.floor(sampleCount * 0.3));
  const midCount = sampleCount - headCount - tailCount;

  const headEnd = Math.max(1, Math.floor(total * 0.2));
  const tailStart = Math.min(total - 1, Math.floor(total * 0.8));

  return [
    ...uniformSample(chunks.slice(0, headEnd), headCount),
    ...uniformSample(chunks.slice(headEnd, tailStart), midCount),
    ...uniformSample(chunks.slice(tailStart), tailCount),
  ];
}

// ── 并发池(对齐 table_description.js 的 pool) ──────────────────────
async function pool(items, limit, worker) {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; await worker(items[i]); }
  });
  await Promise.all(runners);
}

// ── Prompt 构建(移植 _build_document_prompt / _build_datasource_prompt) ──
function buildDocumentPrompt({ title, fileExt, totalChunks, sampledChunks }) {
  let chunksText = '';
  sampledChunks.forEach((chunk, i) => {
    const text = chunk.length > 1000 ? chunk.slice(0, 1000) : chunk;
    chunksText += `\n--- Excerpt ${i + 1} ---\n${text}\n`;
  });

  return `You are a document analysis expert. Generate a business description for the document based on its content snippets.

## Document Information
- Document Name: ${title}
- File Type: ${fileExt}
- Total Chunks: ${totalChunks}

## Document Content Snippets (Sampled)
The following content snippets are sampled from the document, ordered by their position:
${chunksText}

## Requirements
1. Analyze all content snippets to understand the document's overall theme and core content
2. Generate a concise but comprehensive description highlighting the document's topic, core content, and key information
3. Describe the document's purpose and value from a business perspective
4. Keep the description between 50-200 words
5. Describe directly, avoid redundant openings like "This document is"

## Output Format
Return strictly in the following JSON format:
{"description": "Business description of the document..."}`;
}

function buildDatasourcePrompt({ datasourceName, docsInfo }) {
  let docsText = '';
  docsInfo.forEach(([title, desc], i) => {
    docsText += `\n${i + 1}. **${title}**:${desc}`;
  });

  return `You are a knowledge base expert. Generate an overall business description for the document library based on all document descriptions.

## Document Library Information
- Library Name: ${datasourceName}
- Document Count: ${docsInfo.length}

## Document List
${docsText}

## Requirements
1. Analyze all document titles and descriptions to understand the library's overall theme and coverage
2. Generate an overall business description highlighting core topics and knowledge scope
3. Keep the description between 100-300 words

## Output Format
Return strictly in the following JSON format:
{"description": "Overall business description of the document library..."}`;
}

function parseDescription(resp) {
  const content = typeof resp === 'string' ? resp : String(resp ?? '');
  try {
    const cleaned = ResponseExtractor.clean_llm_json_response(content);
    const data = typeof cleaned === 'string' ? JSON.parse(cleaned) : cleaned;
    const desc = data && typeof data === 'object' ? data.description : null;
    if (!desc) return content.trim();
    return String(desc).trim();
  } catch {
    return content.trim();
  }
}

// ── 描述 embedding:存为 content_index=-1 的特殊 chunk(移植 _store_description_embedding) ──
async function storeDescriptionEmbedding(documentId, description, projectId) {
  if (!description) return;
  try {
    const vec = await embed(description, { project_id: projectId || null });
    await query(
      `DELETE FROM unstructured_contents WHERE document_id=$1 AND content_index=-1`,
      [documentId],
    ).catch(() => {});
    const now = new Date().toISOString();
    await query(
      `INSERT INTO unstructured_contents
         (id, document_id, content_index, content_size, embedding_content, embedding, meta_info, created_at, updated_at)
       VALUES ($1,$2,-1,$3,$4,$5,$6,$7,$7)`,
      [
        randomUUID(), documentId,
        Buffer.byteLength(description, 'utf8'),
        description,
        vec ? JSON.stringify(vec) : null,
        '{"type": "description"}',
        now,
      ],
    );
  } catch (e) {
    console.warn(`[DocDescription] 文档描述 embedding 生成失败: ${e?.message ?? e}`);
  }
}

/** 为单个文档生成描述(写 unstructured_documents.description + 描述向量)。 */
export async function generateDocumentDescription(documentId, { projectId = null, title = null, fileExt = null } = {}) {
  let docTitle = title;
  let docExt = fileExt;
  if (!docTitle) {
    const doc = await queryOne(
      `SELECT title, file_ext FROM unstructured_documents WHERE id=$1`,
      [documentId],
    ).catch(() => null);
    if (!doc) throw new Error(`文档不存在: ${documentId}`);
    docTitle = doc.title;
    docExt = doc.file_ext || '';
  }

  const rows = await query(
    `SELECT embedding_content FROM unstructured_contents
      WHERE document_id=$1 AND content_index >= 0
      ORDER BY content_index`,
    [documentId],
  ).catch(() => []);
  const allChunks = rows.map((r) => r.embedding_content).filter((c) => c);
  if (!allChunks.length) {
    console.warn(`[DocDescription] 文档 ${documentId} 无 chunk 内容,跳过描述生成`);
    return '';
  }

  const sampled = sampleChunks(allChunks);
  const prompt = buildDocumentPrompt({
    title: docTitle, fileExt: docExt || '', totalChunks: allChunks.length, sampledChunks: sampled,
  });

  const resp = await chat(prompt, {
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 1500,
    project_id: projectId,
    call_site: 'document_description_doc',
  });
  const description = parseDescription(resp);

  await query(
    `UPDATE unstructured_documents SET description=$1, updated_at=now() WHERE id=$2`,
    [description, documentId],
  ).catch(() => {});

  await storeDescriptionEmbedding(documentId, description, projectId);
  return description;
}

/** 批量为数据源下已完成文档生成描述(并发受限)。 */
export async function generateDocumentsDescriptions({ dataSourceId, projectId, documentIds = null }) {
  let sql =
    `SELECT id, title, file_ext FROM unstructured_documents
      WHERE unstructured_data_source_id=$1 AND status='completed' AND deleted_at IS NULL`;
  const params = [dataSourceId];
  if (Array.isArray(documentIds) && documentIds.length) {
    sql += ` AND id = ANY($2)`;
    params.push(documentIds);
  }
  const docs = await query(sql, params).catch(() => []);
  if (!docs.length) return { documents_processed: 0, documents_generated: 0, details: [] };

  const details = [];
  await pool(docs, DOC_CONCURRENCY, async (doc) => {
    try {
      const desc = await generateDocumentDescription(doc.id, {
        projectId, title: doc.title, fileExt: doc.file_ext,
      });
      details.push({ document_id: doc.id, title: doc.title, success: true, description: desc });
    } catch (e) {
      console.warn(`[DocDescription] 文档 ${doc.title} 描述生成失败: ${e?.message ?? e}`);
      details.push({ document_id: doc.id, title: doc.title, success: false, error: String(e?.message ?? e) });
    }
  });

  const generated = details.filter((d) => d.success).length;
  return { documents_processed: docs.length, documents_generated: generated, details };
}

/** 基于所有文档描述汇总生成数据源描述(写 unstructured_data_sources.description)。 */
export async function generateDatasourceDescription({ dataSourceId, projectId }) {
  const ds = await queryOne(
    `SELECT id, name FROM unstructured_data_sources WHERE id=$1 AND deleted_at IS NULL`,
    [dataSourceId],
  ).catch(() => null);
  if (!ds) throw new Error(`数据源不存在: ${dataSourceId}`);

  const docsInfo = await query(
    `SELECT title, description FROM unstructured_documents
      WHERE unstructured_data_source_id=$1 AND description IS NOT NULL
        AND length(description) > 0 AND deleted_at IS NULL`,
    [dataSourceId],
  ).catch(() => []);
  if (!docsInfo.length) {
    console.warn(`[DocDescription] 数据源 ${dataSourceId} 无文档描述,跳过汇总生成`);
    return '';
  }

  const prompt = buildDatasourcePrompt({
    datasourceName: ds.name,
    docsInfo: docsInfo.map((d) => [d.title, d.description]),
  });

  const resp = await chat(prompt, {
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 1500,
    project_id: projectId,
    call_site: 'document_description_datasource',
  });
  const description = parseDescription(resp);

  await query(
    `UPDATE unstructured_data_sources SET description=$1, updated_at=now() WHERE id=$2`,
    [description, dataSourceId],
  ).catch(() => {});
  return description;
}

export default {
  generateDocumentDescription,
  generateDocumentsDescriptions,
  generateDatasourceDescription,
};

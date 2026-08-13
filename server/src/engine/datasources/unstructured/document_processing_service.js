// 迁移自 dsh_kernel/semantic_catalogs/unstructured_data/document_processing_service.py(桌面精简版)
//
// 文档处理流水线:load(提取文本) → split(分块) → embed(向量化) → store(存 unstructured_contents)
// → 更新 unstructured_documents.status/chunk_count。失败置 status='failed' + error_msg,不抛。

import { randomUUID } from 'node:crypto';
import { sqlite, query, queryOne } from '../../../db.js';
import { embed } from '../../core/llm.js';
import { loadDocument } from './document_loaders.js';
import { splitText } from './text_splitter.js';

// 增量进度的 embed 批大小(粗于 embed 内部的 10,够细到能看进度即可)。
const _EMBED_PROGRESS_BATCH = 20;

function setStatus(id, status, progress, errorMsg = null) {
  try {
    sqlite.prepare(
      `UPDATE unstructured_documents SET status=?, progress=?, error_msg=?, updated_at=? WHERE id=?`,
    ).run(status, progress, errorMsg, new Date().toISOString(), id);
  } catch { /* 状态更新失败不致命 */ }
}

export class DocumentProcessingService {
  /**
   * 处理单个文档(整条 ingest 流水线)。
   * @param {string} documentId unstructured_documents.id
   * @param {{chunkSize?:number, chunkOverlap?:number, projectId?:string}} [opts]
   * @returns {Promise<{success:boolean, chunk_count?:number, message:string}>}
   */
  static async processDocument(documentId, { chunkSize = 512, chunkOverlap = 50, projectId = null } = {}) {
    const doc = await queryOne(
      `SELECT id, file_path, file_ext, title, project_id FROM unstructured_documents
        WHERE id = $1 AND deleted_at IS NULL`,
      [documentId],
    ).catch(() => null);
    if (!doc) return { success: false, message: '文档不存在' };

    try {
      setStatus(documentId, 'processing', 10);
      // 1) 提取文本
      const text = await loadDocument(doc.file_path, doc.file_ext);
      if (!text || !String(text).trim()) {
        setStatus(documentId, 'failed', 0, '文档内容为空或无法提取');
        return { success: false, message: '文档内容为空或无法提取' };
      }
      // 2) 分块
      const chunks = splitText(text, { chunkSize, chunkOverlap });
      if (!chunks.length) {
        setStatus(documentId, 'failed', 0, '文本分块为空');
        return { success: false, message: '文本分块为空' };
      }
      setStatus(documentId, 'embedding', 40);
      // 3) 向量化:按批 embed + 增量更新 progress(40→95),让后台任务可被轮询观测;
      //    单批失败仅该批降级为纯文本(无向量),不拖垮整篇。
      const vecs = new Array(chunks.length).fill(null);
      for (let i = 0; i < chunks.length; i += _EMBED_PROGRESS_BATCH) {
        const group = chunks.slice(i, i + _EMBED_PROGRESS_BATCH);
        try {
          const gv = await embed(group, { project_id: projectId || doc.project_id });
          for (let j = 0; j < group.length; j += 1) vecs[i + j] = gv[j] ?? null;
        } catch (e) {
          console.warn(`[DocProcessing] embed 批失败(${i}~${i + group.length}),该批仅存文本: ${e?.message ?? e}`);
        }
        const done = Math.min(i + group.length, chunks.length);
        setStatus(documentId, 'embedding', 40 + Math.floor((done / chunks.length) * 55));
      }
      // 4) 落库(先清旧 chunk 再插)
      sqlite.prepare(`DELETE FROM unstructured_contents WHERE document_id = ?`).run(documentId);
      const now = new Date().toISOString();
      const ins = sqlite.prepare(
        `INSERT INTO unstructured_contents
           (id, document_id, content_index, content_size, token_count, embedding_content, embedding, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      );
      chunks.forEach((c, i) => {
        const vec = vecs[i];
        ins.run(randomUUID(), documentId, i, c.length, Math.ceil(c.length / 2), c, vec ? JSON.stringify(vec) : null, now, now);
      });
      // 5) 更新文档
      sqlite.prepare(
        `UPDATE unstructured_documents SET status='completed', chunk_count=?, progress=100, error_msg=NULL, updated_at=? WHERE id=?`,
      ).run(chunks.length, now, documentId);

      return { success: true, chunk_count: chunks.length, message: `处理完成,共 ${chunks.length} 个切片` };
    } catch (e) {
      setStatus(documentId, 'failed', 0, String(e?.message ?? e));
      return { success: false, message: String(e?.message ?? e) };
    }
  }
}

// 进程内串行后台队列:detach 文档处理,不阻塞 HTTP 响应。
// 串行(而非并发)避免多文档同时上传时一起 embed 把 DashScope 打爆;桌面单用户串行足够。
// processDocument 自身全程 try/catch + 写 status,这里再兜一层 catch 保证队列不被单篇失败打断。
let _processChain = Promise.resolve();

/**
 * 把文档处理排进后台串行队列,立即返回该任务的 Promise(调用方一般 fire-and-forget)。
 * @param {string} documentId
 * @param {{chunkSize?:number, chunkOverlap?:number, projectId?:string}} [opts]
 * @returns {Promise<{success:boolean, chunk_count?:number, message:string}>}
 */
export function enqueueProcessDocument(documentId, opts = {}) {
  const run = () => DocumentProcessingService.processDocument(documentId, opts);
  const task = _processChain.then(run, run);
  _processChain = task.catch(() => {});
  return task;
}

/**
 * 启动续跑:扫描上次进程退出时卡在中途的文档(status 为 pending/processing/embedding),
 * 重新排进后台串行队列。processDocument 幂等(先清旧 chunk 再插),重跑安全。
 * fire-and-forget 调用,不阻塞启动。需在模型 provider 注册后调用(否则 embed 解析不到模型)。
 * @returns {Promise<number>} 重新入队的文档数
 */
export async function resumePendingDocuments() {
  try {
    const rows = await query(
      `SELECT id, project_id FROM unstructured_documents
        WHERE status IN ('pending','processing','embedding') AND deleted_at IS NULL
        ORDER BY created_at ASC`,
      [],
    ).catch(() => []);
    if (!rows.length) return 0;
    console.info(`[DocProcessing] 启动续跑:${rows.length} 个未完成文档重新入队`);
    for (const r of rows) {
      enqueueProcessDocument(r.id, { projectId: r.project_id })
        .catch((e) => console.warn(`[DocProcessing] 续跑文档 ${r.id} 失败: ${e?.message ?? e}`));
    }
    return rows.length;
  } catch (e) {
    console.warn(`[DocProcessing] 启动续跑扫描失败: ${e?.message ?? e}`);
    return 0;
  }
}

export async function drainDocumentProcessingQueue(timeoutMs = 5_000) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const drained = _processChain.then(() => true, () => true);
  return Promise.race([drained, timeout]).finally(() => clearTimeout(timer));
}

export default DocumentProcessingService;

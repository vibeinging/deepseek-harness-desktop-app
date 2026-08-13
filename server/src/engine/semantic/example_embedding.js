// few-shot SQL 样例向量生成(迁移补全 P4)。
// examples 召回走 Plugin 工具；这里保留生产侧向量写入：
// 插入样例不生成 embedding → 召回退化关键词。这里补 question 向量化写入 examples.embedding。

import { embed } from '../core/llm.js';
import { vectorReady, query } from '../../db.js';

const BATCH = 16;
const EMBEDDING_MODEL = 'text-embedding-v3';

/**
 * 为某项目下缺向量的样例批量生成 embedding(question 向量化)。
 * @param {string} projectId
 * @param {{onlyEmpty?:boolean}} [opts]
 * @returns {Promise<{total:number, embedded:number, skipped?:string}>}
 */
export async function embedExamples(projectId, { onlyEmpty = true, exampleId = null, exampleType = null } = {}) {
  if (!vectorReady) return { total: 0, embedded: 0, skipped: '向量扩展未加载' };
  const blank = onlyEmpty ? "AND (embedding IS NULL OR embedding = '')" : '';
  const params = [projectId];
  let filters = blank;
  if (exampleId) { params.push(exampleId); filters += ` AND id = $${params.length}`; }
  if (exampleType) { params.push(exampleType); filters += ` AND example_type = $${params.length}`; }
  const rows = await query(
    `SELECT id, question FROM examples
      WHERE project_id=$1 AND deleted_at IS NULL ${filters}`,
    params,
  ).catch(() => []);
  if (exampleId && !rows.length) return { total: 0, embedded: 0, not_found: true };
  if (!rows.length) return { total: 0, embedded: 0 };

  let embedded = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    let vecs = [];
    try { vecs = await embed(chunk.map((r) => String(r.question || '')), { project_id: projectId }); }
    catch (e) { console.warn(`[example_embedding] embed 失败(batch ${i}): ${e?.message ?? e}`); break; }
    for (let j = 0; j < chunk.length; j += 1) {
      if (!vecs[j]) continue;
      await query(
        `UPDATE examples SET embedding=$1, embedding_model=$2, updated_at=now() WHERE id=$3`,
        [JSON.stringify(vecs[j]), EMBEDDING_MODEL, chunk[j].id],
      ).catch(() => {});
      embedded += 1;
    }
  }
  return { total: rows.length, embedded };
}

/**
 * 向量召回某项目下相似样例(供 examples/search 路由)。
 * @param {string} projectId
 * @param {string} queryText
 * @param {{topK?:number}} [opts]
 * @returns {Promise<Array<{id,question,content,description,distance}>>}
 */
export async function searchExamples(projectId, queryText, { topK = 5, exampleType = null } = {}) {
  if (!queryText || !String(queryText).trim()) return [];
  if (vectorReady) {
    let vec;
    try { vec = await embed(String(queryText), { project_id: projectId }); }
    catch { vec = null; }
    if (Array.isArray(vec) && vec.length) {
      const params = [JSON.stringify(vec), projectId];
      let typeFilter = '';
      if (exampleType) { params.push(exampleType); typeFilter = ` AND example_type=$${params.length}`; }
      params.push(topK);
      const rows = await query(
        `SELECT id, question, content, description, example_type,
                vexdb_cosine_distance(embedding, vexdb_f32($1)) AS distance
           FROM examples
          WHERE project_id=$2 AND deleted_at IS NULL AND embedding IS NOT NULL AND embedding != ''${typeFilter}
          ORDER BY distance ASC LIMIT $${params.length}`,
        params,
      ).catch(() => []);
      if (rows.length) {
        return rows.map((row) => ({ ...row, similarity: Math.max(0, 1 - Number(row.distance || 0)) }));
      }
    }
  }

  const params = [projectId];
  let typeFilter = '';
  if (exampleType) { params.push(exampleType); typeFilter = ` AND example_type=$${params.length}`; }
  const rows = await query(
    `SELECT id, question, content, description, example_type FROM examples
      WHERE project_id=$1 AND deleted_at IS NULL AND (is_active=true OR is_active IS NULL)${typeFilter}`,
    params,
  ).catch(() => []);
  const tokens = String(queryText).toLowerCase().match(/[a-z0-9_]+|[一-鿿]/g) || [];
  return rows.map((row) => {
    const haystack = `${row.question || ''} ${row.description || ''}`.toLowerCase();
    const hits = tokens.filter((token) => haystack.includes(token)).length;
    const similarity = tokens.length ? hits / tokens.length : 0;
    return { ...row, similarity, distance: 1 - similarity };
  }).sort((a, b) => b.similarity - a.similarity).slice(0, topK);
}

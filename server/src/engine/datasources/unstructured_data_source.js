// 迁移自 dsh_kernel/data_sources/datasource/unstructured_data_source.py(桌面精简版)
//
// 非结构化数据源:知识库文档的检索。
// - profile(): 列出该源下已处理完成的文档(每个文档作为一个"表",供 agent semantic_scan 按名读取)。
// - query(search_query):
//     · `Database:X Table:Y` 寻址 → 读文档 Y 的全部 chunk(semantic_scan 用)
//     · 自由查询 → vexdb 向量召回 top_k chunk(kb_search/RAG 用),embedding 缺失则 LIKE 关键词兜底
//
// chunk 存 unstructured_contents(embedding_content=切片文本,embedding=JSON 向量);
// 文档存 unstructured_documents(title/status,FK unstructured_data_source_id)。
// 桌面版混合检索暂只做向量(BM25 待 FTS5),与 Python 的 vector+bm25 hybrid 相比简化。

import { DataSource, QueryResult } from './data_source.js';
import { Profile, Column } from './profile.js';
import { query, queryOne, vectorReady } from '../../db.js';
import { embed } from '../core/llm.js';

const SCAN_RE = /^Database:\s*(.+?)\s+Table:\s*(.+)$/;
const DEFAULT_RETRIEVAL_CANDIDATE_MULTIPLIER = 12;
const RRF_OFFSET = 60;

function safeMeta(m) {
  if (!m) return {};
  try { return typeof m === 'string' ? JSON.parse(m) : m; } catch { return {}; }
}

export function buildLexicalSearchTerms(searchQuery, maxTerms = 12) {
  const normalized = String(searchQuery || '').normalize('NFKC').toLowerCase();
  const candidates = [];
  for (const token of normalized.match(/[\p{L}\p{N}_-]+/gu) || []) {
    if (!token || token.length < 2) continue;
    if (/^\p{Script=Han}+$/u.test(token) && token.length > 4) {
      for (let index = 0; index < token.length - 1; index += 2) {
        candidates.push(token.slice(index, Math.min(token.length, index + 3)));
      }
    } else {
      candidates.push(token);
    }
  }
  return [...new Set(candidates)]
    .sort((left, right) => right.length - left.length)
    .slice(0, Math.max(1, Math.trunc(Number(maxTerms) || 12)));
}

export function rankLexicalRows(rows, terms) {
  return (rows || [])
    .map((row) => {
      const content = String(row?.content || '').normalize('NFKC').toLowerCase();
      const matchedTerms = (terms || []).filter((term) => content.includes(term));
      const lexicalScore = matchedTerms.reduce((sum, term) => sum + Math.max(1, term.length), 0);
      return { ...row, lexical_score: lexicalScore, matched_terms: matchedTerms };
    })
    .filter((row) => row.lexical_score > 0)
    .sort((left, right) => right.lexical_score - left.lexical_score);
}

function fuseRanks(vectorRows, lexicalRows, topK) {
  const fused = new Map();
  const addRank = (rows, method) => {
    rows.forEach((row, index) => {
      const key = `${row.document_id}:${row.content_index}`;
      const current = fused.get(key) || { ...row, retrieval_methods: [], retrieval_score: 0 };
      current.retrieval_score += 1 / (RRF_OFFSET + index + 1);
      if (!current.retrieval_methods.includes(method)) current.retrieval_methods.push(method);
      if (row.similarity != null) current.vector_similarity = row.similarity;
      if (row.lexical_score != null) current.lexical_score = row.lexical_score;
      if (row.matched_terms != null) current.matched_terms = row.matched_terms;
      fused.set(key, current);
    });
  };
  addRank(vectorRows, 'vector');
  addRank(lexicalRows, 'lexical');
  return [...fused.values()]
    .sort((left, right) => right.retrieval_score - left.retrieval_score)
    .slice(0, topK);
}

export class UnstructuredDataSource extends DataSource {
  /**
   * @param {string} business_id
   * @param {string} project_id
   * @param {string} raw_id unstructured_data_source.id
   * @param {{source_id?:string}} [opts]
   */
  constructor(business_id, project_id, raw_id, { source_id = null } = {}) {
    super(source_id || raw_id, business_id, project_id, 'unstructured_data_source');
    this.raw_id = raw_id;
  }

  /** 该源下已处理完成的文档列表。 */
  async _documents() {
    return query(
      `SELECT d.id, d.title, COALESCE(d.chunk_count, 0) AS chunk_count,
              (SELECT COUNT(*) FROM unstructured_contents c
                WHERE c.document_id = d.id AND c.content_index >= 0
                  AND c.deleted_at IS NULL AND c.embedding IS NOT NULL) AS embedded_chunk_count
         FROM unstructured_documents d
        WHERE d.unstructured_data_source_id = $1 AND d.deleted_at IS NULL
          AND (status IS NULL OR status = 'completed')
        ORDER BY d.created_at DESC`,
      [this.raw_id],
    ).catch(() => []);
  }

  /** 每个文档作为一个 Profile(让 agent 知道有哪些文件可 semantic_scan)。 */
  async profile(_user_message = null) {
    const docs = await this._documents();
    const dsName = this.datasource_name || this.raw_id;
    if (!docs.length) {
      return [new Profile(dsName, '知识库', '非结构化知识库(暂无已处理文档)', 0, [], [], false)];
    }
    return docs.map((d) => {
      const chunkCount = Number(d.chunk_count || 0);
      const embeddedCount = Number(d.embedded_chunk_count || 0);
      const retrievalStatus = chunkCount > 0 && embeddedCount === chunkCount ? '向量+词法检索就绪' : '仅词法检索';
      return new Profile(
      dsName, d.title, `非结构化文档(${retrievalStatus},可整库语义扫描)`, 1,
      [new Column('content', '文档切片内容', new Set(['str']))], [], false,
      );
    });
  }

  /**
   * 检索。`Database:X Table:Y` → 读文档全部 chunk;否则向量召回 top_k。
   * @param {string} search_query
   * @param {{top_k?:number,file_name?:string,candidate_keys?:Array<string|number>}} [kwargs]
   * @returns {Promise<QueryResult>}
  */
  async query(search_query, kwargs = {}) {
    const requestedTopK = Number(kwargs.top_k ?? kwargs.topK ?? 5);
    const top_k = Math.max(1, Math.min(200, Number.isFinite(requestedTopK) ? Math.trunc(requestedTopK) : 5));
    try {
      const m = SCAN_RE.exec(String(search_query || ''));
      if (m) {
        const tblName = m[2].trim();
        const doc = await queryOne(
          `SELECT id FROM unstructured_documents
            WHERE unstructured_data_source_id = $1 AND title = $2 AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
          [this.raw_id, tblName],
        ).catch(() => null);
        if (!doc) return QueryResult.error(`未找到指定的非结构化文档: ${tblName}`, search_query);
        const rows = await query(
          `SELECT content_index, embedding_content, token_count, meta_info
             FROM unstructured_contents WHERE document_id = $1 AND deleted_at IS NULL
            ORDER BY content_index ASC`,
          [doc.id],
        ).catch(() => []);
        const data = rows.map((r) => ({
          content_index: r.content_index, content: r.embedding_content, ...safeMeta(r.meta_info),
        }));
        return QueryResult.ok(data, data.length ? Object.keys(data[0]) : ['content'], data.length, '');
      }

      // 自由查询 → 向量召回
      let docs = await this._documents();
      const fileName = String(kwargs.file_name || kwargs.fileName || '').trim();
      if (fileName) docs = docs.filter((doc) => doc.title === fileName);
      if (!docs.length) return QueryResult.ok([], ['content'], 0, '知识库暂无文档');
      const docIds = docs.map((d) => d.id);
      const documentNames = new Map(docs.map((doc) => [String(doc.id), doc.title]));
      const candidateLimit = Math.max(top_k, top_k * DEFAULT_RETRIEVAL_CANDIDATE_MULTIPLIER);
      let vectorRows = [];

      if (vectorReady) {
        const qvec = await embed(search_query).catch(() => null);
        if (qvec) {
          const rows = await query(
            `SELECT embedding_content AS content, content_index, document_id,
                    vexdb_cosine_distance(embedding, vexdb_f32($1)) AS distance
               FROM unstructured_contents
              WHERE document_id::text = ANY($2::text[]) AND embedding IS NOT NULL AND deleted_at IS NULL
              ORDER BY distance ASC LIMIT $3`,
            [JSON.stringify(qvec), docIds, candidateLimit],
          ).catch((e) => { console.warn(`[Unstructured] 向量召回失败: ${e?.message ?? e}`); return []; });
          vectorRows = rows.map((r) => ({
            content: r.content, content_index: r.content_index,
            document_id: r.document_id,
            document_name: documentNames.get(String(r.document_id)) || null,
            similarity: Math.max(0, 1 - Number(r.distance ?? 1)),
          }));
        }
      }

      // 词法召回始终执行，与向量结果做名次融合；没有向量时也能工作。
      const candidateKeys = (Array.isArray(kwargs.candidate_keys) ? kwargs.candidate_keys : [])
        .map((value) => String(value ?? '').normalize('NFKC').trim().toLowerCase())
        .filter((value) => value.length >= 2)
        .slice(0, 500);
      const terms = [...new Set([...candidateKeys, ...buildLexicalSearchTerms(search_query)])];
      let lexicalRows = [];
      if (terms.length) {
        const clauses = terms.map((_, index) => `LOWER(embedding_content) LIKE $${index + 2}`);
        const limitPlaceholder = terms.length + 2;
        const rows = await query(
          `SELECT embedding_content AS content, content_index, document_id FROM unstructured_contents
            WHERE document_id::text = ANY($1::text[])
              AND (${clauses.join(' OR ')})
              AND deleted_at IS NULL
            LIMIT $${limitPlaceholder}`,
          [docIds, ...terms.map((term) => `%${term}%`), candidateLimit],
        ).catch(() => []);
        lexicalRows = rankLexicalRows(rows, terms).map((row) => ({
          ...row,
          document_name: documentNames.get(String(row.document_id)) || null,
        }));
      }

      const data = fuseRanks(vectorRows, lexicalRows, top_k);
      const embeddedChunkCount = docs.reduce((sum, doc) => sum + Number(doc.embedded_chunk_count || 0), 0);
      const chunkCount = docs.reduce((sum, doc) => sum + Number(doc.chunk_count || 0), 0);
      const result = QueryResult.ok(data, data.length ? Object.keys(data[0]) : ['content'], data.length, '');
      result.retrieval_health = {
        mode: vectorRows.length ? 'hybrid' : 'lexical_only',
        chunk_count: chunkCount,
        embedded_chunk_count: embeddedChunkCount,
        embedding_coverage: chunkCount ? embeddedChunkCount / chunkCount : 0,
      };
      return result;
    } catch (e) {
      return QueryResult.error(String(e?.message ?? e), search_query);
    }
  }
}

export default UnstructuredDataSource;

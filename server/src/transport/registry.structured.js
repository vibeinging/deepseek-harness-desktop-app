// structured 域路由表(结构化文档导入:本地文件 → DuckDB,抽自 routes/structured_docs.js)。
// 一域一文件,避免多 agent 扇出冲突。
import * as structured from '../app/docs/structured.js';

export const structuredRoutes = [
  { m: 'POST', p: '/api/projects/:pid/structured-documents/create', fn: structured.createStructuredDocuments, auth: true },
  { m: 'POST', p: '/api/projects/:pid/structured-documents/process', fn: structured.processStructuredDocuments, auth: true },
  { m: 'GET', p: '/api/projects/:pid/structured-documents/list', fn: structured.listStructuredDocuments, auth: true },
  { m: 'POST', p: '/api/projects/:pid/structured-documents/delete', fn: structured.deleteStructuredDocument, auth: true },
  { m: 'POST', p: '/api/projects/:pid/structured-documents/delete_batch', fn: structured.deleteStructuredDocumentsBatch, auth: true },
  { m: 'GET', p: '/api/projects/:pid/structured-tables', fn: structured.listStructuredTables, auth: true },
  { m: 'GET', p: '/api/projects/:pid/structured-tables/by-document', fn: structured.listStructuredTablesByDocument, auth: true },
  { m: 'POST', p: '/api/projects/:pid/structured-datasources/:dsid/semantic-retrieval', fn: structured.searchStructuredTables, auth: true },
];

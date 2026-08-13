// unstructured 域路由表(批 1:非结构化文档管理 + RAG ingest)。一域一文件,避免多 agent 扇出冲突。
import * as unstructured from '../app/docs/unstructured.js';

export const unstructuredRoutes = [
  { m: 'POST', p: '/api/projects/:pid/unstructured-datasources/:dsid/documents', fn: unstructured.createDocument, auth: true },
  { m: 'GET', p: '/api/projects/:pid/unstructured-datasources/:dsid/documents', fn: unstructured.listDocuments, auth: true },
  { m: 'GET', p: '/api/projects/:pid/unstructured-datasources/:dsid/documents/:docId/chunks', fn: unstructured.listDocumentChunks, auth: true },
  { m: 'POST', p: '/api/projects/:pid/unstructured-datasources/:dsid/documents/:docId/reprocess', fn: unstructured.reprocessDocument, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/unstructured-datasources/:dsid/documents/:docId', fn: unstructured.deleteDocument, auth: true },
  { m: 'POST', p: '/api/projects/:pid/unstructured-datasources/:dsid/documents/delete_batch', fn: unstructured.deleteDocumentsBatch, auth: true },
  { m: 'POST', p: '/api/projects/:pid/unstructured-datasources/:dsid/search', fn: unstructured.searchDatasource, auth: true },
  { m: 'POST', p: '/api/projects/:pid/unstructured-documents/generate-descriptions', fn: unstructured.generateDocumentDescriptions, auth: true },
  { m: 'POST', p: '/api/projects/:pid/unstructured-datasources/:dsid/generate-description', fn: unstructured.generateDatasourceDescriptionDoc, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/unstructured-documents/:docId/description', fn: unstructured.updateDocumentDescription, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/unstructured-datasources/:dsid/description', fn: unstructured.updateDatasourceDescription, auth: true },
];

// 迁移自 dsh_kernel/semantic_catalogs/unstructured_data/document_loaders/(桌面版,用 Node 库)
//
// 按扩展名把文件读成纯文本:
//   - txt/md/log/json/csv:Node 内置 fs(json 美化、csv 原样文本)
//   - html/htm:剥标签
//   - pdf:pdf-parse / docx:mammoth / xlsx·xls:xlsx(各 sheet 转文本)
// 不支持的扩展名抛错(由上层标记文档失败)。

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function loadPdf(path) {
  const mod = await import('pdf-parse');
  const pdf = mod.default || mod;
  const buf = await readFile(path);
  const r = await pdf(buf);
  return r.text || '';
}

async function loadDocx(path) {
  const mod = await import('mammoth');
  const mammoth = mod.default || mod;
  const r = await mammoth.extractRawText({ path });
  return r.value || '';
}

async function loadXlsx(path) {
  const mod = await import('xlsx');
  const XLSX = mod.default || mod;
  const wb = XLSX.readFile(path);
  const parts = [];
  for (const name of wb.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    if (csv && csv.trim()) parts.push(`# Sheet: ${name}\n${csv}`);
  }
  return parts.join('\n\n');
}

/**
 * 把文件加载为纯文本。
 * @param {string} filePath
 * @param {string} [fileExt] 扩展名(不含点);不给则从 filePath 推断
 * @returns {Promise<string>}
 */
export async function loadDocument(filePath, fileExt = null) {
  const ext = String(fileExt || extname(filePath).slice(1) || '').toLowerCase();
  switch (ext) {
    case 'txt': case 'md': case 'markdown': case 'log': case 'text':
      return (await readFile(filePath, 'utf8'));
    case 'csv': case 'tsv':
      return (await readFile(filePath, 'utf8'));
    case 'json': {
      const raw = await readFile(filePath, 'utf8');
      try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
    }
    case 'html': case 'htm':
      return stripHtml(await readFile(filePath, 'utf8'));
    case 'pdf':
      return loadPdf(filePath);
    case 'docx':
      return loadDocx(filePath);
    case 'xlsx': case 'xls':
      return loadXlsx(filePath);
    default:
      throw new Error(`不支持的文档类型: .${ext}(支持 txt/md/csv/json/html/pdf/docx/xlsx)`);
  }
}

/** 支持的扩展名(供上层校验/前端提示)。 */
export const SUPPORTED_EXTS = ['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'json', 'html', 'htm', 'pdf', 'docx', 'xlsx', 'xls'];

export default loadDocument;

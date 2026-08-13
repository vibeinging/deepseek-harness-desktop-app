// DuckDB 数据访问层 —— 原生 Node 绑定(@duckdb/node-api),替代原先的 python3 子进程。
// 数据全程本地、不出网,且**自包含**:打包后无需用户机装 python + duckdb pip 包。
//
// 提供(均为 async):
// - duckSchema(path): 列出所有表 + 列(information_schema + DESCRIBE)
// - duckRun(path, sql, limit): 执行只读 SQL,返回 {columns, rows}
// - duckRunRecords(path, sql, limit): 同上,返回 List<Object>(行字典)
// - duckListTables(path): 读 _intermediate_metadata 元数据表(中间库)
// - duckTableSchema(path, table): DESCRIBE 单表
// - duckSampleRows(path, table, limit): 取样本行(行字典)
// - duckTableExists(path, table): 元数据表里是否存在该表
// - duckWriteRecords(path, name, records, columns): 记录数组 → DuckDB 表(read_write)
// - duckImportFile(path, name, src, fmt): 本地文件(csv/parquet/json/xlsx)→ DuckDB 表
// 同步工具:duckFormatForExt / sanitizeTableName / sanitizeColumnName / METADATA_TABLE
//
// 注意:native DuckDB 整数列返回 BigInt、DATE/TIMESTAMP/DECIMAL 返回特殊对象 —— safe() 归一
//   (BigInt→Number、Decimal→Number、Date/Timestamp 等→字符串),对齐原 Python safe()。
// 连接:每次操作 open→run→close(close 释放文件锁,已验证可重开),对齐原 python 无状态语义。

import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const METADATA_TABLE = '_intermediate_metadata';

/** 值归一:对齐 Python safe()。BigInt→Number、Decimal→Number、Date/Timestamp 等→字符串,其余透传。 */
function safe(v) {
  if (v == null) return v;
  const t = typeof v;
  if (t === 'bigint') return Number(v);
  if (t === 'object') {
    if (v.constructor?.name === 'DuckDBDecimalValue') {
      const n = Number(v.toString());
      return Number.isNaN(n) ? v.toString() : n;
    }
    if (typeof v.toString === 'function') return v.toString(); // Date / Timestamp / Time / Interval / ...
    return v;
  }
  return v; // number / string / boolean
}

/** 单引号转义(供文件路径字面量内插;路径为服务端可控)。 */
const esc = (s) => String(s ?? '').replace(/'/g, "''");
/** 双引号转义(供标识符内插)。 */
const qid = (s) => String(s ?? '').replace(/"/g, '""');
/** path 字符串化(允许传 URL/Path-like) */
function toPath(p) { return String(p ?? ''); }

function inferDuckTypeForColumn(records, column) {
  let type = null;
  for (const row of records || []) {
    const value = row?.[column];
    if (value === null || value === undefined) continue;
    const valueType = typeof value;
    let nextType = 'VARCHAR';
    if (valueType === 'boolean') nextType = 'BOOLEAN';
    else if (valueType === 'number' || valueType === 'bigint') {
      const n = Number(value);
      nextType = Number.isInteger(n) ? 'BIGINT' : 'DOUBLE';
    } else if (valueType === 'object') {
      nextType = 'JSON';
    }
    if (!type) {
      type = nextType;
      continue;
    }
    if (type === nextType) continue;
    if ((type === 'BIGINT' && nextType === 'DOUBLE') || (type === 'DOUBLE' && nextType === 'BIGINT')) {
      type = 'DOUBLE';
      continue;
    }
    type = 'VARCHAR';
  }
  return type || 'VARCHAR';
}

async function normalizeInferredColumnTypes(con, tableName, records, columns) {
  for (const column of columns || []) {
    const desiredType = inferDuckTypeForColumn(records, column);
    if (desiredType === 'JSON') continue;
    try {
      await con.run(
        `ALTER TABLE "${qid(tableName)}" ALTER COLUMN "${qid(column)}" SET DATA TYPE ${desiredType} ` +
          `USING CAST("${qid(column)}" AS ${desiredType})`,
      );
    } catch (e) {
      console.warn(`[duck] 列类型归一失败 ${tableName}.${column} -> ${desiredType}: ${e?.message ?? e}`);
    }
  }
}

/** 打开 DuckDB(per-call,read_only 或 read_write)→ 跑 fn → 关闭(释放锁)。 */
async function withDuck(path, { readOnly = false, create = false } = {}, fn) {
  const p = toPath(path);
  if (create) {
    const dir = dirname(p);
    if (dir) { try { mkdirSync(dir, { recursive: true }); } catch { /* ignore */ } }
  }
  const inst = await DuckDBInstance.create(p, readOnly ? { access_mode: 'READ_ONLY' } : {});
  let con;
  try {
    con = await inst.connect();
    return await fn(con);
  } finally {
    try { con?.disconnectSync?.(); } catch { /* ignore */ }
    try { con?.closeSync?.(); } catch { /* ignore */ }
    try { inst?.closeSync?.(); } catch { /* ignore */ }
  }
}

/** 读 SQL → {columns, rows(已归一二维数组)}。limit=null 全量;否则读到 ≥limit 再切到 limit。 */
async function readCR(con, sql, limit, parameters = []) {
  const values = Array.isArray(parameters) && parameters.length ? parameters : undefined;
  const reader = (limit == null)
    ? await con.runAndReadAll(sql, values)
    : await con.runAndReadUntil(sql, Number(limit), values);
  const columns = reader.columnNames();
  let rows = reader.getRows();
  if (limit != null && rows.length > Number(limit)) rows = rows.slice(0, Number(limit));
  return { columns, rows: rows.map((r) => r.map(safe)) };
}

/** 把 {columns, rows} 拉成行字典数组(对齐 df.to_dict('records'))。 */
function toRecords({ columns, rows }) {
  return rows.map((row) => {
    const o = {};
    columns.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

// ── 对外 API(均 async)──

/** 列出 DuckDB 文件里所有表及其列。 */
export async function duckSchema(path) {
  return withDuck(path, { readOnly: true }, async (con) => {
    const { rows } = await readCR(
      con,
      "SELECT table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','pg_catalog')",
      null,
    );
    const out = [];
    for (const [t] of rows) {
      const d = await readCR(con, `DESCRIBE SELECT * FROM "${qid(t)}"`, null);
      out.push({ table: t, columns: d.rows.map((r) => ({ name: r[0], type: r[1] })) });
    }
    return { tables: out };
  });
}

/** 执行只读 SQL,返回原始 columns/rows(二维数组,已归一)。 */
export async function duckRun(path, sql, limit = 200, parameters = []) {
  return withDuck(path, { readOnly: true }, (con) => readCR(con, sql, limit, parameters));
}

/** 执行只读 SQL,返回行字典列表。 */
export async function duckRunRecords(path, sql, limit = 200, parameters = []) {
  return toRecords(await duckRun(path, sql, limit, parameters));
}

/** 读中间库元数据表 _intermediate_metadata。文件不存在返回 []。兼容旧表无 sub_query/sql_query 列。 */
export async function duckListTables(path) {
  const p = toPath(path);
  if (!existsSync(p)) return [];
  try {
    return await withDuck(p, { readOnly: true }, async (con) => {
      let rows;
      let has = true;
      try {
        rows = (await readCR(
          con,
          `SELECT table_name, description, row_count, column_count, created_at, COALESCE(sub_query,'') sub_query, COALESCE(sql_query,'') sql_query FROM ${METADATA_TABLE} ORDER BY created_at DESC`,
          null,
        )).rows;
      } catch {
        has = false;
        try {
          rows = (await readCR(
            con,
            `SELECT table_name, description, row_count, column_count, created_at FROM ${METADATA_TABLE} ORDER BY created_at DESC`,
            null,
          )).rows;
        } catch { rows = []; }
      }
      return rows.map((r) => ({
        table_name: r[0],
        description: r[1],
        row_count: r[2],
        column_count: r[3],
        created_at: r[4],
        sub_query: has ? r[5] : '',
        sql_query: has ? r[6] : '',
      }));
    });
  } catch (e) {
    console.error('[duck] duckListTables 失败:', e?.message ?? e);
    return [];
  }
}

/** DESCRIBE 单表,返回 [{name, type}]。文件/表不存在返回 []。 */
export async function duckTableSchema(path, table) {
  const p = toPath(path);
  if (!existsSync(p)) return [];
  try {
    return await withDuck(p, { readOnly: true }, async (con) => {
      const { rows } = await readCR(con, `DESCRIBE "${qid(table)}"`, null);
      return rows.map((r) => ({ name: r[0], type: r[1] }));
    });
  } catch (e) {
    console.error('[duck] duckTableSchema 失败:', e?.message ?? e);
    return [];
  }
}

/** 取样本行(行字典)。文件/表不存在返回 []。 */
export async function duckSampleRows(path, table, limit = 5) {
  const p = toPath(path);
  if (!existsSync(p)) return [];
  try {
    return await withDuck(p, { readOnly: true }, async (con) => {
      const cr = await readCR(con, `SELECT * FROM "${qid(table)}" LIMIT ${Number(limit)}`, limit);
      return toRecords(cr);
    });
  } catch (e) {
    console.error('[duck] duckSampleRows 失败:', e?.message ?? e);
    return [];
  }
}

/** 中间库元数据表里是否存在该表(table 原始名,内部 sanitize)。 */
export async function duckTableExists(path, table) {
  const p = toPath(path);
  if (!existsSync(p)) return false;
  const sanitized = sanitizeTableName(table);
  return (await duckListTables(p)).some((t) => t.table_name === sanitized);
}

/**
 * 把记录数组写入 DuckDB 表(read_write,文件不存在自动建)。
 * @returns {{success, table_name, row_count, column_count}}
 */
export async function duckWriteRecords(path, name, records, columns = [], meta = null) {
  const nm = qid(name);
  const recs = records || [];
  const cols = columns || [];
  const columnCount = cols.length || (recs[0] ? Object.keys(recs[0]).length : 0);
  return withDuck(path, { create: true }, async (con) => {
    await con.run(`DROP TABLE IF EXISTS "${nm}"`);
    let rc = 0;
    if (!recs.length) {
      if (cols.length) {
        const coldefs = cols.map((c) => `"${qid(c)}" VARCHAR`).join(', ');
        await con.run(`CREATE TABLE "${nm}" (${coldefs})`);
      }
    } else {
      const tmp = `${toPath(path)}.${randomBytes(4).toString('hex')}.json`;
      // BigInt/Date 等已在读取侧归一;这里再兜底 BigInt → Number,避免 JSON.stringify 抛错。
      writeFileSync(tmp, JSON.stringify(recs, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)));
      try {
        await con.run(`CREATE TABLE "${nm}" AS SELECT * FROM read_json_auto('${esc(tmp)}', format='array')`);
        await normalizeInferredColumnTypes(con, name, recs, cols.length ? cols : Object.keys(recs[0] || {}));
        const cnt = await readCR(con, `SELECT count(*) n FROM "${nm}"`, 1);
        rc = Number(cnt.rows[0]?.[0] ?? 0);
      } finally {
        try { unlinkSync(tmp); } catch { /* ignore */ }
      }
    }
    // 登记到 _intermediate_metadata(否则中间表对 duckListTables/profile/renderIntermediateSection 不可见)。
    // schema 对齐 duckListTables 的读列;table_name 主键,先删后插做 upsert。
    if (meta) {
      await con.run(
        `CREATE TABLE IF NOT EXISTS ${METADATA_TABLE} (table_name VARCHAR PRIMARY KEY, description VARCHAR, row_count INTEGER, column_count INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, sub_query VARCHAR DEFAULT '', sql_query VARCHAR DEFAULT '')`,
      );
      await con.run(`DELETE FROM ${METADATA_TABLE} WHERE table_name = '${esc(name)}'`);
      await con.run(
        `INSERT INTO ${METADATA_TABLE} (table_name, description, row_count, column_count, sub_query, sql_query, created_at) ` +
          `VALUES ('${esc(name)}', '${esc(meta.description ?? '')}', ${Number(rc)}, ${Number(columnCount)}, '${esc(meta.sub_query ?? '')}', '${esc(meta.sql_query ?? '')}', CURRENT_TIMESTAMP)`,
      );
    }
    return { success: true, table_name: name, row_count: rc, column_count: columnCount };
  });
}

const IMPORT_FORMATS = new Set(['csv', 'parquet', 'json', 'xlsx']);

/**
 * 把本地结构化文件(csv/parquet/json/xlsx)解析进 DuckDB 表(原生 read_*_auto,read_write)。
 * @returns {{success, table_name, row_count, columns:[{name,type}]}}
 */
export async function duckImportFile(path, name, src, fmt) {
  const sanitized = sanitizeTableName(name);
  const nm = qid(sanitized);
  if (!IMPORT_FORMATS.has(fmt)) throw new Error('unsupported format: ' + String(fmt));
  const r = await withDuck(path, { create: true }, async (con) => {
    await con.run(`DROP TABLE IF EXISTS "${nm}"`);
    if (fmt === 'csv') {
      await con.run(`CREATE TABLE "${nm}" AS SELECT * FROM read_csv_auto('${esc(src)}', header=true, all_varchar=false, sample_size=-1)`);
    } else if (fmt === 'parquet') {
      await con.run(`CREATE TABLE "${nm}" AS SELECT * FROM read_parquet('${esc(src)}')`);
    } else if (fmt === 'json') {
      // 探测 KDD/包裹格式 {table:<名>, records:[<行>,...]}:先展平 records,非包裹直读。
      let doc = null;
      try { doc = JSON.parse(readFileSync(src, 'utf8')); } catch { doc = null; }
      if (doc && typeof doc === 'object' && !Array.isArray(doc) && Array.isArray(doc.records)) {
        const tmp = `${src}.records.json`;
        writeFileSync(tmp, JSON.stringify(doc.records));
        try { await con.run(`CREATE TABLE "${nm}" AS SELECT * FROM read_json_auto('${esc(tmp)}', format='array')`); }
        finally { try { unlinkSync(tmp); } catch { /* ignore */ } }
      } else {
        await con.run(`CREATE TABLE "${nm}" AS SELECT * FROM read_json_auto('${esc(src)}')`);
      }
    } else if (fmt === 'xlsx') {
      await con.run('INSTALL excel; LOAD excel;');
      await con.run(`CREATE TABLE "${nm}" AS SELECT * FROM read_xlsx('${esc(src)}', all_varchar=false)`);
    }
    const cnt = await readCR(con, `SELECT count(*) n FROM "${nm}"`, 1);
    const d = await readCR(con, `DESCRIBE "${nm}"`, null);
    return {
      success: true,
      table_name: sanitized,
      row_count: Number(cnt.rows[0]?.[0] ?? 0),
      columns: d.rows.map((r2) => ({ name: r2[0], type: r2[1] })),
    };
  });
  return { ...r, table_name: sanitized };
}

const _FMT_BY_EXT = {
  csv: 'csv', tsv: 'csv', txt: 'csv',
  parquet: 'parquet', pq: 'parquet',
  json: 'json', jsonl: 'json', ndjson: 'json',
  xlsx: 'xlsx', xls: 'xlsx',
};

/** 由文件扩展名推断 DuckDB 导入格式;不支持返回 null。 */
export function duckFormatForExt(ext) {
  return _FMT_BY_EXT[String(ext || '').toLowerCase().replace(/^\./, '')] || null;
}

/** 清理表名,确保符合 DuckDB 命名规范(对齐 IntermediateStorageService.sanitize_table_name)。 */
export function sanitizeTableName(name) {
  let sanitized = String(name ?? '').replace(/[^\w]/g, '_');
  if (sanitized && /^[0-9]/.test(sanitized[0])) sanitized = `t_${sanitized}`;
  sanitized = sanitized.toLowerCase();
  if (sanitized.length > 100) sanitized = sanitized.slice(0, 100);
  return sanitized || 'table';
}

/** 清理列名(对齐 IntermediateStorageService.sanitize_column_name)。保留中文/字母/数字/下划线。 */
export function sanitizeColumnName(name) {
  const nameStr = name != null ? String(name) : 'unnamed';
  let sanitized = nameStr.replace(/[^\w一-鿿]/g, '_');
  sanitized = sanitized.replace(/_+/g, '_');
  sanitized = sanitized.replace(/^_+|_+$/g, '');
  if (!sanitized || /^[0-9]/.test(sanitized[0])) {
    sanitized = sanitized ? `col_${sanitized}` : 'col';
  }
  if (sanitized.length > 100) sanitized = sanitized.slice(0, 100);
  return sanitized;
}

export { METADATA_TABLE };

export default {
  duckSchema,
  duckRun,
  duckRunRecords,
  duckListTables,
  duckTableSchema,
  duckSampleRows,
  duckTableExists,
  duckWriteRecords,
  duckImportFile,
  duckFormatForExt,
  sanitizeTableName,
  sanitizeColumnName,
  METADATA_TABLE,
};

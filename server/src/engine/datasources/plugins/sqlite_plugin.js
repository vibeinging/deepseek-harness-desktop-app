// SQLite 插件:把本地 .db / .sqlite 文件当作业务库连接(better-sqlite3 打开外部文件)。
//
// 与 db.js 的元数据库无关——这里用全新的 better-sqlite3 句柄直接打开 config.database 指向的
// 外部 SQLite 文件,跑原生 SQL(不经 PG→SQLite 翻译 shim)。供本地 .db 数据集
// 以「本地路径」方式建连接并同步 schema，无需上传。
//
// 只实现核心 5 法 + 方言;getExampleValues/getDistinctValues/searchColumnValues/explain 走 base 默认实现。

import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { PluginRegistry, DatabasePlugin } from './base.js';

/** 打开外部 SQLite 文件(优先 read-only;不支持则回退 read-write,仅 SELECT 不会改数据)。 */
function openDb(config) {
  const path = config?.database || config?.host;
  if (!path) throw new Error('SQLite 连接缺少 database(文件路径)');
  if (!existsSync(path)) throw new Error(`SQLite 文件不存在: ${path}`);
  try {
    return new Database(path, { readonly: true });
  } catch {
    return new Database(path);
  }
}

const qid = (s) => `"${String(s).replace(/"/g, '""')}"`;

export class SQLitePlugin extends DatabasePlugin {
  static metadata = {
    value: 'SQLite',
    label: 'SQLite',
    default_port: null,
    multiple_schema: false,
    description: '本地 SQLite 文件(.db / .sqlite)',
    aliases: ['sqlite', 'sqlite3', 'db'],
  };

  async testConnection(config) {
    try {
      const db = openDb(config);
      try {
        db.prepare('SELECT 1').get();
        const version = db.prepare('SELECT sqlite_version() AS v').get().v;
        return { success: true, message: '连接成功', connection_info: this.getConnectionInfo(config, version) };
      } finally {
        db.close();
      }
    } catch (e) {
      return { success: false, message: '连接失败: ' + (e?.message || String(e)) };
    }
  }

  async getVersion(config) {
    const db = openDb(config);
    try {
      return db.prepare('SELECT sqlite_version() AS v').get().v;
    } finally {
      db.close();
    }
  }

  async executeQuery(config, sql, opts = {}) {
    let db;
    try {
      db = openDb(config);
      const parameters = Array.isArray(opts?.parameters) ? opts.parameters : [];
      const data = db.prepare(sql).all(...parameters);
      const columns = data.length
        ? Object.keys(data[0]).map((name) => ({ column_name: name, data_type: 'UNKNOWN', is_nullable: true, default_value: null }))
        : [];
      return { success: true, message: '查询成功', data, columns, row_count: data.length, sql_executed: sql };
    } catch (e) {
      const msg = e?.message || String(e);
      return { success: false, message: '查询失败: ' + msg, error: msg, data: [], columns: [], row_count: 0, sql_executed: sql };
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  async getSchemas(_config) {
    return ['main'];
  }

  async getSchemaInfo(config, _opts = {}) {
    let db;
    try {
      db = openDb(config);
      const tblRows = db.prepare(
        `SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      ).all();
      const tables = [];
      for (const t of tblRows) {
        const colInfo = db.prepare(`PRAGMA table_info(${qid(t.name)})`).all();
        let fkRows = [];
        try { fkRows = db.prepare(`PRAGMA foreign_key_list(${qid(t.name)})`).all(); } catch { fkRows = []; }
        const fkSet = new Set(fkRows.map((f) => f.from));
        const columns = colInfo.map((c) => ({
          column_name: c.name,
          data_type: c.type || 'UNKNOWN',
          is_nullable: c.notnull === 0,
          default_value: c.dflt_value ?? null,
          is_primary_key: c.pk > 0,
          is_foreign_key: fkSet.has(c.name),
        }));
        let rowCount = null;
        try { rowCount = Number(db.prepare(`SELECT count(*) AS n FROM ${qid(t.name)}`).get().n); } catch { rowCount = null; }
        tables.push({
          table_name: t.name,
          schema_name: 'main',
          table_type: t.type === 'view' ? 'VIEW' : 'TABLE',
          is_view: t.type === 'view',
          row_count: rowCount,
          columns,
        });
      }
      return { tables };
    } catch (e) {
      return { tables: [], error: e?.message || String(e) };
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }
  }

  // ── 方言 ──
  quoteIdentifier(identifier) {
    return qid(identifier);
  }

  quoteTableWithSchema(tableName) {
    // SQLite 单库,忽略 schema 前缀
    return qid(tableName);
  }
}

PluginRegistry.register(new SQLitePlugin());

export default SQLitePlugin;

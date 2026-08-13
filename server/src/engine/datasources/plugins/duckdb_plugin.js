// DuckDB 插件:让 DuckDB 文件库走 PluginRegistry 的统一 schema 内省 / 查询 / 示例值流程
// (sync-schema / store-vectors / example-values 都依赖它)。底层复用 duck.js 的原生 DuckDB(@duckdb/node-api)访问。
//
// 文件路径取 config.database(eval 上传后建连接时只填 database);兼容 host 兜底(老连接 host=path)。
import { DatabasePlugin, PluginRegistry } from './base.js';
import { duckSchema, duckRun, duckRunRecords } from '../duck.js';

function dbPath(config) {
  return config?.database || config?.host || '';
}

export class DuckDBPlugin extends DatabasePlugin {
  static metadata = {
    value: 'DuckDB',
    label: 'DuckDB',
    default_port: null,
    multiple_schema: false,
    description: '本地 DuckDB 文件库',
    aliases: ['duckdb'],
  };

  async testConnection(config) {
    try {
      const r = await duckSchema(dbPath(config));
      if (r?.error) return { success: false, message: '连接失败: ' + r.error };
      return {
        success: true,
        message: '连接成功',
        connection_info: { db_type: 'DuckDB', database: dbPath(config), version: 'DuckDB' },
      };
    } catch (e) {
      return { success: false, message: '连接失败: ' + (e?.message || String(e)) };
    }
  }

  async getVersion(_config) {
    return 'DuckDB';
  }

  async getSchemas(_config) {
    return ['main'];
  }

  async getSchemaInfo(config, _opts = {}) {
    try {
      const path = dbPath(config);
      const res = await duckSchema(path); // { tables: [{ table, columns: [{name,type}] }] }
      const tables = [];
      for (const t of res?.tables || []) {
        let rowCount = null;
        try {
          const c = await duckRun(path, `SELECT count(*) AS n FROM "${t.table}"`, 1);
          const n = Number(c?.rows?.[0]?.[0]);
          rowCount = Number.isNaN(n) ? null : n;
        } catch {
          rowCount = null;
        }
        tables.push({
          table_name: t.table,
          schema_name: 'main',
          table_type: 'TABLE',
          is_view: false,
          row_count: rowCount,
          columns: (t.columns || []).map((c) => ({
            column_name: c.name,
            data_type: c.type || 'UNKNOWN',
            is_nullable: true,
            default_value: null,
            is_primary_key: false,
            is_foreign_key: false,
          })),
        });
      }
      return { tables };
    } catch (e) {
      return { tables: [], error: e?.message || String(e) };
    }
  }

  async executeQuery(config, sql, opts = {}) {
    try {
      const path = dbPath(config);
      const limit = opts?.limit ?? 200;
      const data = await duckRunRecords(path, sql, limit, opts?.parameters || []);
      const columns = data.length ? Object.keys(data[0]).map((name) => ({ name })) : [];
      return { success: true, message: '查询成功', data, columns, row_count: data.length, sql_executed: sql };
    } catch (e) {
      const msg = e?.message || String(e);
      return { success: false, message: '查询失败: ' + msg, error: msg, data: [], columns: [], row_count: 0, sql_executed: sql };
    }
  }

  // getExampleValues / getDistinctValues / searchColumnValues / explain 走 base 默认实现(复用 executeQuery)。
}

PluginRegistry.register(new DuckDBPlugin());
export default DuckDBPlugin;

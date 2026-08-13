// 迁移自 backend/dsh_kernel/semantic_catalogs/database/entity_service.py
//
// 数据库数据源实体提取服务（DB 级）：从数据库表中提取实体数据（数据名词 column_value /
// 字段名词 column_name），并管理实体映射配置。继承 EntityServiceBase。
// 对外方法名按源码 1:1 保留，供下游路由（business_semantic / database 路由）import 不改调用方。
//
// 原 Python 类名 DatabaseEntityService（下游以此名 import），本波统一产物清单又登记为
// EntityService —— 两者均导出（EntityService 为 DatabaseEntityService 的别名）。
//
// ============================ 桌面版迁移要点 ============================
// 1. 无 ORM / AsyncSession / 事务：原 Python 用 SQLAlchemy select/delete/func + db.add/
//    flush/commit/rollback/refresh。本版所有需要查库的方法第一个参数改为注入的 ctx/deps：
//      {
//        query(sql, params)->Promise<rows>,        // SELECT / INSERT..RETURNING / DELETE..RETURNING
//        queryOne(sql, params)->Promise<row|null>,  // 单行
//        execute(sql, params)->Promise<{rowCount}>, // 无返回的写（可选；缺省回退到 query）
//      }
//    事务边界（commit/rollback）由上层注入的连接/事务管理负责，本服务不显式控制。
//    Vastbase 把空串当 NULL：判空用 IS NOT NULL；所有查询带 deleted_at IS NULL 软删过滤。
//    .in_() → = ANY($n)。
// 2. 主键 / 时间戳：entity_mappings / entity_mapping_configs 主键为 uuid7 字符串（原默认值由
//    BaseModel 生成）。桌面版无 uuid7 服务，INSERT 时本层用 _gen_id() 生成 UUID 作为 id，
//    created_at/updated_at 用 now()。INSERT 一律带 RETURNING id 回填，保持返回结构含 config_id。
// 3. embedding/向量召回：当前已接入 core/llm.js 的 embed() 和 VexDB 余弦距离查询。
//    generate_entity_embeddings 会分批写入真实向量；没有可用模型或向量扩展时返回明确的
//    降级结果。count_entities_with_embedding 和 vector_count 继续按真实 embedding 覆盖数统计。
// 4. 目标库取 distinct 值（_fetch_distinct_values）：原版走 database_plugin_service 插件直连目标库。
//    本层改为通过注入的 dataSource（DatabaseDataSource 实例，含 query_distinct_values）取值；
//    无 dataSource 时返回 []，并标 TODO。
// 5. @cache(get_entity_mapping_configs) → 用 cache.js 的 withCache 内存缓存；
//    invalidate_cache 直接复用。fastapi-cache 的 key_builder=service_key_builder 同步沿用。
// 6. embedding_state（后台向量生成状态，内存级）：内联一个等价的内存单例（原独立模块未迁移）。
// 7. metadata_fields / sample_entities 在 entity_mapping_configs 里是 JSONB（pg 驱动收发对象/数组）；
//    meta_data 在 entity_mappings 里是 Text(JSON 字符串)。
// 8. BusinessEntityService.invalidate_entity_config_cache / entity_suggest_service.suggest_entity_columns
//    尚未迁移：前者就近用 invalidate_cache('get_entity_mapping_configs', {project_id}) 等价实现；
//    后者尝试动态 import，缺失时返回 [] 并标 TODO。
// =======================================================================

import crypto from 'crypto';
import { NotFoundError, ValidationError } from '../core/exceptions.js';
import { t } from '../utils/i18n.js';
import { service_key_builder, invalidate_cache, withCache } from '../core/cache.js';
import { EntityServiceBase } from './entity_service_base.js';

// ---------------------------------------------------------------------------
// 向量生成状态跟踪（内存级，内联自未迁移的 database/embedding_state.py）
// config_id → {status:'generating'|'failed', error?}，供 get_entity_mapping_configs 返回状态。
// ---------------------------------------------------------------------------
class _EmbeddingState {
  constructor() {
    this._states = new Map();
  }

  set_generating(configId) {
    this._states.set(configId, { status: 'generating' });
  }

  set_failed(configId, error) {
    this._states.set(configId, { status: 'failed', error });
  }

  clear_state(configId) {
    this._states.delete(configId);
  }

  /** @returns {'generating'|'failed'|null} */
  get_status(configId) {
    const state = this._states.get(configId);
    return state ? state.status : null;
  }

  get_error(configId) {
    const state = this._states.get(configId);
    return state ? (state.error ?? null) : null;
  }

  has(configId) {
    return this._states.has(configId);
  }
}

export const embedding_state = new _EmbeddingState();

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 生成实体 / 配置主键（桌面版替代 uuid7 默认值）。 */
function _gen_id() {
  return crypto.randomUUID();
}

/** PG bool 规整为 JS boolean（pg 驱动一般已返回 boolean，兜底字符串）。 */
function _toBool(v) {
  if (v === true || v === false) return v;
  if (v == null) return false;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase();
  return s === 't' || s === 'true' || s === '1' || s === 'y';
}

/** ISO 字符串化（对应 created_at.isoformat()）。 */
function _isoOrNull(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** JSONB 列规整：pg 驱动返回对象/数组则原样；字符串则尝试 parse。 */
function _asJsonb(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return raw;
  }
}

/**
 * 统一写库入口：优先用 ctx.execute，否则回退 ctx.query。
 * @param {object} ctx
 * @param {string} sql
 * @param {Array} params
 * @returns {Promise<Array<object>>} 返回行（RETURNING 时有值）
 */
async function _exec(ctx, sql, params) {
  if (typeof ctx.execute === 'function') {
    const r = await ctx.execute(sql, params);
    return Array.isArray(r) ? r : (r?.rows ?? []);
  }
  return ctx.query(sql, params);
}

class DatabaseEntityService extends EntityServiceBase {
  // ==================== 表信息获取 ====================

  /**
   * 获取表信息并预加载关联连接信息（对应 _get_table_with_connection + selectinload）。
   * 返回的表行额外带 connection_id（= database_connection.id）以兼容原版 table.database_connection.id。
   * @param {{queryOne:Function}} ctx
   * @param {string} table_id
   * @returns {Promise<object>} table_metadata 行（含 database_connection_id 等）
   */
  static async _get_table_with_connection(ctx, table_id) {
    const table = await ctx.queryOne(
      `SELECT id, table_name, schema_name, database_connection_id
         FROM table_metadata
        WHERE id = $1 AND deleted_at IS NULL`,
      [table_id],
    );
    if (!table) {
      throw new NotFoundError(t('表不存在'));
    }
    return table;
  }

  /**
   * 获取结构化表的 TableMetadata 信息。
   * @param {{queryOne:Function}} ctx
   * @param {string} table_id
   * @param {string} data_source_id
   * @returns {Promise<[object, string]>} [table_metadata 行, database_connection_id]
   */
  static async _get_structured_table_metadata(ctx, table_id, data_source_id) {
    // 获取结构化数据源的 database_connection_id
    const dataSource = await ctx.queryOne(
      `SELECT id, database_connection_id
         FROM structured_data_sources
        WHERE id = $1 AND deleted_at IS NULL`,
      [data_source_id],
    );
    if (!dataSource || !dataSource.database_connection_id) {
      throw new NotFoundError(t('结构化数据源不存在或未完成同步'));
    }

    const table = await ctx.queryOne(
      `SELECT id, table_name, schema_name, database_connection_id
         FROM table_metadata
        WHERE id = $1
          AND database_connection_id = $2
          AND deleted_at IS NULL`,
      [table_id, dataSource.database_connection_id],
    );
    if (!table) {
      throw new NotFoundError(t('结构化表不存在'));
    }
    return [table, dataSource.database_connection_id];
  }

  // ==================== 数据名词提取 ====================

  /**
   * 从数据库表或结构化表提取列值实体（数据名词）。
   * 实体配置归属数据源级别（database_connection_id）。project_id 仅用于向后兼容和缓存清除。
   *
   * @param {{query:Function, queryOne:Function, execute?:Function, dataSource?:object}} ctx
   * @param {string} source_id
   * @param {string} source_type
   * @param {string} table_id
   * @param {string} column_name
   * @param {string} project_id
   * @param {object} [opts]
   * @param {Array<string>|null} [opts.metadata_fields=null]
   * @param {string|null} [opts.rule=null]
   * @param {string|null} [opts.project_id=null]
   * @returns {Promise<{success:boolean, count:number, config_id:string, message:string}>}
   */
  static async extract_column_value_entities(ctx, source_id, source_type, table_id, column_name, project_id, {
    metadata_fields = null, rule = null,
  } = {}) {
    try {
      let table;
      // 根据数据源类型获取表信息
      if (source_type === 'structured') {
        const [structTable, connectionId] = await DatabaseEntityService._get_structured_table_metadata(
          ctx, table_id, source_id,
        );
        table = structTable;
        source_id = connectionId;
        source_type = 'database';
      } else {
        table = await DatabaseEntityService._get_table_with_connection(ctx, table_id);
        if (table.database_connection_id !== source_id) {
          throw new ValidationError(t('表与数据源不匹配'));
        }
      }

      const tableName = table.table_name;
      const tableSchema = table.schema_name;

      // 检查是否已存在相同配置（数据源级去重）
      const _schema = (tableSchema && tableSchema !== 'default') ? tableSchema : null;
      const existParams = [source_id, source_id, tableName, column_name];
      let existSql = `SELECT id FROM entity_mapping_configs
                       WHERE database_connection_id = $1
                         AND source_id = $2
                         AND table_name = $3
                         AND column_name = $4
                         AND entity_type = 'column_value'
                         AND deleted_at IS NULL`;
      if (_schema) {
        existParams.push(_schema);
        existSql += ` AND schema_name = $${existParams.length}`;
      } else {
        existSql += ' AND schema_name IS NULL';
      }
      const existing = await ctx.queryOne(existSql, existParams);
      if (existing) {
        throw new ValidationError(t('实体配置已存在：{}.{}', tableName, column_name));
      }

      // 创建配置（归属数据源）
      const configId = _gen_id();
      await _exec(
        ctx,
        `INSERT INTO entity_mapping_configs
           (id, database_connection_id, project_id, import_type, source_id, source_type,
            table_name, column_name, schema_name, entity_type, metadata_fields, rule, is_active,
            created_at, updated_at)
         VALUES ($1, $2, $3, 'database', $4, $5, $6, $7, $8, 'column_value', $9, $10, TRUE, now(), now())`,
        [
          configId, source_id, project_id, source_id, source_type,
          tableName, column_name, _schema,
          metadata_fields != null ? JSON.stringify(metadata_fields) : null,
          rule,
        ],
      );

      // 从数据库提取实体数据
      const entityValues = await DatabaseEntityService._fetch_distinct_values(
        ctx, source_id, tableName, column_name, tableSchema, metadata_fields,
      );

      if (!entityValues.length) {
        await invalidate_cache('get_entity_mapping_configs', { connection_id: source_id });
        if (project_id) {
          await DatabaseEntityService._invalidate_business_entity_cache(project_id);
        }
        return {
          success: true,
          count: 0,
          config_id: configId,
          message: t('列 {} 没有找到有效数据', column_name),
        };
      }

      // 批量存储实体（基类构建待插入行，本层负责落库）
      const entityRows = await DatabaseEntityService._store_entities_batch(
        ctx, project_id, source_id, source_type, entityValues, tableName, column_name,
        { config_id: configId, entity_type: 'column_value', include_source_value: true, schema_name: tableSchema },
      );
      await DatabaseEntityService._insert_entity_mappings(ctx, entityRows);

      // 更新样本实体
      const entityNames = entityValues.map((e) => e.entity_name);
      const sampleEntities = DatabaseEntityService.get_diverse_length_samples(entityNames, 3);
      await _exec(
        ctx,
        'UPDATE entity_mapping_configs SET sample_entities = $1, updated_at = now() WHERE id = $2',
        [JSON.stringify(sampleEntities), configId],
      );

      await invalidate_cache('get_entity_mapping_configs', { connection_id: source_id });
      if (project_id) {
        await DatabaseEntityService._invalidate_business_entity_cache(project_id);
      }

      return {
        success: true,
        count: entityValues.length,
        config_id: configId,
        message: t('成功为列 {} 创建了 {} 个实体映射', column_name, entityValues.length),
      };
    } catch (e) {
      console.error(`创建实体映射配置失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  // ==================== 字段名词创建 ====================

  /**
   * 创建列名实体（将表的列名作为实体存储）。
   * @param {{query:Function, queryOne:Function, execute?:Function}} ctx
   * @param {string} project_id
   * @param {string} table_id
   * @param {string} source_type 'database' 或 'structured'
   * @param {Array<object>} columns 每项含 column_name 和可选 description
   * @param {object} [opts]
   * @param {string|null} [opts.rule=null]
   * @param {string|null} [opts.project_id=null]
   * @returns {Promise<{success:boolean, count:number, config_id:string, message:string}>}
   */
  static async create_column_name_entities(ctx, project_id, table_id, source_type, columns, {
    rule = null,
  } = {}) {
    try {
      let sourceId;
      let tableName;
      let schemaName;

      // 根据数据源类型获取表信息
      if (source_type === 'structured') {
        const table = await ctx.queryOne(
          `SELECT id, table_name, schema_name, database_connection_id
             FROM table_metadata
            WHERE id = $1 AND deleted_at IS NULL`,
          [table_id],
        );
        if (!table) {
          throw new NotFoundError(t('结构化表不存在'));
        }
        sourceId = table.database_connection_id;
        tableName = table.table_name;
        schemaName = table.schema_name;
        source_type = 'database';
      } else {
        const table = await DatabaseEntityService._get_table_with_connection(ctx, table_id);
        sourceId = table.database_connection_id;
        tableName = table.table_name;
        schemaName = table.schema_name;
      }

      // 检查是否已存在列名实体配置（数据源级去重）
      const _schema = (schemaName && schemaName !== 'default') ? schemaName : null;
      const existParams = [sourceId, sourceId, tableName];
      let existSql = `SELECT id, rule FROM entity_mapping_configs
                       WHERE database_connection_id = $1
                         AND source_id = $2
                         AND table_name = $3
                         AND entity_type = 'column_name'
                         AND deleted_at IS NULL`;
      if (_schema) {
        existParams.push(_schema);
        existSql += ` AND schema_name = $${existParams.length}`;
      } else {
        existSql += ' AND schema_name IS NULL';
      }
      let config = await ctx.queryOne(existSql, existParams);

      let configId;
      if (!config) {
        // 创建新配置（归属数据源）
        configId = _gen_id();
        await _exec(
          ctx,
          `INSERT INTO entity_mapping_configs
             (id, database_connection_id, project_id, import_type, source_id, source_type,
              table_name, column_name, schema_name, entity_type, rule, is_active, created_at, updated_at)
           VALUES ($1, $2, $3, 'column_name', $4, $5, $6, NULL, $7, 'column_name', $8, TRUE, now(), now())`,
          [configId, sourceId, project_id, sourceId, source_type, tableName, _schema, rule],
        );
        config = { id: configId };
      } else {
        configId = config.id;
        if (rule) {
          await _exec(
            ctx,
            'UPDATE entity_mapping_configs SET rule = $1, updated_at = now() WHERE id = $2',
            [rule, configId],
          );
        }
      }

      // 获取已存在的列名实体
      const existingRows = await ctx.query(
        'SELECT name FROM entity_mappings WHERE config_id = $1 AND deleted_at IS NULL',
        [configId],
      );
      const existingNames = new Set(existingRows.map((row) => row.name));

      // 创建新的列名实体（英文列名 + 中文注释分别存储）
      let createdCount = 0;
      const allEntityNames = [];
      const newEntityRows = [];

      for (const colInfo of columns) {
        const colName = colInfo.column_name;
        const colDesc = colInfo.description;

        if (!colName) continue;

        // 1. 创建英文列名实体
        if (!existingNames.has(colName)) {
          allEntityNames.push(colName);

          const metaData = {
            table_name: tableName,
            column_name: colName, // 实际的英文列名
            source_type: 'column_name',
            description: colDesc ?? null,
          };
          if (schemaName) metaData.schema_name = schemaName;

          newEntityRows.push({
            project_id,
            name: colName,
            source_id: sourceId,
            source_type,
            entity_type: 'column_name',
            config_id: configId,
            meta_data: JSON.stringify(metaData),
          });
          createdCount += 1;
        }

        // 2. 如果有中文注释，额外创建中文注释实体
        if (colDesc && colDesc.trim() && !existingNames.has(colDesc) && colDesc !== colName) {
          allEntityNames.push(colDesc);

          const metaDataDesc = {
            table_name: tableName,
            column_name: colName, // 指向实际的英文列名
            source_type: 'column_name',
            description: colDesc,
            is_alias: true, // 标记为别名（中文注释）
          };
          if (schemaName) metaDataDesc.schema_name = schemaName;

          newEntityRows.push({
            project_id,
            name: colDesc, // 使用中文注释作为 name
            source_id: sourceId,
            source_type,
            entity_type: 'column_name',
            config_id: configId,
            meta_data: JSON.stringify(metaDataDesc),
          });
          createdCount += 1;
        }
      }

      await DatabaseEntityService._insert_entity_mappings(ctx, newEntityRows);

      // 更新样本实体（包含英文和中文）
      const allNames = [...existingNames, ...allEntityNames];
      const sampleEntities = DatabaseEntityService.get_diverse_length_samples(allNames.slice(0, 100), 3);
      await _exec(
        ctx,
        'UPDATE entity_mapping_configs SET sample_entities = $1, updated_at = now() WHERE id = $2',
        [JSON.stringify(sampleEntities), configId],
      );

      // 清除缓存
      await invalidate_cache('get_entity_mapping_configs', { connection_id: sourceId });
      if (project_id) {
        await DatabaseEntityService._invalidate_business_entity_cache(project_id);
      }

      return {
        success: true,
        count: createdCount,
        config_id: configId,
        message: t('成功创建 {} 个列名实体', createdCount),
      };
    } catch (e) {
      console.error(`创建列名实体失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  // ==================== Excel 导入 ====================

  /**
   * 从 Excel 导入实体数据。
   * @param {{queryOne:Function, execute?:Function, query:Function}} ctx
   * @param {string} project_id
   * @param {string} project_id
   * @param {Array<object>} entities
   * @param {string} config_name
   * @param {object} [opts]
   * @param {string|null} [opts.rule=null]
   * @returns {Promise<{success:boolean, count:number, config_id:string, message:string}>}
   */
  static async import_entities_from_excel(ctx, project_id, entities, config_name, {
    rule = null,
  } = {}) {
    try {
      // 验证业务权限
      await DatabaseEntityService._validate_business(ctx, project_id);

      // 创建 Excel 导入类型的配置
      const configId = _gen_id();
      await _exec(
        ctx,
        `INSERT INTO entity_mapping_configs
           (id, project_id, import_type, source_id, source_type, table_name, column_name,
            config_name, entity_type, rule, is_active, created_at, updated_at)
         VALUES ($1, $2, 'excel', NULL, NULL, NULL, NULL, $3, 'column_value', $4, TRUE, now(), now())`,
        [configId, project_id, config_name, rule],
      );

      // 批量创建实体
      let createdCount = 0;
      const newEntityRows = [];
      for (const entityData of entities) {
        const entityName = entityData.name ?? entityData.entity_name;
        if (!entityName) continue;

        const metaData = {};
        for (const [k, v] of Object.entries(entityData)) {
          if (!['name', 'entity_name'].includes(k)) metaData[k] = v;
        }
        const hasMeta = Object.keys(metaData).length > 0;

        newEntityRows.push({
          project_id,
          name: String(entityName),
          source_id: null,
          source_type: null,
          entity_type: 'column_value',
          config_id: configId,
          meta_data: hasMeta ? JSON.stringify(metaData) : null,
        });
        createdCount += 1;
      }
      await DatabaseEntityService._insert_entity_mappings(ctx, newEntityRows);

      // 更新样本实体
      const entityNames = entities
        .map((e) => e.name ?? e.entity_name)
        .filter((n) => n);
      const sampleEntities = DatabaseEntityService.get_diverse_length_samples(entityNames.slice(0, 100), 3);
      await _exec(
        ctx,
        'UPDATE entity_mapping_configs SET sample_entities = $1, updated_at = now() WHERE id = $2',
        [JSON.stringify(sampleEntities), configId],
      );

      // 清除缓存
      await DatabaseEntityService._invalidate_business_entity_cache(project_id);

      return {
        success: true,
        count: createdCount,
        config_id: configId,
        message: t('成功从 Excel 导入了 {} 个实体', createdCount),
      };
    } catch (e) {
      console.error(`Excel 导入实体失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  // ==================== 数据库提取辅助方法 ====================

  /**
   * 从目标数据库获取不重复的实体值。
   *
   * ⚠️ 桌面版无插件直连：原版走 database_plugin_service._get_plugin(...).get_distinct_values。
   *    本层改为通过注入的 ctx.dataSource（DatabaseDataSource 实例，含 query_distinct_values）取值；
   *    无 dataSource 时返回 []（不静默丢功能，标 TODO）。
   *    注：query_distinct_values 仅返回单列值，metadata_fields（附加列）在桌面版退化为不取，
   *    仅产出 entity_name（原版带 metadata_fields 时会多取附加列，本层标 TODO）。
   *
   * @param {{dataSource?:object}} ctx
   * @param {string} connection_id 数据源连接 id（保留位置语义）
   * @param {string} table_name
   * @param {string} column_name
   * @param {string|null} [schema_name=null]
   * @param {Array<string>|null} [metadata_fields=null]
   * @returns {Promise<Array<object>>} [{ entity_name, table_name, column_name, ...metadata }]
   */
  static async _fetch_distinct_values(ctx, connection_id, table_name, column_name, schema_name = null, metadata_fields = null) {
    try {
      const dataSource = ctx?.dataSource;
      if (!dataSource || typeof dataSource.query_distinct_values !== 'function') {
        // TODO(distinct): 桌面版未注入 DatabaseDataSource，无法直连目标库取 distinct 值。
        console.warn('[DatabaseEntityService] _fetch_distinct_values 未注入 dataSource，返回空');
        return [];
      }

      const allValues = [];
      const batchSize = 10000;
      let offset = 0;

      // TODO(metadata_fields): query_distinct_values 仅返回单列值，附加 metadata_fields 暂不支持。
      for (;;) {
        const batchValues = await dataSource.query_distinct_values(table_name, column_name, {
          schema_name: schema_name || 'public',
          limit: batchSize,
          offset,
        });

        if (!batchValues || !batchValues.length) break;

        for (const value of batchValues) {
          if (value !== null && value !== undefined && String(value).trim()) {
            allValues.push({
              entity_name: String(value),
              table_name,
              column_name,
            });
          }
        }

        if (batchValues.length < batchSize) break;
        offset += batchSize;
      }

      return allValues;
    } catch (e) {
      console.error(`获取实体值失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 批量插入实体行（内部工具，落库 _store_entities_batch / create_column_name_entities 构建的行）。
   * 用单条多值 INSERT；空数组直接返回。
   * @param {{query:Function, execute?:Function}} ctx
   * @param {Array<object>} rows 形如 {project_id,name,source_id,source_type,entity_type,config_id,meta_data}
   * @returns {Promise<void>}
   */
  static async _insert_entity_mappings(ctx, rows) {
    if (!rows || !rows.length) return;

    const cols = ['id', 'project_id', 'name', 'source_id', 'source_type', 'entity_type', 'config_id', 'meta_data'];
    const valuesClauses = [];
    const params = [];
    let p = 0;

    for (const row of rows) {
      const placeholders = [];
      const rowVals = [
        _gen_id(),
        row.project_id ?? null,
        row.name,
        row.source_id ?? null,
        row.source_type ?? null,
        row.entity_type ?? 'column_value',
        row.config_id ?? null,
        row.meta_data ?? null,
      ];
      for (const v of rowVals) {
        p += 1;
        placeholders.push(`$${p}`);
        params.push(v);
      }
      // created_at / updated_at 用 now()
      valuesClauses.push(`(${placeholders.join(', ')}, now(), now())`);
    }

    const sql = `INSERT INTO entity_mappings (${cols.join(', ')}, created_at, updated_at)
                 VALUES ${valuesClauses.join(', ')}`;
    await _exec(ctx, sql, params);
  }

  /**
   * 就近清除项目级实体配置缓存（BusinessEntityService.invalidate_entity_config_cache 等价实现，
   * 原服务未迁移）。
   * @param {string} project_id
   * @returns {Promise<void>}
   */
  static async _invalidate_business_entity_cache(project_id) {
    // BusinessEntityService.invalidate_entity_config_cache 内部即按 project_id 清缓存。
    await invalidate_cache('get_entity_mapping_configs', { project_id });
  }

  // ==================== 配置管理方法 ====================

  /**
   * 获取实体映射配置列表（带内存缓存）。
   * 实际实现见 _get_entity_mapping_configs_impl；此处用 withCache 包裹保留 @cache 语义。
   * @param {{query:Function}} ctx
   * @param {string} connection_id
   * @param {string} project_id
   * @param {string|null} [table_name=null]
   * @returns {Promise<Array<object>>}
   */
  static async get_entity_mapping_configs(ctx, connection_id, project_id, table_name = null) {
    return DatabaseEntityService._cachedGetConfigs(ctx, connection_id, project_id, table_name);
  }

  /**
   * 实际查询逻辑（未缓存）。优化：批量查询替代 N+1。
   * @param {{query:Function}} ctx
   * @param {string} connection_id
   * @param {string} project_id
   * @param {string|null} table_name
   * @returns {Promise<Array<object>>}
   */
  static async _get_entity_mapping_configs_impl(ctx, connection_id, project_id, table_name = null) {
    try {
      // 1. 构建主查询获取所有配置
      const params = [connection_id];
      let sql = `SELECT id, table_name, column_name, schema_name, entity_type,
                        metadata_fields, is_active, rule, created_at, updated_at
                   FROM entity_mapping_configs
                  WHERE source_id = $1
                    AND source_type = 'database'
                    AND deleted_at IS NULL`;
      if (table_name) {
        params.push(table_name);
        sql += ` AND table_name = $${params.length}`;
      }
      sql += ' ORDER BY table_name, column_name';

      const configList = await ctx.query(sql, params);
      if (!configList.length) return [];

      // 2. 批量查询所有实体的统计信息（按 entity_type 分组）
      //    meta_data 是 Text(JSON)：用 (meta_data::jsonb)->>'key' 提取 table_name/column_name。
      const statsRows = await ctx.query(
        `SELECT (meta_data::jsonb)->>'table_name'  AS table_name,
                (meta_data::jsonb)->>'column_name' AS column_name,
                entity_type                        AS entity_type,
                COUNT(id)                          AS entity_count,
                COUNT(embedding)                   AS vector_count
           FROM entity_mappings
          WHERE source_id = $1
            AND source_type = 'database'
            AND deleted_at IS NULL
          GROUP BY (meta_data::jsonb)->>'table_name',
                   (meta_data::jsonb)->>'column_name',
                   entity_type`,
        [connection_id],
      );

      // 构建统计信息的字典
      // 列值实体：key = "table_name|column_name"；列名实体：按表汇总
      const statsDict = {};
      const columnNameStats = {};
      for (const row of statsRows) {
        const entityType = row.entity_type || 'column_value';
        if (entityType === 'column_name') {
          const tableKey = row.table_name;
          if (!(tableKey in columnNameStats)) {
            columnNameStats[tableKey] = { entity_count: 0, vector_count: 0 };
          }
          columnNameStats[tableKey].entity_count += Number(row.entity_count) || 0;
          columnNameStats[tableKey].vector_count += Number(row.vector_count) || 0;
        } else {
          const key = `${row.table_name}|${row.column_name}`;
          statsDict[key] = {
            entity_count: Number(row.entity_count) || 0,
            vector_count: Number(row.vector_count) || 0,
          };
        }
      }

      // 3. 组装结果
      const configs = [];
      for (const config of configList) {
        const entityType = config.entity_type || 'column_value';
        let stats;
        if (entityType === 'column_name') {
          stats = columnNameStats[config.table_name] || { entity_count: 0, vector_count: 0 };
        } else {
          const key = `${config.table_name}|${config.column_name}`;
          stats = statsDict[key] || { entity_count: 0, vector_count: 0 };
        }

        const entityCount = stats.entity_count;
        const vectorCount = stats.vector_count;

        // 向量状态：优先检查后台生成状态
        const bgStatus = embedding_state.get_status(config.id);
        let vectorStatus;
        let vectorError;
        if (bgStatus === 'generating') {
          vectorStatus = '生成中';
          vectorError = null;
        } else if (bgStatus === 'failed') {
          vectorStatus = '生成失败';
          vectorError = embedding_state.get_error(config.id);
        } else if (vectorCount > 0) {
          vectorStatus = '已生成';
          vectorError = null;
        } else {
          vectorStatus = '未生成';
          vectorError = null;
        }

        configs.push({
          id: config.id,
          table_name: config.table_name,
          column_name: config.column_name,
          schema_name: config.schema_name,
          entity_type: entityType,
          metadata_fields: _asJsonb(config.metadata_fields),
          is_active: config.is_active,
          rule: config.rule,
          created_at: _isoOrNull(config.created_at),
          updated_at: _isoOrNull(config.updated_at),
          entity_count: entityCount,
          vector_count: vectorCount,
          vector_status: vectorStatus,
          vector_error: vectorError,
        });
      }

      return configs;
    } catch (e) {
      console.error(`获取实体映射配置失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 删除实体映射配置（通过 ID）并级联删除对应的实体。
   * @param {{query:Function, queryOne:Function, execute?:Function}} ctx
   * @param {string} connection_id
   * @param {string} config_id
   * @param {string} project_id
   * @returns {Promise<boolean>}
   */
  static async delete_entity_mapping_config(ctx, connection_id, config_id, project_id) {
    try {
      // 验证权限：数据库连接存在
      const connection = await ctx.queryOne(
        'SELECT id FROM database_connections WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
        [connection_id, project_id],
      );
      if (!connection) {
        throw new NotFoundError(t('数据库连接不存在'));
      }

      // 查找配置
      const config = await ctx.queryOne(
        `SELECT id, table_name, column_name, project_id
           FROM entity_mapping_configs
          WHERE id = $1
            AND source_id = $2
            AND source_type = 'database'
            AND deleted_at IS NULL`,
        [config_id, connection_id],
      );
      if (!config) {
        throw new NotFoundError(t('实体映射配置不存在'));
      }

      const tableName = config.table_name;
      const columnName = config.column_name;

      // 0. 收集所有引用该配置的业务 ID（用于后续清缓存）
      const refRows = await ctx.query(
        `SELECT project_id FROM business_entity_configs
          WHERE entity_config_id = $1 AND deleted_at IS NULL`,
        [config_id],
      );
      const affectedProjectIds = refRows.map((row) => row.project_id);

      // 1. 删除关联的 business_entity_configs 引用记录
      await _exec(ctx, 'DELETE FROM business_entity_configs WHERE entity_config_id = $1', [config_id]);

      // 2. 删除该配置对应的所有实体映射（通过 config_id 关联）
      const delResult = await _exec(
        ctx,
        'DELETE FROM entity_mappings WHERE config_id = $1 RETURNING id',
        [config_id],
      );
      const deletedEntityCount = Array.isArray(delResult) ? delResult.length : 0;

      // 3. 再删除配置
      await _exec(ctx, 'DELETE FROM entity_mapping_configs WHERE id = $1', [config_id]);

      // 清除缓存
      await invalidate_cache('get_entity_mapping_configs', { connection_id });
      if (config.project_id) affectedProjectIds.push(config.project_id);
      for (const pid of new Set(affectedProjectIds)) {
        await DatabaseEntityService._invalidate_business_entity_cache(pid);
      }

      console.info(
        `成功删除实体映射配置: ${tableName}.${columnName}, 同时删除了 ${deletedEntityCount} 个实体映射`,
      );
      return true;
    } catch (e) {
      console.error(`删除实体映射配置失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 更新实体映射配置（如 rule、is_active 字段）。
   * @param {{queryOne:Function, execute?:Function}} ctx
   * @param {string} config_id
   * @param {string} connection_id
   * @param {string} project_id
   * @param {object} [opts]
   * @param {string|null} [opts.rule=null]
   * @param {boolean|null} [opts.is_active=null]
   * @returns {Promise<object>}
   */
  static async update_entity_mapping_config(ctx, config_id, connection_id, project_id, {
    rule = null, is_active = null,
  } = {}) {
    try {
      // 验证权限
      const connection = await ctx.queryOne(
        'SELECT id FROM database_connections WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
        [connection_id, project_id],
      );
      if (!connection) {
        throw new NotFoundError(t('数据库连接不存在'));
      }

      // 查找配置
      const config = await ctx.queryOne(
        `SELECT id, table_name, column_name, project_id, rule, is_active
           FROM entity_mapping_configs
          WHERE id = $1
            AND source_id = $2
            AND source_type = 'database'
            AND deleted_at IS NULL`,
        [config_id, connection_id],
      );
      if (!config) {
        throw new NotFoundError(t('实体映射配置不存在'));
      }

      // 构建更新字段
      const setClauses = [];
      const params = [];
      if (rule !== null) {
        params.push(rule);
        setClauses.push(`rule = $${params.length}`);
      }
      if (is_active !== null) {
        params.push(is_active);
        setClauses.push(`is_active = $${params.length}`);
      }

      let updated = { ...config };
      if (setClauses.length) {
        setClauses.push('updated_at = now()');
        params.push(config_id);
        const updatedRows = await _exec(
          ctx,
          `UPDATE entity_mapping_configs SET ${setClauses.join(', ')}
            WHERE id = $${params.length}
        RETURNING id, table_name, column_name, project_id, rule, is_active`,
          params,
        );
        if (Array.isArray(updatedRows) && updatedRows.length) {
          updated = updatedRows[0];
        } else {
          if (rule !== null) updated.rule = rule;
          if (is_active !== null) updated.is_active = is_active;
        }
      }

      // 清除配置缓存
      await invalidate_cache('get_entity_mapping_configs', { connection_id });
      if (updated.project_id) {
        await DatabaseEntityService._invalidate_business_entity_cache(project_id, updated.project_id);
      }

      console.info(
        `成功更新实体映射配置: ${updated.table_name}.${updated.column_name}, rule=${rule}, is_active=${is_active}`,
      );

      return {
        id: updated.id,
        table_name: updated.table_name,
        column_name: updated.column_name,
        rule: updated.rule,
        is_active: updated.is_active,
      };
    } catch (e) {
      console.error(`更新实体映射配置失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 删除实体映射配置（通过表名和列名）并级联删除对应的实体。
   * 两种模式：指定 column_name 删特定列；column_name 为空删整表所有配置。
   * @param {{query:Function, queryOne:Function, execute?:Function}} ctx
   * @param {string} connection_id
   * @param {string} table_name
   * @param {string|null} column_name
   * @param {string} project_id
   * @param {object} [opts]
   * @param {string|null} [opts.schema_name=null]
   * @returns {Promise<boolean>}
   */
  static async delete_entity_mapping_config_by_table_column(ctx, connection_id, table_name, column_name, project_id, {
    schema_name = null,
  } = {}) {
    try {
      // 验证权限
      const connection = await ctx.queryOne(
        'SELECT id FROM database_connections WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
        [connection_id, project_id],
      );
      if (!connection) {
        throw new NotFoundError(t('数据库连接不存在'));
      }

      let businessId = null;

      // 构建 schema_name 过滤条件片段
      const _schema = (schema_name && schema_name !== 'default') ? schema_name : null;

      if (column_name) {
        // 删除特定列的配置
        const params = [connection_id, table_name, column_name];
        let sql = `SELECT id, project_id FROM entity_mapping_configs
                    WHERE source_id = $1
                      AND source_type = 'database'
                      AND table_name = $2
                      AND column_name = $3
                      AND deleted_at IS NULL`;
        if (_schema) {
          params.push(_schema);
          sql += ` AND schema_name = $${params.length}`;
        } else {
          sql += ' AND schema_name IS NULL';
        }
        const config = await ctx.queryOne(sql, params);
        if (!config) {
          throw new NotFoundError(t('实体映射配置不存在: {}.{}', table_name, column_name));
        }

        businessId = config.project_id;

        // 1. 先删除该配置对应的所有实体映射（通过 config_id 精确关联）
        const delEntities = await _exec(
          ctx,
          'DELETE FROM entity_mappings WHERE config_id = $1 RETURNING id',
          [config.id],
        );
        const deletedEntityCount = Array.isArray(delEntities) ? delEntities.length : 0;

        // 2. 再删除配置
        await _exec(ctx, 'DELETE FROM entity_mapping_configs WHERE id = $1', [config.id]);

        console.info(
          `成功删除实体映射配置: ${table_name}.${column_name}, 同时删除了 ${deletedEntityCount} 个实体映射`,
        );
      } else {
        // 删除整个表的所有配置
        const params = [connection_id, table_name];
        let sql = `SELECT id, project_id FROM entity_mapping_configs
                    WHERE source_id = $1
                      AND source_type = 'database'
                      AND table_name = $2
                      AND deleted_at IS NULL`;
        if (_schema) {
          params.push(_schema);
          sql += ` AND schema_name = $${params.length}`;
        } else {
          sql += ' AND schema_name IS NULL';
        }
        const configs = await ctx.query(sql, params);
        if (!configs.length) {
          throw new NotFoundError(t('表 {} 不存在实体映射配置', table_name));
        }

        businessId = configs[0].project_id;
        const configIds = configs.map((c) => c.id);

        // 1. 先删除该表所有配置对应的实体映射（通过 config_id 精确关联）
        const delEntities = await _exec(
          ctx,
          'DELETE FROM entity_mappings WHERE config_id::text = ANY($1::text[]) RETURNING id',
          [configIds],
        );
        const deletedEntityCount = Array.isArray(delEntities) ? delEntities.length : 0;

        // 2. 再删除所有配置
        await _exec(ctx, 'DELETE FROM entity_mapping_configs WHERE id::text = ANY($1::text[])', [configIds]);

        console.info(
          `成功删除表 ${table_name} 的所有实体映射配置: 删除了 ${configIds.length} 个配置, ${deletedEntityCount} 个实体映射`,
        );
      }

      // 清除实体映射配置缓存
      await invalidate_cache('get_entity_mapping_configs', { connection_id });
      if (businessId) {
        await DatabaseEntityService._invalidate_business_entity_cache(project_id, businessId);
      }

      return true;
    } catch (e) {
      console.error(`删除实体映射配置失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 统计有向量嵌入的实体数量（按 source_id 过滤，返回真实计数，可能 > 0）。
   * @param {{queryOne:Function}} ctx
   * @param {string} connection_id
   * @returns {Promise<number>}
   */
  static async count_entities_with_embedding(ctx, connection_id) {
    const row = await ctx.queryOne(
      `SELECT COUNT(*) AS cnt FROM entity_mappings
        WHERE source_id = $1
          AND embedding IS NOT NULL
          AND deleted_at IS NULL`,
      [connection_id],
    );
    return row ? (Number(row.cnt) || 0) : 0;
  }

  /**
   * 获取激活状态的实体来源配置（用于实体召回）。
   * @param {{query:Function}} ctx
   * @param {string} database_id
   * @returns {Promise<Array<object>>}
   */
  static async get_active_entity_sources(ctx, database_id) {
    try {
      const configs = await ctx.query(
        `SELECT id, table_name, column_name, schema_name, entity_type, sample_entities, rule
           FROM entity_mapping_configs
          WHERE source_id = $1
            AND source_type = 'database'
            AND is_active = TRUE
            AND sample_entities IS NOT NULL
            AND deleted_at IS NULL
          ORDER BY table_name, column_name`,
        [database_id],
      );

      return configs.map((config) => ({
        id: config.id,
        table_name: config.table_name,
        column_name: config.column_name,
        schema_name: config.schema_name,
        entity_type: config.entity_type || 'column_value',
        sample_entities: _asJsonb(config.sample_entities) || [],
        rule: config.rule,
      }));
    } catch (e) {
      console.error(`获取激活实体来源失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  // ==================== 实体列推荐（委托） ====================

  /**
   * 自动推荐适合创建实体索引的列，委托给 entity_suggest_service。
   *
   * ⚠️ entity_suggest_service 尚未迁移：尝试动态 import，缺失时返回 [] 并标 TODO。
   *
   * @param {object} ctx
   * @param {string} connection_id
   * @param {string} project_id
   * @param {object} [opts]
   * @param {Array<string>|null} [opts.table_ids=null]
   * @param {number} [opts.min_score=0.4]
   * @param {boolean} [opts.use_llm=false]
   * @returns {Promise<Array<object>>}
   */
  static async suggest_entity_columns(ctx, connection_id, project_id, {
    table_ids = null, min_score = 0.4, use_llm = false,
  } = {}) {
    try {
      // TODO(migrate): entity_suggest_service.js 未迁移，动态探测。
      const mod = await import('./entity_suggest_service.js').catch(() => null);
      const suggest = mod && (mod.suggest_entity_columns || mod.default);
      if (typeof suggest === 'function') {
        return await suggest(ctx, connection_id, project_id, table_ids, min_score, use_llm);
      }
    } catch (e) {
      console.warn(`suggest_entity_columns 委托失败: ${e?.message ?? e}`);
    }
    console.warn('[DatabaseEntityService] entity_suggest_service 未迁移，suggest_entity_columns 返回空');
    return [];
  }

  /**
   * 为数据源级实体生成向量嵌入。
   *
   * 对该数据源（source_id=connection_id, source_type='database'）下 embedding IS NULL 的实体，
   * 组合 name + meta_data(description/column_name/table_name) 文本批量向量化并回填。
   * 委托基类 _generate_embeddings_for_entities 落库；无 EMBEDDING 模型 / 向量扩展未就绪时
   * 降级为 processed=0（不抛）。生成期间用 embedding_state 标记状态，失败标 failed。
   *
   * @param {{query:Function, queryOne?:Function, execute?:Function}} ctx
   * @param {string} connection_id
   * @param {string} project_id
   * @param {object} [opts]
   * @param {string|null} [opts.config_id=null] 仅生成指定配置下的实体（可选）
   * @param {number} [opts.batch_size=1000]
   * @returns {Promise<{success:boolean, total:number, processed:number, message:string}>}
   */
  static async generate_entity_embeddings(ctx, connection_id, project_id, {
    config_id = null, batch_size = 1000,
  } = {}) {
    if (config_id) embedding_state.set_generating(config_id);
    try {
      let total = 0;
      let processed = 0;

      if (config_id) {
        // 指定配置：直接对该 config 下 embedding IS NULL 的实体生成
        const r = await DatabaseEntityService._generate_embeddings_for_config(
          ctx, config_id, project_id, batch_size,
        );
        total = r.total;
        processed = r.processed;
      } else {
        // 数据源级：委托基类按 source_id/source_type 生成
        const r = await DatabaseEntityService._generate_embeddings_for_entities(
          ctx, null, connection_id, 'database', project_id, batch_size,
        );
        total = r.total;
        processed = r.processed;
      }

      if (config_id) embedding_state.clear_state(config_id);
      await invalidate_cache('get_entity_mapping_configs', { connection_id });

      if (!total) {
        return {
          success: true,
          total: 0,
          processed: 0,
          message: t('没有找到需要生成向量的实体'),
        };
      }
      return {
        success: true,
        total,
        processed,
        message: t('成功为 {} 个实体生成向量（共 {} 个待处理）', processed, total),
      };
    } catch (e) {
      if (config_id) embedding_state.set_failed(config_id, e?.message ?? String(e));
      console.error(`生成实体向量失败: ${e?.message ?? e}`);
      await invalidate_cache('get_entity_mapping_configs', { connection_id });
      return {
        success: false,
        total: 0,
        processed: 0,
        message: t('生成实体向量失败: {}', e?.message ?? String(e)),
      };
    }
  }

  /**
   * 为单个配置下 embedding IS NULL 的实体生成向量（generate_entity_embeddings 的 config 分支）。
   * 复用基类的取数→embed→回填批处理逻辑，但以 config_id 为过滤维度。
   * @param {{query:Function, execute?:Function}} ctx
   * @param {string} config_id
   * @param {string} project_id
   * @param {number} [batch_size=1000]
   * @returns {Promise<{total:number, processed:number}>}
   */
  static async _generate_embeddings_for_config(ctx, config_id, project_id, batch_size = 1000) {
    try {
      const { embed } = await import('../core/llm.js');
      const { vectorReady } = await import('../../db.js');
      if (!vectorReady) {
        console.warn('[DatabaseEntityService] 向量扩展未就绪，跳过实体向量生成');
        return { total: 0, processed: 0 };
      }

      const rows = await ctx.query(
        `SELECT id, name, meta_data FROM entity_mappings
          WHERE config_id = $1 AND embedding IS NULL AND deleted_at IS NULL
          LIMIT $2`,
        [config_id, batch_size],
      );
      const total = rows.length;
      if (!total) return { total: 0, processed: 0 };

      let processed = 0;
      const EMBED_BATCH = 16;
      for (let i = 0; i < rows.length; i += EMBED_BATCH) {
        const batch = rows.slice(i, i + EMBED_BATCH);
        const texts = batch.map((r) => DatabaseEntityService._entityEmbeddingText(r));
        let vecs;
        try {
          vecs = await embed(texts, { project_id });
        } catch (e) {
          console.warn(`[DatabaseEntityService] 实体 embed 失败，保留降级: ${e?.message ?? e}`);
          break;
        }
        if (!Array.isArray(vecs) || !vecs.length) break;
        for (let j = 0; j < batch.length; j += 1) {
          const vec = vecs[j];
          if (!Array.isArray(vec) || !vec.length) continue;
          await DatabaseEntityService._updateEntityEmbedding(ctx, batch[j].id, vec);
          processed += 1;
        }
      }
      return { total, processed };
    } catch (e) {
      console.error(`按配置生成实体向量失败: ${e?.message ?? e}`);
      return { total: 0, processed: 0 };
    }
  }

  /**
   * 判断某列是否有实体索引。
   * @param {{queryOne:Function}} ctx
   * @param {string} database_id
   * @param {string} table_name
   * @param {string} column_name
   * @param {object} [opts]
   * @param {string|null} [opts.schema_name=null]
   * @returns {Promise<object>} { has_index, config_id?, entity_type?, project_id?, table_name?, column_name? }
   */
  static async check_column_has_entity_index(ctx, database_id, table_name, column_name, {
    schema_name = null,
  } = {}) {
    try {
      const _schema = (schema_name && schema_name !== 'default') ? schema_name : null;
      const params = [database_id, table_name, column_name];
      let sql = `SELECT id, entity_type, project_id, table_name, column_name
                   FROM entity_mapping_configs
                  WHERE source_id = $1
                    AND source_type = 'database'
                    AND table_name = $2
                    AND column_name = $3
                    AND is_active = TRUE
                    AND sample_entities IS NOT NULL
                    AND deleted_at IS NULL`;
      if (_schema) {
        params.push(_schema);
        sql += ` AND schema_name = $${params.length}`;
      } else {
        sql += ' AND schema_name IS NULL';
      }

      const config = await ctx.queryOne(sql, params);

      if (config) {
        return {
          has_index: true,
          config_id: String(config.id),
          entity_type: config.entity_type,
          project_id: String(config.project_id),
          table_name: config.table_name,
          column_name: config.column_name,
        };
      }

      return { has_index: false };
    } catch (e) {
      console.error(`检查列实体索引失败: ${e?.message ?? e}`);
      return { has_index: false };
    }
  }
}

// @cache(expire=86400, key_builder=service_key_builder) 的等价内存缓存包裹。
// 注：service_key_builder 默认排除 DB session/复杂对象，ctx 作为对象不会进入 key；
// 实际缓存 key 取决于 connection_id/project_id/table_name 等基础参数（与 Python 版语义一致）。
function get_entity_mapping_configs(ctx, connection_id, project_id, table_name = null) {
  return DatabaseEntityService._get_entity_mapping_configs_impl(ctx, connection_id, project_id, table_name);
}
get_entity_mapping_configs.__paramNames = [null, 'connection_id', 'project_id', 'table_name'];

DatabaseEntityService._cachedGetConfigs = withCache({ expire: 86400, keyBuilder: service_key_builder })(get_entity_mapping_configs);

// 本波产物清单登记名 EntityService = 真实 Python 类名 DatabaseEntityService 的别名。
export { DatabaseEntityService };
export const EntityService = DatabaseEntityService;
export default DatabaseEntityService;

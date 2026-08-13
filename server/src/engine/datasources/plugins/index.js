/**
 * 数据库插件入口:导入即触发各插件 register 到 PluginRegistry。
 * 新增引擎(oracle / clickhouse …)在此 import 一行即可。
 */
import { PluginRegistry, DatabasePlugin } from './base.js'
import './postgresql_plugin.js'
import './mysql_plugin.js'
import './sqlite_plugin.js'
import './duckdb_plugin.js'
import './oracle_plugin.js'
import './sqlserver_plugin.js'
import './clickhouse_plugin.js'

export { PluginRegistry, DatabasePlugin }
export default PluginRegistry

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('../../server/node_modules/better-sqlite3');

const MODEL_CATEGORIES = new Set(['PRIMARY', 'SECONDARY', 'VISION', 'EMBEDDING', 'IMAGE']);

function parseExtraConfig(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function enabled(value) {
  return [1, true, '1', 'true'].includes(value);
}

export function defaultConfiguredModelSourcePath(env = process.env) {
  const explicit = String(env.DSH_EVAL_MODEL_SOURCE_DB || '').trim();
  return explicit ? path.resolve(explicit) : path.join(homedir(), '.dsh', 'local.db');
}

export function normalizeConfiguredModelRows(rows = []) {
  const activeByCategory = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const category = String(row?.category || '').trim().toUpperCase();
    if (!MODEL_CATEGORIES.has(category) || !enabled(row?.is_enabled)) continue;
    if (!row?.model_name || !row?.api_base || activeByCategory.has(category)) continue;
    activeByCategory.set(category, {
      model_name: String(row.model_name),
      display_name: String(row.display_name || row.model_name),
      category,
      api_base: String(row.api_base),
      api_key: row.api_key == null ? null : String(row.api_key),
      api_format: String(row.api_format || 'chat_completions'),
      supports_streaming: enabled(row.supports_streaming),
      dimension: row.dimension == null ? null : Number(row.dimension),
      extra_config: parseExtraConfig(row.extra_config),
    });
  }
  return [...activeByCategory.values()];
}

export function readConfiguredModels(sourceDbPath = defaultConfiguredModelSourcePath()) {
  const resolved = path.resolve(String(sourceDbPath || ''));
  if (!resolved || !existsSync(resolved)) {
    throw new Error(`找不到当前模型配置数据库: ${resolved || '(empty)'}`);
  }
  const db = new BetterSqlite3(resolved, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT model_name, display_name, category, api_base, api_key, api_format,
             supports_streaming, dimension, is_enabled, extra_config, updated_at
        FROM llm_models
       WHERE project_id IS NULL AND deleted_at IS NULL AND is_enabled=1
       ORDER BY updated_at DESC, created_at DESC
    `).all();
    const models = normalizeConfiguredModelRows(rows);
    if (!models.some((model) => model.category === 'PRIMARY')) {
      throw new Error('当前模型配置中没有已启用的 PRIMARY 模型');
    }
    return models;
  } finally {
    db.close();
  }
}

function publicModelSummary(model) {
  return {
    category: model.category,
    model_name: model.model_name,
    display_name: model.display_name,
    api_format: model.api_format,
  };
}

export async function seedConfiguredModels(api, {
  sourceDbPath = defaultConfiguredModelSourcePath(),
  models = null,
} = {}) {
  if (typeof api !== 'function') throw new Error('复制当前模型配置需要可用的 App API');
  const configuredModels = models || readConfiguredModels(sourceDbPath);
  if (!configuredModels.some((model) => model.category === 'PRIMARY')) {
    throw new Error('当前模型配置中没有已启用的 PRIMARY 模型');
  }

  for (const model of configuredModels) {
    const response = await api('POST', '/api/llm_model/create', {
      ...model,
      is_enabled: true,
    });
    if (!(response?.status >= 200 && response?.status < 300)) {
      throw new Error(`复制 ${model.category} 模型 ${model.model_name} 失败: HTTP ${response?.status || 0}`);
    }
  }

  return {
    source: 'current-local-model-config',
    count: configuredModels.length,
    models: configuredModels.map(publicModelSummary),
  };
}

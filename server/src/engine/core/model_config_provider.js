import { ModelConfigResolver } from "./llm.js";

function parseExtraConfig(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function createDbModelConfigProvider({ queryOne, notFoundMessage, catchErrors = false } = {}) {
  if (typeof queryOne !== "function") {
    throw new Error("createDbModelConfigProvider requires queryOne");
  }
  return async ({ model_id, project_id, category }) => {
    const explicitModel = String(model_id || '').trim();
    const sql = explicitModel
      ? `SELECT id, model_name, api_base, api_key, category, extra_config, api_format FROM llm_models
          WHERE id=$1 AND api_key IS NOT NULL AND deleted_at IS NULL
            AND category=COALESCE($3,'PRIMARY') AND (project_id=$2 OR project_id IS NULL)
          LIMIT 1`
      : `SELECT id, model_name, api_base, api_key, category, extra_config, api_format FROM llm_models
          WHERE api_key IS NOT NULL AND deleted_at IS NULL AND is_enabled=true
            AND category=COALESCE($2,'PRIMARY') AND (project_id = $1 OR project_id IS NULL)
          ORDER BY (project_id = $1) DESC, created_at DESC LIMIT 1`;
    const params = explicitModel
      ? [explicitModel, project_id || null, category || 'PRIMARY']
      : [project_id || null, category || 'PRIMARY'];
    const queryPromise = queryOne(sql, params);
    const m = catchErrors ? await queryPromise.catch(() => null) : await queryPromise;
    if (!m) {
      throw new Error(notFoundMessage || `未找到可用模型(category=${category || "PRIMARY"})`);
    }
    const extra_config = parseExtraConfig(m.extra_config);
    return {
      id: m.id,
      model_name: m.model_name,
      api_base: m.api_base,
      api_key: m.api_key,
      category: m.category || category || "PRIMARY",
      supports_streaming: true,
      is_enabled: true,
      extra_config,
      context_window: extra_config.context_window,
      api_format: m.api_format || "chat_completions",
    };
  };
}

export function registerDbModelConfigProvider(options = {}) {
  ModelConfigResolver.setProvider(createDbModelConfigProvider(options));
}

export function ensureDbModelConfigProvider(options = {}) {
  if (ModelConfigResolver.hasProvider()) return;
  registerDbModelConfigProvider(options);
}

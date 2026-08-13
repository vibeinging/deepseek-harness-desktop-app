import { Result } from "../core/base_tool.js";
import { WebSearchTool } from "./web_search_tool.js";

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function configuredRows(results) {
  return (Array.isArray(results) ? results : []).map((item) => ({
    title: clean(item?.title, 500),
    url: clean(item?.url, 4096),
    snippet: clean(item?.snippet, 4000),
    source: clean(item?.source, 300),
    date: clean(item?.date, 80),
  }));
}

function queryResult(configName, engineName, query, results) {
  const rows = configuredRows(results);
  return Result.create({
    operator: {
      source_name: configName,
      query,
      search_engine: engineName,
    },
    result: {
      success: true,
      data: rows,
      columns: ["title", "url", "snippet", "source", "date"],
      row_count: rows.length,
    },
    "sub-query": query,
  });
}

async function defaultConfiguredSearch({ config, query, maxResults, context }) {
  // Keep the generic search execution and SSRF checks in one implementation.
  // The dynamic import avoids a static cycle through app/models -> web_tools.
  const { normalizeWebSearchResults, requestWebSearchRaw } = await import("../../app/models/web_search_models.js");
  const raw = await requestWebSearchRaw(config, query, {
    fetchFn: context?.fetch || globalThis.fetch,
    resolveHost: context?.resolveHost,
    resolvePublicHost: context?.resolvePublicHost,
    proxyConfigured: context?.proxyConfigured,
    maxResults,
  });
  return normalizeWebSearchResults(raw, config, { maxResults });
}

/**
 * Query-facing web search. Project Web Search settings take priority; the
 * built-in search remains available when the project has no saved setting.
 */
export class ProjectWebSearchTool extends WebSearchTool {
  constructor({ bds = null, configuredSearch = defaultConfiguredSearch, ...deps } = {}) {
    super(deps);
    this._businessDataSources = bds;
    this._configuredSearch = configuredSearch;
  }

  async execute(context, kwargs = {}) {
    const query = clean(kwargs.query, 500);
    if (!query) return Result.createError("缺少查询参数");

    const bds = this._businessDataSources
      || context?.input_data?.data_sources_info?.business_data_sources
      || null;
    if (bds?.load_sources && bds?._loaded !== true) await bds.load_sources();
    const configs = [...(bds?.web_search_configs?.values?.() || [])];
    if (!configs.length) {
      const fallback = await super.execute(context, kwargs);
      if (!fallback?.success) return fallback;
      return queryResult(
        fallback.data?.search_engine || "built-in web search",
        fallback.data?.search_engine || "builtin",
        query,
        fallback.data?.results || [],
      );
    }

    const requestedName = clean(kwargs.web_search_model_name, 160);
    const selected = requestedName
      ? configs.find((item) => clean(item?.name, 160) === requestedName)
      : configs.find((item) => item?.is_default === true || Number(item?.is_default) === 1) || configs[0];
    if (!selected) {
      return Result.createError(
        `未找到网络搜索配置「${requestedName}」。可用配置：${configs.map((item) => clean(item?.name, 160)).filter(Boolean).join("、")}`,
      );
    }

    try {
      const maxResults = Math.max(1, Math.min(20, Number(kwargs.max_results) || 10));
      const results = await this._configuredSearch({
        config: selected,
        query,
        maxResults,
        context,
      });
      return queryResult(selected.name, selected.model, query, results);
    } catch (error) {
      return Result.createError(error?.message || String(error));
    }
  }
}

export default ProjectWebSearchTool;

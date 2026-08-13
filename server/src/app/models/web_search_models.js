import { randomUUID } from "node:crypto";

import { ApiError } from "../../errors.js";
import {
  AiCapabilityError,
  AiOutputValidationError,
  runStructuredAi,
} from "../../engine/core/structured_ai.js";
import { fetchPublicJson } from "../../engine/agents/web_tools.js";
import { requireProjectMember, requireProjectOwner } from "../projects/access.js";

const MAX_RAW_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_INFER_RESPONSE_BYTES = 256 * 1024;
const WEB_SEARCH_SOURCE_TYPE = "web_search_model";
const WEB_SEARCH_COLUMNS = `id, project_id, name, model, api, description,
  config_type, custom_config, is_default, created_at, updated_at`;
const PRESETS = Object.freeze({
  bocha: Object.freeze({ label: "博查", endpoint: "https://api.bocha.cn/v1/web-search", method: "POST" }),
  serper: Object.freeze({ label: "Serper", endpoint: "https://google.serper.dev/search", method: "POST" }),
  tavily: Object.freeze({ label: "Tavily", endpoint: "https://api.tavily.com/search", method: "POST" }),
  perplexity: Object.freeze({ label: "Perplexity", endpoint: "https://api.perplexity.ai/search", method: "POST" }),
  serpapi: Object.freeze({ label: "SerpApi", endpoint: "https://serpapi.com/search", method: "GET" }),
});
export const WEB_SEARCH_SUPPORTED_TYPES = Object.freeze([
  ...Object.entries(PRESETS).map(([value, preset]) => Object.freeze({ value, label: preset.label })),
  Object.freeze({ value: "custom", label: "自定义" }),
]);
const RESPONSE_MAPPING_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["response_mappings"],
  properties: {
    response_mappings: {
      type: "object",
      additionalProperties: false,
      required: ["results_path", "fields"],
      properties: {
        results_path: { type: "string" },
        fields: {
          type: "object",
          additionalProperties: false,
          required: ["title", "url", "snippet"],
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            snippet: { type: "string" },
            source: { type: "string" },
            date: { type: "string" },
          },
        },
      },
    },
  },
});

function clean(value, maxLength = 4096) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(value) {
  if (plainObject(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return plainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function modelKey(value) {
  const normalized = clean(value, 80).toLowerCase();
  if (normalized === "博查") return "bocha";
  if (normalized === "custom") return "custom";
  return normalized;
}

function endpointValue(value) {
  const endpoint = clean(value, 2048);
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new ApiError("搜索 API 地址无效", 400); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new ApiError("搜索 API 地址只支持不含账号信息的 HTTP/HTTPS URL", 400);
  }
  return parsed.toString();
}

function restoreMaskedValues(value, previous) {
  if (typeof value === "string" && value.includes("****")) return previous ?? value;
  if (Array.isArray(value)) {
    return value.map((item, index) => restoreMaskedValues(item, Array.isArray(previous) ? previous[index] : undefined));
  }
  if (!plainObject(value)) return value;
  const previousObject = parseJsonObject(previous);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, restoreMaskedValues(item, previousObject[key])]),
  );
}

function normalizeCustomConfig(value, { required = false, existing = null } = {}) {
  const raw = restoreMaskedValues(parseJsonObject(value), parseJsonObject(existing));
  const endpoint = clean(raw.endpoint, 2048);
  const method = clean(raw.method || "GET", 16).toUpperCase();
  if (required && !endpoint) throw new ApiError("自定义搜索必须提供 API 地址", 400);
  if (endpoint) endpointValue(endpoint);
  if (method !== "GET" && method !== "POST") throw new ApiError("自定义搜索只支持 GET 或 POST", 400);
  for (const field of ["request_params", "response_mappings"]) {
    if (raw[field] != null && !plainObject(raw[field])) throw new ApiError(`${field} 必须是 JSON 对象`, 400);
  }
  return {
    endpoint: endpoint || null,
    method,
    request_params: plainObject(raw.request_params) ? raw.request_params : {},
    response_mappings: plainObject(raw.response_mappings) ? raw.response_mappings : {},
  };
}

function normalizeConfig(value, { existing = null } = {}) {
  const input = plainObject(value) ? value : {};
  const name = clean(input.name ?? existing?.name, 160);
  const model = clean(input.model ?? existing?.model, 80);
  const key = modelKey(model);
  const configType = clean(input.config_type ?? existing?.config_type ?? (key === "custom" ? "custom" : "preset"), 20)
    .toLowerCase();
  if (!name || !model) throw new ApiError("配置名称与搜索引擎不能为空", 400);
  if (configType !== "preset" && configType !== "custom") throw new ApiError("config_type 只支持 preset 或 custom", 400);
  if (configType === "preset" && !PRESETS[key]) throw new ApiError(`不支持的搜索引擎: ${model}`, 400);
  const apiInput = input.api;
  const api = apiInput != null && !clean(apiInput).includes("****") ? clean(apiInput, 8192) : clean(existing?.api, 8192);
  if (configType === "preset" && !api) throw new ApiError("预设搜索引擎必须提供 API Key", 400);
  const customConfig = normalizeCustomConfig(
    input.custom_config ?? existing?.custom_config,
    { required: configType === "custom", existing: existing?.custom_config },
  );
  return {
    name,
    model,
    api: api || null,
    description: clean(input.description ?? existing?.description, 2000) || null,
    config_type: configType,
    custom_config: customConfig,
    is_default: input.is_default == null ? Boolean(existing?.is_default) : Boolean(input.is_default),
  };
}

function modelRow(row) {
  if (!row) return null;
  return {
    ...row,
    custom_config: normalizeCustomConfig(row.custom_config),
    is_default: row.is_default === true || Number(row.is_default) === 1,
  };
}

function publicModel(row) {
  if (!row) return null;
  return {
    ...row,
    api: row.api ? "********" : null,
    custom_config: maskCustomConfig(row.custom_config),
  };
}

function isSensitiveResponseKey(value) {
  const key = String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
  return key === "api"
    || /api[-_\s]?key|token|secret|password|credential/.test(key)
    || /(?:^|[-_])(?:auth|oauth|authorization|authentication)(?:$|[-_])/.test(key);
}

function maskCustomConfig(value, parentKey = "", insideHeaders = false) {
  const secretKey = isSensitiveResponseKey(parentKey);
  if ((secretKey || insideHeaders) && !plainObject(value) && !Array.isArray(value)) {
    return clean(value) ? "********" : value;
  }
  if (Array.isArray(value)) return value.map((item) => maskCustomConfig(item, parentKey, insideHeaders || secretKey));
  if (!plainObject(value)) return value;
  if (secretKey) return Object.keys(value).length ? "********" : value;
  const childHeaders = insideHeaders || /headers?/i.test(parentKey);
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, maskCustomConfig(item, key, childHeaders)]),
  );
}

async function ensureProjectWebSearchBinding(ctx, projectId, modelId) {
  const params = [clean(projectId, 160), WEB_SEARCH_SOURCE_TYPE, clean(modelId, 160)];
  let binding = await ctx.queryOne(
    `SELECT id FROM business_data_sources
      WHERE project_id=$1 AND source_type=$2 AND source_id=$3 AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 1`,
    params,
  );
  if (binding) return binding;

  const reusable = await ctx.queryOne(
    `SELECT id FROM business_data_sources
      WHERE project_id=$1 AND source_type=$2 AND source_id=$3 AND deleted_at IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`,
    params,
  );
  if (reusable) {
    await ctx.query(
      `UPDATE business_data_sources
          SET deleted_at=NULL, deleted_by=NULL, updated_at=now()
        WHERE id=$4
          AND NOT EXISTS (
            SELECT 1 FROM business_data_sources
             WHERE project_id=$1 AND source_type=$2 AND source_id=$3 AND deleted_at IS NULL
          )`,
      [...params, reusable.id],
    );
  } else {
    await ctx.query(
      `INSERT INTO business_data_sources
         (id, project_id, source_type, source_id, created_at, updated_at)
       SELECT $4, $1, $2, $3, now(), now()
        WHERE NOT EXISTS (
          SELECT 1 FROM business_data_sources
           WHERE project_id=$1 AND source_type=$2 AND source_id=$3 AND deleted_at IS NULL
        )`,
      [...params, randomUUID()],
    );
  }

  binding = await ctx.queryOne(
    `SELECT id FROM business_data_sources
      WHERE project_id=$1 AND source_type=$2 AND source_id=$3 AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 1`,
    params,
  );
  if (!binding) {
    throw new ApiError("网络搜索配置无法绑定到当前项目", 500, "WEB_SEARCH_BINDING_FAILED");
  }
  return binding;
}

async function ensureProjectWebSearchBindings(ctx, projectId, modelIds) {
  for (const modelId of new Set(modelIds.map((value) => clean(value, 160)).filter(Boolean))) {
    await ensureProjectWebSearchBinding(ctx, projectId, modelId);
  }
}

async function requireModel(ctx, projectId, modelId, { ensureBinding = true } = {}) {
  const row = await ctx.queryOne(
    `SELECT ${WEB_SEARCH_COLUMNS} FROM web_search_models
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [clean(modelId, 160), clean(projectId, 160)],
  );
  if (!row) throw new ApiError("网络搜索配置不存在", 404);
  if (ensureBinding) await ensureProjectWebSearchBinding(ctx, projectId, row.id);
  return modelRow(row);
}

export async function listProjectWebSearchModels(ctx, input) {
  const projectId = input.params.pid;
  await requireProjectMember(ctx, projectId);
  const rows = await ctx.query(
    `SELECT ${WEB_SEARCH_COLUMNS} FROM web_search_models
      WHERE project_id=$1 AND deleted_at IS NULL ORDER BY is_default DESC, created_at DESC`,
    [projectId],
  );
  await ensureProjectWebSearchBindings(ctx, projectId, rows.map((row) => row.id));
  const items = rows.map((row) => publicModel(modelRow(row)));
  return {
    data: { items, total: items.length, supported_types: WEB_SEARCH_SUPPORTED_TYPES },
    message: "获取网络搜索模型成功",
  };
}

export async function createProjectWebSearchModel(ctx, input) {
  const projectId = input.params.pid;
  await requireProjectOwner(ctx, projectId);
  const config = normalizeConfig(input.body);
  const existing = await ctx.queryOne(
    "SELECT id FROM web_search_models WHERE project_id=$1 AND deleted_at IS NULL LIMIT 1",
    [projectId],
  );
  const id = randomUUID();
  const makeDefault = config.is_default || !existing;
  if (makeDefault) {
    await ctx.query("UPDATE web_search_models SET is_default=false, updated_at=now() WHERE project_id=$1 AND deleted_at IS NULL", [projectId]);
  }
  await ctx.query(
    `INSERT INTO web_search_models
       (id, project_id, name, model, api, description, config_type, custom_config, is_default, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())`,
    [id, projectId, config.name, config.model, config.api, config.description, config.config_type,
      JSON.stringify(config.custom_config), makeDefault],
  );
  return { data: publicModel(await requireModel(ctx, projectId, id)), message: "创建网络搜索配置成功" };
}

export async function getProjectWebSearchModel(ctx, input) {
  await requireProjectMember(ctx, input.params.pid);
  return { data: publicModel(await requireModel(ctx, input.params.pid, input.params.modelId)), message: "获取网络搜索配置成功" };
}

export async function updateProjectWebSearchModel(ctx, input) {
  const { pid: projectId, modelId } = input.params;
  await requireProjectOwner(ctx, projectId);
  const existing = await requireModel(ctx, projectId, modelId);
  const config = normalizeConfig(input.body, { existing });
  if (config.is_default) {
    await ctx.query(
      "UPDATE web_search_models SET is_default=CASE WHEN id=$2 THEN true ELSE false END, updated_at=now() WHERE project_id=$1 AND deleted_at IS NULL",
      [projectId, modelId],
    );
  }
  await ctx.query(
    `UPDATE web_search_models SET name=$1, model=$2, api=$3, description=$4,
       config_type=$5, custom_config=$6, is_default=$7, updated_at=now()
      WHERE id=$8 AND project_id=$9 AND deleted_at IS NULL`,
    [config.name, config.model, config.api, config.description, config.config_type,
      JSON.stringify(config.custom_config), config.is_default, modelId, projectId],
  );
  return { data: publicModel(await requireModel(ctx, projectId, modelId)), message: "更新网络搜索配置成功" };
}

export async function deleteProjectWebSearchModel(ctx, input) {
  const { pid: projectId, modelId } = input.params;
  await requireProjectOwner(ctx, projectId);
  const existing = await requireModel(ctx, projectId, modelId, { ensureBinding: false });
  await ctx.query(
    "UPDATE web_search_models SET deleted_at=now(), deleted_by=$1, is_default=false, updated_at=now() WHERE id=$2 AND project_id=$3",
    [ctx.userId, modelId, projectId],
  );
  await ctx.query(
    `UPDATE business_data_sources
        SET deleted_at=now(), deleted_by=$1, updated_at=now()
      WHERE project_id=$2 AND source_type=$3 AND source_id=$4 AND deleted_at IS NULL`,
    [ctx.userId, projectId, WEB_SEARCH_SOURCE_TYPE, modelId],
  );
  if (existing.is_default) {
    const fallback = await ctx.queryOne(
      "SELECT id FROM web_search_models WHERE project_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1",
      [projectId],
    );
    if (fallback) await ctx.query("UPDATE web_search_models SET is_default=true, updated_at=now() WHERE id=$1", [fallback.id]);
  }
  return { data: null, message: "删除网络搜索配置成功" };
}

function substitute(value, variables) {
  if (Array.isArray(value)) return value.map((item) => substitute(item, variables));
  if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substitute(item, variables)]));
  if (typeof value !== "string") return value;
  return value.replace(/\{\{?\s*(query|max_results)\s*\}?\}/g, (_match, key) => String(variables[key]));
}

function requestInit(method, headers, body) {
  return {
    method,
    headers,
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  };
}

function appendQuery(endpoint, query) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null) continue;
    url.searchParams.set(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return url.toString();
}

export async function requestWebSearchRaw(configValue, queryValue, {
  fetchFn = globalThis.fetch,
  resolveHost,
  resolvePublicHost,
  proxyConfigured,
  maxResults = 10,
} = {}) {
  if (typeof fetchFn !== "function") throw new ApiError("当前运行环境不支持网络请求", 503);
  const config = normalizeConfig(configValue, { existing: configValue });
  const query = clean(queryValue, 500);
  if (!query) throw new ApiError("搜索问题不能为空", 400);
  const key = modelKey(config.model);
  const custom = config.custom_config;
  const useCustom = config.config_type === "custom";
  const variables = { query, max_results: Math.max(1, Math.min(20, Number(maxResults) || 10)) };
  let endpoint = useCustom ? custom.endpoint : PRESETS[key]?.endpoint;
  let method = useCustom ? custom.method : PRESETS[key]?.method;
  let headers = { accept: "application/json" };
  let requestQuery = {};
  let body = null;

  if (key === "tavily" && !useCustom) body = { api_key: config.api, query, max_results: variables.max_results };
  else if (key === "serper" && !useCustom) {
    headers["x-api-key"] = config.api;
    body = { q: query, num: variables.max_results };
  } else if (key === "bocha" && !useCustom) {
    headers.authorization = `Bearer ${config.api}`;
    body = { query, count: variables.max_results, summary: true };
  } else if (key === "perplexity" && !useCustom) {
    headers.authorization = `Bearer ${config.api}`;
    body = { query, max_results: variables.max_results };
  } else if (key === "serpapi" && !useCustom) {
    requestQuery = { engine: "google", q: query, num: variables.max_results, api_key: config.api };
  } else {
    const params = substitute(custom.request_params, variables);
    const reserved = new Set(["headers", "query", "body", "api_key_header", "api_key_prefix"]);
    const freeParams = Object.fromEntries(Object.entries(params).filter(([field]) => !reserved.has(field)));
    headers = { ...headers, ...(plainObject(params.headers) ? params.headers : {}) };
    if (method === "GET") requestQuery = plainObject(params.query) ? params.query : freeParams;
    else body = plainObject(params.body) ? params.body : freeParams;
    const queryTarget = method === "GET" ? requestQuery : body;
    if (!Object.prototype.hasOwnProperty.call(queryTarget, "query") && !Object.prototype.hasOwnProperty.call(queryTarget, "q")) {
      queryTarget.query = query;
    }
    if (config.api) {
      const header = clean(params.api_key_header, 120) || "authorization";
      const prefix = params.api_key_prefix == null ? "Bearer " : String(params.api_key_prefix);
      if (!headers[header]) headers[header] = `${prefix}${config.api}`;
    }
  }
  endpoint = endpointValue(endpoint);
  if (method === "POST") headers["content-type"] = "application/json";
  const request = requestInit(method, headers, body);
  try {
    return await fetchPublicJson(method === "GET" ? appendQuery(endpoint, requestQuery) : endpoint, {
      fetchImpl: fetchFn,
      resolveHost,
      resolvePublicHost,
      ...(typeof proxyConfigured === "boolean" ? { proxyConfigured } : {}),
      method: request.method,
      headers: request.headers,
      body: request.body,
      maxBytes: MAX_RAW_RESPONSE_BYTES,
      // Search APIs do not need browser-style redirects. Rejecting them also
      // removes a common SSRF hop to metadata and private-network services.
      maxRedirects: 0,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = clean(error?.message || "搜索服务请求失败", 1000);
    const blocked = /本机|局域网|无法解析|地址无效|账号信息|只允许/.test(message);
    throw new ApiError(message, blocked ? 400 : 502, blocked ? "WEB_SEARCH_OUTBOUND_BLOCKED" : "WEB_SEARCH_REQUEST_FAILED");
  }
}

function pathParts(pathValue) {
  return clean(pathValue, 256).replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
}

function atPath(value, pathValue) {
  let current = value;
  for (const part of pathParts(pathValue)) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function firstArray(value, prefix = "", depth = 0) {
  if (Array.isArray(value)) return { path: prefix, items: value };
  if (!plainObject(value) || depth >= 5) return null;
  for (const [key, child] of Object.entries(value)) {
    const found = firstArray(child, prefix ? `${prefix}.${key}` : key, depth + 1);
    if (found) return found;
  }
  return null;
}

function defaultMappings(raw, key) {
  if (key === "serper" || key === "serpapi") {
    return { results_path: key === "serper" ? "organic" : "organic_results", fields: { title: "title", url: "link", snippet: "snippet", source: "source", date: "date" } };
  }
  if (key === "bocha") return { results_path: "data.webPages.value", fields: { title: "name", url: "url", snippet: "summary", source: "siteName", date: "datePublished" } };
  if (key === "tavily" || key === "perplexity") return { results_path: "results", fields: { title: "title", url: "url", snippet: "content", source: "source", date: "published_date" } };
  const found = firstArray(raw);
  return { results_path: found?.path || "", fields: { title: "title", url: "url", snippet: "snippet", source: "source", date: "date" } };
}

function mappingValue(mappings, name, fallback) {
  const fields = plainObject(mappings?.fields) ? mappings.fields : mappings;
  return clean(fields?.[name] ?? fields?.[`${name}_field`] ?? fallback, 256);
}

export function normalizeWebSearchResults(raw, configValue, { maxResults = 10 } = {}) {
  const config = normalizeConfig(configValue, { existing: configValue });
  const configured = parseJsonObject(config.custom_config.response_mappings);
  const mappings = Object.keys(configured).length ? configured : defaultMappings(raw, modelKey(config.model));
  const resultsPath = clean(mappings.results_path ?? mappings.results ?? mappings.items_path, 256);
  const sourceItems = resultsPath ? atPath(raw, resultsPath) : raw;
  if (!Array.isArray(sourceItems)) throw new ApiError("搜索响应映射没有指向结果数组", 502);
  const fields = {
    title: mappingValue(mappings, "title", "title"),
    url: mappingValue(mappings, "url", "url"),
    snippet: mappingValue(mappings, "snippet", "snippet"),
    source: mappingValue(mappings, "source", "source"),
    date: mappingValue(mappings, "date", "date"),
  };
  return sourceItems.slice(0, Math.max(1, Math.min(20, Number(maxResults) || 10))).flatMap((item) => {
    if (!plainObject(item)) return [];
    const url = clean(atPath(item, fields.url), 4096);
    if (!/^https?:\/\//i.test(url)) return [];
    return [{
      title: clean(atPath(item, fields.title), 500) || url,
      url,
      snippet: clean(atPath(item, fields.snippet), 4000),
      source: clean(atPath(item, fields.source), 300),
      date: clean(atPath(item, fields.date), 80),
    }];
  });
}

export async function testProjectWebSearchModel(ctx, input) {
  const projectId = input.params.pid;
  await requireProjectMember(ctx, projectId);
  const existing = clean(input.body?.model_id, 160)
    ? await requireModel(ctx, projectId, input.body.model_id)
    : null;
  const config = normalizeConfig(input.body, { existing });
  if (ctx.pluginHostRequest && config.config_type === "custom") {
    throw new ApiError(
      "Plugin Page 不能测试自定义网络地址，请在项目设置中完成测试",
      403,
      "PLUGIN_WEB_SEARCH_CUSTOM_NETWORK_FORBIDDEN",
    );
  }
  const raw = await requestWebSearchRaw(config, "DSH connection test", {
    fetchFn: ctx.fetch || globalThis.fetch,
    resolveHost: ctx.resolveHost,
    resolvePublicHost: ctx.resolvePublicHost,
    proxyConfigured: ctx.proxyConfigured,
    maxResults: 3,
  });
  return {
    // Plugin Host only needs the connection verdict. Do not let an upstream
    // service echo a stored credential back through an arbitrary raw payload.
    data: ctx.pluginHostRequest
      ? { success: true }
      : { success: true, data: { raw_response: maskCustomConfig(raw) } },
    message: "搜索服务连接成功",
  };
}

export async function qaTestProjectWebSearchModel(ctx, input) {
  const projectId = input.params.pid;
  await requireProjectMember(ctx, projectId);
  const query = clean(input.body?.query, 500);
  if (!query) throw new ApiError("搜索问题不能为空", 400);
  const model = await requireModel(ctx, projectId, input.body?.model_id);
  if (ctx.pluginHostRequest && model.config_type === "custom") {
    throw new ApiError(
      "Plugin Page 不能调用自定义网络地址，请在项目设置中完成测试",
      403,
      "PLUGIN_WEB_SEARCH_CUSTOM_NETWORK_FORBIDDEN",
    );
  }
  const raw = await requestWebSearchRaw(model, query, {
    fetchFn: ctx.fetch || globalThis.fetch,
    resolveHost: ctx.resolveHost,
    resolvePublicHost: ctx.resolvePublicHost,
    proxyConfigured: ctx.proxyConfigured,
    maxResults: 10,
  });
  const results = normalizeWebSearchResults(raw, model, { maxResults: 10 });
  return { data: { results, model: model.model }, message: "网络搜索测试完成" };
}

function validatedResponseMappings(value) {
  const mappings = value?.response_mappings;
  if (!plainObject(mappings) || !plainObject(mappings.fields)) throw new AiOutputValidationError("缺少 response_mappings.fields");
  const resultsPath = clean(mappings.results_path, 256);
  const fields = {};
  for (const name of ["title", "url", "snippet", "source", "date"]) {
    const path = clean(mappings.fields[name], 256);
    if (["title", "url", "snippet"].includes(name) && !path) throw new AiOutputValidationError(`缺少字段映射 ${name}`);
    if (path) fields[name] = path;
  }
  return { response_mappings: { results_path: resultsPath, fields } };
}

export async function inferProjectWebSearchResponseMappings(ctx, input) {
  const projectId = input.params.pid;
  await requireProjectMember(ctx, projectId);
  const raw = input.body?.raw_response;
  if (!plainObject(raw) && !Array.isArray(raw)) throw new ApiError("raw_response 必须是 JSON 对象或数组", 400);
  const rawJson = JSON.stringify(raw);
  if (Buffer.byteLength(rawJson, "utf8") > MAX_INFER_RESPONSE_BYTES) throw new ApiError("raw_response 过大", 413);
  const runAi = typeof ctx.runStructuredAi === "function" ? ctx.runStructuredAi : runStructuredAi;
  try {
    const inferred = await runAi({
      projectId,
      callSite: "web_search.response_mapping.infer",
      schema: RESPONSE_MAPPING_SCHEMA,
      maxTokens: 1200,
      messages: [
        {
          role: "system",
          content: "分析一个网络搜索 JSON 响应，返回结果数组路径和单条结果字段路径。路径使用点号，不要添加解释。",
        },
        { role: "user", content: rawJson },
      ],
      validate: validatedResponseMappings,
    });
    return { data: inferred.data, message: "响应映射推断完成" };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof AiCapabilityError || error?.code === "AI_MODEL_UNAVAILABLE" || error?.code === "AI_OUTPUT_INVALID") {
      throw new ApiError(error.message, error.code === "AI_OUTPUT_INVALID" ? 422 : 503, error.code);
    }
    throw error;
  }
}

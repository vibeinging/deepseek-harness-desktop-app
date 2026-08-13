import { createHash } from "node:crypto";
import { getChatCompletionsAdapter } from "./chat_completions_adapter.js";
import { ensureAgentModelCatalog } from "./model_catalog.js";
import { APP_DISPLAY_NAME } from "../../config/app_name.js";
import {
  hasCustomRuntimeParameterMapping,
  runtimeCapabilitiesFromConfig,
  runtimeParametersFromConfig,
} from "./runtime_parameters.js";

const MODEL_GATEWAY_RUNTIME_KEY = "dsh-model-gateway-runtime";
const MODEL_GATEWAY_ENV_KEY = "DSH_AGENT_MODEL_GATEWAY_TOKEN";

function hash(value, length = 16) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, length);
}

function apiFormat(config = {}) {
  return String(config.api_format || config.apiFormat || "chat_completions").trim().toLowerCase();
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function objectConfig(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function agentRuntimeConfig(config = {}) {
  const extra = objectConfig(config.extra_config);
  const runtime = objectConfig(extra.agent_runtime);
  const parameters = runtimeParametersFromConfig(config);
  const reasoningEffort = parameters.reasoning_effort.default || String(runtime.reasoning_effort || "");
  const reasoningSummary = parameters.reasoning_summary.default || String(runtime.reasoning_summary || "");
  const verbosity = parameters.verbosity.default || String(runtime.verbosity || "");
  const contextWindow = positiveInteger(runtime.context_window)
    || positiveInteger(extra.context_window)
    || positiveInteger(config.context_window);
  return {
    ...(reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}),
    ...(reasoningSummary ? { model_reasoning_summary: reasoningSummary } : {}),
    ...(verbosity ? { model_verbosity: verbosity } : {}),
    ...(contextWindow ? { model_context_window: contextWindow } : {}),
    ...(positiveInteger(runtime.auto_compact_token_limit)
      ? { model_auto_compact_token_limit: positiveInteger(runtime.auto_compact_token_limit) }
      : {}),
  };
}

function agentRuntimeCapabilities(config = {}) {
  return runtimeCapabilitiesFromConfig(config);
}

export async function createAgentModelBinding(config = {}, {
  mode = "project",
  chatAdapter = getChatCompletionsAdapter(),
  modelCatalog = ensureAgentModelCatalog,
  modelCatalogOptions = {},
} = {}) {
  const selectedMode = String(mode || "project").trim().toLowerCase();
  const format = apiFormat(config);
  const supportedFormat = format === "responses" || format === "chat_completions";
  const canUseProject = supportedFormat && config.api_base && config.api_key && config.model_name;
  if (selectedMode === "account") {
    const error = new Error(`${APP_DISPLAY_NAME}不使用外部账户模型，请配置项目模型`);
    error.code = "AGENT_ACCOUNT_MODEL_UNAVAILABLE";
    throw error;
  }
  if (!canUseProject) {
    const formatHint = supportedFormat ? "" : `，当前协议 ${format || "unknown"} 不受支持`;
    const error = new Error(`主模型配置不完整，需要 Responses 或 Chat Completions API、模型名称、API 地址和密钥${formatHint}`);
    error.code = "AGENT_MODEL_PROVIDER_INVALID";
    throw error;
  }
  const secretHash = hash(config.api_key);
  const configHash = hash(JSON.stringify(config.extra_config || {}));
  const identity = hash(`${config.id || ""}|${config.api_base}|${config.model_name}|${format}|${secretHash}|${configHash}`);
  const providerId = `dsh_${identity}`;
  const baseUrl = normalizeBaseUrl(config.api_base);
  const needsParameterAdapter = format === "responses" && hasCustomRuntimeParameterMapping(config);
  const catalog = await modelCatalog(config, modelCatalogOptions);
  const adapter = await chatAdapter.register(providerId, config);
  return {
    source: "project_model",
    runtimeKey: `${MODEL_GATEWAY_RUNTIME_KEY}:${catalog.revision}`,
    kernelOptions: {
      args: catalog.args,
      env: { ...process.env, [MODEL_GATEWAY_ENV_KEY]: adapter.accessToken },
    },
    threadOptions: {
      model: String(config.model_name),
      modelProvider: providerId,
      config: {
        model_provider: providerId,
        ...agentRuntimeConfig(config),
        model_providers: {
          [providerId]: {
            name: `${APP_DISPLAY_NAME}项目模型 ${config.model_name}`,
            base_url: adapter.baseUrl,
            env_key: MODEL_GATEWAY_ENV_KEY,
            wire_api: "responses",
            requires_openai_auth: false,
            supports_websockets: false,
          },
        },
      },
    },
    snapshot: {
      id: config.id || null,
      provider: providerId,
      model_name: String(config.model_name),
      api_base: baseUrl,
      api_format: format,
      transport: format === "chat_completions"
        ? "chat_completions_adapter"
        : needsParameterAdapter
          ? "responses_parameter_adapter"
          : "responses_gateway",
      agent_runtime: agentRuntimeConfig(config),
      capabilities: agentRuntimeCapabilities(config),
      model_catalog: {
        revision: catalog.revision,
        context_window: catalog.model?.context_window || null,
        input_modalities: catalog.model?.input_modalities || ["text"],
      },
    },
  };
}

export function applyAgentProjectSettings(binding, settings = {}) {
  const effort = String(settings.reasoning_effort || '').trim().toLowerCase();
  const supported = binding.snapshot?.capabilities?.reasoning_efforts || [];
  if (!effort || !supported.includes(effort)) return binding;
  binding.threadOptions.config = {
    ...binding.threadOptions.config,
    model_reasoning_effort: effort,
  };
  binding.snapshot = {
    ...binding.snapshot,
    agent_runtime: { ...(binding.snapshot.agent_runtime || {}), model_reasoning_effort: effort },
  };
  return binding;
}

export function applyAgentRuntimeSettings(binding, settings = {}) {
  const requestedEffort = String(settings.reasoningEffort || '').trim().toLowerCase();
  const requestedSummary = String(settings.reasoningSummary || '').trim().toLowerCase();
  const requestedVerbosity = String(settings.verbosity || '').trim().toLowerCase();
  const capabilities = binding.snapshot?.capabilities || {};
  const effort = (capabilities.reasoning_efforts || []).includes(requestedEffort) ? requestedEffort : '';
  const summary = (capabilities.reasoning_summaries || []).includes(requestedSummary) ? requestedSummary : '';
  const verbosity = (capabilities.verbosity_levels || []).includes(requestedVerbosity) ? requestedVerbosity : '';
  const configPatch = {
    ...(effort ? { model_reasoning_effort: effort } : {}),
    ...(summary ? { model_reasoning_summary: summary } : {}),
    ...(verbosity ? { model_verbosity: verbosity } : {}),
  };
  if (Object.keys(configPatch).length === 0) return binding;
  binding.threadOptions.config = { ...binding.threadOptions.config, ...configPatch };
  binding.snapshot = {
    ...binding.snapshot,
    agent_runtime: { ...(binding.snapshot.agent_runtime || {}), ...configPatch },
  };
  return binding;
}

export default createAgentModelBinding;

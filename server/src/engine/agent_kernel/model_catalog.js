import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { APP_DISPLAY_NAME } from "../../config/app_name.js";
import { agentRuntimeHome } from "../../config/paths.js";
import { resolveAgentRuntimeBinary } from "./runtime_binary.js";
import { runtimeCapabilitiesFromConfig } from "./runtime_parameters.js";

const execFileAsync = promisify(execFile);
const bundledCatalogs = new Map();
const DEFAULT_CONTEXT_WINDOW = 272_000;

export const PROJECT_MODEL_BASE_INSTRUCTIONS = [
  "You are an AI assistant working with the user in a desktop workspace.",
  "Follow the application instructions and the user's request. Use the provided context and tools only within their documented scope, and preserve existing user work.",
  "Report results truthfully. Distinguish completed work from planned, attempted, or unverified work. Do not infer or claim a model, provider, product, or client identity that was not explicitly provided in the current instructions.",
].join("\n\n");

const REASONING_DESCRIPTIONS = Object.freeze({
  none: "No additional reasoning",
  minimal: "Minimal reasoning",
  low: "Light reasoning",
  medium: "Balanced reasoning",
  high: "Deep reasoning",
  xhigh: "Extra deep reasoning",
  max: "Maximum reasoning",
});

function hash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
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

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
}

function runtimeMetadata(config = {}) {
  const extra = objectConfig(config.extra_config);
  const runtime = objectConfig(extra.agent_runtime);
  const capabilities = runtimeCapabilitiesFromConfig(config);
  const reasoningDefault = String(capabilities.reasoning_effort_default || runtime.reasoning_effort || "").trim().toLowerCase();
  const summaryDefault = String(capabilities.reasoning_summary_default || runtime.reasoning_summary || "").trim().toLowerCase();
  const verbosityDefault = String(capabilities.verbosity_default || runtime.verbosity || "").trim().toLowerCase();
  const reasoningEfforts = unique([...capabilities.reasoning_efforts, reasoningDefault]);
  const reasoningSummaries = unique([...capabilities.reasoning_summaries, summaryDefault]);
  // A saved default alone is not proof that the provider accepts the
  // verbosity parameter. Only advertise it when the model configuration also
  // declares supported values.
  const verbosityLevels = unique(capabilities.verbosity_levels);
  const contextWindow = positiveInteger(runtime.context_window)
    || positiveInteger(extra.context_window)
    || positiveInteger(config.context_window)
    || DEFAULT_CONTEXT_WINDOW;
  return {
    contextWindow,
    autoCompactTokenLimit: positiveInteger(runtime.auto_compact_token_limit),
    reasoningEfforts,
    reasoningDefault: reasoningEfforts.includes(reasoningDefault) ? reasoningDefault : null,
    reasoningSummaries,
    summaryDefault: reasoningSummaries.includes(summaryDefault) ? summaryDefault : "auto",
    verbosityLevels,
    verbosityDefault: verbosityLevels.includes(verbosityDefault) ? verbosityDefault : null,
    supportsImageInput: extra.supports_image_input === true,
    supportsParallelToolCalls: runtime.supports_parallel_tool_calls === true,
  };
}

function parseBundledCatalog(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ""));
  } catch (cause) {
    const error = new Error("Agent 内置模型目录不是有效 JSON", { cause });
    error.code = "AGENT_MODEL_CATALOG_INVALID";
    throw error;
  }
  if (!Array.isArray(parsed?.models) || parsed.models.length === 0) {
    const error = new Error("Agent 内置模型目录为空");
    error.code = "AGENT_MODEL_CATALOG_INVALID";
    throw error;
  }
  return parsed;
}

async function loadBundledCatalog(binary) {
  const key = String(binary);
  if (!bundledCatalogs.has(key)) {
    bundledCatalogs.set(key, execFileAsync(binary, ["debug", "models", "--bundled"], {
      encoding: "utf8",
      maxBuffer: 20_000_000,
    }).then(({ stdout }) => parseBundledCatalog(stdout)).catch((cause) => {
      bundledCatalogs.delete(key);
      const error = new Error(`读取 Agent 内置模型目录失败: ${cause.message}`, { cause });
      error.code = "AGENT_MODEL_CATALOG_READ_FAILED";
      throw error;
    }));
  }
  return bundledCatalogs.get(key);
}

export function buildAgentModelCatalog(config = {}, bundledCatalog = {}) {
  const modelName = String(config.model_name || "").trim();
  if (!modelName) {
    const error = new Error("生成 Agent 模型目录需要模型名称");
    error.code = "AGENT_MODEL_CATALOG_MODEL_REQUIRED";
    throw error;
  }
  const models = Array.isArray(bundledCatalog.models) ? bundledCatalog.models : [];
  const metadata = runtimeMetadata(config);
  const model = {
    slug: modelName,
    display_name: modelName,
    description: `${APP_DISPLAY_NAME}项目模型`,
    default_reasoning_level: metadata.reasoningDefault,
    supported_reasoning_levels: metadata.reasoningEfforts.map((effort) => ({
      effort,
      description: REASONING_DESCRIPTIONS[effort] || effort,
    })),
    shell_type: "default",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: PROJECT_MODEL_BASE_INSTRUCTIONS,
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    // Collaboration is a product/runtime capability, not a provider identity.
    // Declare the pinned app-server contract explicitly so custom models do
    // not silently fall back to the legacy V1 surface.
    multi_agent_version: "v2",
    supports_reasoning_summary_parameter: metadata.reasoningSummaries.length > 0,
    default_reasoning_summary: metadata.summaryDefault,
    support_verbosity: metadata.verbosityLevels.length > 0,
    default_verbosity: metadata.verbosityDefault,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10_000 },
    supports_parallel_tool_calls: metadata.supportsParallelToolCalls,
    supports_image_detail_original: false,
    context_window: metadata.contextWindow,
    max_context_window: metadata.contextWindow,
    ...(metadata.autoCompactTokenLimit
      ? { auto_compact_token_limit: metadata.autoCompactTokenLimit }
      : {}),
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: metadata.supportsImageInput ? ["text", "image"] : ["text"],
    supports_search_tool: false,
    use_responses_lite: false,
  };
  return {
    models: [
      ...models.filter((entry) => entry?.slug !== modelName),
      model,
    ],
  };
}

export async function ensureAgentModelCatalog(config = {}, {
  binary = resolveAgentRuntimeBinary(),
  runtimeHome = agentRuntimeHome(),
  bundledCatalog = null,
} = {}) {
  const source = bundledCatalog || await loadBundledCatalog(binary);
  const catalog = buildAgentModelCatalog(config, source);
  const contents = `${JSON.stringify(catalog)}\n`;
  const revision = hash(contents).slice(0, 24);
  const directory = join(runtimeHome, "model-catalogs");
  const path = join(directory, `${revision}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const model = catalog.models.find((entry) => entry.slug === String(config.model_name).trim());
  return {
    path,
    revision,
    model,
    args: ["-c", `model_catalog_json=${JSON.stringify(path)}`, "app-server"],
  };
}

export default ensureAgentModelCatalog;

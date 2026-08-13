const PARAMETER_SPECS = {
  reasoning_effort: {
    valuesKey: "reasoning_efforts",
    defaultKey: "reasoning_effort",
    sourcePath: "reasoning.effort",
    requestKeys: { responses: "reasoning.effort", chat_completions: "reasoning_effort" },
    allowedValues: new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
  },
  reasoning_summary: {
    valuesKey: "reasoning_summaries",
    defaultKey: "reasoning_summary",
    sourcePath: "reasoning.summary",
    requestKeys: { responses: "reasoning.summary", chat_completions: "reasoning_summary" },
    allowedValues: new Set(["auto", "concise", "detailed", "none"]),
  },
  verbosity: {
    valuesKey: "verbosity_levels",
    defaultKey: "verbosity",
    sourcePath: "text.verbosity",
    requestKeys: { responses: "text.verbosity", chat_completions: "verbosity" },
    allowedValues: new Set(["low", "medium", "high"]),
  },
};

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

function formatName(value) {
  return String(value || "responses").trim().toLowerCase() === "chat_completions"
    ? "chat_completions"
    : "responses";
}

function apiValue(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return "";
  if (!/^(?:true|false|null|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|["[{])/i.test(text)) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function sameValue(left, right) {
  if (left === right) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function pathParts(path) {
  const blocked = new Set(["__proto__", "prototype", "constructor"]);
  const parts = String(path || "").split(".").map((item) => item.trim()).filter(Boolean);
  return parts.some((part) => blocked.has(part)) ? [] : parts;
}

function getPath(target, path) {
  return pathParts(path).reduce(
    (value, key) => (value && typeof value === "object" ? value[key] : undefined),
    target,
  );
}

function setPath(target, path, value) {
  const parts = pathParts(path);
  if (!parts.length) return;
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

function deletePath(target, path) {
  const parts = pathParts(path);
  if (!parts.length) return;
  const parents = [];
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object") return;
    parents.push([cursor, part]);
    cursor = cursor[part];
  }
  if (!cursor || typeof cursor !== "object") return;
  delete cursor[parts.at(-1)];
  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const [parent, key] = parents[index];
    const child = parent[key];
    if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) delete parent[key];
    else break;
  }
}

export function runtimeParametersFromConfig(config = {}) {
  const format = formatName(config.api_format || config.apiFormat);
  const extra = objectConfig(config.extra_config);
  const runtime = objectConfig(extra.agent_runtime);
  const configuredParameters = objectConfig(runtime.parameters);
  const result = {};

  for (const [name, spec] of Object.entries(PARAMETER_SPECS)) {
    const configured = objectConfig(configuredParameters[name]);
    const legacyValues = Array.isArray(runtime[spec.valuesKey])
      ? runtime[spec.valuesKey].map(String).filter((value) => spec.allowedValues.has(value))
      : [];
    const rawOptions = Array.isArray(configured.options) ? configured.options : [];
    const seen = new Set();
    const options = rawOptions.flatMap((item) => {
      const option = objectConfig(item);
      const value = String(option.value || "").trim().toLowerCase();
      if (!value || seen.has(value) || !spec.allowedValues.has(value) || option.enabled === false) return [];
      seen.add(value);
      return [{
        value,
        label: String(option.label || "").trim(),
        api_value: apiValue(option.api_value, value),
      }];
    });
    if (!rawOptions.length) {
      for (const value of legacyValues) {
        if (seen.has(value)) continue;
        seen.add(value);
        options.push({ value, label: "", api_value: value });
      }
    }
    const requestedDefault = String(configured.default ?? runtime[spec.defaultKey] ?? "").trim().toLowerCase();
    // Supported values describe capability, not the provider's chosen default.
    // Do not invent a request value when the model configuration did not pick one.
    const defaultValue = options.some((option) => option.value === requestedDefault)
      ? requestedDefault
      : "";
    result[name] = {
      request_key: String(configured.request_key || spec.requestKeys[format]).trim(),
      options,
      default: defaultValue,
      configured: Object.prototype.hasOwnProperty.call(configuredParameters, name),
    };
  }
  return result;
}

export function runtimeCapabilitiesFromConfig(config = {}) {
  const parameters = runtimeParametersFromConfig(config);
  const extra = objectConfig(config.extra_config);
  return {
    supports_image_input: extra.supports_image_input === true,
    reasoning_efforts: parameters.reasoning_effort.options.map((item) => item.value),
    reasoning_effort_options: parameters.reasoning_effort.options.map(({ value, label }) => ({ value, label })),
    reasoning_effort_default: parameters.reasoning_effort.default,
    reasoning_summaries: parameters.reasoning_summary.options.map((item) => item.value),
    reasoning_summary_options: parameters.reasoning_summary.options.map(({ value, label }) => ({ value, label })),
    reasoning_summary_default: parameters.reasoning_summary.default,
    verbosity_levels: parameters.verbosity.options.map((item) => item.value),
    verbosity_options: parameters.verbosity.options.map(({ value, label }) => ({ value, label })),
    verbosity_default: parameters.verbosity.default,
  };
}

export function hasCustomRuntimeParameterMapping(config = {}) {
  const format = formatName(config.api_format || config.apiFormat);
  const parameters = runtimeParametersFromConfig(config);
  return Object.entries(PARAMETER_SPECS).some(([name, spec]) => {
    const parameter = parameters[name];
    if (!parameter.options.length) return parameter.configured;
    if (parameter.request_key !== spec.requestKeys[format]) return true;
    return parameter.options.some((option) => !sameValue(option.api_value, option.value));
  });
}

export function mapRuntimeRequestParameters(source, target, parameters, targetFormat) {
  const format = formatName(targetFormat);
  for (const [name, spec] of Object.entries(PARAMETER_SPECS)) {
    const selected = getPath(source, spec.sourcePath);
    if (selected === undefined) continue;
    const parameter = parameters?.[name];
    const options = Array.isArray(parameter?.options) ? parameter.options : [];
    const option = options.find((item) => item.value === String(selected));
    deletePath(target, spec.sourcePath);
    if ((parameter?.configured || options.length > 0) && !option) {
      continue;
    }
    const requestKey = String(parameter?.request_key || spec.requestKeys[format]).trim();
    setPath(target, requestKey, option ? option.api_value : selected);
  }
  return target;
}

export function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export { PARAMETER_SPECS as AGENT_RUNTIME_PARAMETER_SPECS };

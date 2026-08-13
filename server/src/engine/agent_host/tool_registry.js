import { PermissionPolicy } from "./permission_policy.js";

function registryError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function clean(value, max = 1_000) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanName(value) {
  const name = clean(value, 160);
  if (!name) throw registryError("工具名称不能为空", "TOOL_NAME_REQUIRED");
  if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(name)) {
    throw registryError(`工具名称不合法: ${name}`, "TOOL_NAME_INVALID");
  }
  return name;
}

function names(value) {
  if (value == null) return null;
  return new Set(Array.isArray(value) || value instanceof Set ? value : [value]);
}

export function normalizeToolDefinition(definition = {}, { pluginName = null } = {}) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw registryError("工具定义必须是对象", "TOOL_DEFINITION_INVALID");
  }
  const name = cleanName(definition.name);
  const exposure = clean(definition.exposure, 32).toLowerCase() || "direct";
  if (!new Set(["direct", "deferred"]).has(exposure)) {
    throw registryError(`工具暴露方式不合法: ${exposure}`, "TOOL_EXPOSURE_INVALID");
  }
  const inputSchema = definition.input_schema ?? definition.inputSchema ?? definition.parameters ?? {
    type: "object",
    properties: {},
  };
  return Object.freeze({
    ...definition,
    name,
    description: clean(definition.description, 2_000),
    input_schema: inputSchema,
    parameters: definition.parameters ?? inputSchema,
    plugin_name: clean(pluginName ?? definition.plugin_name ?? definition.pluginName, 120) || null,
    exposure,
    side_effect: clean(definition.side_effect ?? definition.sideEffect ?? definition.safety, 64) || "none",
    capabilities: Object.freeze([...(definition.capabilities || [])]),
    permission_requirements: Object.freeze([
      ...(definition.permission_requirements ?? definition.permissionRequirements ?? []),
    ]),
    execution_metadata: Object.freeze({
      ...(definition.execution_metadata ?? definition.executionMetadata ?? definition.execution ?? {}),
    }),
  });
}

function searchScore(tool, terms) {
  const text = [tool.name, tool.description, ...(tool.capabilities || [])].join(" ").toLowerCase();
  return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0);
}

export class ToolRegistry {
  constructor({ permissionPolicy = null, tools = [] } = {}) {
    this.permissionPolicy = permissionPolicy || new PermissionPolicy();
    this.tools = new Map();
    this.registerMany(tools);
  }

  register(definition, { pluginName = null, replace = false } = {}) {
    const tool = normalizeToolDefinition(definition, { pluginName });
    if (this.tools.has(tool.name) && !replace) {
      throw registryError(`工具已注册: ${tool.name}`, "TOOL_ALREADY_REGISTERED");
    }
    this.tools.set(tool.name, tool);
    return tool;
  }

  registerMany(tools = [], options = {}) {
    return [...(tools || [])].map((tool) => this.register(tool, options));
  }

  get(name) {
    return this.tools.get(cleanName(name)) || null;
  }

  require(name) {
    const tool = this.get(name);
    if (!tool) throw registryError(`工具未注册: ${name}`, "TOOL_NOT_FOUND");
    return tool;
  }

  discover({ exposure = null, pluginName = null } = {}) {
    return [...this.tools.values()].filter((tool) => {
      if (exposure && tool.exposure !== exposure) return false;
      if (pluginName && tool.plugin_name !== pluginName) return false;
      return true;
    });
  }

  list(criteria = {}) {
    return this.discover(criteria);
  }

  resolve(name) {
    return this.require(name);
  }

  resolveVisibleTools({
    activeSkill = null,
    skill = null,
    requestedNames = null,
    includeDeferred = false,
    permissionPolicy = null,
    ...permissionContext
  } = {}) {
    const requested = names(requestedNames);
    let candidates = this.discover().filter((tool) => {
      if (tool.exposure === "deferred" && !includeDeferred) return false;
      return !requested || requested.has(tool.name);
    });
    const policy = permissionPolicy || this.permissionPolicy;
    candidates = policy.allowedTools(candidates, {
      ...permissionContext,
      activeSkill: activeSkill || skill,
      requestedNames,
    });
    return candidates;
  }

  listVisible(context = {}) {
    return this.resolveVisibleTools(context);
  }

  search(query, { limit = 8, deferredOnly = true, permissionPolicy = null, ...context } = {}) {
    const terms = clean(query, 500).toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    let tools = this.discover();
    if (deferredOnly) tools = tools.filter((tool) => tool.exposure === "deferred");
    const policy = permissionPolicy || this.permissionPolicy;
    return policy.allowedTools(tools, context)
      .map((tool) => ({ tool, score: searchScore(tool, terms) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, Math.max(0, Number(limit) || 0))
      .map((item) => item.tool);
  }
}

export default { ToolRegistry, normalizeToolDefinition };

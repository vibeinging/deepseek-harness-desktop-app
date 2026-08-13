export const MCP_TOOL_APPROVAL_MODES = Object.freeze([
  "auto",
  "prompt",
  "writes",
  "approve",
]);

const APPROVAL_MODES = new Set(MCP_TOOL_APPROVAL_MODES);
const MAX_TOOL_COUNT = 256;
const MAX_TOOL_NAME_LENGTH = 512;

function policyError(message) {
  const error = new Error(message);
  error.code = "MCP_TOOL_POLICY_INVALID";
  return error;
}

function clean(value, max = MAX_TOOL_NAME_LENGTH) {
  return String(value ?? "").trim().slice(0, max);
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => clean(item)).filter(Boolean))].slice(0, MAX_TOOL_COUNT);
}

function approvalMode(value, field, { nullable = true } = {}) {
  if (value === undefined) return undefined;
  if (value === null || value === "") {
    if (nullable) return null;
    throw policyError(`${field} 不能为空`);
  }
  const mode = clean(value, 32).toLowerCase();
  if (!APPROVAL_MODES.has(mode)) {
    throw policyError(`${field} 必须是 auto、prompt、writes 或 approve`);
  }
  return mode;
}

function rawToolPolicies(body = {}) {
  if (Object.prototype.hasOwnProperty.call(body, "tool_policies")) return body.tool_policies;
  return body.tools;
}

export function normalizeMcpToolPolicies(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw policyError("工具权限必须是按工具名组织的对象");
  }
  const result = {};
  for (const [rawName, rawPolicy] of Object.entries(value).slice(0, MAX_TOOL_COUNT)) {
    const name = clean(rawName);
    if (!name) continue;
    const source = typeof rawPolicy === "string"
      ? { approval_mode: rawPolicy }
      : rawPolicy;
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      throw policyError(`工具「${name}」权限配置无效`);
    }
    const mode = approvalMode(source.approval_mode, `工具「${name}」的确认规则`);
    if (mode) result[name] = { approval_mode: mode };
  }
  return result;
}

export function mcpToolPolicyDefinition(body = {}, existing = {}) {
  const result = {};
  const requestedDefault = approvalMode(
    body.default_tools_approval_mode,
    "默认工具确认规则",
  );
  const defaultMode = requestedDefault === undefined
    ? approvalMode(existing.default_tools_approval_mode, "默认工具确认规则")
    : requestedDefault;
  if (defaultMode) result.default_tools_approval_mode = defaultMode;

  const enabledTools = body.enabled_tools === undefined
    ? stringList(existing.enabled_tools)
    : stringList(body.enabled_tools);
  const disabledTools = body.disabled_tools === undefined
    ? stringList(existing.disabled_tools)
    : stringList(body.disabled_tools);
  if (enabledTools.length) result.enabled_tools = enabledTools;
  if (disabledTools.length) result.disabled_tools = disabledTools;

  const requestedTools = rawToolPolicies(body);
  const tools = requestedTools === undefined
    ? normalizeMcpToolPolicies(existing.tools)
    : normalizeMcpToolPolicies(requestedTools);
  if (Object.keys(tools).length) result.tools = tools;
  return result;
}

export function mcpToolPolicyView(definition = {}) {
  const mode = approvalMode(definition.default_tools_approval_mode, "默认工具确认规则");
  const toolPolicies = normalizeMcpToolPolicies(definition.tools);
  return {
    default_tools_approval_mode: mode || null,
    enabled_tools: stringList(definition.enabled_tools),
    disabled_tools: stringList(definition.disabled_tools),
    tool_policies: Object.fromEntries(Object.entries(toolPolicies).map(([name, policy]) => [
      name,
      policy.approval_mode,
    ])),
  };
}

export function replaceMcpToolPolicy(body = {}, existing = {}) {
  const next = { ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}) };
  delete next.default_tools_approval_mode;
  delete next.enabled_tools;
  delete next.disabled_tools;
  delete next.tools;
  return { ...next, ...mcpToolPolicyDefinition(body, existing) };
}

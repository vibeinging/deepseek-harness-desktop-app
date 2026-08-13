export const TOOL_SIDE_EFFECTS = Object.freeze([
  "none",
  "intermediate",
  "project_write",
  "external_write",
]);

const SIDE_EFFECT_ALIASES = Object.freeze({
  read: "none",
  meta: "none",
  write: "project_write",
  execute: "project_write",
  local_write: "project_write",
  external_read: "none",
});

function values(value) {
  if (value == null) return null;
  return new Set(Array.isArray(value) || value instanceof Set ? value : [value]);
}

function toolName(tool) {
  return String(typeof tool === "string" ? tool : tool?.name ?? "").trim();
}

function visibilityLimit(skill) {
  if (!skill) return null;
  const raw = skill.tool_visibility_limit ?? skill.toolVisibilityLimit;
  if (raw == null) return null;
  const limit = values(raw);
  return !limit?.size ? null : limit;
}

export function normalizeSideEffect(value) {
  const raw = String(value ?? "none").trim().toLowerCase() || "none";
  return SIDE_EFFECT_ALIASES[raw] || raw;
}

function intersect(current, limit) {
  if (limit == null) return current == null ? null : new Set(current);
  if (current == null) return new Set(limit);
  return new Set([...current].filter((item) => limit.has(item)));
}

export class PermissionPolicy {
  constructor({
    allowedTools = null,
    deniedTools = [],
    allowedSideEffects = null,
    grantedPermissions = null,
  } = {}) {
    this.hostAllowedTools = values(allowedTools);
    this.hostDeniedTools = values(deniedTools) || new Set();
    this.hostAllowedSideEffects = allowedSideEffects == null
      ? null
      : new Set([...values(allowedSideEffects)].map(normalizeSideEffect));
    // Tool requirements must be granted by the Host explicitly. An absent grant list
    // means no named permissions, not an implicit wildcard.
    this.hostGrantedPermissions = values(grantedPermissions) || new Set();
  }

  effectiveToolNameSet({ skill = null, activeSkill = null, requestedNames = null, allowedTools = null } = {}) {
    let effective = this.hostAllowedTools == null ? null : new Set(this.hostAllowedTools);
    effective = intersect(effective, values(allowedTools));
    // Dependencies describe what a Skill needs. They never grant or remove Host
    // permissions. A trusted Host visibility limit may only narrow the set.
    effective = intersect(effective, visibilityLimit(activeSkill || skill));
    effective = intersect(effective, values(requestedNames));
    if (effective == null) return null;
    for (const denied of this.hostDeniedTools) effective.delete(denied);
    return effective;
  }

  decision(tool, context = {}) {
    const name = toolName(tool);
    if (!name) return { allowed: false, reason: "tool_name_missing", side_effect: "none" };
    const effectiveNames = this.effectiveToolNameSet(context);
    if (this.hostDeniedTools.has(name)) {
      return { allowed: false, reason: "tool_denied_by_host", tool: name, side_effect: normalizeSideEffect(tool?.side_effect) };
    }
    if (effectiveNames && !effectiveNames.has(name)) {
      return { allowed: false, reason: "tool_outside_effective_allowlist", tool: name, side_effect: normalizeSideEffect(tool?.side_effect) };
    }

    const sideEffect = normalizeSideEffect(tool?.side_effect ?? tool?.sideEffect ?? tool?.safety);
    const contextSideEffects = context.allowedSideEffects ?? context.allowed_side_effects;
    const allowedSideEffects = intersect(this.hostAllowedSideEffects, contextSideEffects == null
      ? null
      : new Set([...values(contextSideEffects)].map(normalizeSideEffect)));
    if (allowedSideEffects && !allowedSideEffects.has(sideEffect)) {
      return { allowed: false, reason: "side_effect_denied", tool: name, side_effect: sideEffect };
    }

    const requirements = values(tool?.permission_requirements ?? tool?.permissionRequirements) || new Set();
    const granted = intersect(this.hostGrantedPermissions, values(context.grantedPermissions ?? context.granted_permissions));
    const missingPermissions = granted == null
      ? []
      : [...requirements].filter((permission) => !granted.has(permission));
    if (missingPermissions.length) {
      return {
        allowed: false,
        reason: "permission_missing",
        tool: name,
        side_effect: sideEffect,
        missing_permissions: missingPermissions,
      };
    }
    return {
      allowed: true,
      reason: "allowed",
      tool: name,
      side_effect: sideEffect,
      requires_approval: sideEffect === "project_write" || sideEffect === "external_write",
    };
  }

  authorize(tool, context = {}) {
    return this.decision(tool, context).allowed;
  }

  assertAllowed(tool, context = {}) {
    const decision = this.decision(tool, context);
    if (decision.allowed) return decision;
    const error = new Error(`工具无权限: ${decision.tool || "unknown"} (${decision.reason})`);
    error.code = "TOOL_PERMISSION_DENIED";
    error.decision = decision;
    throw error;
  }

  allowedTools(tools = [], context = {}) {
    return [...(tools || [])].filter((tool) => this.authorize(tool, context));
  }

  effectiveToolNames(tools = [], context = {}) {
    return this.allowedTools(tools, context).map(toolName);
  }
}

export default { PermissionPolicy, TOOL_SIDE_EFFECTS, normalizeSideEffect };

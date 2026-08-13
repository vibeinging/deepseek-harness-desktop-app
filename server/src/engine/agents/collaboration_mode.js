const COLLABORATION_MODES = new Set(["default", "plan"]);
const MUTATING_SIDE_EFFECTS = new Set([
  "write",
  "execute",
  "local_write",
  "project_write",
  "external_write",
]);

export function normalizeCollaborationMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  return COLLABORATION_MODES.has(mode) ? mode : "default";
}

export function isMutatingHostTool(tool = {}) {
  const sideEffect = String(
    tool.side_effect
      ?? tool.sideEffect
      ?? tool.safety
      ?? tool.execution_metadata?.side_effect
      ?? "",
  ).trim().toLowerCase();
  return MUTATING_SIDE_EFFECTS.has(sideEffect);
}

// Codex Plan mode is analysis-only. The native runtime enforces this for its
// own command and file tools; Host tools need the same boundary before they are
// exposed as dynamic tools.
export function scopeToolsForCollaborationMode(tools, mode) {
  if (normalizeCollaborationMode(mode) !== "plan") return tools;
  return (Array.isArray(tools) ? tools : []).filter((tool) => !isMutatingHostTool(tool));
}

export default {
  normalizeCollaborationMode,
  isMutatingHostTool,
  scopeToolsForCollaborationMode,
};

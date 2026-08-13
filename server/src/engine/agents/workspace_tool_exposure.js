const WEB_TOOL_NAMES = new Set(["web_search", "web_open", "web_find"]);

const CHAT_COMPLETIONS_DIRECT_TOOL_NAMES = new Set([
  "ui_render",
  "canvas_inspect",
  "canvas_create",
  "canvas_edit",
  "canvas_suggest",
  "artifact_publish",
  "artifact_office_inspect",
  "artifact_office_create",
  "artifact_office_edit",
  "image_gen",
]);

export function resolveWorkspaceToolExposure(tool, {
  apiFormat = "responses",
  mountedPluginNames = [],
  selectedSkills = [],
  forceDirectNames = [],
} = {}) {
  if (WEB_TOOL_NAMES.has(String(tool?.name || ""))) return "direct";
  if (String(apiFormat || "").toLowerCase() !== "chat_completions") {
    return tool?.exposure === "direct" ? "direct" : "deferred";
  }
  const directNames = new Set([
    ...CHAT_COMPLETIONS_DIRECT_TOOL_NAMES,
    ...Array.from(forceDirectNames || []),
    ...(selectedSkills || []).flatMap((skill) => skill?.tool_dependencies || skill?.required_tools || []),
  ].map(String));
  const mounted = new Set(Array.from(mountedPluginNames || [], String));
  const direct = directNames.has(String(tool?.name || ""))
    || (tool?.plugin_name && mounted.has(String(tool.plugin_name)))
    || tool?.exposure === "direct";
  return direct ? "direct" : "deferred";
}

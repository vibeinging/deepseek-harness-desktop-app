import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

function canonicalPath(value) {
  const path = String(value || "").trim();
  if (!path) return "";
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function skillQualifiedName(skill = {}) {
  const explicit = String(skill.qualified_name || "").trim();
  if (explicit) return explicit;
  const name = String(skill.name || "").trim();
  const pluginName = String(skill.plugin_name || "").trim();
  if (!pluginName || name.startsWith(`${pluginName}:`)) return name;
  return `${pluginName}:${name}`;
}

/** Browser-safe identity for choosing one exact Skill without exposing its local path. */
export function skillSelectionKey(skill = {}) {
  const explicit = String(skill.selection_key || "").trim();
  if (explicit) return explicit;
  const path = canonicalPath(skill._runtimePath || skill.path);
  if (path) {
    return `skill:${createHash("sha256").update(path).digest("hex").slice(0, 24)}`;
  }
  return skillQualifiedName(skill);
}

export function skillIdentityView(skill = {}) {
  return {
    qualified_name: skillQualifiedName(skill),
    selection_key: skillSelectionKey(skill),
  };
}

export default { skillQualifiedName, skillSelectionKey, skillIdentityView };

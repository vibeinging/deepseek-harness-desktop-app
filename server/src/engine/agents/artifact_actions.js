const ACTION_ORDER = Object.freeze(["open", "reveal", "copy", "download"]);
const ACTION_SET = new Set(ACTION_ORDER);
const COPYABLE_KINDS = new Set(["image", "table", "chart", "json"]);

function clean(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * Resolve the user actions exposed by one delivered artifact.
 *
 * Tools declare what they produced. The host owns the stable action vocabulary,
 * so individual tools cannot invent native capabilities or renderer branches.
 */
export function artifactActionsFor({ kind, path, materialization } = {}) {
  const normalizedKind = clean(kind) || "file";
  if (clean(materialization) === "client-download") return ["download"];

  const actions = [];
  if (path && normalizedKind !== "image") actions.push("open");
  if (path) actions.push("reveal");
  if (COPYABLE_KINDS.has(normalizedKind)) actions.push("copy");
  return actions;
}

export function normalizeArtifactActions(actions, fallback = {}) {
  if (!Array.isArray(actions)) return artifactActionsFor(fallback);
  const allowed = new Set(actions.map(clean).filter((action) => ACTION_SET.has(action)));
  return ACTION_ORDER.filter((action) => allowed.has(action));
}

export const ARTIFACT_ACTIONS = ACTION_ORDER;

function objectValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function hasPositiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0;
}

// These values preserve capabilities that older releases inferred at runtime.
// They are used only by the one-time database migration below; current turns
// and catalogs never infer capabilities from a model name.
const LEGACY_MODEL_CAPABILITIES = Object.freeze([
  Object.freeze({
    matches: (name) => /^qwen3\.7-plus(?:-\d{4}-\d{2}-\d{2})?$/.test(name),
    contextWindow: 1_000_000,
    supportsImageInput: true,
  }),
]);

export function explicitLegacyModelCapabilities(modelName, extraConfig = {}) {
  const name = String(modelName || "").trim().toLowerCase();
  const profile = LEGACY_MODEL_CAPABILITIES.find((candidate) => candidate.matches(name));
  const original = objectValue(extraConfig);
  if (!profile) return Object.freeze({ changed: false, extraConfig: original });

  const runtime = objectValue(original.agent_runtime);
  const runtimeContextWindow = hasPositiveInteger(runtime.context_window)
    ? Number(runtime.context_window)
    : null;
  const legacyRootContextWindow = hasPositiveInteger(original.context_window)
    ? Number(original.context_window)
    : null;
  const explicitContextWindow = runtimeContextWindow
    || legacyRootContextWindow
    || profile.contextWindow;
  const hasImageDeclaration = Object.prototype.hasOwnProperty.call(original, "supports_image_input");
  // Older settings stored context_window at the root. The current editor and
  // catalog use agent_runtime, so normalize that value instead of treating the
  // legacy shape as fully migrated.
  if (runtimeContextWindow && hasImageDeclaration) {
    return Object.freeze({ changed: false, extraConfig: original });
  }

  const next = {
    ...original,
    ...(!hasImageDeclaration ? { supports_image_input: profile.supportsImageInput } : {}),
    agent_runtime: {
      ...runtime,
      context_window: explicitContextWindow,
    },
  };
  return Object.freeze({ changed: true, extraConfig: next });
}

export default explicitLegacyModelCapabilities;

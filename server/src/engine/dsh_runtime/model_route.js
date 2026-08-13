const ROUTE_PREFIX = "dsh-model:";

function routeError(message) {
  const error = new Error(message);
  error.code = "DSH_MODEL_ROUTE_INVALID";
  return error;
}

/** Encode one DSH provider/model pair as an opaque value safe for App storage. */
export function encodeDshModelRoute(provider, model) {
  const route = [String(provider || "").trim(), String(model || "").trim()];
  if (!route[0] || !route[1]) throw routeError("DSH 模型路由缺少 provider 或 model");
  return `${ROUTE_PREFIX}${Buffer.from(JSON.stringify(route)).toString("base64url")}`;
}

/** Decode only the current DSH route format; old App model ids are unsupported. */
export function decodeDshModelRoute(value) {
  const encoded = String(value || "").trim();
  if (!encoded.startsWith(ROUTE_PREFIX)) throw routeError("旧模型选择已停用，请重新选择 DSH 模型");
  try {
    const parsed = JSON.parse(Buffer.from(encoded.slice(ROUTE_PREFIX.length), "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2
      || parsed.some((item) => typeof item !== "string" || !item.trim())) {
      throw new Error("invalid route tuple");
    }
    return { provider: parsed[0], model: parsed[1] };
  } catch (error) {
    if (error?.code === "DSH_MODEL_ROUTE_INVALID") throw error;
    throw routeError("DSH 模型路由格式无效，请重新选择模型");
  }
}

/** Project the official DSH catalog into the dsh-work selector shape. */
export function dshModelOptions(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  return groups.flatMap((group) => (Array.isArray(group?.models) ? group.models : []).map((model) => {
    const efforts = Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : [];
    return {
      id: encodeDshModelRoute(group.id, model.id),
      provider: group.id,
      provider_name: group.name || group.id,
      model_name: model.id,
      display_name: model.name || model.id,
      description: model.description || null,
      source: "dsh",
      is_enabled: false,
      capabilities: {
        reasoning_efforts: efforts.map((effort) => effort.id),
        reasoning_effort_options: efforts.map((effort) => ({
          value: effort.id,
          label: effort.name || effort.id,
          description: effort.description || null,
        })),
        reasoning_effort_default: model?.reasoning?.defaultEffort || "",
      },
    };
  }));
}

export default { encodeDshModelRoute, decodeDshModelRoute, dshModelOptions };

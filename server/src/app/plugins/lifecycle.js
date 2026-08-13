import { ApiError } from "../../errors.js";
import { getDshProfilePluginService } from "../../engine/dsh_runtime/profile_plugin_service.js";
import { publishPluginCatalogChanged } from "../../engine/plugins/plugin_catalog_events.js";

function apiError(error, fallback) {
  if (error instanceof ApiError) return error;
  const code = error?.code || "DSH_PROFILE_OPERATION_FAILED";
  const status = code === "PLUGIN_NOT_FOUND" ? 404
    : code === "PLUGIN_UNINSTALL_NOT_ALLOWED" ? 409
      : 400;
  return new ApiError(error?.message || fallback, status, code);
}

export async function installProfileBundle(ctx, input) {
  try {
    const result = await getDshProfilePluginService().install(input.body?.source);
    publishPluginCatalogChanged({
      userId: ctx?.userId,
      reason: "install",
      canonicalPluginId: result.id,
    });
    return { data: result, message: `DSH Profile Bundle「${result.name}」已安装` };
  } catch (error) {
    throw apiError(error, "安装 DSH Profile Bundle 失败");
  }
}

export async function preflightProfileBundle(_ctx, input) {
  try {
    const result = await getDshProfilePluginService().preflight(input.body?.source);
    return { data: result, message: result.installable ? "候选 Profile Bundle 可以安装" : "候选插件需要处理兼容问题" };
  } catch (error) {
    throw apiError(error, "检查 DSH Profile Bundle 失败");
  }
}

export async function uninstallProfileBundle(ctx, input) {
  try {
    const result = await getDshProfilePluginService().uninstall(input.params?.id);
    publishPluginCatalogChanged({
      userId: ctx?.userId,
      reason: "uninstall",
      canonicalPluginId: result.id,
    });
    return { data: result, message: `DSH Profile Bundle「${result.name}」已卸载` };
  } catch (error) {
    throw apiError(error, "卸载 DSH Profile Bundle 失败");
  }
}

export async function rejectLegacyPluginOperation() {
  throw new ApiError(
    "旧 Plugin marketplace 和 enabled 接口已移除，请使用 DSH Profile Bundle",
    410,
    "LEGACY_PLUGIN_LIFECYCLE_REMOVED",
  );
}

export default {
  installProfileBundle,
  preflightProfileBundle,
  uninstallProfileBundle,
  rejectLegacyPluginOperation,
};

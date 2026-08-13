import { ApiError } from "../../errors.js";
import { getDshProfilePluginService } from "../../engine/dsh_runtime/profile_plugin_service.js";

function catalogError(error, fallback) {
  if (error instanceof ApiError) return error;
  const code = error?.code || "DSH_PROFILE_CATALOG_FAILED";
  const status = code === "PLUGIN_NOT_FOUND" ? 404 : 400;
  return new ApiError(error?.message || fallback, status, code);
}

export async function listPluginCatalog({ service = getDshProfilePluginService() } = {}) {
  try {
    return await service.catalog();
  } catch (error) {
    throw catalogError(error, "无法读取 DSH Profile Bundle");
  }
}

export async function readPluginDetail(pluginId, { service = getDshProfilePluginService() } = {}) {
  try {
    return await service.read(pluginId);
  } catch (error) {
    throw catalogError(error, "无法读取 DSH Profile Bundle 详情");
  }
}

export async function listAgentPluginCatalog(_ctx, input) {
  return {
    data: await listPluginCatalog({ forceRefetch: input.query?.refresh === "1" }),
    message: "获取 DSH Profile Bundle 成功",
  };
}

export async function getAgentPluginDetail(_ctx, input) {
  return { data: await readPluginDetail(input.params?.id), message: "获取 DSH Profile Bundle 详情成功" };
}

export default { listPluginCatalog, readPluginDetail, listAgentPluginCatalog, getAgentPluginDetail };

import {
  previewProjectDataPreparation,
  runProjectDataPreparation,
} from "../../engine/agents/product_capabilities/data_preparation.js";
import {
  getLatestDataPreparationRevision,
  listDataPreparationRevisions,
} from "../../engine/semantic/data_preparation_revision_store.js";

function projectId(input) {
  return String(input?.params?.pid || "").trim();
}

export async function previewDataPreparation(ctx, input) {
  const pid = projectId(input);
  const params = { ...(input.query || {}), ...(input.body || {}) };
  return {
    data: await previewProjectDataPreparation(ctx, pid, params),
    message: "数据准备状态检查完成",
  };
}

export async function runDataPreparation(ctx, input) {
  const pid = projectId(input);
  const result = await runProjectDataPreparation(ctx, pid, input.body || {});
  return {
    data: result,
    message: result.status === "completed" ? "项目数据准备完成" : "项目数据准备未完整完成",
  };
}

export async function getDataPreparationStatus(ctx, input) {
  const pid = projectId(input);
  const [latest, history] = await Promise.all([
    getLatestDataPreparationRevision(ctx, pid),
    listDataPreparationRevisions(ctx, pid, { limit: Number(input.query?.limit) || 20 }),
  ]);
  return {
    data: { project_id: pid, latest, history },
    message: "获取数据准备版本成功",
  };
}

export default {
  previewDataPreparation,
  runDataPreparation,
  getDataPreparationStatus,
};

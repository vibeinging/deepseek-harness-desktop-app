// 项目语义域路由表(去业务层:资源直接挂 /api/projects/:pid,不再有 :bid 中间段)。
// 抽自原 routes/business_crud.js,53 端点收敛为项目级端点。
// 一域一 registry,避免多 agent 扇出冲突。
//
// 顺序与源文件 register() 内逐行一致 —— 具体路径必须在通配 :param 之前注册(metrics/metric-views)。
//
// 项目语义功能统一由 Node use-case 实现，路由表不保留可点击功能的 501 占位。
import * as business from "../app/business/business.js";
import * as metrics from "../app/business/metrics.js";
import * as examples from "../app/business/examples.js";
import * as entityConfigs from "../app/business/entity_configs.js";
import * as metricViews from "../app/business/metric_views.js";
import * as memory from "../app/business/memory.js";

export const businessRoutes = [
  // ── 消歧记忆(团队映射记忆)CRUD ──
  { m: "GET", p: "/api/projects/:pid/memory", fn: memory.listMemory, auth: true },
  { m: "POST", p: "/api/projects/:pid/memory", fn: memory.createMemory, auth: true },
  { m: "PUT", p: "/api/projects/:pid/memory/:rid", fn: memory.updateMemory, auth: true },
  { m: "POST", p: "/api/projects/:pid/memory/bulk_import", fn: memory.bulkImportMemory, auth: true },
  { m: "POST", p: "/api/projects/:pid/memory/bulk_delete", fn: memory.bulkDeleteMemory, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/memory/:rid", fn: memory.deleteMemory, auth: true },

  // ── Business CRUD(去业务层:项目即业务,不再创建/更新/删除 business 实体)──
  // 原 POST/PUT/DELETE /businesses 端点已废弃(businesses 表保留作过渡,见阶段 6)。

  // ── Data Sources binding(数据源绑定直接挂项目)──
  { m: "POST", p: "/api/projects/:pid/data-sources", fn: business.bindDataSource, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/data-sources", fn: business.unbindDataSource, auth: true },

  // ── Entity Refs (business_entity_configs) ──
  { m: "GET", p: "/api/projects/:pid/entity_refs", fn: entityConfigs.listEntityRefs, auth: true },
  { m: "GET", p: "/api/projects/:pid/entity_refs/available", fn: entityConfigs.listAvailableEntityRefs, auth: true },
  { m: "POST", p: "/api/projects/:pid/entity_refs", fn: entityConfigs.addEntityRefs, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/entity_refs/:refId", fn: entityConfigs.removeEntityRef, auth: true },
  { m: "PATCH", p: "/api/projects/:pid/entity_refs/:refId/active", fn: entityConfigs.toggleEntityRefActive, auth: true },

  // ── Metrics CRUD(具体路径在 :mid 通配之前)──
  { m: "POST", p: "/api/projects/:pid/metrics/generate_embeddings", fn: metrics.generateMetricEmbeddings, auth: true },
  { m: "POST", p: "/api/projects/:pid/metrics/bulk_import", fn: metrics.bulkImportMetrics, auth: true },
  { m: "GET", p: "/api/projects/:pid/metrics/search", fn: metrics.searchMetrics, auth: true },
  { m: "POST", p: "/api/projects/:pid/metrics/code_values/import", fn: metrics.importCodeValues, auth: true },
  { m: "GET", p: "/api/projects/:pid/metrics/code_values/export", fn: metrics.exportCodeValues, auth: true },
  { m: "PATCH", p: "/api/projects/:pid/metrics/batch_update_status", fn: metrics.batchUpdateMetricStatus, auth: true },
  { m: "POST", p: "/api/projects/:pid/metrics/:mid/execute", fn: metrics.executeMetric, auth: true },
  { m: "PATCH", p: "/api/projects/:pid/metrics/:mid/status", fn: metrics.updateMetricStatus, auth: true },
  { m: "POST", p: "/api/projects/:pid/metrics", fn: metrics.createMetric, auth: true },
  { m: "PUT", p: "/api/projects/:pid/metrics/:mid", fn: metrics.updateMetric, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/metrics/:mid", fn: metrics.deleteMetric, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/metrics", fn: metrics.deleteMetrics, auth: true },

  // ── Examples CRUD ──
  { m: "POST", p: "/api/projects/:pid/examples/search", fn: examples.searchExamplesUseCase, auth: true },
  { m: "POST", p: "/api/projects/:pid/examples/generate_embeddings", fn: examples.generateExampleEmbeddings, auth: true },
  { m: "POST", p: "/api/projects/:pid/examples", fn: examples.createExamples, auth: true },
  { m: "PUT", p: "/api/projects/:pid/examples/:eid", fn: examples.updateExample, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/examples", fn: examples.deleteExamples, auth: true },

  // ── Entity Configs (entity_mapping_configs) ──
  { m: "POST", p: "/api/projects/:pid/entity_configs/generate_embeddings", fn: entityConfigs.generateEntityConfigEmbeddings, auth: true },
  { m: "POST", p: "/api/projects/:pid/entity_configs", fn: entityConfigs.createEntityConfig, auth: true },
  { m: "PUT", p: "/api/projects/:pid/entity_configs/:cid", fn: entityConfigs.updateEntityConfig, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/entity_configs/:cid", fn: entityConfigs.deleteEntityConfig, auth: true },

  // ── Entity Mappings (entities) ──
  { m: "POST", p: "/api/projects/:pid/entity_mappings/column_names", fn: entityConfigs.createColumnNameEntities, auth: true },
  { m: "POST", p: "/api/projects/:pid/entity_mappings/test_agent", fn: entityConfigs.testEntityAgent, auth: true },
  { m: "POST", p: "/api/projects/:pid/entity_mappings/revert_auto_promoted", fn: entityConfigs.revertAutoPromoted, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/entities", fn: entityConfigs.deleteEntities, auth: true },
  { m: "POST", p: "/api/projects/:pid/entities/search", fn: entityConfigs.searchEntities, auth: true },
  { m: "POST", p: "/api/projects/:pid/entities/import_excel", fn: entityConfigs.importEntities, auth: true },

  // ── Metric Views CRUD(具体路径在 :mvid 通配之前)──
  { m: "POST", p: "/api/projects/:pid/metric-views/preview", fn: metricViews.previewMetricView, auth: true },
  { m: "POST", p: "/api/projects/:pid/metric-views/embeddings", fn: metricViews.generateMetricViewEmbeddings, auth: true },
  { m: "POST", p: "/api/projects/:pid/metric-views/column-distinct-values", fn: metricViews.getColumnDistinctValues, auth: true },
  { m: "POST", p: "/api/projects/:pid/metric-views/recommendations", fn: metricViews.runMetricViewRecommendation, auth: true },
  { m: "GET", p: "/api/projects/:pid/metric-views/recommendations/latest", fn: metricViews.getLatestMetricViewRecommendation, auth: true },
  { m: "GET", p: "/api/projects/:pid/metric-views/recommendations/:taskId", fn: metricViews.getMetricViewRecommendationTask, auth: true },
  { m: "POST", p: "/api/projects/:pid/metric-views/recommendations/:taskId/apply", fn: metricViews.applyMetricViewRecommendation, auth: true },
  { m: "PATCH", p: "/api/projects/:pid/metric-views/:mvid/status", fn: metricViews.updateMetricViewStatus, auth: true },
  { m: "POST", p: "/api/projects/:pid/metric-views", fn: metricViews.createMetricView, auth: true },
  { m: "PUT", p: "/api/projects/:pid/metric-views/:mvid", fn: metricViews.updateMetricView, auth: true },
  { m: "DELETE", p: "/api/projects/:pid/metric-views/:mvid", fn: metricViews.deleteMetricView, auth: true },

];

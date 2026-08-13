// Reads domain routes (batch 4 in index.js): all GET list/read endpoints, extracted from index.js.
// One registry per domain avoids conflicts from multiple agents editing the same file.
//
// All endpoints are read-only GET. Split into 4 usecase files: index (project-level misc), reads_business, reads_session, reads_datasource.
//
// Route order: literal path segments must come before :param wildcards (first-match in router.js).
// Different segment counts don't conflict, but keep specific routes first to prevent regressions.
//
import * as reads from "../app/reads/index.js";
import * as rb from "../app/reads/reads_business.js";
import * as rs from "../app/reads/reads_session.js";
import * as rd from "../app/reads/reads_datasource.js";

export const readsRoutes = [
  // ── Sessions (list/detail/messages/feedback/intermediate tables) ──
  { m: "GET", p: "/api/projects/:pid/sessions", fn: rs.listSessions, auth: true },
  { m: "GET", p: "/api/projects/:pid/sessions/:sid/messages", fn: rs.listSessionMessages, auth: true },
  { m: "GET", p: "/api/projects/:pid/sessions/:sid/intermediate-tables", fn: rs.listIntermediateTables, auth: true },
  { m: "GET", p: "/api/projects/:pid/sessions/:sid/feedback-status", fn: rs.getSessionFeedbackStatus, auth: true },
  { m: "GET", p: "/api/projects/:pid/sessions/:sid", fn: rs.getSession, auth: true },

  // ── Project semantics: data sources / metrics / entities / metric views / examples (resource scoped by project) ──
  // Note: listBusinesses/getBusiness still points to businesses table for compatibility during migration.
  { m: "GET", p: "/api/projects/:pid/businesses", fn: rb.listBusinesses, auth: true },
  { m: "GET", p: "/api/projects/:pid/data-sources", fn: rb.getBusinessDataSources, auth: true },
  // Metrics / entities / metric views / examples (specific paths before :mvid wildcard)
  { m: "GET", p: "/api/projects/:pid/metrics/embedding_pending_count", fn: rb.getMetricsEmbeddingPendingCount, auth: true },
  { m: "GET", p: "/api/projects/:pid/metrics", fn: rb.listMetrics, auth: true },
  { m: "GET", p: "/api/projects/:pid/entity_configs", fn: rb.listEntityConfigs, auth: true },
  { m: "GET", p: "/api/projects/:pid/entities", fn: rb.listEntities, auth: true },
  { m: "GET", p: "/api/projects/:pid/metric-views/:mvid", fn: rb.getMetricView, auth: true },
  { m: "GET", p: "/api/projects/:pid/metric-views", fn: rb.listMetricViews, auth: true },
  { m: "GET", p: "/api/projects/:pid/examples/stats", fn: rb.getExamplesStats, auth: true },
  { m: "GET", p: "/api/projects/:pid/examples", fn: rb.listExamples, auth: true },
  { m: "GET", p: "/api/projects/:pid/business", fn: rb.getBusiness, auth: true },

  // ── Database connections / tables / columns / relationships / sync pending ──
  { m: "GET", p: "/api/projects/:pid/databases/meta/supported-types", fn: rd.listSupportedDbTypes, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases/:cid/tables/:tid/columns", fn: rd.listColumns, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases/:cid/tables", fn: rd.listTables, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases/:cid/relationships", fn: rd.listRelationships, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases/:cid/sync_pending", fn: rd.getSyncPending, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases/:cid", fn: rd.getDatabase, auth: true },
  { m: "GET", p: "/api/projects/:pid/databases", fn: rd.listDatabases, auth: true },

  // ── Structured / unstructured data source paths (both dashed and undashed variants kept for UI compatibility) ──
  { m: "GET", p: "/api/projects/:pid/structured-data-sources", fn: rd.listStructuredDataSourcesHyphen, auth: true },
  { m: "GET", p: "/api/projects/:pid/unstructured-data-sources", fn: rd.listUnstructuredDataSourcesHyphen, auth: true },
  { m: "GET", p: "/api/projects/:pid/structured-datasources", fn: rd.listStructuredDatasources, auth: true },
  { m: "GET", p: "/api/projects/:pid/unstructured-datasources", fn: rd.listUnstructuredDatasources, auth: true },

  // ── Dashboards / panels ──
  { m: "GET", p: "/api/projects/:pid/dashboards/:did/panels", fn: reads.listDashboardPanels, auth: true },
  { m: "GET", p: "/api/projects/:pid/dashboards", fn: reads.listDashboards, auth: true },
  { m: "GET", p: "/api/projects/:pid/panels/:panelId", fn: reads.getPanel, auth: true },
  { m: "GET", p: "/api/projects/:pid/panels", fn: reads.listPanels, auth: true },
];

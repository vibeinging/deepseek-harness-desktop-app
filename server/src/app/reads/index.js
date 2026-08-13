// L1 use-case layer for project-level read-only dashboard and panel endpoints.
// Copied from index.js GET handlers with line-by-line alignment.
// Signature is always async fn(ctx, input) -> { data, message }.
// req.params -> input.params; req.query -> ctx.query; ok({rows}) -> {data: rows}; fail -> throw ApiError.
import { ApiError } from "../../errors.js";

// ════════════════════════════════════════════
// Dashboard / Panel
// ════════════════════════════════════════════

// GET /api/projects/:pid/dashboards — dashboard list (frontend reads data.dashboards)
export async function listDashboards(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, created_by, title, description, layout, refresh_interval, created_at, updated_at
       FROM dashboards WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  // Frontend reads res.data.dashboards (not items)
  return { data: { dashboards: rows, total: rows.length, page: 1, per_page: rows.length, pages: 1 }, message: "获取看板列表成功" };
}

// GET /api/projects/:pid/panels — panel library list (frontend reads data.panels)
export async function listPanels(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, created_by, title, tags, content_type, content, display_type, display_config,
            execute_type, execute, source_type, source_id, created_at, updated_at
       FROM panels WHERE project_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
    [input.params.pid],
  );
  // Frontend reads res.data.panels (not items)
  return { data: { panels: rows, total: rows.length, page: 1, per_page: rows.length, pages: 1 }, message: "获取 Panel 列表成功" };
}

// GET /api/projects/:pid/panels/:panelId — panel detail
export async function getPanel(ctx, input) {
  const p = await ctx.queryOne(
    `SELECT id, project_id, title, tags, content_type, content, display_type, display_config,
            execute_type, execute, source_type, source_id, created_at, updated_at
       FROM panels WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [input.params.panelId, input.params.pid],
  );
  if (!p) throw new ApiError("Panel 不存在", 404);
  return { data: p, message: "获取 Panel 成功" };
}

// GET /api/projects/:pid/dashboards/:did/panels — panels inside dashboard (frontend reads data array)
export async function listDashboardPanels(ctx, input) {
  // Frontend reads res.data as array (not items), from dashboard_panels including x/y/w/h layout
  const rows = await ctx.query(
    `SELECT id, dashboard_id, title, tags, content_type, content, display_type, display_config,
            execute_type, execute, source_type, source_id, x, y, w, h, created_at, updated_at
       FROM dashboard_panels WHERE dashboard_id=$1 AND deleted_at IS NULL ORDER BY y ASC, x ASC`,
    [input.params.did],
  ).catch(() => []);
  return { data: rows, message: "获取看板 Panel 成功" };
}

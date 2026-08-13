// L1 use-case layer for Dashboard & Panel CRUD. Aligned line-by-line with routes/dashboard_crud.js.
// Signature is always async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
import { randomUUID } from 'crypto';
import { ApiError } from '../../errors.js';

/** Generate UUID (crypto built-in, Node >= 16). */
const newId = () => randomUUID();

// ─────────────────────────────────────────────
// Internal helpers (moved from register closure to module scope, ported line-by-line).
// ─────────────────────────────────────────────

// SQLite returns JSON/JSONB columns as text (PG driver parses automatically). Parse on demand:
// Return object/array values directly; only attempt JSON.parse when the string looks like JSON ({ or [), otherwise keep raw text.
function parseJsonCol(v, dflt = undefined) {
  if (v == null) return dflt;
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s && (s[0] === "{" || s[0] === "[")) {
    try { return JSON.parse(s); } catch { /* Keep raw value when JSON is invalid */ }
  }
  return v;
}

/** Build dashboard response object, aligned with Python to_dict(). */
function fmtDashboard(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    created_by: row.created_by,
    title: row.title,
    description: row.description,
    layout: parseJsonCol(row.layout, []),
    refresh_interval: row.refresh_interval ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Build dashboard_panel response object. */
function fmtDashboardPanel(row) {
  return {
    id: row.id,
    dashboard_id: row.dashboard_id,
    title: row.title,
    tags: parseJsonCol(row.tags, []),
    content_type: row.content_type,
    content: parseJsonCol(row.content),
    display_type: row.display_type,
    display_config: parseJsonCol(row.display_config),
    execute_type: row.execute_type,
    execute: row.execute,
    source_type: row.source_type,
    source_id: row.source_id,
    x: row.x ?? 0,
    y: row.y ?? 0,
    w: row.w ?? 6,
    h: row.h ?? 3,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Build panel catalog response object. */
function fmtPanel(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    created_by: row.created_by,
    title: row.title,
    tags: parseJsonCol(row.tags, []),
    content_type: row.content_type,
    content: parseJsonCol(row.content),
    display_type: row.display_type,
    display_config: parseJsonCol(row.display_config),
    execute_type: row.execute_type,
    execute: row.execute,
    source_type: row.source_type,
    source_id: row.source_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ─────────────────────────────────────────────
// Dashboard CRUD
// ─────────────────────────────────────────────

// POST /api/projects/:pid/dashboards — create dashboard
export async function createDashboard(ctx, input) {
  const { pid } = input.params;
  const { title, description } = input.body || {};
  if (!title) throw new ApiError('缺少必需参数: title', 400);

  const id = newId();
  const row = await ctx.queryOne(
    `INSERT INTO dashboards (id, project_id, created_by, title, description, refresh_interval, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 0, now(), now())
     RETURNING id, project_id, created_by, title, description, layout, refresh_interval, created_at, updated_at`,
    [id, pid, ctx.userId, title, description || null],
  );

  return { data: fmtDashboard(row), message: '创建Dashboard成功' };
}

// PUT /api/projects/:pid/dashboards/:did — update dashboard
export async function updateDashboard(ctx, input) {
  const { pid, did } = input.params;
  const { title, description, layout, refresh_interval } = input.body || {};

  const existing = await ctx.queryOne(
    `SELECT id FROM dashboards WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [did, pid],
  );
  if (!existing) throw new ApiError('Dashboard不存在', 404);

  // Build SET clause dynamically, updating only provided fields.
  const sets = [];
  const params = [];
  let idx = 1;

  if (title !== undefined)           { sets.push(`title=$${idx++}`);            params.push(title); }
  if (description !== undefined)     { sets.push(`description=$${idx++}`);      params.push(description); }
  if (layout !== undefined)          { sets.push(`layout=$${idx++}`);           params.push(JSON.stringify(layout)); }
  if (refresh_interval !== undefined){ sets.push(`refresh_interval=$${idx++}`); params.push(refresh_interval); }

  if (sets.length === 0) {
    // No fields to update, return current data directly.
    const cur = await ctx.queryOne(
      `SELECT id, project_id, created_by, title, description, layout, refresh_interval, created_at, updated_at
         FROM dashboards WHERE id=$1`,
      [did],
    );
    return { data: fmtDashboard(cur), message: '更新Dashboard成功' };
  }

  sets.push(`updated_at=now()`);
  params.push(did); // for WHERE

  const row = await ctx.queryOne(
    `UPDATE dashboards SET ${sets.join(', ')} WHERE id=$${idx}
     RETURNING id, project_id, created_by, title, description, layout, refresh_interval, created_at, updated_at`,
    params,
  );
  return { data: fmtDashboard(row), message: '更新Dashboard成功' };
}

// DELETE /api/projects/:pid/dashboards/:did — soft delete dashboard
export async function deleteDashboard(ctx, input) {
  const { pid, did } = input.params;
  const existing = await ctx.queryOne(
    `SELECT id FROM dashboards WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [did, pid],
  );
  if (!existing) throw new ApiError('Dashboard不存在', 404);

  await ctx.query(
    `UPDATE dashboards SET deleted_at=now() WHERE id=$1`,
    [did],
  );
  return { data: true, message: '删除Dashboard成功' };
}

// POST /api/projects/:pid/dashboards/:did/refresh — refresh dashboard (empty implementation; logic in Python LLM)
export async function refreshDashboard(ctx, input) {
  const { pid, did } = input.params;
  const dashboard = await ctx.queryOne(
    `SELECT id, project_id, created_by, title, description, layout, refresh_interval, created_at, updated_at
       FROM dashboards WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [did, pid],
  );
  if (!dashboard) throw new ApiError('Dashboard不存在', 404);

  // Return dashboard + refreshed_panels (empty)
  return { data: { dashboard: fmtDashboard(dashboard), refreshed_panels: [] }, message: '刷新Dashboard数据成功' };
}

// ─────────────────────────────────────────────
// Dashboard Panel CRUD
// ─────────────────────────────────────────────

// POST /api/projects/:pid/dashboards/:did/panels — create or copy panel
export async function createDashboardPanel(ctx, input) {
  const { pid, did } = input.params;
  const body = input.body || {};

  // Ensure dashboard exists
  const dashboard = await ctx.queryOne(
    `SELECT id FROM dashboards WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [did, pid],
  );
  if (!dashboard) throw new ApiError('Dashboard不存在', 404);

  // Copy mode: panel_id is provided.
  if (body.panel_id) {
    const src = await ctx.queryOne(
      `SELECT * FROM panels WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
      [body.panel_id, pid],
    );
    if (!src) throw new ApiError('Panel不存在', 404);

    // Get max y+h in current dashboard and append content to the bottom.
    const maxYRow = await ctx.queryOne(
      `SELECT COALESCE(MAX(y + h), 0) AS max_y FROM dashboard_panels WHERE dashboard_id=$1 AND deleted_at IS NULL`,
      [did],
    );
    const maxY = parseInt(maxYRow?.max_y ?? 0, 10);

    const dpId = newId();
    const row = await ctx.queryOne(
      `INSERT INTO dashboard_panels
         (id, dashboard_id, title, tags, content_type, content, display_type, display_config,
          execute_type, execute, source_type, source_id, x, y, w, h, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, 0,$13, 6, 3, now(), now())
       RETURNING id, dashboard_id, title, tags, content_type, content, display_type, display_config,
                 execute_type, execute, source_type, source_id, x, y, w, h, created_at, updated_at`,
      [
        dpId,
        did,
        src.title,
        // src comes from SELECT. In SQLite, tags/display_config are JSON text, pass through directly; stringify only when object to avoid double-escaping.
        src.tags == null ? null : (typeof src.tags === "string" ? src.tags : JSON.stringify(src.tags)),
        src.content_type,
        src.content,
        src.display_type,
        src.display_config == null ? null : (typeof src.display_config === "string" ? src.display_config : JSON.stringify(src.display_config)),
        src.execute_type,
        src.execute,
        src.source_type,
        src.source_id,
        maxY,
      ],
    );
    return { data: fmtDashboardPanel(row), message: '复制Panel成功' };
  }

  // Create mode
  const { title, content_type, content, display_type, display_config,
          execute_type, execute, source_type, source_id, tags,
          x = 0, y = 0, w = 6, h = 4 } = body;
  if (!title) throw new ApiError('缺少必需参数: title 或 panel_id', 400);

  const dpId2 = newId();
  const row = await ctx.queryOne(
    `INSERT INTO dashboard_panels
       (id, dashboard_id, title, tags, content_type, content, display_type, display_config,
        execute_type, execute, source_type, source_id, x, y, w, h, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now(), now())
     RETURNING id, dashboard_id, title, tags, content_type, content, display_type, display_config,
               execute_type, execute, source_type, source_id, x, y, w, h, created_at, updated_at`,
    [
      dpId2,
      did,
      title,
      tags ? JSON.stringify(tags) : null,
      content_type || 'text',
      content || '',
      display_type || 'text',
      display_config ? JSON.stringify(display_config) : null,
      execute_type || null,
      execute || null,
      source_type || null,
      source_id || null,
      x, y, w, h,
    ],
  );
  return { data: fmtDashboardPanel(row), message: '创建Panel成功' };
}

// PUT /api/projects/:pid/panels/:panelId — update dashboard_panel
// Note: deletePanel uses /dashboards/panels/:panelId, while updatePanel uses /panels/:panelId
// This PUT updates dashboard_panels table (see dashboard.py update_panel).
export async function updatePanel(ctx, input) {
  const { pid, panelId } = input.params;
  const body = input.body || {};

  // Find row in dashboard_panels first, including join to dashboard for current project.
  let row = await ctx.queryOne(
    `SELECT dp.* FROM dashboard_panels dp
       JOIN dashboards d ON d.id = dp.dashboard_id
      WHERE dp.id=$1 AND d.project_id=$2 AND dp.deleted_at IS NULL`,
    [panelId, pid],
  );

  if (row) {
    // Update dashboard_panels
    const sets = [];
    const params = [];
    let idx = 1;

    const fields = ['title','content_type','content','display_type','display_config',
                    'execute_type','execute','source_type','source_id','tags','x','y','w','h'];
    for (const f of fields) {
      if (body[f] !== undefined) {
        if (['display_config','tags'].includes(f) && body[f] !== null && typeof body[f] === 'object') {
          sets.push(`${f}=$${idx++}`);
          params.push(JSON.stringify(body[f]));
        } else {
          sets.push(`${f}=$${idx++}`);
          params.push(body[f]);
        }
      }
    }

    if (sets.length === 0) {
      return { data: fmtDashboardPanel(row), message: '更新Panel成功' };
    }

    sets.push(`updated_at=now()`);
    params.push(panelId);

    const updated = await ctx.queryOne(
      `UPDATE dashboard_panels SET ${sets.join(', ')} WHERE id=$${idx}
       RETURNING id, dashboard_id, title, tags, content_type, content, display_type, display_config,
                 execute_type, execute, source_type, source_id, x, y, w, h, created_at, updated_at`,
      params,
    );
    return { data: fmtDashboardPanel(updated), message: '更新Panel成功' };
  }

  // If not found in dashboard_panels, try panels catalog.
  const panelRow = await ctx.queryOne(
    `SELECT * FROM panels WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [panelId, pid],
  );
  if (!panelRow) throw new ApiError('Panel不存在', 404);

  const sets = [];
  const params = [];
  let idx = 1;

  const libFields = ['title','content_type','content','display_type','display_config',
                     'execute_type','execute','source_type','source_id','tags'];
  for (const f of libFields) {
    if (body[f] !== undefined) {
      if (['display_config','tags'].includes(f) && body[f] !== null && typeof body[f] === 'object') {
        sets.push(`${f}=$${idx++}`);
        params.push(JSON.stringify(body[f]));
      } else {
        sets.push(`${f}=$${idx++}`);
        params.push(body[f]);
      }
    }
  }

  if (sets.length === 0) {
    return { data: fmtPanel(panelRow), message: '更新Panel成功' };
  }

  sets.push(`updated_at=now()`);
  params.push(panelId);

  const updatedPanel = await ctx.queryOne(
    `UPDATE panels SET ${sets.join(', ')} WHERE id=$${idx}
     RETURNING id, project_id, created_by, title, tags, content_type, content, display_type, display_config,
               execute_type, execute, source_type, source_id, created_at, updated_at`,
    params,
  );
  return { data: fmtPanel(updatedPanel), message: '更新Panel成功' };
}

// DELETE /api/projects/:pid/dashboards/panels/:panelId — soft delete dashboard_panel
// Route order matters: /dashboards/panels/:panelId is more specific than /dashboards/:did.
// Express matches by registration order; register either before /dashboards/:did or avoid ambiguity (here "panels" is literal).
export async function deleteDashboardPanel(ctx, input) {
  const { pid, panelId } = input.params;

  const row = await ctx.queryOne(
    `SELECT dp.id FROM dashboard_panels dp
       JOIN dashboards d ON d.id = dp.dashboard_id
      WHERE dp.id=$1 AND d.project_id=$2 AND dp.deleted_at IS NULL`,
    [panelId, pid],
  );
  if (!row) throw new ApiError('Panel不存在', 404);

  await ctx.query(
    `UPDATE dashboard_panels SET deleted_at=now() WHERE id=$1`,
    [panelId],
  );
  return { data: true, message: '删除Panel成功' };
}

// PUT /api/projects/:pid/dashboards/:did/panels/layout — bulk layout update
// Must register this route before /dashboards/:did/panels/:panelId so "layout" is not treated as panelId.
export async function updatePanelsLayout(ctx, input) {
  const { pid, did } = input.params;
  const { layouts } = input.body || {};

  if (!layouts || !Array.isArray(layouts) || layouts.length === 0) {
    throw new ApiError('缺少布局数据', 400);
  }

  const dashboard = await ctx.queryOne(
    `SELECT id FROM dashboards WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [did, pid],
  );
  if (!dashboard) throw new ApiError('Dashboard不存在', 404);

  let updatedCount = 0;
  for (const item of layouts) {
    const { panel_id, x = 0, y = 0, w = 6, h = 3 } = item;
    if (!panel_id) continue;
    // Add RETURNING id so db.js uses stmt.all() and returns actual matched rows, counting only panels that changed.
    const result = await ctx.query(
      `UPDATE dashboard_panels SET x=$1, y=$2, w=$3, h=$4, updated_at=now()
        WHERE id=$5 AND dashboard_id=$6 AND deleted_at IS NULL RETURNING id`,
      [x, y, w, h, panel_id, did],
    );
    if (result && result.length) updatedCount++;
  }

  return { data: { updated_count: updatedCount }, message: '批量更新布局成功' };
}

// POST /api/projects/:pid/dashboards/:did/panels/:panelId/refresh — refresh single panel (empty implementation)
export async function refreshDashboardPanel(ctx, input) {
  const { pid, did, panelId } = input.params;

  const row = await ctx.queryOne(
    `SELECT dp.id, dp.dashboard_id, dp.title, dp.tags, dp.content_type, dp.content,
            dp.display_type, dp.display_config, dp.execute_type, dp.execute,
            dp.source_type, dp.source_id, dp.x, dp.y, dp.w, dp.h, dp.created_at, dp.updated_at
       FROM dashboard_panels dp
       JOIN dashboards d ON d.id = dp.dashboard_id
      WHERE dp.id=$1 AND dp.dashboard_id=$2 AND d.project_id=$3 AND dp.deleted_at IS NULL`,
    [panelId, did, pid],
  );
  if (!row) throw new ApiError('Panel不存在', 404);

  return { data: fmtDashboardPanel(row), message: '刷新Panel数据成功' };
}

// ─────────────────────────────────────────────
// Panel catalog CRUD
// ─────────────────────────────────────────────

// POST /api/projects/:pid/panels — create panel catalog entry
export async function createPanel(ctx, input) {
  const { pid } = input.params;
  const { title, content_type, content, display_type, display_config,
          execute_type, execute, source_type, source_id, tags } = input.body || {};

  if (!title) throw new ApiError('缺少必需参数: title', 400);

  const pId = newId();
  const row = await ctx.queryOne(
    `INSERT INTO panels
       (id, project_id, created_by, title, tags, content_type, content, display_type, display_config,
        execute_type, execute, source_type, source_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now())
     RETURNING id, project_id, created_by, title, tags, content_type, content, display_type, display_config,
               execute_type, execute, source_type, source_id, created_at, updated_at`,
    [
      pId,
      pid,
      ctx.userId,
      title,
      tags ? JSON.stringify(tags) : null,
      content_type || 'text',
      content || '',
      display_type || 'text',
      display_config ? JSON.stringify(display_config) : null,
      execute_type || null,
      execute || null,
      source_type || null,
      source_id || null,
    ],
  );
  return { data: fmtPanel(row), message: '创建Panel成功' };
}

// DELETE /api/projects/:pid/panels/:panelId — soft delete panel catalog entry
export async function deletePanel(ctx, input) {
  const { pid, panelId } = input.params;

  const row = await ctx.queryOne(
    `SELECT id FROM panels WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [panelId, pid],
  );
  if (!row) throw new ApiError('Panel不存在', 404);

  await ctx.query(
    `UPDATE panels SET deleted_at=now() WHERE id=$1`,
    [panelId],
  );
  return { data: true, message: '删除Panel成功' };
}

// POST /api/projects/:pid/panels/generate — generate recommended panel (empty implementation, LLM logic in Python)
// Note: /panels/generate must be registered before /panels/:panelId, otherwise "generate" can be treated as panelId.
// Here there is no conflict because /panels/:panelId only handles GET/PUT/DELETE.
export async function generatePanel(ctx, input) {
  // No LLM dependency; return empty result for frontend handling.
  return { data: { panel: null, attempts: 0 }, message: '生成推荐Panel成功' };
}

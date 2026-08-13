// L1 app/usecase layer: business CRUD + data-source binding, aligned line-by-line with routes/business_crud.js.
// Signature stays async fn(ctx, input) -> { data, message } or throws ApiError; does not touch req/res.
//
// Covered endpoints:
//   Business CRUD   POST/PUT/DELETE /api/projects/:pid/businesses[/:bid]
//   Data Sources    POST/DELETE     /api/projects/:pid/businesses/:bid/data-sources
//
// Note: app/business/ is one level deeper than routes/; use ../../ for engine/db imports.
import { ApiError } from "../../errors.js";

// ─────────────────────────────────────────────
// Helpers (moved from route closures to module scope)
// ─────────────────────────────────────────────

/**
 * Scope is now project level. bid is project scope (projectId from front-end); businesses row existence is no longer required.
 * Legacy callers still passing real business IDs in eval are still accepted; data is consistently read/written by scope column (business_id=that value).
 */
export async function assertBusiness(pid, bid) {
  const scopeId = bid || pid;
  return scopeId ? { id: scopeId } : null;
}

// ════════════════════════════════════════════
// Business CRUD
// ════════════════════════════════════════════

// POST /api/projects/:pid/businesses — create project-scoped business
export async function createBusiness(ctx, input) {
  const { pid } = input.params;
  const { name, description } = input.body || {};
  if (!name || !name.trim()) throw new ApiError("业务名称不能为空", 400);
  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO businesses (id, project_id, name, description, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,now(),now())`,
    [id, pid, name.trim(), description || null, ctx.userId],
  );
  const b = await ctx.queryOne(`SELECT * FROM businesses WHERE id=$1`, [id]);
  return { data: b, message: "创建业务成功" };
}

// PUT /api/projects/:pid/businesses/:bid — update business
export async function updateBusiness(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const { name, description } = input.body || {};
  const updates = [];
  const vals = [];
  if (name !== undefined) { updates.push(`name=$${vals.length + 1}`); vals.push(name); }
  if (description !== undefined) { updates.push(`description=$${vals.length + 1}`); vals.push(description); }
  if (!updates.length) throw new ApiError("没有可更新的字段", 400);
  updates.push("updated_at=now()");
  vals.push(bid);
  await ctx.query(`UPDATE businesses SET ${updates.join(",")} WHERE id=$${vals.length}`, vals);
  const updated = await ctx.queryOne(`SELECT * FROM businesses WHERE id=$1`, [bid]);
  return { data: updated, message: "更新业务成功" };
}

// DELETE /api/projects/:pid/businesses/:bid — soft delete business
export async function deleteBusiness(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  await ctx.query(
    `UPDATE businesses SET deleted_at=now(), updated_at=now() WHERE id=$1`,
    [bid],
  );
  return { data: null, message: "删除业务成功" };
}

// ════════════════════════════════════════════
// Data source binding
// ════════════════════════════════════════════

// POST /api/projects/:pid/data-sources — bind data source (project scope, no bid needed)
export async function bindDataSource(ctx, input) {
  const { pid } = input.params;
  const { source_type, source_id } = input.body || {};
  if (!source_type || !source_id) throw new ApiError("source_type 和 source_id 不能为空", 400);

  // Skip if already bound (deduplicate by project_id in project scope)
  const existing = await ctx.queryOne(
    `SELECT id FROM business_data_sources
      WHERE project_id=$1 AND source_type=$2 AND source_id=$3 AND deleted_at IS NULL`,
    [pid, source_type, source_id],
  );
  if (existing) return { data: null, message: "数据源已绑定" };

  const id = crypto.randomUUID();
  // In decoupled architecture, business_data_sources no longer writes business_id (scope is always project_id).
  await ctx.query(
    `INSERT INTO business_data_sources (id, project_id, source_type, source_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,now(),now())`,
    [id, pid, source_type, source_id],
  );
  return { data: null, message: "添加数据源成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/data-sources — unbind data source
export async function unbindDataSource(ctx, input) {
  const { pid } = input.params;
  const { source_type, source_id } = input.body || {};
  if (!source_type || !source_id) throw new ApiError("source_type 和 source_id 不能为空", 400);
  await ctx.query(
    `UPDATE business_data_sources SET deleted_at=now(), updated_at=now()
      WHERE project_id=$1 AND source_type=$2 AND source_id=$3 AND deleted_at IS NULL`,
    [pid, source_type, source_id],
  );
  return { data: null, message: "移除数据源成功" };
}

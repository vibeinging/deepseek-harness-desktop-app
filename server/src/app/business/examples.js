// L1 use-case layer for Examples CRUD + vectors, aligned line-by-line with routes/business_crud.js.
// Signature is always async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
//
// Coverage:
//   POST search                — semantic retrieval of similar examples (implemented)
//   POST generate_embeddings   — batch generate example vectors (implemented)
//   POST/PUT/DELETE /examples[/:eid]  (supports batch DELETE)
//
// Note: app/business/ is one layer deeper than routes/, so engine/db uses ../../.
import { ApiError } from "../../errors.js";
import { embedExamples, searchExamples } from "../../engine/semantic/example_embedding.js";
import { assertBusiness } from "./business.js";

// ════════════════════════════════════════════
// Examples CRUD
// ════════════════════════════════════════════

// POST /api/projects/:pid/businesses/:bid/examples/search — semantic retrieval of similar examples (migration backfill)
export async function searchExamplesUseCase(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const queryText = input.body?.query || input.query?.query || input.body?.question || input.body?.user_message || "";
  const topK = Math.min(100, Math.max(1, Number(input.body?.top_k || input.query?.limit || 5)));
  const exampleType = input.body?.example_type || input.query?.example_type || null;
  const items = await searchExamples(pid, queryText, { topK, exampleType });
  return { data: { items, total: items.length }, message: "召回样例成功" };
}

// POST /api/projects/:pid/businesses/:bid/examples/generate_embeddings — batch generate example vectors (migration backfill)
export async function generateExampleEmbeddings(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const onlyEmpty = input.body?.only_pending !== false;
  const exampleId = input.query?.example_id || input.body?.example_id || null;
  const exampleType = input.query?.example_type || input.body?.example_type || null;
  if (exampleId) {
    const exists = await ctx.queryOne(
      `SELECT id FROM examples WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
      [exampleId, pid],
    );
    if (!exists) throw new ApiError("样例不存在", 404);
  }
  const r = await embedExamples(pid, { onlyEmpty, exampleId, exampleType });
  if (r.skipped || ((r.total || 0) > 0 && (r.embedded || 0) === 0)) {
    throw new ApiError(r.skipped || "样例向量未生成", 503);
  }
  return { data: r, message: "样例向量生成完成" };
}

// POST /api/projects/:pid/businesses/:bid/examples — batch create examples
export async function createExamples(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const { example_type = "sql", examples, source_id, source_type } = input.body || {};
  if (!Array.isArray(examples) || !examples.length) throw new ApiError("examples 不能为空", 400);

  let created = 0;
  for (const ex of examples) {
    const { question, content, description } = ex;
    if (!question || !content) continue;
    const id = crypto.randomUUID();
    await ctx.query(
      `INSERT INTO examples
         (id, project_id, example_type, question, content, description,
          source_id, source_type, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,now(),now())`,
      [id, pid, example_type, question, content, description || null, source_id || null, source_type || null],
    );
    created++;
  }
  // Generate vectors for new examples in background, non-blocking.
  // Retrieval falls back to keyword match when example embeddings are absent.
  // Return immediately and keep async behavior via queueMicrotask.
  queueMicrotask(() => {
    embedExamples(pid).catch((e) =>
    console.warn(`[examples] Failed to generate vectors for project ${pid}: ${e?.message ?? e}`));
  });
  return { data: { created }, message: `成功创建 ${created} 条样例` };
}

// PUT /api/projects/:pid/businesses/:bid/examples/:eid — update example
export async function updateExample(ctx, input) {
  const { pid, eid } = input.params;
  const existing = await ctx.queryOne(
    `SELECT id FROM examples WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [eid, pid],
  );
  if (!existing) throw new ApiError("样例不存在", 404);

  const { question, content, description, is_active } = input.body || {};
  const sets = ["updated_at=now()"];
  const vals = [];
  const add = (col, val) => { sets.push(`${col}=$${vals.length + 1}`); vals.push(val); };
  if (question !== undefined) add("question", question);
  if (content !== undefined) add("content", content);
  if (description !== undefined) add("description", description);
  if (is_active !== undefined) add("is_active", !!is_active);
  vals.push(eid);
  await ctx.query(`UPDATE examples SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
  const row = await ctx.queryOne(`SELECT * FROM examples WHERE id=$1`, [eid]);
  return { data: row, message: "更新成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/examples — batch delete examples
export async function deleteExamples(ctx, input) {
  const { pid } = input.params;
  const { example_ids } = input.body || {};
  if (!Array.isArray(example_ids) || !example_ids.length)
    throw new ApiError("example_ids 不能为空", 400);
  const existing = await ctx.query(
    `SELECT id FROM examples WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
    [pid, example_ids],
  );
  const deleted_count = existing.length;
  if (deleted_count) {
    await ctx.query(
      `UPDATE examples SET deleted_at=now(), updated_at=now()
        WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
      [pid, example_ids],
    );
  }
  return { data: { deleted_count }, message: `成功删除 ${deleted_count} 条样例` };
}

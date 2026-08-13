import { ApiError } from "../../errors.js";
import { BusinessDataSources } from "../../engine/datasources/business_data_sources.js";
import { validateQueryResultEvidence } from "../../engine/agents/query_result_validation.js";
import { createAgentRuntime } from "../../engine/agents/agent_run_runtime.js";
import { duckWriteRecords } from "../../engine/datasources/duck.js";
import { randomUUID } from "node:crypto";
import { requireProjectOwner } from "../projects/access.js";

function assertEvalMode() {
  if (!process.env.DSH_EVAL_MODE && process.env.NODE_ENV !== "test") {
    throw new ApiError("查询证据诊断只在 Eval 环境可用", 404);
  }
}

function quoteIdentifier(value) {
  return `"${String(value || "").replace(/"/g, '""')}"`;
}

export async function diagnoseQueryExecutionEvidence(ctx, input) {
  assertEvalMode();
  const projectId = String(input.body?.project_id || input.body?.projectId || "").trim();
  const tableId = String(input.body?.table_id || input.body?.tableId || "").trim();
  if (!(projectId && tableId)) throw new ApiError("缺少 project_id 或 table_id", 400);
  await requireProjectOwner(ctx, projectId);
  const target = await ctx.queryOne(
    `SELECT t.id AS table_id, t.schema_name, t.table_name, c.id AS connection_id,
            b.id AS binding_id, b.source_type, b.source_id
       FROM table_metadata t
       JOIN database_connections c ON c.id=t.database_connection_id AND c.deleted_at IS NULL
       LEFT JOIN structured_data_sources s
         ON s.database_connection_id=c.id AND s.deleted_at IS NULL
       JOIN business_data_sources b
         ON b.project_id=$1 AND b.deleted_at IS NULL
        AND (
          (b.source_type='database_connection' AND b.source_id=c.id) OR
          (b.source_type='structured_data_source' AND b.source_id=s.id)
        )
      WHERE t.id=$2 AND t.deleted_at IS NULL
      LIMIT 1`,
    [projectId, tableId],
  );
  if (!target) throw new ApiError("项目中不存在该表", 404);
  const columns = await ctx.query(
    `SELECT id, column_name FROM column_metadata
      WHERE table_id=$1 AND deleted_at IS NULL ORDER BY id LIMIT 3`,
    [tableId],
  );
  if (!columns.length) throw new ApiError("目标表没有可查询字段", 400);

  const bds = new BusinessDataSources(projectId, projectId);
  await bds.load_sources();
  const datasource = bds.get_data_source(target.binding_id) || bds.get_data_source(target.connection_id);
  if (!datasource?.datasource_name) throw new ApiError("无法加载目标数据源", 500);
  const tableSql = target.schema_name && target.schema_name !== "main"
    ? `${quoteIdentifier(target.schema_name)}.${quoteIdentifier(target.table_name)}`
    : quoteIdentifier(target.table_name);
  const requestedLimit = Number(input.body?.query_limit || input.body?.queryLimit || 2);
  const queryLimit = Number.isFinite(requestedLimit) ? Math.min(1_000, Math.max(1, Math.floor(requestedLimit))) : 2;
  const sql = `SELECT ${columns.map((column) => quoteIdentifier(column.column_name)).join(", ")} FROM ${tableSql} LIMIT ${queryLimit}`;
  const result = await bds.query(datasource.datasource_name, sql, { project_id: projectId, parameters: [] });
  if (!result.success) throw new ApiError(`真实查询失败：${result.message}`, 500);
  const requirements = input.body?.validation && typeof input.body.validation === "object"
    ? input.body.validation
    : null;
  let validation = requirements
    ? validateQueryResultEvidence({
        evidence: result.evidence,
        rows: result.data,
        rowsComplete: true,
        requirements,
      })
    : null;
  let diagnosticBundle = null;
  if (input.body?.create_bundle === true) {
    const sessionId = String(input.body?.session_id || input.body?.sessionId || "").trim();
    if (!sessionId) throw new ApiError("创建证据包需要 session_id", 400);
    const session = await ctx.queryOne(
      `SELECT id FROM sessions
        WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL LIMIT 1`,
      [sessionId, projectId, ctx.userId || ""],
    );
    if (!session) throw new ApiError("诊断会话不存在", 404);
    const runId = `evidence-diagnostic-${randomUUID()}`;
    const queryCallId = `query-${randomUUID()}`;
    const validationCallId = `validation-${randomUUID()}`;
    const finalItemId = `answer-${randomUUID()}`;
    const runtime = createAgentRuntime({
      ctx,
      stream: null,
      runId,
      sessionId,
      projectId,
      userId: ctx.userId || "",
      skill: "query-project-data",
      mode: "diagnostic_evidence_bundle",
    });
    const created = await runtime.createRun();
    if (!created) throw new ApiError("无法创建证据包诊断运行", 500);
    await runtime.captureEnvironment({
      approvalPolicy: "read_only_diagnostic",
      sandboxPolicy: {
        mode: "query-engine",
        system_enforced: false,
        network: "configured-data-sources-only",
        write_scope: "run-intermediate-only",
      },
    });
    await runtime.beginToolCall({
      callId: queryCallId,
      toolName: "execute_readonly_sql",
      accessMode: "read",
      input: { question: "读取证据诊断样例", sql },
    });
    await runtime.finishToolCall({
      callId: queryCallId,
      toolName: "execute_readonly_sql",
      ok: true,
      result: { row_count: result.data.length, evidence_id: result.evidence?.evidence_id },
    });
    const storedEvidence = { ...result.evidence, tool_call_id: queryCallId };
    let storedValidation = validation;
    if (validation) {
      await runtime.beginToolCall({
        callId: validationCallId,
        toolName: "validate_query_result",
        accessMode: "read",
        input: requirements,
      });
      storedValidation = { ...validation, tool_call_id: validationCallId };
      validation = storedValidation;
      await runtime.finishToolCall({
        callId: validationCallId,
        toolName: "validate_query_result",
        ok: validation.status === "passed",
        result: validation,
        error: validation.status === "passed" ? null : Object.assign(new Error("结果校验失败"), { code: "QUERY_VALIDATION_FAILED" }),
      });
    }
    const answerText = `真实查询返回 ${result.data.length} 行，结果${validation?.status === "passed" ? "已通过校验" : "已有执行证据"}。`;
    const bundle = await runtime.recordEvidenceBundle({
      finalItemId,
      answerText,
      evidence: [storedEvidence],
      validations: storedValidation ? [storedValidation] : [],
      toolCallIds: [queryCallId, ...(storedValidation ? [validationCallId] : [])],
      metadata: { diagnostic: true },
    });
    await runtime.completeRun("completed");
    if (input.body?.attach_to_session === true && bundle) {
      const seqRow = await ctx.queryOne(
        `SELECT COALESCE(MAX(sequence_number),0) AS max_seq FROM session_messages WHERE session_id=$1`,
        [sessionId],
      );
      const sequence = Number(seqRow?.max_seq || 0);
      await ctx.query(
        `INSERT INTO session_messages (
           id, session_id, role, content_items, sequence_number, created_at, updated_at
         ) VALUES ($1,$2,'user',$3,$4,now(),now())`,
        [
          randomUUID(),
          sessionId,
          JSON.stringify([{ id: `question-${runId}`, type: "text", content: "这份数据的查询结果是什么？" }]),
          sequence + 1,
        ],
      );
      await ctx.query(
        `INSERT INTO session_messages (
           id, session_id, role, content_items, message_metadata, sequence_number, created_at, updated_at
         ) VALUES ($1,$2,'assistant',$3,$4,$5,now(),now())`,
        [
          `assistant-${runId}`,
          sessionId,
          JSON.stringify([{
            id: finalItemId,
            type: "markdown",
            content: answerText,
            title: "回答",
            metadata: {
              item_type: "agentMessage",
              answer_status: bundle.status === "verified" ? "accepted" : "rejected",
              answer_item_id: finalItemId,
              answer_source: bundle.status === "verified" ? "diagnostic_evidence_bundle" : null,
              answer_rejection_code: bundle.status === "verified" ? null : "EVIDENCE_BUNDLE_UNVERIFIED",
              evidence_bundle_ref: {
                id: bundle.id,
                final_item_id: bundle.final_item_id,
                status: bundle.status,
                snapshot_hash: bundle.snapshot_hash,
              },
            },
          }]),
          JSON.stringify({
            thread_id: sessionId,
            turn_id: runId,
            turn_status: bundle.status === "verified" ? "completed" : "failed",
            answer_status: bundle.status === "verified" ? "accepted" : "rejected",
            answer_item_id: finalItemId,
          }),
          sequence + 2,
        ],
      );
      await ctx.query(
        `UPDATE sessions SET updated_at=now(), message_count=COALESCE(message_count,0)+2 WHERE id=$1`,
        [sessionId],
      );
    }
    diagnosticBundle = { run_id: runId, final_item_id: finalItemId, bundle };
  }
  return {
    data: {
      rows: result.data,
      evidence: result.evidence,
      validation,
      diagnostic_bundle: diagnosticBundle,
      target: {
        table_id: target.table_id,
        column_ids: columns.map((column) => column.id),
        binding_id: target.binding_id,
        source_type: target.source_type,
        source_id: target.source_id,
      },
    },
    message: "查询执行证据诊断通过",
  };
}

export async function replaceQueryEvidenceDiagnosticRows(ctx, input) {
  assertEvalMode();
  const projectId = String(input.body?.project_id || input.body?.projectId || "").trim();
  const tableId = String(input.body?.table_id || input.body?.tableId || "").trim();
  const rows = input.body?.rows;
  if (!(projectId && tableId)) throw new ApiError("缺少 project_id 或 table_id", 400);
  await requireProjectOwner(ctx, projectId);
  if (!Array.isArray(rows) || rows.length > 1_000 || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new ApiError("rows 必须是最多 1000 行的对象数组", 400);
  }
  const target = await ctx.queryOne(
    `SELECT t.id AS table_id, t.table_name, c.id AS connection_id, c.database, c.host, c.db_type
       FROM table_metadata t
       JOIN database_connections c ON c.id=t.database_connection_id AND c.deleted_at IS NULL
      WHERE t.id=$1 AND c.project_id=$2 AND t.deleted_at IS NULL
      LIMIT 1`,
    [tableId, projectId],
  );
  if (!target) throw new ApiError("项目中不存在该表", 404);
  if (String(target.db_type || "").toLowerCase() !== "duckdb") {
    throw new ApiError("Eval 数据替换只支持 DuckDB", 400);
  }
  const columns = await ctx.query(
    `SELECT column_name FROM column_metadata
      WHERE table_id=$1 AND deleted_at IS NULL ORDER BY id`,
    [tableId],
  );
  const columnNames = columns.map((column) => String(column.column_name));
  const allowed = new Set(columnNames);
  const unknown = rows.flatMap((row) => Object.keys(row).filter((key) => !allowed.has(key)));
  if (unknown.length) throw new ApiError(`rows 包含未知字段：${[...new Set(unknown)].join("、")}`, 400);
  const normalizedRows = rows.map((row) => Object.fromEntries(columnNames.map((column) => [column, row[column] ?? null])));
  const result = await duckWriteRecords(
    target.database || target.host,
    target.table_name,
    normalizedRows,
    columnNames,
  );
  return {
    data: { table_id: tableId, table_name: target.table_name, ...result },
    message: "Eval 数据已替换",
  };
}

export default { diagnoseQueryExecutionEvidence, replaceQueryEvidenceDiagnosticRows };

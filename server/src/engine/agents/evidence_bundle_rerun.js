import { randomUUID } from "node:crypto";

import { BusinessDataSources } from "../datasources/business_data_sources.js";
import { buildQueryExecutionEvidence } from "../datasources/query_execution_evidence.js";
import { ModelConfigResolver } from "../core/llm.js";
import { validateQueryResultEvidence } from "./query_result_validation.js";
import { environmentSnapshotRef, readRunEnvironmentSnapshot } from "./run_environment_snapshot.js";
import { createAgentRuntime } from "./agent_run_runtime.js";

export const EVIDENCE_RERUN_VERSION = "agent_evidence_rerun.v1";

function text(value) {
  return String(value || "").trim();
}

function sameJson(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function numericDelta(before = {}, after = {}) {
  const result = {};
  for (const column of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    const oldValue = before?.[column] || null;
    const newValue = after?.[column] || null;
    result[column] = {
      before: oldValue,
      after: newValue,
      sum_delta: oldValue && newValue ? Number(newValue.sum || 0) - Number(oldValue.sum || 0) : null,
      changed: !sameJson(oldValue, newValue),
    };
  }
  return result;
}

export function compareEvidenceSnapshots({
  baselineEvidence = [],
  currentEvidence = [],
  baselineValidations = [],
  currentValidations = [],
  baselineEnvironment = null,
  currentEnvironment = null,
} = {}) {
  const queries = baselineEvidence.map((before, index) => {
    const after = currentEvidence[index] || null;
    const sourceChanged = !sameJson(
      [before?.source?.binding_id, before?.source?.source_id, before?.source?.connection_id],
      [after?.source?.binding_id, after?.source?.source_id, after?.source?.connection_id],
    );
    const statementChanged = !sameJson(
      [before?.statement?.text, before?.statement?.parameters],
      [after?.statement?.text, after?.statement?.parameters],
    );
    const schemaChanged = before?.schema?.version !== after?.schema?.version;
    const dataChanged = before?.result?.data_hash !== after?.result?.data_hash;
    const columnsChanged = !sameJson(before?.result?.columns || [], after?.result?.columns || []);
    const beforeRows = Number(before?.result?.row_count || 0);
    const afterRows = Number(after?.result?.row_count || 0);
    return {
      baseline_evidence_id: before?.evidence_id || null,
      current_evidence_id: after?.evidence_id || null,
      source_changed: sourceChanged,
      statement_changed: statementChanged,
      schema_changed: schemaChanged,
      data_changed: dataChanged,
      columns_changed: columnsChanged,
      status: { before: before?.result?.status || null, after: after?.result?.status || null },
      row_count: { before: beforeRows, after: afterRows, delta: afterRows - beforeRows },
      data_hash: { before: before?.result?.data_hash || null, after: after?.result?.data_hash || null },
      numeric_summary: numericDelta(before?.result?.numeric_summary, after?.result?.numeric_summary),
    };
  });
  for (let index = baselineEvidence.length; index < currentEvidence.length; index += 1) {
    queries.push({
      baseline_evidence_id: null,
      current_evidence_id: currentEvidence[index]?.evidence_id || null,
      source_changed: true,
      statement_changed: true,
      schema_changed: true,
      data_changed: true,
      columns_changed: true,
      status: { before: null, after: currentEvidence[index]?.result?.status || null },
      row_count: { before: 0, after: Number(currentEvidence[index]?.result?.row_count || 0), delta: Number(currentEvidence[index]?.result?.row_count || 0) },
      data_hash: { before: null, after: currentEvidence[index]?.result?.data_hash || null },
      numeric_summary: numericDelta({}, currentEvidence[index]?.result?.numeric_summary),
    });
  }
  const validations = baselineValidations.map((before, index) => {
    const after = currentValidations[index] || null;
    const beforeFailed = (before?.checks || []).filter((check) => !check?.passed).map((check) => check.name);
    const afterFailed = (after?.checks || []).filter((check) => !check?.passed).map((check) => check.name);
    return {
      baseline_validation_id: before?.validation_id || null,
      current_validation_id: after?.validation_id || null,
      status: { before: before?.status || null, after: after?.status || null },
      failed_checks: { before: beforeFailed, after: afterFailed },
      changed: before?.status !== after?.status || !sameJson(beforeFailed, afterFailed),
    };
  });
  const changedQueries = queries.filter((query) =>
    query.source_changed || query.statement_changed || query.schema_changed || query.data_changed || query.columns_changed || query.status.before !== query.status.after,
  );
  const changedValidations = validations.filter((validation) => validation.changed);
  const baselineEnvironmentHash = text(baselineEnvironment?.snapshot_hash);
  const currentEnvironmentHash = text(currentEnvironment?.snapshot_hash);
  const environmentComparable = Boolean(baselineEnvironmentHash && currentEnvironmentHash);
  const environmentChanged = environmentComparable
    ? baselineEnvironmentHash !== currentEnvironmentHash
    : null;
  const evidenceIdentical = changedQueries.length === 0 && changedValidations.length === 0;
  return {
    version: EVIDENCE_RERUN_VERSION,
    mode: "same_query_snapshot",
    summary: {
      identical: evidenceIdentical && environmentChanged !== true,
      fully_reproducible: evidenceIdentical && environmentChanged === false,
      query_count: queries.length,
      changed_query_count: changedQueries.length,
      validation_count: validations.length,
      changed_validation_count: changedValidations.length,
      schema_changed: queries.some((query) => query.schema_changed),
      data_changed: queries.some((query) => query.data_changed),
      environment_changed: environmentChanged,
    },
    environment: {
      comparable: environmentComparable,
      changed: environmentChanged,
      baseline: baselineEnvironment || null,
      current: currentEnvironment || null,
    },
    queries,
    validations,
  };
}

function validationRequirements(bundle, validation) {
  const callId = text(validation?.tool_call_id);
  return (bundle?.tool_calls || []).find((tool) => text(tool.call_id) === callId)?.input || {};
}

export async function rerunEvidenceBundle(ctx, {
  bundle,
  userId = null,
} = {}) {
  if (!(bundle?.id && bundle?.run_id && bundle?.session_id && bundle?.project_id)) {
    const error = new Error("证据包缺少复跑所需的运行、会话或项目信息");
    error.code = "EVIDENCE_RERUN_INVALID_BUNDLE";
    throw error;
  }
  const runId = `evidence-rerun-${randomUUID()}`;
  const finalItemId = `rerun-answer-${randomUUID()}`;
  const runtime = createAgentRuntime({
    ctx,
    stream: null,
    runId,
    sessionId: bundle.session_id,
    projectId: bundle.project_id,
    userId,
    skill: "query-project-data",
    mode: "evidence_rerun",
  });
  const created = await runtime.createRun();
  if (!created) throw new Error("无法创建证据复跑运行");

  try {
    const baselineEnvironmentSnapshot = await readRunEnvironmentSnapshot(bundle.run_id).catch(() => null);
    const baselineEnvironment = environmentSnapshotRef(baselineEnvironmentSnapshot)
      || bundle.metadata?.environment_snapshot_ref
      || null;
    const baselineSelectedModel = baselineEnvironmentSnapshot?.environment?.models?.selected || null;
    const selectedModel = baselineSelectedModel
      ? await ModelConfigResolver.resolve({
          project_id: bundle.project_id,
          category: baselineSelectedModel.category || "PRIMARY",
        }).catch(() => null)
      : null;
    const currentEnvironmentSnapshot = await runtime.captureEnvironment({
      selectedModel,
      approvalPolicy: baselineEnvironmentSnapshot?.permissions?.approval_policy || "read_only_evidence_rerun",
      sandboxPolicy: baselineEnvironmentSnapshot?.permissions?.sandbox || {
        mode: "query-engine",
        system_enforced: false,
        network: "configured-data-sources-only",
        write_scope: "run-intermediate-only",
      },
    });
    const currentEnvironment = environmentSnapshotRef(currentEnvironmentSnapshot);
    const bds = new BusinessDataSources(bundle.project_id, bundle.project_id);
    await bds.load_sources();
    const currentEvidence = [];
    const rowsByBaselineEvidenceId = new Map();
    const evidenceByBaselineEvidenceId = new Map();

  for (const [index, baseline] of (bundle.evidence || []).entries()) {
    const callId = `rerun-query-${index + 1}-${randomUUID()}`;
    const statement = text(baseline?.statement?.text);
    const parameters = Array.isArray(baseline?.statement?.parameters) ? baseline.statement.parameters : [];
    const source = bds.get_data_source(baseline?.source?.binding_id)
      || bds.get_data_source(baseline?.source?.source_id)
      || bds.get_data_source(baseline?.source?.connection_id);
    await runtime.beginToolCall({
      callId,
      toolName: "execute_readonly_sql",
      accessMode: "read",
      input: { source_id: source?.id || null, statement, parameters, baseline_evidence_id: baseline?.evidence_id || null },
    });
    let result;
    if (source?.datasource_name && statement) {
      result = await bds.query(source.datasource_name, statement, {
        project_id: bundle.project_id,
        session_id: bundle.session_id,
        parameters,
      });
    } else {
      result = {
        success: false,
        data: [],
        columns: [],
        row_count: 0,
        total_count: 0,
        message: source ? "证据缺少可执行语句" : "原数据源已不可用",
      };
      result.evidence = await buildQueryExecutionEvidence({
        datasource: source,
        statement,
        parameters,
        result,
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    }
    const evidence = { ...(result.evidence || {}), tool_call_id: callId, rerun_of_evidence_id: baseline?.evidence_id || null };
    currentEvidence.push(evidence);
    rowsByBaselineEvidenceId.set(text(baseline?.evidence_id), Array.isArray(result.data) ? result.data : []);
    evidenceByBaselineEvidenceId.set(text(baseline?.evidence_id), evidence);
    await runtime.finishToolCall({
      callId,
      toolName: "execute_readonly_sql",
      ok: result.success !== false,
      result: result.success === false ? null : { evidence_id: evidence.evidence_id, row_count: evidence?.result?.row_count },
      error: result.success === false ? Object.assign(new Error(result.message || "复跑查询失败"), { code: "EVIDENCE_RERUN_QUERY_FAILED" }) : null,
    });
  }

  const currentValidations = [];
  for (const [index, baselineValidation] of (bundle.validations || []).entries()) {
    const callId = `rerun-validation-${index + 1}-${randomUUID()}`;
    const baselineEvidenceId = text(baselineValidation?.evidence_id);
    const evidence = evidenceByBaselineEvidenceId.get(baselineEvidenceId);
    const requirements = validationRequirements(bundle, baselineValidation);
    const reconcileBaselineId = text(requirements?.reconcile?.evidence_id);
    await runtime.beginToolCall({
      callId,
      toolName: "validate_query_result",
      accessMode: "read",
      input: requirements,
    });
    const validation = {
      ...validateQueryResultEvidence({
        evidence,
        rows: rowsByBaselineEvidenceId.get(baselineEvidenceId) || [],
        rowsComplete: true,
        requirements,
        reconcileEvidence: reconcileBaselineId ? evidenceByBaselineEvidenceId.get(reconcileBaselineId) : null,
        reconcileRows: reconcileBaselineId ? rowsByBaselineEvidenceId.get(reconcileBaselineId) || [] : [],
      }),
      tool_call_id: callId,
      rerun_of_validation_id: baselineValidation?.validation_id || null,
    };
    await runtime.finishToolCall({
      callId,
      toolName: "validate_query_result",
      ok: validation.status === "passed",
      result: validation.status === "passed" ? validation : null,
      error: validation.status === "passed" ? null : Object.assign(new Error("复跑结果校验失败"), { code: "QUERY_VALIDATION_FAILED" }),
    });
    currentValidations.push(validation);
  }

    const comparison = compareEvidenceSnapshots({
      baselineEvidence: bundle.evidence || [],
      currentEvidence,
      baselineValidations: bundle.validations || [],
      currentValidations,
      baselineEnvironment,
      currentEnvironment,
    });
    const answerText = comparison.summary.identical
      ? "复跑完成：数据、Schema、校验结果和运行环境与原证据快照一致。"
      : comparison.summary.environment_changed && comparison.summary.changed_query_count === 0
        ? "复跑完成：查询结果一致，但运行环境已经变化。"
        : `复跑完成：发现 ${comparison.summary.changed_query_count} 个查询结果或数据快照变化。`;
    const rerunBundle = await runtime.recordEvidenceBundle({
      finalItemId,
      answerText,
      evidence: currentEvidence,
      validations: currentValidations,
      toolCallIds: [
        ...currentEvidence.map((item) => item.tool_call_id).filter(Boolean),
        ...currentValidations.map((item) => item.tool_call_id).filter(Boolean),
      ],
      metadata: {
        rerun_of_bundle_id: bundle.id,
        rerun_of_snapshot_hash: bundle.snapshot_hash,
        comparison,
      },
    });
    await runtime.completeRun("completed");
    return {
      run_id: runId,
      baseline_bundle_id: bundle.id,
      rerun_bundle: rerunBundle,
      comparison: { ...comparison, baseline_bundle_id: bundle.id, rerun_bundle_id: rerunBundle?.id || null },
    };
  } catch (error) {
    await runtime.completeRun("failed").catch(() => null);
    throw error;
  }
}

export default { compareEvidenceSnapshots, EVIDENCE_RERUN_VERSION, rerunEvidenceBundle };

import {
  batchSyncDistinctAndEnums,
  batchSyncExampleValues,
} from "../../../app/datasource/tables.js";
import {
  generateDatasourceDescriptionDoc,
  generateDocumentDescriptions,
} from "../../../app/docs/unstructured.js";
import {
  beginDataPreparationRevision,
  transitionDataPreparationRevision,
} from "../../semantic/data_preparation_revision_store.js";
import {
  previewMetadataEnrichment,
  runMetadataEnrichment,
} from "./metadata_enrichment.js";

function clean(value, maxLength = 500) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function selectedIds(value) {
  return new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => clean(item, 128))
      .filter(Boolean),
  );
}

function statusIsCompleted(value) {
  return /^(completed|complete|done|ready|success)$/i.test(clean(value, 64));
}

function statusIsFailed(value) {
  return /^(failed|error|cancelled|canceled)$/i.test(clean(value, 64));
}

async function resolveEmbeddingCapability(ctx, projectId) {
  const model = await ctx.queryOne(
    `SELECT id, model_name
       FROM llm_models
      WHERE api_key IS NOT NULL AND deleted_at IS NULL AND is_enabled=true
        AND category='EMBEDDING' AND (project_id=$1 OR project_id IS NULL)
      ORDER BY (project_id=$1) DESC, created_at DESC
      LIMIT 1`,
    [projectId],
  ).catch(() => null);
  return {
    configured: !!model,
    required: !!model,
    mode: model ? "vector_and_lexical" : "lexical_only",
    model_id: model?.id || null,
    model_name: model?.model_name || null,
    reason: model ? null : "未配置 Embedding 模型，使用关键词和全文检索",
  };
}

async function listStructuredTargets(ctx, projectId, params = {}, embeddingCapability = { required: true }) {
  const requested = selectedIds(params.connection_ids);
  const connections = await ctx.query(
    `SELECT id, name, db_type, database AS database_name, description
       FROM database_connections
      WHERE project_id=$1 AND deleted_at IS NULL
      ORDER BY name, created_at`,
    [projectId],
  );
  const targets = [];
  for (const connection of connections) {
    const connectionId = String(connection.id);
    if (requested.size && !requested.has(connectionId)) continue;
    const preview = await previewMetadataEnrichment(ctx, projectId, {
      connection_id: connectionId,
    });
    if (!preview.success) {
      targets.push({
        connection_id: connectionId,
        connection_name: connection.name,
        status: "failed",
        error: preview.error || "数据库元数据不可用",
        table_ids: [],
        table_count: 0,
      });
      continue;
    }
    const target = preview.target;
    const descriptionsReady = target.table_count > 0
      && target.tables_with_description === target.table_count
      && target.columns_with_description === target.column_count
      && target.has_database_description;
    const vectorCoverageReady = target.table_count > 0
      && target.tables_with_vector === target.table_count
      && target.columns_with_vector === target.column_count;
    const vectorsReady = !embeddingCapability.required || vectorCoverageReady;
    targets.push({
      ...target,
      status: descriptionsReady && vectorsReady ? "prepared" : "pending",
      descriptions_ready: descriptionsReady,
      vectors_ready: vectorsReady,
      vector_coverage_ready: vectorCoverageReady,
      retrieval_mode: embeddingCapability.mode,
    });
  }
  if (requested.size) {
    const found = new Set(targets.map((target) => target.connection_id));
    const missing = [...requested].filter((id) => !found.has(id));
    if (missing.length) throw new Error(`connection_ids 中包含不属于当前项目的数据源: ${missing.join("、")}`);
  }
  return targets;
}

async function listUnstructuredTargets(ctx, projectId, params = {}, embeddingCapability = { required: true }) {
  const requested = selectedIds(params.unstructured_data_source_ids);
  const sources = await ctx.query(
    `SELECT id, name, description
       FROM unstructured_data_sources
      WHERE project_id=$1 AND deleted_at IS NULL
      ORDER BY name, created_at`,
    [projectId],
  );
  const documents = await ctx.query(
    `SELECT d.id, d.unstructured_data_source_id, d.title, d.description, d.status,
            d.chunk_count, d.progress, d.error_msg,
            (SELECT COUNT(*) FROM unstructured_contents c
              WHERE c.document_id=d.id AND c.content_index >= 0
                AND c.deleted_at IS NULL AND c.embedding IS NOT NULL) AS embedded_chunk_count
       FROM unstructured_documents d
      WHERE d.project_id=$1 AND d.deleted_at IS NULL
      ORDER BY d.created_at`,
    [projectId],
  );
  const bySource = new Map();
  for (const document of documents) {
    const sourceId = String(document.unstructured_data_source_id || "");
    if (!bySource.has(sourceId)) bySource.set(sourceId, []);
    bySource.get(sourceId).push(document);
  }
  const targets = sources
    .filter((source) => !requested.size || requested.has(String(source.id)))
    .map((source) => {
      const docs = bySource.get(String(source.id)) || [];
      const documentCount = docs.length;
      const documentsCompleted = docs.filter((doc) => statusIsCompleted(doc.status)).length;
      const documentsFailed = docs.filter((doc) => statusIsFailed(doc.status)).length;
      const documentsProcessing = Math.max(0, documentCount - documentsCompleted - documentsFailed);
      const chunksTotal = docs.reduce((sum, doc) => sum + Number(doc.chunk_count || 0), 0);
      const chunksEmbedded = docs.reduce((sum, doc) => sum + Number(doc.embedded_chunk_count || 0), 0);
      const documentsWithDescription = docs.filter((doc) => hasValue(doc.description)).length;
      const parsingReady = documentCount > 0 && documentsCompleted === documentCount && chunksTotal > 0;
      const descriptionsReady = parsingReady
        && documentsWithDescription === documentCount
        && hasValue(source.description);
      const vectorCoverageReady = parsingReady && chunksEmbedded === chunksTotal;
      const vectorsReady = parsingReady && (!embeddingCapability.required || vectorCoverageReady);
      return {
        data_source_id: String(source.id),
        data_source_name: source.name,
        has_data_source_description: hasValue(source.description),
        document_ids: docs.map((doc) => String(doc.id)),
        document_count: documentCount,
        documents_completed: documentsCompleted,
        documents_processing: documentsProcessing,
        documents_failed: documentsFailed,
        documents_with_description: documentsWithDescription,
        chunks_total: chunksTotal,
        chunks_embedded: chunksEmbedded,
        parsing_ready: parsingReady,
        descriptions_ready: descriptionsReady,
        vectors_ready: vectorsReady,
        vector_coverage_ready: vectorCoverageReady,
        retrieval_mode: embeddingCapability.mode,
        status: parsingReady && descriptionsReady && vectorsReady ? "prepared" : (documentsFailed ? "failed" : "pending"),
        failures: docs
          .filter((doc) => statusIsFailed(doc.status))
          .map((doc) => ({
            document_id: String(doc.id),
            title: doc.title,
            error: doc.error_msg || `文档状态为 ${doc.status}`,
          })),
      };
    });
  if (requested.size) {
    const found = new Set(targets.map((target) => target.data_source_id));
    const missing = [...requested].filter((id) => !found.has(id));
    if (missing.length) {
      throw new Error(`unstructured_data_source_ids 中包含不属于当前项目的数据源: ${missing.join("、")}`);
    }
  }
  return targets;
}

export function summarizeDataPreparationCoverage(structured, unstructured, embeddingCapability = null) {
  const structuredTotals = structured.reduce((summary, target) => ({
    connections_total: summary.connections_total + 1,
    connections_prepared: summary.connections_prepared + (target.status === "prepared" ? 1 : 0),
    tables_total: summary.tables_total + Number(target.table_count || 0),
    tables_with_description: summary.tables_with_description + Number(target.tables_with_description || 0),
    columns_total: summary.columns_total + Number(target.column_count || 0),
    columns_with_description: summary.columns_with_description + Number(target.columns_with_description || 0),
    tables_with_vector: summary.tables_with_vector + Number(target.tables_with_vector || 0),
    columns_with_vector: summary.columns_with_vector + Number(target.columns_with_vector || 0),
  }), {
    connections_total: 0,
    connections_prepared: 0,
    tables_total: 0,
    tables_with_description: 0,
    columns_total: 0,
    columns_with_description: 0,
    tables_with_vector: 0,
    columns_with_vector: 0,
  });
  const unstructuredTotals = unstructured.reduce((summary, target) => ({
    data_sources_total: summary.data_sources_total + 1,
    data_sources_prepared: summary.data_sources_prepared + (target.status === "prepared" ? 1 : 0),
    documents_total: summary.documents_total + Number(target.document_count || 0),
    documents_completed: summary.documents_completed + Number(target.documents_completed || 0),
    documents_failed: summary.documents_failed + Number(target.documents_failed || 0),
    documents_with_description: summary.documents_with_description + Number(target.documents_with_description || 0),
    chunks_total: summary.chunks_total + Number(target.chunks_total || 0),
    chunks_embedded: summary.chunks_embedded + Number(target.chunks_embedded || 0),
  }), {
    data_sources_total: 0,
    data_sources_prepared: 0,
    documents_total: 0,
    documents_completed: 0,
    documents_failed: 0,
    documents_with_description: 0,
    chunks_total: 0,
    chunks_embedded: 0,
  });
  return {
    structured: structuredTotals,
    unstructured: unstructuredTotals,
    embedding: embeddingCapability,
    source_count: structuredTotals.connections_total + unstructuredTotals.data_sources_total,
  };
}

export async function previewProjectDataPreparation(ctx, projectId, params = {}) {
  if (!projectId) throw new Error("缺少 project_id");
  const embeddingCapability = await resolveEmbeddingCapability(ctx, projectId);
  const [structured, unstructured] = await Promise.all([
    listStructuredTargets(ctx, projectId, params, embeddingCapability),
    listUnstructuredTargets(ctx, projectId, params, embeddingCapability),
  ]);
  const coverage = summarizeDataPreparationCoverage(structured, unstructured, embeddingCapability);
  return {
    success: coverage.source_count > 0,
    needs_clarification: false,
    project_id: projectId,
    structured,
    unstructured,
    coverage,
    fully_prepared: coverage.source_count > 0
      && structured.every((target) => target.status === "prepared")
      && unstructured.every((target) => target.status === "prepared"),
    error: coverage.source_count ? null : "当前项目没有可准备的数据源",
  };
}

function step(status, data = null, error = null) {
  return { status, data, error };
}

async function runStep(fn) {
  try {
    const data = await fn();
    const reported = clean(data?.status, 64).toLowerCase();
    if (reported === "failed") return step("failed", data, data?.error || "底层准备步骤失败");
    if (reported === "partial") return step("partial", data, data?.error || "底层准备步骤部分完成");
    return step("completed", data, null);
  } catch (error) {
    return step("failed", null, error?.message || String(error));
  }
}

function stepFailures(targetType, targetId, steps) {
  return Object.entries(steps)
    .filter(([, result]) => result.status !== "completed")
    .map(([name, result]) => ({
      target_type: targetType,
      target_id: targetId,
      step: name,
      status: result.status,
      error: result.error || "准备步骤未完成",
    }));
}

export async function runProjectDataPreparation(
  ctx,
  projectId,
  params = {},
  {
    previewFn = previewProjectDataPreparation,
    beginRevisionFn = beginDataPreparationRevision,
    transitionRevisionFn = transitionDataPreparationRevision,
    syncExampleValuesFn = batchSyncExampleValues,
    syncDistinctAndEnumsFn = batchSyncDistinctAndEnums,
    runStructuredFn = runMetadataEnrichment,
    generateDocumentDescriptionsFn = generateDocumentDescriptions,
    generateDatasourceDescriptionFn = generateDatasourceDescriptionDoc,
  } = {},
) {
  if (!projectId) throw new Error("缺少 project_id");
  const before = await previewFn(ctx, projectId, params);
  const revision = await beginRevisionFn(ctx, {
    projectId,
    coverageSummary: before.coverage,
  });
  try {
  if (!before.success) {
    const failures = [{ code: "NO_PROJECT_DATA_SOURCE", message: before.error }];
    const failed = await transitionRevisionFn(ctx, revision.id, "failed", {
      coverageSummary: before.coverage,
      failureDetails: failures,
    });
    return { success: false, status: "failed", revision: failed, before, after: before, failures, targets: [] };
  }

  const targets = [];
  const failures = [];
  const onlyPending = params.only_pending !== false;
  for (const target of before.structured) {
    const steps = {
      example_values: await runStep(async () => {
        const response = await syncExampleValuesFn(ctx, {
          params: { pid: projectId, cid: target.connection_id },
          query: {},
          body: {
            table_ids: target.table_ids,
            limit: Number(params.example_limit) || 3,
            only_pending: onlyPending,
          },
        });
        return response?.data || response;
      }),
      distinct_values_and_enums: await runStep(async () => {
        const response = await syncDistinctAndEnumsFn(ctx, {
          params: { pid: projectId, cid: target.connection_id },
          query: {},
          body: {
            table_ids: target.table_ids,
            threshold: Number(params.enum_threshold) || 50,
            only_pending: onlyPending,
          },
        });
        return response?.data || response;
      }),
      metadata: await runStep(async () => runStructuredFn(ctx, projectId, {
        connection_id: target.connection_id,
        connection_name: target.connection_name,
        table_ids: target.table_ids,
        operation: before.coverage?.embedding?.required ? "all" : "descriptions",
        only_pending: onlyPending,
        extra_notes: clean(params.extra_notes, 2000) || null,
      })),
    };
    const targetFailures = stepFailures("database_connection", target.connection_id, steps);
    failures.push(...targetFailures);
    targets.push({
      target_type: "database_connection",
      target_id: target.connection_id,
      target_name: target.connection_name,
      status: targetFailures.length ? (targetFailures.length === Object.keys(steps).length ? "failed" : "partial") : "completed",
      steps,
    });
  }

  for (const target of before.unstructured) {
    const steps = {};
    if (!target.parsing_ready) {
      steps.parsing_and_vectors = step(
        "failed",
        null,
        target.documents_processing
          ? `${target.documents_processing} 个文档仍在解析或生成向量，请等待 job_status 完成后重试`
          : `${target.documents_failed || target.document_count} 个文档未完成解析和向量准备`,
      );
    } else {
      steps.parsing_and_vectors = step("completed", {
        documents: target.documents_completed,
        chunks: target.chunks_total,
        embedded_chunks: target.chunks_embedded,
      });
      steps.document_descriptions = await runStep(async () => {
        const response = await generateDocumentDescriptionsFn(ctx, {
          params: { pid: projectId },
          query: {},
          body: {
            data_source_id: target.data_source_id,
            document_ids: target.document_ids,
            language: params.language || "zh",
          },
        });
        return response?.data || response;
      });
      steps.data_source_description = await runStep(async () => {
        const response = await generateDatasourceDescriptionFn(ctx, {
          params: { pid: projectId, dsid: target.data_source_id },
          query: {},
          body: { language: params.language || "zh" },
        });
        return response?.data || response;
      });
    }
    const targetFailures = stepFailures("unstructured_data_source", target.data_source_id, steps);
    failures.push(...targetFailures, ...(target.failures || []));
    targets.push({
      target_type: "unstructured_data_source",
      target_id: target.data_source_id,
      target_name: target.data_source_name,
      status: targetFailures.length ? (targetFailures.length === Object.keys(steps).length ? "failed" : "partial") : "completed",
      steps,
    });
  }

  const after = await previewFn(ctx, projectId, params);
  for (const target of after.structured) {
    if (target.status !== "prepared") failures.push({
      target_type: "database_connection",
      target_id: target.connection_id,
      step: "completion_validation",
      status: "partial",
      error: "表/字段说明或 Schema 向量覆盖率未完整完成",
    });
  }
  for (const target of after.unstructured) {
    if (target.status !== "prepared") failures.push({
      target_type: "unstructured_data_source",
      target_id: target.data_source_id,
      step: "completion_validation",
      status: "partial",
      error: "文档解析、说明或向量覆盖率未完整完成",
    });
  }
  const completedTargetCount = targets.filter((target) => target.status === "completed").length;
  const finalStatus = after.fully_prepared && failures.length === 0
    ? "completed"
    : (completedTargetCount === 0 ? "failed" : "partial");
  const finalRevision = await transitionRevisionFn(ctx, revision.id, finalStatus, {
    coverageSummary: after.coverage,
    failureDetails: failures.length ? failures : null,
  });
  return {
    success: finalStatus === "completed",
    status: finalStatus,
    revision: finalRevision,
    before,
    after,
    targets,
    failures,
  };
  } catch (error) {
    const failure = {
      code: error?.code || "DATA_PREPARATION_RUN_FAILED",
      message: error?.message || String(error),
    };
    let failedRevision = revision;
    try {
      failedRevision = await transitionRevisionFn(ctx, revision.id, "failed", {
        coverageSummary: before.coverage,
        failureDetails: [failure],
      });
    } catch {
      // If the state was finalized concurrently, preserve the original failure as the tool result.
    }
    return {
      success: false,
      status: "failed",
      revision: failedRevision,
      before,
      after: null,
      targets: [],
      failures: [failure],
    };
  }
}

export default {
  previewProjectDataPreparation,
  runProjectDataPreparation,
  summarizeDataPreparationCoverage,
};

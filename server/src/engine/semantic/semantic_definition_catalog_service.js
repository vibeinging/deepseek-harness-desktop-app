import { vectorReady } from "../../db.js";
import { embed } from "../core/llm.js";
import { MetricService } from "./metric_service.js";
import { describeMetricViewParameters, metricViewOutputColumns } from "./metric_view_runtime.js";
import { MetricViewService } from "./metric_view_service.js";

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalized(value) {
  return String(value || "").toLowerCase().replace(/[\s\-_.，。；;:：/\\()（）\[\]{}]+/g, "").replace(/的/g, "");
}

function phraseRank(question, candidate) {
  const query = normalized(question);
  if (!query) return 0;
  const names = [candidate.name, ...(candidate.aliases || [])].map(normalized).filter(Boolean);
  if (names.some((name) => name === query)) return 3;
  if (names.some((name) => query.includes(name) || name.includes(query))) return 2;
  const text = normalized([candidate.name, candidate.description, ...(candidate.aliases || [])].join(" "));
  return [...new Set(query)].filter((char) => text.includes(char)).length / Math.max(1, new Set(query).size);
}

async function queryEmbedding(question, projectId, supplied) {
  if (Array.isArray(supplied) && supplied.length) return supplied;
  if (!vectorReady || !String(question || "").trim()) return null;
  try {
    const value = await embed(question, { project_id: projectId });
    return Array.isArray(value) && value.length ? value : null;
  } catch (error) {
    console.warn(`[business_definition_catalog] 向量生成失败，回退文字召回: ${error?.message || error}`);
    return null;
  }
}

function metricParameters(spec = {}) {
  return (Array.isArray(spec.parameters) ? spec.parameters : []).map((item) => ({
    name: String(item?.name || "").trim(),
    type: item?.type || "string",
    required: item?.required !== false,
    description: item?.description || null,
    allowed_values: Array.isArray(item?.allowed_values) ? item.allowed_values : [],
  })).filter((item) => item.name);
}

function viewId(match) {
  return match?.definition?.metric_id || match?.definition?.id || null;
}

function keepOutputShapesVisible(ranked) {
  if (ranked.length < 2) return ranked;
  const firstKind = ranked[0]?.candidate?.definition_kind;
  const otherIndex = ranked.findIndex((item, index) => index > 0
    && item?.candidate?.definition_kind && item.candidate.definition_kind !== firstKind);
  if (otherIndex <= 1) return ranked;
  const next = [...ranked];
  const [other] = next.splice(otherIndex, 1);
  next.splice(1, 0, other);
  return next;
}

export class SemanticDefinitionCatalogService {
  static async search(ctx, {
    question,
    project_id,
    limit = 5,
    offset = 0,
    query_embedding = null,
  } = {}) {
    if (!project_id) throw new Error("project_id 不能为空");
    const safeLimit = Math.max(1, Math.min(20, Number.parseInt(limit, 10) || 5));
    const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
    const fetchLimit = safeOffset + safeLimit + 1;
    const sharedEmbedding = await queryEmbedding(question, project_id, query_embedding);
    const embeddingInput = sharedEmbedding || false;
    const [metrics, views] = await Promise.all([
      MetricService.search_metrics(ctx, {
        query_text: question,
        project_id,
        limit: fetchLimit,
        offset: 0,
        query_embedding: embeddingInput,
      }),
      MetricViewService.search(ctx, {
        query_text: question,
        project_id,
        limit: fetchLimit,
        offset: 0,
        query_embedding: embeddingInput,
      }),
    ]);

    const metricIds = metrics.map((item) => item.id).filter(Boolean);
    const planRows = metricIds.length ? await ctx.query(
      `SELECT metric_id, plan_type, spec, evidence_policy, priority, version
         FROM metric_execution_plans
        WHERE project_id=$1 AND metric_id::text = ANY($2::text[])
          AND deleted_at IS NULL AND is_active=true
        ORDER BY metric_id, priority ASC, version DESC, id ASC`,
      [project_id, metricIds],
    ) : [];
    const plansByMetric = new Map();
    for (const row of planRows) {
      const items = plansByMetric.get(row.metric_id) || [];
      items.push({ ...row, spec: parseJson(row.spec, {}), evidence_policy: parseJson(row.evidence_policy, {}) });
      plansByMetric.set(row.metric_id, items);
    }

    const ranked = [];
    metrics.forEach((metric, sourceRank) => {
      const plans = plansByMetric.get(metric.id) || [];
      const preferred = plans[0] || null;
      const parameters = metricParameters(preferred?.spec || {});
      ranked.push({
        candidate: {
          definition_id: metric.id,
          definition_kind: "metric",
          output_shape: "scalar",
          name: metric.name || null,
          description: metric.description || metric.rule || null,
          aliases: metric.aliases || [],
          plan_type: preferred?.plan_type || null,
          available_plan_types: [...new Set(plans.map((item) => item.plan_type).filter(Boolean))],
          unit: preferred?.spec?.unit || preferred?.spec?.result?.unit || null,
          parameters,
          required_parameters: parameters.filter((item) => item.required),
          evidence_required: preferred?.evidence_policy?.require_evidence !== false,
        },
        similarity: Number(metric.similarity || 0),
        sourceRank,
      });
    });
    views.forEach((match, sourceRank) => {
      const definition = match.definition || {};
      const parameters = describeMetricViewParameters(definition);
      ranked.push({
        candidate: {
          definition_id: viewId(match),
          definition_kind: "query_view",
          output_shape: "table",
          name: match.name || definition.name || null,
          description: match.description || definition.descriptions?.[0] || null,
          aliases: match.aliases || definition.aliases || [],
          plan_type: "relational_query",
          available_plan_types: ["relational_query"],
          unit: null,
          parameters,
          required_parameters: parameters.filter((item) => item.required),
          output_columns: metricViewOutputColumns(definition),
          source_name: match.source_name || null,
          evidence_required: true,
        },
        similarity: Number(match.similarity || 0),
        sourceRank,
      });
    });
    for (const item of ranked) item.phraseRank = phraseRank(question, item.candidate);
    ranked.sort((left, right) => right.phraseRank - left.phraseRank
      || right.similarity - left.similarity
      || left.sourceRank - right.sourceRank
      || String(left.candidate.name || "").localeCompare(String(right.candidate.name || ""))
      || String(left.candidate.definition_id || "").localeCompare(String(right.candidate.definition_id || "")));

    const ordered = keepOutputShapesVisible(ranked);
    const candidates = ordered.slice(safeOffset, safeOffset + safeLimit).map((item) => item.candidate);
    const sourceMayHaveMore = metrics.length === fetchLimit || views.length === fetchLimit;
    const hasMore = ordered.length > safeOffset + safeLimit || sourceMayHaveMore;
    return {
      question,
      candidates,
      count: candidates.length,
      limit: safeLimit,
      offset: safeOffset,
      has_more: hasMore,
      next_offset: hasMore ? safeOffset + safeLimit : null,
    };
  }
}

export default SemanticDefinitionCatalogService;

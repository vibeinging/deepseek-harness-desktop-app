// Agent run APIs and the persisted project-rule store used by Plugin tools.
import { randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import { requireProjectMember, requireProjectOwner } from "../projects/access.js";
export {
  archiveAgentRun,
  deleteAgentRun,
  getAgentRun,
  getAgentSubagentThread,
  getAgentRunEnvironment,
  getAgentRunDeletionImpact,
  listAgentRuns,
  prepareAgentRunRecovery,
  stopAgentRun,
  stopAgentSubagentThread,
} from "./run_center.js";
export { prepareRunRecoveryDiagnostic, prepareRunningElectronExitDiagnostic } from "./run_recovery_diagnostics.js";
export { cleanupRunRetentionDiagnostic, prepareRunRetentionDiagnostic } from "./run_retention_diagnostics.js";
export { diagnoseRunWriteback } from "./run_writeback_diagnostics.js";
export { diagnoseQueryExecutionEvidence, replaceQueryEvidenceDiagnosticRows } from "./query_evidence_diagnostics.js";
export { getRunEvidenceBundle, listRunEvidenceBundles, rerunRunEvidenceBundle } from "./evidence_bundles.js";
export { getAgentRuntimeStatus, probeAgentRuntime } from "./agent_runtime.js";
export { getAppInstructions, updateAppInstructions } from "./app_settings.js";

const MAX_PROJECT_RULES_LENGTH = 60_000;

const RULE_TYPES = new Set(["query", "sql", "format"]);

function resolveRuleType(value) {
  const ruleType = String(value || "").trim();
  if (!RULE_TYPES.has(ruleType)) throw new ApiError("rule_type 仅支持 query、sql 或 format", 400);
  return ruleType;
}

function normalizeRules(value) {
  return String(value || "").replace(/\r\n?/g, "\n").trim();
}

export function buildProjectRulesUpdate(currentValue, incomingValue, operationValue = "append") {
  const operation = String(operationValue || "append").trim().toLowerCase();
  if (!new Set(["append", "replace"]).has(operation)) {
    throw new ApiError("operation 仅支持 append 或 replace", 400);
  }
  const incoming = normalizeRules(incomingValue);
  if (!incoming) throw new ApiError("规则内容不能为空", 400);
  const current = normalizeRules(currentValue);
  const alreadyContainsBlock = Boolean(
    current && (
      current === incoming ||
      current.startsWith(`${incoming}\n\n`) ||
      current.endsWith(`\n\n${incoming}`) ||
      current.includes(`\n\n${incoming}\n\n`)
    )
  );
  const unchanged = operation === "replace" ? current === incoming : alreadyContainsBlock;
  const rules = unchanged
    ? current
    : operation === "replace" || !current
      ? incoming
      : `${current}\n\n${incoming}`;
  if (rules.length > MAX_PROJECT_RULES_LENGTH) {
    throw new ApiError(`规则总长度不能超过 ${MAX_PROJECT_RULES_LENGTH} 个字符，请先精简内容`, 400);
  }
  return { operation, incoming, current, rules, unchanged };
}

// Project rules are data consumed through AGENTS.md, not a second Agent prompt stack.
export async function getProjectRules(ctx, input) {
  const { pid, ruleType: rawRuleType } = input.params || {};
  await requireProjectMember(ctx, pid);
  const ruleType = resolveRuleType(rawRuleType);
  const row = await ctx.queryOne(
    `SELECT content FROM project_rules
      WHERE project_id=$1 AND rule_type=$2
      LIMIT 1`,
    [pid, ruleType],
  );
  const rules = String(row?.content || "");
  return {
    data: {
      project_id: pid,
      rule_type: ruleType,
      rules,
      rules_length: rules.length,
    },
    message: "获取项目规则成功",
  };
}

export async function updateProjectRules(ctx, input) {
  const { pid, ruleType: rawRuleType } = input.params || {};
  await requireProjectOwner(ctx, pid);
  const ruleType = resolveRuleType(rawRuleType);
  if (!pid) throw new ApiError("project_id 不能为空", 400);

  const existingRule = await ctx.queryOne(
    `SELECT id, content FROM project_rules
      WHERE project_id=$1 AND rule_type=$2
      LIMIT 1`,
    [pid, ruleType],
  );
  const preview = buildProjectRulesUpdate(
    existingRule?.content || "",
    input.body?.content,
    input.body?.operation || "append",
  );
  const { operation, incoming, rules: nextRules, unchanged } = preview;

  if (!unchanged) {
    if (existingRule) {
      await ctx.query(
        `UPDATE project_rules SET content=$1, updated_at=now() WHERE id=$2`,
        [nextRules, existingRule.id],
      );
    } else {
      await ctx.query(
        `INSERT INTO project_rules
           (id, project_id, rule_type, content, version, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'1.0.0',now(),now())`,
        [randomUUID(), pid, ruleType, nextRules],
      );
    }
  }

  return {
    data: {
      project_id: pid,
      rule_type: ruleType,
      operation,
      unchanged: Boolean(unchanged),
      added_length: unchanged ? 0 : incoming.length,
      rules_length: nextRules.length,
      rules: nextRules,
    },
    message: unchanged ? "规则已存在，无需重复添加" : "项目规则更新成功",
  };
}

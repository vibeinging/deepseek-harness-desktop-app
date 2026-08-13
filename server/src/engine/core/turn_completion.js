const COMPLETION_POLICIES = Symbol("turn_completion_policies");

function clean(value) {
  return String(value || "").trim();
}

function normalizeTurnStatus(value) {
  const status = clean(value).toLowerCase();
  if (["completed", "failed", "interrupted"].includes(status)) return status;
  return "failed";
}

function policyFailure(policy, error, {
  fallbackCode = "TURN_COMPLETION_POLICY_ERROR",
  fallbackTitle = "能力收尾失败",
} = {}) {
  const message = clean(error?.message || error) || `能力 ${policy.id} 收尾失败`;
  return {
    policy_id: policy.id,
    status: "failed",
    code: clean(error?.code) || fallbackCode,
    title: clean(error?.title) || fallbackTitle,
    message,
    details: error?.details && typeof error.details === "object" ? error.details : null,
  };
}

function normalizeVerdict(policy, value) {
  if (!value || value.status === "passed" || value.status === "completed") {
    return {
      policy_id: policy.id,
      status: "passed",
      code: null,
      title: null,
      message: null,
      details: value?.details && typeof value.details === "object" ? value.details : null,
    };
  }
  if (value.status !== "failed") {
    throw new Error(`完成策略 ${policy.id} 返回了无效状态: ${value.status}`);
  }
  return {
    policy_id: policy.id,
    status: "failed",
    code: clean(value.code) || "TURN_COMPLETION_REJECTED",
    title: clean(value.title) || "任务未完成",
    message: clean(value.message) || `能力 ${policy.id} 尚未满足完成条件`,
    details: value.details && typeof value.details === "object" ? value.details : null,
  };
}

export function registerTurnCompletionPolicy(agentContext, policy = {}) {
  if (!agentContext || typeof agentContext !== "object") throw new Error("注册完成策略缺少 AgentContext");
  const id = clean(policy.id);
  if (!id) throw new Error("完成策略缺少 id");
  if (typeof policy.evaluate !== "function" && typeof policy.settle !== "function") {
    throw new Error(`完成策略 ${id} 缺少 evaluate 或 settle`);
  }
  const policies = agentContext[COMPLETION_POLICIES] ||= [];
  if (policies.some((item) => item.id === id)) throw new Error(`完成策略重复注册: ${id}`);
  policies.push({
    id,
    priority: Number.isFinite(Number(policy.priority)) ? Number(policy.priority) : 100,
    evaluate: typeof policy.evaluate === "function" ? policy.evaluate : null,
    settle: typeof policy.settle === "function" ? policy.settle : null,
  });
  policies.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
}

export function listTurnCompletionPolicies(agentContext) {
  return [...(agentContext?.[COMPLETION_POLICIES] || [])];
}

/**
 * 先让各能力独立裁决，再用汇总状态收尾能力自己的执行实体。
 * 任一裁决或收尾抛错都 fail closed，通用层不解释领域 details。
 */
export async function completeTurnCapabilities(agentContext, input = {}) {
  const policies = listTurnCompletionPolicies(agentContext);
  const initialStatus = normalizeTurnStatus(input.status);
  const verdicts = [];

  for (const policy of policies) {
    if (!policy.evaluate) {
      verdicts.push(normalizeVerdict(policy, null));
      continue;
    }
    try {
      verdicts.push(normalizeVerdict(policy, await policy.evaluate({ ...input, status: initialStatus })));
    } catch (error) {
      verdicts.push(policyFailure(policy, error));
    }
  }

  const evaluationFailures = verdicts.filter((verdict) => verdict.status === "failed");
  const answerGateFailure = (
    initialStatus === "completed"
    && input.answerAccepted === false
    && evaluationFailures.length === 0
  ) ? {
    policy_id: "turn-answer",
    status: "failed",
    code: "TURN_ANSWER_MISSING",
    title: "最终回答无效",
    message: "任务运行已结束，但没有生成可用的最终回答。",
    details: null,
  } : null;
  const completionFailures = answerGateFailure
    ? [...evaluationFailures, answerGateFailure]
    : evaluationFailures;
  let status = initialStatus === "completed" && completionFailures.length ? "failed" : initialStatus;
  const settlementFailures = [];
  for (const policy of policies) {
    if (!policy.settle) continue;
    try {
      await policy.settle({
        ...input,
        initialStatus,
        status,
        phase: "settle",
        verdicts,
        failures: [...completionFailures],
      });
    } catch (error) {
      settlementFailures.push(policyFailure(policy, error));
    }
  }
  if (settlementFailures.length) {
    const previousStatus = status;
    status = "failed";
    // A later capability may fail after an earlier one already persisted a
    // successful/interrupted terminal state. Re-run every idempotent settler
    // once with the final failed state so domain entities cannot split.
    if (previousStatus !== "failed") {
      const failures = [...completionFailures, ...settlementFailures];
      for (const policy of policies) {
        if (!policy.settle) continue;
        try {
          await policy.settle({
            ...input,
            initialStatus,
            status,
            phase: "reconcile",
            verdicts,
            failures,
          });
        } catch (error) {
          settlementFailures.push(policyFailure(policy, error, {
            fallbackCode: "TURN_COMPLETION_RECONCILIATION_ERROR",
            fallbackTitle: "能力最终状态对齐失败",
          }));
        }
      }
    }
  }

  return {
    initialStatus,
    status,
    verdicts,
    failures: [...completionFailures, ...settlementFailures],
  };
}

export default completeTurnCapabilities;

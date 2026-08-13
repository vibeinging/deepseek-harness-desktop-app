function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
}

export function approvalArgsFingerprint(args) {
  try { return JSON.stringify(canonical(args ?? {})); } catch { return String(args ?? ""); }
}

function textResult(text, details = {}) {
  return {
    content: [{ type: "text", text }],
    details,
    terminate: true,
  };
}

function failedResult(error) {
  return {
    content: [{ type: "text", text: error?.message || String(error) }],
    details: { error_code: error?.code || "AGENT_WRITEBACK_STAGE_FAILED" },
    isError: true,
  };
}

export function wrapToolsWithDeferredApprovals(tools = [], {
  approvalPolicy,
  runtime,
  agentContext,
  streamCallback,
  shortArgs = () => "",
} = {}) {
  return tools.map((tool) => {
    if (!tool?.name || typeof tool.execute !== "function") return tool;
    return {
      ...tool,
      execute: async (callId, args, ...rest) => {
        if (!approvalPolicy?.needsConfirm?.(tool.name)) {
          return tool.execute(callId, args, ...rest);
        }

        const fingerprint = approvalArgsFingerprint(args);
        let stagedWriteback = null;
        if (typeof tool.prepareWriteback === "function") {
          if (typeof runtime?.stageWriteback !== "function") {
            return failedResult(Object.assign(new Error("当前运行无法保存写回草稿，已阻止项目修改。"), {
              code: "AGENT_WRITEBACK_RUNTIME_UNAVAILABLE",
            }));
          }
          try {
            const proposal = await tool.prepareWriteback(args || {});
            stagedWriteback = await runtime.stageWriteback({
              callId,
              toolName: tool.name,
              argsFingerprint: fingerprint,
              proposal,
            });
          } catch (error) {
            return failedResult(error);
          }
        }
        const grant = agentContext?.approvalGrant;
        if (
          grant &&
          !grant.consumed &&
          grant.approved === true &&
          grant.tool_name === tool.name &&
          grant.args_fingerprint === fingerprint
        ) {
          grant.consumed = true;
          await runtime?.recordEvent?.({
            eventType: "run_approval_grant_consumed",
            status: "running",
            callId,
            metadata: { tool_name: tool.name, approved_request_id: grant.request_id || null },
          });
          const result = await tool.execute(callId, args, ...rest);
          if (
            stagedWriteback &&
            !result?.isError &&
            result?.details?.success !== false &&
            typeof runtime?.completeWriteback === "function"
          ) {
            const actualAfter = typeof tool.readWritebackState === "function"
              ? await tool.readWritebackState(args || {})
              : result?.details || null;
            await runtime.completeWriteback({
              callId,
              toolName: tool.name,
              staged: stagedWriteback,
              actualAfter,
              approvedRequestId: grant.request_id || null,
            });
          }
          return result;
        }

        // Current Agent Runtime path: keep the dynamic tool call open and
        // resolve the decision inside the same Thread/Turn. Persistence still
        // records the proposal and final receipt, but no second Agent run is
        // created merely to continue an approval.
        if (typeof agentContext?.awaitDecision === "function") {
          const approvalRequest = {
            ...approvalPolicy.approvalRequest(tool.name, args),
            ...(typeof tool.buildApprovalRequest === "function" ? tool.buildApprovalRequest(args || {}) : {}),
            deferred: false,
            threadId: agentContext.runtime_thread_id || null,
            turnId: agentContext.runtime_turn_id || null,
            itemId: callId,
            tool_name: tool.name,
            args_fingerprint: fingerprint,
            writeback: stagedWriteback ? {
              version: stagedWriteback.version,
              kind: stagedWriteback.kind,
              target: stagedWriteback.target,
              path: stagedWriteback.path,
              proposal_hash: stagedWriteback.proposal_hash,
            } : null,
          };
          const displayArgs = typeof tool.redactInput === "function" ? tool.redactInput(args || {}) : args;
          // Register the pending decision before publishing the approval event.
          // Fast clients (including eval auto-approval) may answer from inside
          // the stream callback, before this call stack yields again.
          const decisionPromise = agentContext.awaitDecision(callId, {
            threadId: approvalRequest.threadId,
            turnId: approvalRequest.turnId,
            itemId: callId,
            method: "item/dynamicTool/requestApproval",
          }).catch(() => "decline");
          await streamCallback?.(`${tool.name} ${shortArgs(displayArgs)}`, {
            content_id: `confirm:${callId}`,
            content_type: "confirm",
            title: tool.name,
            tool_call_id: callId,
            approval_request: approvalRequest,
          });
          const decision = await decisionPromise;
          const approved = decision === true || decision === "accept" || decision === "acceptForSession";
          await streamCallback?.(`${tool.name} ${shortArgs(displayArgs)}`, {
            content_id: `confirm:${callId}`,
            content_type: "confirm",
            title: approved ? "approved" : "rejected",
            tool_call_id: callId,
            approval_request: approvalRequest,
          });
          if (!approved) {
            return textResult("用户拒绝了该写入或外部操作。", {
              approval_rejected: true,
              tool_name: tool.name,
            });
          }
          const result = await tool.execute(callId, args, ...rest);
          if (
            stagedWriteback &&
            !result?.isError &&
            result?.details?.success !== false &&
            typeof runtime?.completeWriteback === "function"
          ) {
            const actualAfter = typeof tool.readWritebackState === "function"
              ? await tool.readWritebackState(args || {})
              : result?.details || null;
            await runtime.completeWriteback({
              callId,
              toolName: tool.name,
              staged: stagedWriteback,
              actualAfter,
              approvedRequestId: callId,
            });
          }
          return result;
        }

        if (!runtime?.requestApproval) {
          return textResult("当前运行无法保存审批状态，已阻止工具执行。", {
            error_code: "AGENT_APPROVAL_RUNTIME_UNAVAILABLE",
          });
        }

        const approvalRequest = {
          ...approvalPolicy.approvalRequest(tool.name, args),
          ...(typeof tool.buildApprovalRequest === "function" ? tool.buildApprovalRequest(args || {}) : {}),
        };
        const writeback = stagedWriteback ? {
          version: stagedWriteback.version,
          kind: stagedWriteback.kind,
          target: stagedWriteback.target,
          path: stagedWriteback.path,
          proposal_hash: stagedWriteback.proposal_hash,
        } : null;
        const resumeContext = {
          skill: agentContext?.skillDecision?.skill_name || null,
          runtime: agentContext?.skillDecision?.runtime || null,
          original_user_message: agentContext?.input_data?.user_message || "",
          enhanced_user_query: agentContext?.input_data?.enhanced_user_query || "",
          automation: agentContext?.automation || null,
        };
        const pending = await runtime.requestApproval(
          {
            tool_call_id: callId,
            tool_name: tool.name,
            args,
            args_fingerprint: fingerprint,
            approval_request: approvalRequest,
            writeback,
            ...resumeContext,
          },
          {
            requestId: callId,
            checkpoint: {
              tool: "approval",
              tool_call_id: callId,
              tool_name: tool.name,
              tool_args: args,
              args_fingerprint: fingerprint,
              task_id: agentContext?.task_id || null,
              ...resumeContext,
              project_id: agentContext?.project_id || agentContext?.input_data?.project_id || null,
              session_id: agentContext?.session_id || agentContext?.input_data?.session_id || null,
            },
          },
        );
        const request = {
          ...approvalRequest,
          deferred: true,
          request_id: pending?.request_id || callId,
          run_id: pending?.run_id || runtime.runId || agentContext?.task_id || null,
          project_id: agentContext?.project_id || agentContext?.input_data?.project_id || null,
          session_id: agentContext?.session_id || agentContext?.input_data?.session_id || null,
          resume_handle: pending?.resume_handle || null,
          tool_name: tool.name,
          args_fingerprint: fingerprint,
          writeback,
          ...resumeContext,
        };
        if (agentContext) {
          agentContext.data = agentContext.data || {};
          agentContext.data._suspended_by_approval = true;
          agentContext.data._pending_approval_call_id = callId;
          agentContext.data._pending_approval = request;
        }
        const displayArgs = typeof tool.redactInput === "function" ? tool.redactInput(args || {}) : args;
        await streamCallback?.(`${tool.name} ${shortArgs(displayArgs)}`, {
          content_id: `confirm:${callId}`,
          content_type: "confirm",
          title: tool.name,
          tool_call_id: callId,
          approval_request: request,
        });
        return textResult("等待用户确认。本轮已安全暂停，工具尚未执行。", {
          approval_pending: true,
          request_id: request.request_id,
          tool_name: tool.name,
        });
      },
    };
  });
}

export default { approvalArgsFingerprint, wrapToolsWithDeferredApprovals };

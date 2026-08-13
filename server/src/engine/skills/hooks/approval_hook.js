import { randomUUID } from "node:crypto";

function toolName(ctx) {
  return ctx?.toolCall?.name || "";
}

export class ApprovalHook {
  name = "ApprovalHook";
  priority = 30;

  constructor({
    approval = "ask",
    writeTools = new Set(),
    confirmToolNames = new Set(),
    isExternalTool = () => false,
    streamCallback,
    awaitDecision,
    shortArgs = () => "",
    sandboxPolicy = null,
    onApprovalState = null,
  } = {}) {
    this.approval = approval;
    this.writeTools = writeTools;
    this.confirmToolNames = confirmToolNames;
    this.isExternalTool = isExternalTool;
    this.streamCallback = streamCallback;
    this.awaitDecision = awaitDecision;
    this.shortArgs = shortArgs;
    this.sandboxPolicy = sandboxPolicy;
    this.onApprovalState = onApprovalState;
  }

  needsConfirm(name) {
    const external = this.isExternalTool(name);
    if (this.confirmToolNames.has(name)) return true;
    if (this.approval === "full") return false;
    if (this.approval === "auto") return name === "bash" || external;
    return this.writeTools.has(name) || external;
  }

  approvalRequest(name, args = {}) {
    const external = this.isExternalTool(name);
    const localRunnerTool = this.writeTools.has(name);
    const risk = external
      ? "external_data"
      : name === "bash"
        ? "command_execution"
        : name === "write" || name === "edit"
          ? "file_write"
          : this.confirmToolNames.has(name)
            ? "product_write"
            : "tool_action";
    const target = name === "bash"
      ? String(args.command || "").slice(0, 500)
      : String(args.path || args.provider_name || args.name || "").slice(0, 500);
    return {
      action: name,
      risk,
      target: target || null,
      sandbox: localRunnerTool ? this.sandboxPolicy || null : null,
      network: external
        ? "external_tool"
        : localRunnerTool
          ? this.sandboxPolicy?.network || "unknown"
          : "not_applicable",
      requested_extension: null,
      approval_scope: "once",
    };
  }

  async beforeToolCall(ctx) {
    const name = toolName(ctx);
    if (!this.needsConfirm(name)) return undefined;

    const id = ctx?.toolCall?.id || randomUUID();
    const argStr = this.shortArgs(ctx?.args);
    const approvalRequest = this.approvalRequest(name, ctx?.args);
    if (typeof this.streamCallback === "function") {
      await this.streamCallback(`${name} ${argStr}`, {
        content_id: `confirm:${id}`,
        content_type: "confirm",
        title: name,
        tool_call_id: id,
        approval_request: approvalRequest,
      });
    }
    await this.onApprovalState?.(true, approvalRequest);

    let approved = true;
    if (typeof this.awaitDecision === "function") {
      try {
        approved = await this.awaitDecision(id);
      } catch {
        approved = false;
      }
    }
    await this.onApprovalState?.(false, { ...approvalRequest, approved });

    if (typeof this.streamCallback === "function") {
      await this.streamCallback(`${name} ${argStr}`, {
        content_id: `confirm:${id}`,
        content_type: "confirm",
        title: approved ? "approved" : "rejected",
        tool_call_id: id,
        approval_request: approvalRequest,
        approval_scope: "once",
      });
    }

    if (!approved) return { block: true, reason: "用户拒绝了该写入/执行操作" };
    return undefined;
  }
}

export default ApprovalHook;

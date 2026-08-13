import { ApiError } from "../../errors.js";
import { dshRuntimeEnabled } from "../../engine/dsh_runtime/source_locator.js";
import {
  dshRuntimeStatus,
  probeDshRuntime,
} from "../../engine/dsh_runtime/client.js";
import {
  agentRuntimeStatus,
  probeAgentRuntime as probeRuntimeKernel,
} from "../../engine/agent_kernel/agent_runtime.js";

export async function getAgentRuntimeStatus() {
  return {
    data: dshRuntimeEnabled() ? dshRuntimeStatus() : agentRuntimeStatus(),
    message: "获取 Agent 运行时状态成功",
  };
}

export async function probeAgentRuntime() {
  try {
    if (dshRuntimeEnabled()) {
      const result = await probeDshRuntime();
      return {
        data: {
          running: result.running,
          version: result.version,
          provider: result.provider,
          model: result.model,
          model_count: result.models.length,
          models: result.models,
          failures: result.failures,
        },
        message: "DSH 运行时连接成功",
      };
    }
    const result = await probeRuntimeKernel();
    return {
      data: {
        running: result.running,
        model_count: result.modelCount,
        models: result.models?.data || result.models?.models || [],
      },
      message: "Agent 运行时连接成功",
    };
  } catch (error) {
    console.error(`[agent-runtime] probe failed: ${error?.message || String(error)}`);
    throw new ApiError("Agent 运行时连接失败", 503);
  }
}

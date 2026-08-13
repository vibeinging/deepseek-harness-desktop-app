import test from "node:test";
import assert from "node:assert/strict";
import { getAgentRuntimeStatus } from "../../server/src/app/agents/agent_runtime.js";
import { agentsRoutes } from "../../server/src/transport/registry.agents.js";

test("Agent runtime status is exposed without starting a process", async () => {
  const response = await getAgentRuntimeStatus();
  assert.equal(typeof response.data.available, "boolean");
  assert.equal(response.data.running, false);
  assert.equal("binary" in response.data, false);
  assert.equal("version" in response.data, false);
});

test("Agent runtime routes expose status and explicit probe", () => {
  assert.ok(agentsRoutes.some((route) => route.m === "GET" && route.p === "/api/agents/runtime"));
  assert.ok(agentsRoutes.some((route) => route.m === "POST" && route.p === "/api/agents/runtime/probe"));
  assert.ok(agentsRoutes.some((route) => route.m === "GET" && route.p === "/api/agents/runs/:runId/subagents/:threadId"));
  assert.ok(agentsRoutes.some((route) => route.m === "POST" && route.p === "/api/agents/runs/:runId/subagents/:threadId/stop"));
});

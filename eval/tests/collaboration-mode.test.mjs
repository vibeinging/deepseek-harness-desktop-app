import assert from "node:assert/strict";
import test from "node:test";

import {
  isMutatingHostTool,
  normalizeCollaborationMode,
  scopeToolsForCollaborationMode,
} from "../../server/src/engine/agents/collaboration_mode.js";

test("Plan and Default are separate collaboration modes", () => {
  assert.equal(normalizeCollaborationMode("plan"), "plan");
  assert.equal(normalizeCollaborationMode("default"), "default");
  assert.equal(normalizeCollaborationMode("legacy-plan"), "default");
});

test("Plan mode keeps read tools and removes mutating Host tools", () => {
  const tools = [
    { name: "project_list", side_effect: "read" },
    { name: "web_open", side_effect: "external_read" },
    { name: "project_create", side_effect: "write" },
    { name: "mcp__crm__update", side_effect: "external_write" },
  ];

  assert.equal(isMutatingHostTool(tools[0]), false);
  assert.equal(isMutatingHostTool(tools[2]), true);
  assert.deepEqual(
    scopeToolsForCollaborationMode(tools, "plan").map((tool) => tool.name),
    ["project_list", "web_open"],
  );
  assert.equal(scopeToolsForCollaborationMode(tools, "default"), tools);
});

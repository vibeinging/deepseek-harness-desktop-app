import assert from "node:assert/strict";
import test from "node:test";

import { PermissionPolicy } from "../../server/src/engine/agent_host/permission_policy.js";
import { ToolRegistry } from "../../server/src/engine/agent_host/tool_registry.js";

function tool(name, options = {}) {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [] }),
    ...options,
  };
}

test("PermissionPolicy treats dependencies as requirements and visibility limit as a narrowing rule", () => {
  const policy = new PermissionPolicy({
    allowedTools: ["inspect_schema", "query_sql", "write_annotation"],
    allowedSideEffects: ["none", "intermediate"],
  });
  const activeSkill = {
    name: "query-project-data",
    tool_dependencies: ["inspect_schema", "query_sql", "write_annotation", "unknown_from_skill"],
    tool_visibility_limit: ["inspect_schema", "query_sql", "write_annotation", "unknown_from_skill"],
  };
  const tools = [
    tool("inspect_schema"),
    tool("query_sql", { side_effect: "intermediate" }),
    tool("write_annotation", { side_effect: "project_write" }),
    tool("unknown_from_skill"),
  ];

  assert.deepEqual(policy.effectiveToolNames(tools, { activeSkill }), ["inspect_schema", "query_sql"]);
  assert.equal(policy.decision(tools[2], { activeSkill }).reason, "side_effect_denied");
  assert.equal(policy.decision(tools[3], { activeSkill }).reason, "tool_outside_effective_allowlist");
});

test("an omitted Skill visibility limit does not hide declared dependencies", () => {
  const policy = new PermissionPolicy({
    allowedTools: ["inspect_schema", "query_sql"],
  });
  const activeSkill = {
    tool_dependencies: ["inspect_schema", "query_sql"],
    tool_visibility_limit: [],
  };
  assert.deepEqual(
    policy.effectiveToolNames([tool("inspect_schema"), tool("query_sql")], { activeSkill }),
    ["inspect_schema", "query_sql"],
  );
});

test("Skill dependencies do not grant tools or hide other Host-authorized tools", () => {
  const policy = new PermissionPolicy({
    allowedTools: ["inspect_schema", "query_sql"],
  });
  const activeSkill = { tool_dependencies: ["inspect_schema", "missing_tool"] };
  assert.deepEqual(
    policy.effectiveToolNames([tool("inspect_schema"), tool("query_sql"), tool("missing_tool")], { activeSkill }),
    ["inspect_schema", "query_sql"],
  );
});

test("Skill visibility may narrow Host tools independently from dependency declarations", () => {
  const skill = {
    name: "report-workflow",
    tool_dependencies: ["read_report"],
    tool_visibility_limit: ["format_report"],
  };
  const policy = new PermissionPolicy({ allowedTools: ["read_report", "format_report", "publish_report"] });
  assert.deepEqual(
    policy.effectiveToolNames(
      [tool("read_report"), tool("format_report"), tool("publish_report")],
      { activeSkill: skill },
    ),
    ["format_report"],
  );
});

test("ToolRegistry keeps deferred schemas hidden until explicitly requested and authorized", () => {
  const permissionPolicy = new PermissionPolicy({
    allowedTools: ["inspect_schema", "query_sql", "scan_document"],
    allowedSideEffects: ["none", "intermediate"],
  });
  const tools = new ToolRegistry({ permissionPolicy });
  tools.register(tool("inspect_schema", { plugin_name: "ask-data", exposure: "direct" }));
  tools.register(tool("query_sql", { plugin_name: "ask-data", exposure: "direct", side_effect: "intermediate" }));
  tools.register(tool("scan_document", {
    plugin_name: "ask-data",
    exposure: "deferred",
    capabilities: ["unstructured document retrieval"],
  }));
  const activeSkill = {
    tool_dependencies: ["inspect_schema", "query_sql", "scan_document", "write_annotation"],
  };

  assert.deepEqual(
    tools.listVisible({ activeSkill }).map((item) => item.name),
    ["inspect_schema", "query_sql"],
  );
  assert.deepEqual(
    tools.resolveVisibleTools({ activeSkill, includeDeferred: true, requestedNames: ["scan_document"] })
      .map((item) => item.name),
    ["scan_document"],
  );
  assert.deepEqual(
    tools.search("document retrieval", { activeSkill }).map((item) => item.name),
    ["scan_document"],
  );
});

test("Permission requirements are denied unless the Host grants them", () => {
  const restricted = tool("external_lookup", {
    permission_requirements: ["network.read"],
  });
  const deniedPolicy = new PermissionPolicy({ allowedTools: ["external_lookup"] });
  assert.equal(deniedPolicy.decision(restricted).reason, "permission_missing");

  const allowedPolicy = new PermissionPolicy({
    allowedTools: ["external_lookup"],
    grantedPermissions: ["network.read"],
  });
  assert.equal(allowedPolicy.authorize(restricted), true);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadSkillManifest,
  parseOpenAiMetadata,
} from "../../server/src/engine/skills/skill_file_loader.js";
import { renderSkillsIndexPrompt } from "../../server/src/engine/agents/skill_registry.js";

test("parseOpenAiMetadata reads the Codex interface, dependencies and invocation policy", () => {
  const metadata = parseOpenAiMetadata(`
interface:
  display_name: "Private workflow"
  short_description: "Only run when selected"
dependencies:
  tools:
    - type: cli
      value: private-cli
    - type: mcp
      value: private-mcp
policy:
  allow_implicit_invocation: false
`);
  assert.equal(metadata.interface.display_name, "Private workflow");
  assert.deepEqual(metadata.dependencies.tools, [
    { type: "cli", value: "private-cli" },
    { type: "mcp", value: "private-mcp" },
  ]);
  assert.equal(metadata.policy.allow_implicit_invocation, false);
});

test("loadSkillManifest respects agents/openai.yaml without treating it as a permission grant", async () => {
  const temp = await mkdtemp(join(tmpdir(), "dsh-skill-loader-"));
  try {
    const skillRoot = join(temp, "private-workflow");
    await mkdir(join(skillRoot, "agents"), { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: private-workflow\ndescription: Run a private workflow.\n---\n\n# Workflow\n",
      "utf8",
    );
    await writeFile(
      join(skillRoot, "agents", "openai.yaml"),
      "interface:\n  display_name: Private workflow\ndependencies:\n  tools:\n    - type: cli\n      value: private-cli\n    - type: mcp\n      value: private-mcp\npolicy:\n  allow_implicit_invocation: false\n",
      "utf8",
    );

    const skill = loadSkillManifest(skillRoot, { builtin: false });
    assert.equal(skill.name, "private-workflow");
    assert.equal(skill.allow_implicit_invocation, false);
    assert.equal(skill.interface.display_name, "Private workflow");
    assert.deepEqual(skill.tool_dependencies, []);
    assert.deepEqual(skill.tool_visibility_limit, []);
    assert.deepEqual(skill.required_bins, ["private-cli"]);
    assert.deepEqual(skill.required_mcp_servers, ["private-mcp"]);
    assert.deepEqual(skill.dependencies.tools, [
      { type: "cli", value: "private-cli" },
      { type: "mcp", value: "private-mcp" },
    ]);
    assert.doesNotMatch(renderSkillsIndexPrompt([{ ...skill, is_enabled: true }]), /private-workflow/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

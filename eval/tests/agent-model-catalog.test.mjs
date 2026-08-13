import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAgentModelCatalog,
  ensureAgentModelCatalog,
  PROJECT_MODEL_BASE_INSTRUCTIONS,
} from "../../server/src/engine/agent_kernel/model_catalog.js";

const bundledCatalog = {
  models: [{
    slug: "gpt-5.2",
    display_name: "GPT-5.2",
    base_instructions: "You are GPT-5.2 running in the Codex CLI.",
    model_messages: { instructions_template: "You are Codex, an agent based on GPT-5." },
  }],
};

test("project model catalog uses configured capabilities and a model-independent prompt", () => {
  const catalog = buildAgentModelCatalog({
    model_name: "qwen3.7-plus",
    extra_config: {
      supports_image_input: true,
      agent_runtime: {
        context_window: 1_000_000,
        reasoning_effort: "medium",
        reasoning_summary: "auto",
        verbosity: "medium",
      },
    },
  }, bundledCatalog);
  const model = catalog.models.find((entry) => entry.slug === "qwen3.7-plus");
  assert.equal(model.context_window, 1_000_000);
  assert.equal(model.max_context_window, 1_000_000);
  assert.equal(model.default_reasoning_level, "medium");
  assert.deepEqual(model.input_modalities, ["text", "image"]);
  assert.equal(model.support_verbosity, false);
  assert.equal(model.default_verbosity, null);
  assert.equal(model.used_fallback_model_metadata, undefined);
  assert.equal(model.base_instructions, PROJECT_MODEL_BASE_INSTRUCTIONS);
  assert.doesNotMatch(model.base_instructions, /\b(?:gpt|codex|openai)\b/i);
  assert.notEqual(model.base_instructions, bundledCatalog.models[0].base_instructions);
  assert.equal(model.model_messages, undefined);
  assert.equal(model.include_skills_usage_instructions, true);
  assert.equal(model.include_plugin_usage_instructions, true);
  assert.equal(model.include_apps_usage_instructions, true);
  assert.equal(model.multi_agent_version, 'v2');
});

test("project model catalog does not infer capabilities from the model name", () => {
  const catalog = buildAgentModelCatalog({ model_name: "qwen3.7-plus" }, bundledCatalog);
  const model = catalog.models.find((entry) => entry.slug === "qwen3.7-plus");
  assert.equal(model.context_window, 272_000);
  assert.equal(model.max_context_window, 272_000);
  assert.deepEqual(model.input_modalities, ["text"]);
  assert.equal(model.supports_parallel_tool_calls, false);
});

test("project model catalog is written once under the Agent runtime home", async (t) => {
  const runtimeHome = await mkdtemp(join(tmpdir(), "agent-model-catalog-"));
  t.after(() => rm(runtimeHome, { recursive: true, force: true }));
  const config = {
    model_name: "private-project-model",
    extra_config: { agent_runtime: { context_window: 131_072 } },
  };
  const first = await ensureAgentModelCatalog(config, { runtimeHome, bundledCatalog });
  const second = await ensureAgentModelCatalog(config, { runtimeHome, bundledCatalog });
  assert.equal(first.path, second.path);
  assert.equal(first.revision, second.revision);
  assert.equal(first.model.context_window, 131_072);
  assert.deepEqual(first.args, ["-c", `model_catalog_json=${JSON.stringify(first.path)}`, "app-server"]);
  const saved = JSON.parse(await readFile(first.path, "utf8"));
  assert.equal(saved.models.at(-1).slug, "private-project-model");
});

import test from "node:test";
import assert from "node:assert/strict";
import { applyAgentProjectSettings, applyAgentRuntimeSettings, createAgentModelBinding } from "../../server/src/engine/agent_kernel/model_provider.js";
import { getProjectAgentSettings, updateProjectAgentSettings } from "../../server/src/app/models/index.js";

test("Agent model binding routes a Responses model through the shared local gateway without exposing its key", async () => {
  let registered = null;
  const chatAdapter = {
    register: async (providerId, config) => {
      registered = { providerId, config };
      return {
        baseUrl: `http://127.0.0.1:43123/providers/${providerId}/v1`,
        accessToken: "shared-loopback-token",
      };
    },
  };
  const binding = await createAgentModelBinding({
    id: "model-1",
    model_name: "gpt-data",
    api_base: "https://models.example.com/v1/",
    api_key: "secret-value",
    api_format: "responses",
    extra_config: {
      extra_headers: { "X-Tenant": "tenant-1" },
      agent_runtime: {
        reasoning_effort: "high",
        reasoning_summary: "concise",
        verbosity: "low",
        context_window: 128000,
        auto_compact_token_limit: 100000,
      },
    },
  }, { chatAdapter });
  assert.equal(binding.source, "project_model");
  assert.equal(binding.threadOptions.model, "gpt-data");
  assert.match(binding.threadOptions.modelProvider, /^dsh_[a-f0-9]+$/);
  const provider = binding.threadOptions.config.model_providers[binding.threadOptions.modelProvider];
  assert.match(provider.base_url, /^http:\/\/127\.0\.0\.1:43123\/providers\/dsh_[a-f0-9]+\/v1$/);
  assert.equal(provider.wire_api, "responses");
  assert.equal(provider.requires_openai_auth, false);
  assert.equal(provider.supports_websockets, false);
  assert.equal(provider.http_headers, undefined);
  assert.equal(binding.threadOptions.config.model_reasoning_effort, "high");
  assert.equal(binding.threadOptions.config.model_reasoning_summary, "concise");
  assert.equal(binding.threadOptions.config.model_verbosity, "low");
  assert.equal(binding.threadOptions.config.model_context_window, 128000);
  assert.equal(binding.threadOptions.config.model_auto_compact_token_limit, 100000);
  assert.equal(provider.env_key, "DSH_AGENT_MODEL_GATEWAY_TOKEN");
  assert.equal(binding.kernelOptions.env[provider.env_key], "shared-loopback-token");
  assert.match(binding.runtimeKey, /^dsh-model-gateway-runtime:[a-f0-9]{24}$/);
  assert.equal(binding.kernelOptions.args[0], "-c");
  assert.match(binding.kernelOptions.args[1], /^model_catalog_json=".+\.json"$/);
  assert.equal(binding.kernelOptions.args.at(-1), "app-server");
  assert.equal(binding.snapshot.transport, "responses_gateway");
  assert.equal(binding.snapshot.model_catalog.context_window, 128000);
  assert.deepEqual(registered.config.extra_config.extra_headers, { "X-Tenant": "tenant-1" });
  assert.doesNotMatch(JSON.stringify(binding.threadOptions), /secret-value/);
  assert.doesNotMatch(JSON.stringify(binding.snapshot), /secret-value/);
});

test("Agent model binding keeps legacy onboarding context windows compatible", async () => {
  const binding = await createAgentModelBinding({
    model_name: "legacy-model",
    api_base: "https://models.example.com/v1",
    api_key: "secret-value",
    api_format: "responses",
    extra_config: { context_window: 65536 },
  });
  assert.equal(binding.threadOptions.config.model_context_window, 65536);
});

test("Agent model binding leaves automatic compaction enabled by runtime default", async () => {
  const binding = await createAgentModelBinding({
    model_name: "default-compaction-model",
    api_base: "https://models.example.com/v1",
    api_key: "secret-value",
    api_format: "responses",
    extra_config: { agent_runtime: { context_window: 128000 } },
  });
  assert.equal(binding.threadOptions.config.model_context_window, 128000);
  assert.equal(binding.threadOptions.config.model_auto_compact_token_limit, undefined);
});

test("Project Agent settings override the provider reasoning default", async () => {
  const binding = await createAgentModelBinding({
    model_name: "gpt-data",
    api_base: "https://models.example.com/v1",
    api_key: "secret-value",
    api_format: "responses",
    extra_config: {
      agent_runtime: { reasoning_effort: "low", reasoning_efforts: ["low", "xhigh"] },
    },
  });
  applyAgentProjectSettings(binding, { reasoning_effort: "xhigh" });
  assert.equal(binding.threadOptions.config.model_reasoning_effort, "xhigh");
  assert.equal(binding.snapshot.agent_runtime.model_reasoning_effort, "xhigh");
});

test("Conversation settings override reasoning and answer detail for the selected model", async () => {
  const binding = await createAgentModelBinding({
    model_name: "gpt-data",
    api_base: "https://models.example.com/v1",
    api_key: "secret-value",
    api_format: "responses",
    extra_config: {
      agent_runtime: {
        reasoning_efforts: ["medium", "high"],
        reasoning_summaries: ["auto"],
        verbosity_levels: ["low", "medium"],
      },
    },
  });
  applyAgentRuntimeSettings(binding, { reasoningEffort: "high", reasoningSummary: "auto", verbosity: "low" });
  assert.equal(binding.threadOptions.config.model_reasoning_effort, "high");
  assert.equal(binding.threadOptions.config.model_verbosity, "low");
  assert.equal(binding.threadOptions.config.model_reasoning_summary, "auto");
  assert.equal(binding.snapshot.agent_runtime.model_reasoning_effort, "high");
  assert.equal(binding.snapshot.agent_runtime.model_verbosity, "low");
});

test("Conversation settings ignore values the selected model does not support", async () => {
  const binding = await createAgentModelBinding({
    model_name: "plain-model",
    api_base: "https://models.example.com/v1",
    api_key: "secret-value",
    api_format: "responses",
    extra_config: { agent_runtime: { reasoning_efforts: ["low"], verbosity_levels: [] } },
  });
  applyAgentRuntimeSettings(binding, { reasoningEffort: "high", verbosity: "high" });
  assert.equal(binding.threadOptions.config.model_reasoning_effort, undefined);
  assert.equal(binding.threadOptions.config.model_verbosity, undefined);
  assert.equal(binding.snapshot.capabilities.reasoning_effort_default, "");
});

test("Project Agent settings persist supported effort and default to medium", async () => {
  let saved = null;
  const ctx = {
    queryOne: async () => saved,
    query: async (_sql, params) => {
      saved = { reasoning_effort: params[1] };
      return [];
    },
  };
  const input = { params: { pid: "project-1" }, body: { reasoning_effort: "xhigh" } };
  assert.deepEqual((await getProjectAgentSettings(ctx, input)).data, { reasoning_effort: "medium" });
  assert.deepEqual((await updateProjectAgentSettings(ctx, input)).data, { reasoning_effort: "xhigh" });
  assert.deepEqual((await getProjectAgentSettings(ctx, input)).data, { reasoning_effort: "xhigh" });
});

test("Project Agent settings reject ultra in the single-Agent product", async () => {
  const ctx = { query: async () => assert.fail("invalid setting must not be persisted") };
  await assert.rejects(
    updateProjectAgentSettings(ctx, {
      params: { pid: "project-1" },
      body: { reasoning_effort: "ultra" },
    }),
    /无效的推理强度/,
  );
});

test("Agent model binding adapts a Chat Completions project model instead of falling back", async () => {
  const chatAdapter = {
    register: async (providerId) => ({
      baseUrl: `http://127.0.0.1:43123/providers/${providerId}/v1`,
      accessToken: "loopback-token",
    }),
  };
  const binding = await createAgentModelBinding({
    id: "model-chat",
    model_name: "qwen3.7-plus",
    api_base: "https://models.example.com/v1",
    api_key: "chat-secret",
    api_format: "chat_completions",
    extra_config: {
      supports_image_input: true,
      agent_runtime: { context_window: 1_000_000 },
    },
  }, { chatAdapter });
  assert.equal(binding.source, "project_model");
  const provider = binding.threadOptions.config.model_providers[binding.threadOptions.modelProvider];
  assert.match(provider.base_url, /^http:\/\/127\.0\.0\.1:\d+\/providers\/dsh_[a-f0-9]+\/v1$/);
  assert.equal(provider.wire_api, "responses");
  assert.equal(binding.kernelOptions.env[provider.env_key], "loopback-token");
  assert.equal(binding.snapshot.api_base, "https://models.example.com/v1");
  assert.equal(binding.snapshot.api_format, "chat_completions");
  assert.equal(binding.snapshot.transport, "chat_completions_adapter");
  assert.equal(binding.snapshot.model_catalog.context_window, 1_000_000);
  assert.deepEqual(binding.snapshot.model_catalog.input_modalities, ["text", "image"]);
  assert.doesNotMatch(JSON.stringify(binding.threadOptions), /chat-secret|models\.example\.com/);
});

test("Responses models use the parameter adapter when a request key or API value differs", async () => {
  let registered = null;
  const chatAdapter = {
    register: async (providerId, config) => {
      registered = { providerId, config };
      return {
        baseUrl: `http://127.0.0.1:43123/providers/${providerId}/v1`,
        accessToken: "parameter-adapter-token",
      };
    },
  };
  const binding = await createAgentModelBinding({
    id: "model-custom-reasoning",
    model_name: "custom-reasoning",
    api_base: "https://models.example.com/v1",
    api_key: "responses-secret",
    api_format: "responses",
    extra_config: {
      agent_runtime: {
        parameters: {
          reasoning_effort: {
            request_key: "thinking.level",
            options: [
              { value: "medium", label: "均衡", api_value: "balanced" },
              { value: "high", label: "深入", api_value: "deep" },
            ],
            default: "medium",
          },
        },
      },
    },
  }, { chatAdapter });
  const provider = binding.threadOptions.config.model_providers[binding.threadOptions.modelProvider];
  assert.equal(binding.snapshot.transport, "responses_parameter_adapter");
  assert.match(provider.base_url, /^http:\/\/127\.0\.0\.1:43123\/providers\//);
  assert.equal(binding.kernelOptions.env[provider.env_key], "parameter-adapter-token");
  assert.equal(binding.snapshot.capabilities.reasoning_effort_default, "medium");
  assert.deepEqual(binding.snapshot.capabilities.reasoning_effort_options, [
    { value: "medium", label: "均衡" },
    { value: "high", label: "深入" },
  ]);
  assert.equal(registered.config.model_name, "custom-reasoning");
});

test("Agent model binding requires a complete project model", async () => {
  await assert.rejects(
    createAgentModelBinding({ api_format: "chat_completions" }),
    { code: "AGENT_MODEL_PROVIDER_INVALID" },
  );
});

test("Agent account mode is not available in Dsh", async () => {
  await assert.rejects(
    createAgentModelBinding({}, { mode: "account" }),
    { code: "AGENT_ACCOUNT_MODEL_UNAVAILABLE" },
  );
});

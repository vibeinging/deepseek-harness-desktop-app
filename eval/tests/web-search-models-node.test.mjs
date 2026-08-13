import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { query, queryOne } from "../../server/src/db.js";
import {
  createProjectWebSearchModel,
  deleteProjectWebSearchModel,
  getProjectWebSearchModel,
  inferProjectWebSearchResponseMappings,
  listProjectWebSearchModels,
  qaTestProjectWebSearchModel,
  requestWebSearchRaw,
  testProjectWebSearchModel,
  updateProjectWebSearchModel,
} from "../../server/src/app/models/web_search_models.js";
import { getBusinessDataSources } from "../../server/src/app/reads/reads_business.js";
import { BusinessDataSources } from "../../server/src/engine/datasources/business_data_sources.js";
import { modelsRoutes } from "../../server/src/transport/registry.models.js";
import { makeRouter } from "../../server/src/transport/router.js";

async function projectFixture(context) {
  const projectId = randomUUID();
  const userId = `web-search-user-${randomUUID()}`;
  await query(
    "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,$2,'active',now(),now())",
    [projectId, `Web Search ${projectId.slice(0, 8)}`],
  );
  await query(
    `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
     VALUES ($1,$2,$3,1,now(),now())`,
    [randomUUID(), projectId, userId],
  );
  context.after(async () => {
    await query("DELETE FROM business_data_sources WHERE project_id=$1", [projectId]);
    await query("DELETE FROM web_search_models WHERE project_id=$1", [projectId]);
    await query("DELETE FROM project_members WHERE project_id=$1", [projectId]);
    await query("DELETE FROM projects WHERE id=$1", [projectId]);
  });
  return { projectId, userId };
}

function customBody(overrides = {}) {
  return {
    name: "Custom Search",
    model: "custom",
    api: "top-secret-search-key",
    description: "Node registry test",
    config_type: "custom",
    custom_config: {
      endpoint: "https://search.example.test/v1/search",
      method: "POST",
      request_params: {
        headers: {
          Authorization: "Bearer custom-header-secret",
          "X-API-Key": "custom-x-api-key-secret",
          Accept: "application/json",
        },
        body: {
          q: "{{query}}",
          limit: "{{max_results}}",
          client_secret: "custom-client-secret",
          nested: [{ bearer_token: "custom-bearer-token" }],
        },
      },
      response_mappings: {
        results_path: "data.items",
        fields: { title: "name", url: "link", snippet: "summary", source: "site", date: "published" },
      },
    },
    ...overrides,
  };
}

test("WebSearch Node registry implements ordered CRUD/test/qa/infer and never returns API keys", async (context) => {
  const { projectId, userId } = await projectFixture(context);
  const requests = [];
  const rawResponse = {
    data: {
      items: [{
        name: "Result one",
        link: "https://example.test/result-one",
        summary: "Summary one",
        site: "Example",
        published: "2026-08-09",
      }],
      access_token: "upstream-access-token",
      nested: [{ client_secret: "upstream-client-secret" }],
    },
    auth: "upstream-auth-value",
    credentials: { bearer_token: "upstream-bearer-token" },
  };
  const ctx = {
    query,
    queryOne,
    userId,
    async resolveHost() {
      return [{ address: "93.184.216.34", family: 4 }];
    },
    proxyConfigured: false,
    async fetch(url, init) {
      requests.push({ url, init });
      return new Response(JSON.stringify(rawResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async runStructuredAi(options) {
      return {
        data: options.validate({
          response_mappings: {
            results_path: "data.items",
            fields: { title: "name", url: "link", snippet: "summary", source: "site", date: "published" },
          },
        }),
        attempts: 1,
      };
    },
  };

  const created = await createProjectWebSearchModel(ctx, { params: { pid: projectId }, body: customBody() });
  const modelId = created.data.id;
  assert.ok(modelId);
  const createdBinding = await queryOne(
    `SELECT id FROM business_data_sources
      WHERE project_id=$1 AND source_type='web_search_model' AND source_id=$2 AND deleted_at IS NULL`,
    [projectId, modelId],
  );
  assert.ok(createdBinding?.id, "新建网络搜索配置后必须自动绑定到项目");
  const createdSources = new BusinessDataSources(projectId, projectId);
  await createdSources.load_sources();
  assert.equal(createdSources.web_search_configs.has("Custom Search"), true);
  assert.equal(createdSources.web_search_configs.get("Custom Search").id, modelId);
  assert.equal(createdSources.web_search_configs.get("Custom Search").config_type, "custom");
  assert.equal(
    createdSources.web_search_configs.get("Custom Search").custom_config.endpoint,
    "https://search.example.test/v1/search",
  );
  assert.equal(createdSources.web_search_configs.get("Custom Search").is_default, true);
  const publicOverview = await getBusinessDataSources(ctx, { params: { pid: projectId } });
  assert.equal(publicOverview.data.web_search_models.length, 1);
  assert.equal(publicOverview.data.web_search_models[0].api, "********");
  assert.equal(publicOverview.data.web_search_models[0].custom_config, undefined);
  assert.doesNotMatch(
    JSON.stringify(publicOverview.data.web_search_models),
    /top-secret-search-key|search\.example\.test|request_params|Authorization|X-API-Key|\{\{query\}\}|custom-(?:client-secret|bearer-token)/,
  );
  assert.equal(created.data.api, "********");
  assert.doesNotMatch(JSON.stringify(created.data), /top-secret-search-key/);
  assert.doesNotMatch(JSON.stringify(created.data), /custom-(?:header|x-api-key)-secret/);
  assert.doesNotMatch(JSON.stringify(created.data), /custom-(?:client-secret|bearer-token)/);
  assert.equal(created.data.custom_config.request_params.headers.Authorization, "********");
  assert.equal(created.data.custom_config.request_params.headers["X-API-Key"], "********");
  assert.equal(created.data.custom_config.request_params.headers.Accept, "********");
  assert.equal(
    (await queryOne("SELECT api FROM web_search_models WHERE id=$1", [modelId])).api,
    "top-secret-search-key",
  );

  const listed = await listProjectWebSearchModels(ctx, { params: { pid: projectId }, query: {} });
  assert.equal(listed.data.total, 1);
  assert.deepEqual(listed.data.supported_types, [
    { value: "bocha", label: "博查" },
    { value: "serper", label: "Serper" },
    { value: "tavily", label: "Tavily" },
    { value: "perplexity", label: "Perplexity" },
    { value: "serpapi", label: "SerpApi" },
    { value: "custom", label: "自定义" },
  ]);
  assert.equal(listed.data.items[0].api, "********");
  assert.doesNotMatch(JSON.stringify(listed.data), /top-secret-search-key|custom-(?:header|x-api-key)-secret/);
  const detail = await getProjectWebSearchModel(ctx, { params: { pid: projectId, modelId } });
  assert.equal(detail.data.api, "********");
  assert.equal(detail.data.custom_config.endpoint, "https://search.example.test/v1/search");
  assert.doesNotMatch(JSON.stringify(detail.data), /top-secret-search-key|custom-(?:header|x-api-key)-secret/);

  const updated = await updateProjectWebSearchModel(ctx, {
    params: { pid: projectId, modelId },
    body: {
      ...customBody({ name: "Updated Search", api: "********" }),
      custom_config: detail.data.custom_config,
    },
  });
  assert.equal(updated.data.name, "Updated Search");
  assert.equal(updated.data.api, "********");
  assert.doesNotMatch(JSON.stringify(updated.data), /top-secret-search-key|custom-(?:header|x-api-key)-secret/);
  assert.equal(
    (await queryOne("SELECT api FROM web_search_models WHERE id=$1", [modelId])).api,
    "top-secret-search-key",
  );
  const storedCustom = JSON.parse((await queryOne("SELECT custom_config FROM web_search_models WHERE id=$1", [modelId])).custom_config);
  assert.equal(storedCustom.request_params.headers.Authorization, "Bearer custom-header-secret");
  assert.equal(storedCustom.request_params.headers["X-API-Key"], "custom-x-api-key-secret");
  assert.equal(storedCustom.request_params.headers.Accept, "application/json");
  assert.equal(storedCustom.request_params.body.client_secret, "custom-client-secret");
  assert.equal(storedCustom.request_params.body.nested[0].bearer_token, "custom-bearer-token");

  await query(
    `UPDATE business_data_sources SET deleted_at=now(), deleted_by='legacy-gap', updated_at=now()
      WHERE project_id=$1 AND source_type='web_search_model' AND source_id=$2`,
    [projectId, modelId],
  );
  await updateProjectWebSearchModel(ctx, {
    params: { pid: projectId, modelId },
    body: { ...customBody({ name: "Updated Search", api: "********" }), custom_config: detail.data.custom_config },
  });
  const repairedBinding = await queryOne(
    `SELECT id, deleted_at, deleted_by FROM business_data_sources
      WHERE project_id=$1 AND source_type='web_search_model' AND source_id=$2 AND deleted_at IS NULL`,
    [projectId, modelId],
  );
  assert.equal(repairedBinding?.id, createdBinding.id, "更新旧配置时应恢复原绑定，不应重复创建");
  assert.equal(repairedBinding.deleted_at, null);
  assert.equal(repairedBinding.deleted_by, null);

  const tested = await testProjectWebSearchModel(ctx, {
    params: { pid: projectId },
    body: customBody(),
  });
  assert.equal(tested.data.data.raw_response.data.access_token, "********");
  assert.equal(tested.data.data.raw_response.data.nested[0].client_secret, "********");
  assert.equal(tested.data.data.raw_response.auth, "********");
  assert.equal(tested.data.data.raw_response.credentials, "********");
  assert.doesNotMatch(
    JSON.stringify(tested.data),
    /upstream-(?:access-token|client-secret|auth-value|bearer-token)/,
  );
  const testRequest = JSON.parse(requests.at(-1).init.body);
  assert.equal(testRequest.q, "DSH connection test");
  assert.equal(testRequest.limit, "3");

  const presetCreated = await createProjectWebSearchModel(ctx, {
    params: { pid: projectId },
    body: {
      name: "Saved Tavily",
      model: "tavily",
      api: "saved-preset-secret",
      config_type: "preset",
    },
  });
  const savedPresetTest = await testProjectWebSearchModel(ctx, {
    params: { pid: projectId },
    body: { model_id: presetCreated.data.id },
  });
  assert.equal(savedPresetTest.data.success, true);
  assert.equal(JSON.parse(requests.at(-1).init.body).api_key, "saved-preset-secret");

  const qa = await qaTestProjectWebSearchModel(ctx, {
    params: { pid: projectId },
    body: { model_id: modelId, query: "real question" },
  });
  assert.equal(qa.data.model, "custom");
  assert.deepEqual(qa.data.results, [{
    title: "Result one",
    url: "https://example.test/result-one",
    snippet: "Summary one",
    source: "Example",
    date: "2026-08-09",
  }]);
  assert.equal(JSON.parse(requests.at(-1).init.body).q, "real question");

  const inferred = await inferProjectWebSearchResponseMappings(ctx, {
    params: { pid: projectId },
    body: { raw_response: rawResponse },
  });
  assert.deepEqual(inferred.data, {
    response_mappings: {
      results_path: "data.items",
      fields: { title: "name", url: "link", snippet: "summary", source: "site", date: "published" },
    },
  });

  const match = makeRouter(modelsRoutes);
  for (const literal of ["test-connection", "qa-test", "infer-response-mappings"]) {
    const hit = match("POST", `/api/projects/${projectId}/web-search-models/${literal}`);
    assert.equal(hit.route.p.endsWith(`/${literal}`), true, `${literal} 不能被 :modelId 抢先匹配`);
  }
  assert.deepEqual(
    modelsRoutes.filter((route) => route.p.includes("web-search-models")).map((route) => route.m),
    ["GET", "POST", "POST", "POST", "POST", "GET", "PUT", "DELETE"],
  );

  const deleted = await deleteProjectWebSearchModel(ctx, { params: { pid: projectId, modelId } });
  assert.equal(deleted.data, null);
  assert.equal(
    await queryOne(
      `SELECT id FROM business_data_sources
        WHERE project_id=$1 AND source_type='web_search_model' AND source_id=$2 AND deleted_at IS NULL`,
      [projectId, modelId],
    ),
    null,
    "删除网络搜索配置时必须同步解除项目绑定",
  );
  await assert.rejects(
    getProjectWebSearchModel(ctx, { params: { pid: projectId, modelId } }),
    (error) => error.status === 404,
  );
});

test("WebSearch list safely repairs legacy unbound configs for query source discovery", async (context) => {
  const { projectId, userId } = await projectFixture(context);
  const modelId = randomUUID();
  await query(
    `INSERT INTO web_search_models
       (id, project_id, name, model, api, description, config_type, custom_config, is_default, created_at, updated_at)
     VALUES ($1,$2,'Legacy Search','tavily','legacy-secret','Legacy unbound row','preset','{}',true,now(),now())`,
    [modelId, projectId],
  );
  const ctx = { query, queryOne, userId };

  const directSources = new BusinessDataSources(projectId, projectId);
  await directSources.load_sources();
  assert.equal(directSources.web_search_configs.has("Legacy Search"), true);
  assert.equal(directSources.web_search_configs.get("Legacy Search").id, modelId);
  assert.equal(directSources.web_search_configs.get("Legacy Search").is_default, true);
  assert.equal(
    await queryOne(
      `SELECT id FROM business_data_sources
        WHERE project_id=$1 AND source_type='web_search_model' AND source_id=$2 AND deleted_at IS NULL`,
      [projectId, modelId],
    ),
    null,
    "直接问数的兼容读取不能隐式写入绑定",
  );

  await listProjectWebSearchModels(ctx, { params: { pid: projectId }, query: {} });
  await listProjectWebSearchModels(ctx, { params: { pid: projectId }, query: {} });

  const bindings = await query(
    `SELECT id FROM business_data_sources
      WHERE project_id=$1 AND source_type='web_search_model' AND source_id=$2 AND deleted_at IS NULL`,
    [projectId, modelId],
  );
  assert.equal(bindings.length, 1, "旧配置补偿必须幂等");

  const sources = new BusinessDataSources(projectId, projectId);
  await sources.load_sources();
  assert.equal(sources.web_search_configs.has("Legacy Search"), true);
  assert.equal(sources.web_search_configs.get("Legacy Search").model, "tavily");
});

test("WebSearch outbound guard blocks private DNS answers, IPv6 literals, metadata and redirects", async () => {
  const configFor = (endpoint) => customBody({
    custom_config: {
      ...customBody().custom_config,
      endpoint,
    },
  });
  const neverFetch = async () => {
    assert.fail("blocked endpoint must not reach fetch");
  };
  for (const endpoint of [
    "http://127.0.0.1/search",
    "http://10.0.0.8/search",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/search",
    "http://[fd00::1]/search",
    "http://metadata.google.internal/computeMetadata/v1",
  ]) {
    await assert.rejects(
      requestWebSearchRaw(configFor(endpoint), "secret target", {
        fetchFn: neverFetch,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
        proxyConfigured: false,
      }),
      (error) => error.code === "WEB_SEARCH_OUTBOUND_BLOCKED",
      endpoint,
    );
  }

  await assert.rejects(
    requestWebSearchRaw(configFor("https://mixed-answer.example/search"), "mixed dns", {
      fetchFn: neverFetch,
      resolveHost: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "192.168.1.20", family: 4 },
      ],
      proxyConfigured: false,
    }),
    (error) => error.code === "WEB_SEARCH_OUTBOUND_BLOCKED",
  );

  let fetchCount = 0;
  await assert.rejects(
    requestWebSearchRaw(configFor("https://public-search.example/search"), "redirect", {
      resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
      proxyConfigured: false,
      async fetchFn(_url, init) {
        fetchCount += 1;
        assert.equal(init.redirect, "manual");
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      },
    }),
    (error) => error.code === "WEB_SEARCH_REQUEST_FAILED" && /不允许跳转/.test(error.message),
  );
  assert.equal(fetchCount, 1);
});

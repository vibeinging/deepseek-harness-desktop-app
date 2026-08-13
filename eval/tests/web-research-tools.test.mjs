import assert from "node:assert/strict";
import test from "node:test";
import { parseDuckDuckGoHtml, WebSearchTool } from "../../server/src/engine/tools/web_search_tool.js";
import { ProjectWebSearchTool } from "../../server/src/engine/tools/project_web_search_tool.js";
import {
  validateWebCitationMarkers,
  webCitationPolicyFailure,
} from "../../server/src/app/chat/agent_chat.js";
import { finalizeTurnAnswer } from "../../server/src/engine/core/turn_finalizer.js";

test("completed App Server turns use the Runtime terminal item as the final answer", () => {
  const items = [
    { id: "progress", type: "markdown", title: "进展", content: "正在查询", metadata: { phase: "commentary" } },
    { id: "tool", type: "tool", content: "execute_readonly_sql" },
    { id: "answer", type: "markdown", title: "进展", content: "共有 3 个不同城市", metadata: { phase: "commentary" } },
  ];
  const final = finalizeTurnAnswer({
    items,
    answerItemId: "answer",
    turnStatus: "completed",
    capabilityStatus: "completed",
  });
  assert.equal(final.item.id, "answer");
  assert.equal(final.item.metadata.answer_status, "accepted");
  assert.equal(Object.hasOwn(final.item.metadata, "phase"), false);
  assert.equal(Object.hasOwn(final.item.metadata, "msg_category"), false);
});
import {
  createWebResearchSession,
  createWebTools,
  extractWebPage,
  isPrivateNetworkAddress,
} from "../../server/src/engine/agents/web_tools.js";

const SEARCH_HTML = `
<div class="result">
  <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fnews" rel="nofollow" class="result__a">Example News</a>
  <a class="result__snippet">The latest verified example.</a>
</div>`;

const ARTICLE_HTML = `<!doctype html><html><head>
  <title>Verified Example</title>
  <link rel="canonical" href="https://example.com/news">
  <meta property="article:published_time" content="2026-07-31">
  <script>ignore me</script>
</head><body><main><h1>Verified Example</h1><p>Revenue reached 42 units.</p></main></body></html>`;

test("DuckDuckGo HTML results are normalized as real result URLs", () => {
  assert.deepEqual(parseDuckDuckGoHtml(SEARCH_HTML), [{
    title: "Example News",
    url: "https://example.com/news",
    snippet: "The latest verified example.",
    displayed_link: "example.com",
    source: "DuckDuckGo",
  }]);
});

test("web research searches, opens actual page text, finds evidence and records sources", async () => {
  const requests = [];
  const session = createWebResearchSession({
    env: {},
    resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async (url) => {
      requests.push(String(url));
      if (String(url).startsWith("https://html.duckduckgo.com/")) {
        return new Response(SEARCH_HTML, { headers: { "content-type": "text/html" } });
      }
      return new Response(ARTICLE_HTML, { headers: { "content-type": "text/html" } });
    },
  });

  const searched = await session.search("example latest");
  assert.equal(searched.results[0].result_id, "R1");
  const opened = await session.open({ resultId: "R1" });
  assert.equal(opened.source.source_id, "S1");
  assert.equal(opened.source.title, "Verified Example");
  assert.match(opened.content, /Revenue reached 42 units/);
  assert.doesNotMatch(opened.content, /ignore me/);
  const found = session.find("S1", "42 units");
  assert.equal(found.matches.length, 1);
  assert.match(found.matches[0].excerpt, /42 units/);
  const recorded = session.getSources()[0];
  assert.equal(recorded.published_at, "2026-07-31");
  assert.match(recorded.excerpt, /42 units/);
  assert.equal(recorded.anchor.start, found.matches[0].start);
  assert.deepEqual(session.getActivity(), { search_count: 1, open_count: 1, find_count: 1 });
  assert.equal(requests.length, 2);
});

test("web open blocks local and private network targets before fetch", async () => {
  let fetched = false;
  const session = createWebResearchSession({
    env: {},
    fetchImpl: async () => { fetched = true; return new Response(ARTICLE_HTML); },
  });
  await assert.rejects(session.open({ url: "http://127.0.0.1:3000/private" }), /不能访问本机或局域网地址/);
  assert.equal(fetched, false);
  assert.equal(isPrivateNetworkAddress("10.0.0.1"), true);
  assert.equal(isPrivateNetworkAddress("172.31.5.8"), true);
  assert.equal(isPrivateNetworkAddress("ff02::1"), true);
  assert.equal(isPrivateNetworkAddress("8.8.8.8"), false);
});

test("web open can use a separately verified public address behind a private egress resolver", async () => {
  let fetched = false;
  const session = createWebResearchSession({
    env: {},
    resolveHost: async () => [{ address: "172.19.0.80", family: 4 }],
    resolvePublicHost: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchImpl: async () => {
      fetched = true;
      return new Response(ARTICLE_HTML, { headers: { "content-type": "text/html" } });
    },
  });
  const opened = await session.open({ url: "https://example.com/news" });
  assert.equal(fetched, true);
  assert.equal(opened.source.source_id, "S1");
  assert.match(opened.content, /42 units/);
});

test("page extraction keeps useful text and off mode performs no network request", async () => {
  const page = extractWebPage(ARTICLE_HTML, "https://example.com/news");
  assert.equal(page.title, "Verified Example");
  assert.match(page.text, /Revenue reached 42 units/);
  const context = { settings: { searchMode: "off" }, signal: null };
  let fetchCount = 0;
  const tools = createWebTools(context, {
    env: {},
    fetchImpl: async () => { fetchCount += 1; return new Response(SEARCH_HTML); },
  });
  const result = await tools.find((tool) => tool.name === "web_search").execute("call-1", { query: "test" });
  assert.equal(result.isError, true);
  assert.equal(result.details.code, "WEB_SEARCH_DISABLED");
  assert.equal(fetchCount, 0);
});

test("search never falls back to fabricated results", async () => {
  const search = new WebSearchTool({ env: {}, fetch: async () => new Response("", { status: 503 }) });
  for (const config of Object.values(search.search_engines)) config.enabled = false;
  search.active_engine = search._select_search_engine();
  const result = await search.execute({}, { query: "must be real" });
  assert.equal(result.success, false);
  assert.match(result.error, /没有可用的搜索引擎/);
  assert.doesNotMatch(JSON.stringify(result), /MockSearch|example\.com\/research/);
});

test("a custom key without an API URL returns a configuration error", async () => {
  const missing = new WebSearchTool({ env: { DSH_WEB_SEARCH_API_KEY: "configured" } });
  assert.equal(missing.active_engine, null);
  assert.match((await missing.execute({}, { query: "test" })).error, /搜索 API URL 未配置/);
});

test("the generic search API uses the configured URL, Bearer key, and stable contract", async () => {
  let request = null;
  const search = new WebSearchTool({
    env: {
      DSH_WEB_SEARCH_API_URL: "https://search.example.test/v1/search",
      DSH_WEB_SEARCH_API_KEY: "search-secret",
    },
    fetch: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify({
        results: [{
          title: "Current result",
          url: "https://source.example.test/news",
          content: "Verified current information.",
          published_date: "2026-07-31T08:00:00Z",
        }],
      }), { headers: { "content-type": "application/json" } });
    },
  });

  const result = await search.execute({}, { query: "latest release", max_results: 3, search_type: "news" });
  assert.equal(result.success, true);
  assert.equal(request.url, "https://search.example.test/v1/search");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.authorization, "Bearer search-secret");
  assert.deepEqual(JSON.parse(request.options.body), {
    query: "latest release",
    max_results: 3,
    search_type: "news",
  });
  assert.equal(result.data.search_engine, "custom");
  assert.equal(result.data.results[0].url, "https://source.example.test/news");
  assert.equal(result.data.results[0].snippet, "Verified current information.");
  assert.equal(result.data.results[0].source, "source.example.test");
});

test("Ask Data web search uses the project's default setting and returns a query-table contract", async () => {
  let received = null;
  const bds = {
    _loaded: true,
    web_search_configs: new Map([
      ["备用搜索", { name: "备用搜索", model: "serper", api: "backup-secret", is_default: false }],
      ["项目默认搜索", { name: "项目默认搜索", model: "tavily", api: "project-secret", is_default: true }],
    ]),
  };
  const search = new ProjectWebSearchTool({
    bds,
    env: {},
    configuredSearch: async (input) => {
      received = input;
      return [{
        title: "Project result",
        url: "https://source.example.test/project",
        snippet: "Verified through the project setting.",
        source: "source.example.test",
        date: "2026-08-09",
      }];
    },
  });

  const result = await search.execute({}, { query: "project question", max_results: 3 });
  assert.equal(result.success, true);
  assert.equal(received.config.name, "项目默认搜索");
  assert.equal(received.maxResults, 3);
  assert.equal(result.data.operator.source_name, "项目默认搜索");
  assert.equal(result.data.operator.search_engine, "tavily");
  assert.deepEqual(result.data.result.columns, ["title", "url", "snippet", "source", "date"]);
  assert.equal(result.data.result.data[0].title, "Project result");
  assert.doesNotMatch(JSON.stringify(result), /project-secret|backup-secret/);
});

test("Ask Data web search can select a named project setting and rejects unknown names", async () => {
  const selected = [];
  const bds = {
    _loaded: true,
    web_search_configs: new Map([
      ["搜索一", { name: "搜索一", model: "bocha", api: "one", is_default: true }],
      ["搜索二", { name: "搜索二", model: "serper", api: "two", is_default: false }],
    ]),
  };
  const search = new ProjectWebSearchTool({
    bds,
    env: {},
    configuredSearch: async ({ config }) => {
      selected.push(config.name);
      return [];
    },
  });
  const named = await search.execute({}, { query: "named", web_search_model_name: "搜索二" });
  assert.equal(named.success, true);
  assert.deepEqual(selected, ["搜索二"]);
  const missing = await search.execute({}, { query: "missing", web_search_model_name: "不存在" });
  assert.equal(missing.success, false);
  assert.match(missing.error, /可用配置：搜索一、搜索二/);
});

test("the generic search API accepts a top-level array and an endpoint without a key", async () => {
  let request = null;
  const search = new WebSearchTool({
    env: { DSH_WEB_SEARCH_API_URL: "https://search.example.test/open" },
    fetch: async (url, options) => {
      request = { url: String(url), options };
      return new Response(JSON.stringify([{ name: "One", link: "https://source.example.test/one", description: "Summary" }]), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await search.execute({}, { query: "custom endpoint", max_results: 1 });
  assert.equal(result.success, true);
  assert.equal(request.url, "https://search.example.test/open");
  assert.equal(request.options.headers.authorization, undefined);
  assert.equal(result.data.results[0].title, "One");
  assert.equal(result.data.results[0].snippet, "Summary");
});

test("an invalid generic search URL returns a configuration error", async () => {
  const search = new WebSearchTool({
    env: {
      DSH_WEB_SEARCH_API_URL: "file:///tmp/search",
      DSH_WEB_SEARCH_API_KEY: "configured",
    },
  });
  assert.equal(search.active_engine, null);
  assert.match((await search.execute({}, { query: "test" })).error, /搜索 API URL 无效/);
});

test("an incompatible generic response reports the real protocol error", async () => {
  const search = new WebSearchTool({
    env: { DSH_WEB_SEARCH_API_URL: "https://search.example.test/v1/search" },
    fetch: async () => new Response(JSON.stringify({ items: [] }), {
      headers: { "content-type": "application/json" },
    }),
  });
  const result = await search.execute({}, { query: "test" });
  assert.equal(result.success, false);
  assert.match(result.error, /缺少 results 数组/);
});

test("citation validation rejects unknown source ids and required mode cannot pass without evidence", () => {
  const sources = [{ source_id: "S1", url: "https://example.com/news" }];
  const valid = validateWebCitationMarkers([{ id: "answer-1", type: "markdown", content: "已核对【S1】" }], sources, { answerItemId: "answer-1" });
  assert.deepEqual(valid.valid, ["S1"]);
  assert.equal(webCitationPolicyFailure("required", sources, valid, { search_count: 1 }), "");

  const invalid = validateWebCitationMarkers([{ id: "answer-1", type: "markdown", content: "伪造【S9】" }], sources, { answerItemId: "answer-1" });
  assert.deepEqual(invalid.invalid, ["S9"]);
  assert.match(webCitationPolicyFailure("required", sources, invalid, { search_count: 1 }), /S9/);
  assert.match(webCitationPolicyFailure("required", [], { valid: [], invalid: [] }, { search_count: 1 }), /没有打开/);
  assert.match(webCitationPolicyFailure("required", sources, valid, { search_count: 0 }), /没有执行网页搜索/);
  assert.equal(webCitationPolicyFailure("auto", sources, invalid), "");
});

test("only citations bound to final-answer text pass validation", () => {
  const sources = [{ source_id: "S1" }, { source_id: "S2" }];
  const validation = validateWebCitationMarkers([
    { id: "progress-1", type: "markdown", content: "过程里提到【S1】" },
    { id: "answer-1", type: "markdown", content: "最终结论没有引用\n【S2】" },
  ], sources, { answerItemId: "answer-1" });
  assert.deepEqual(validation.valid, []);
  assert.deepEqual(validation.unbound, ["S2"]);
  assert.deepEqual(validation.uncited, ["S1", "S2"]);
  assert.match(webCitationPolicyFailure("required", sources, validation, { search_count: 1 }), /S2/);
});

test("commentary-only citations never satisfy required web citation policy", () => {
  const sources = [{ source_id: "S1" }];
  const validation = validateWebCitationMarkers([
    { id: "progress-1", type: "markdown", content: "过程里核对过【S1】" },
    { id: "answer-1", type: "markdown", content: "最终回答没有引用" },
  ], sources, { answerItemId: "answer-1" });
  assert.deepEqual(validation.valid, []);
  assert.deepEqual(validation.uncited, ["S1"]);
  assert.match(webCitationPolicyFailure("required", sources, validation, { search_count: 1 }), /没有引用/);
});

test("canonical citation validation only reads the exact answer item", () => {
  const sources = [{ source_id: "S1" }];
  const items = [
    { id: "progress-1", type: "markdown", content: "旧过程消息【S1】" },
    { id: "answer-1", type: "markdown", content: "最终答案没有引用" },
  ];
  const validation = validateWebCitationMarkers(items, sources, { answerItemId: "answer-1" });
  assert.deepEqual(validation.valid, []);
  assert.deepEqual(validation.uncited, ["S1"]);

  const missing = validateWebCitationMarkers(items, sources, { answerItemId: "missing" });
  assert.deepEqual(missing.valid, []);
  assert.deepEqual(missing.uncited, ["S1"]);
});

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  normalizeWebSearchSettings,
  applyWebSearchEnv,
} = require("../../electron/web-search-settings.js");

test("web search settings keep only one generic API URL and key", () => {
  assert.deepEqual(normalizeWebSearchSettings({
    webSearchApiUrl: " https://search.example.test/v1/search ",
    webSearchApiKey: " local-key ",
    webSearchProvider: "serpapi",
    serpApiKey: "legacy-key",
  }), {
    webSearchApiUrl: "https://search.example.test/v1/search",
    webSearchApiKey: "local-key",
  });
});

test("generic web search settings clear legacy provider variables and inject one API", () => {
  const env = {
    DSH_WEB_SEARCH_PROVIDER: "tavily",
    SERPAPI_API_KEY: "legacy-serp",
    TAVILY_API_KEY: "legacy-tavily",
    BING_SEARCH_API_KEY: "legacy-bing",
  };
  applyWebSearchEnv(env, {
    webSearchApiUrl: "https://search.example.test/v1/search",
    webSearchApiKey: "saved-key",
  });

  assert.equal(env.DSH_WEB_SEARCH_PROVIDER, undefined);
  assert.equal(env.SERPAPI_API_KEY, undefined);
  assert.equal(env.TAVILY_API_KEY, undefined);
  assert.equal(env.BING_SEARCH_API_KEY, undefined);
  assert.equal(env.DSH_WEB_SEARCH_API_URL, "https://search.example.test/v1/search");
  assert.equal(env.DSH_WEB_SEARCH_API_KEY, "saved-key");
});

test("empty settings select the built-in search by removing custom API variables", () => {
  const env = {
    DSH_WEB_SEARCH_API_URL: "https://old.example.test/search",
    DSH_WEB_SEARCH_API_KEY: "old-key",
  };
  applyWebSearchEnv(env, {});
  assert.equal(env.DSH_WEB_SEARCH_API_URL, undefined);
  assert.equal(env.DSH_WEB_SEARCH_API_KEY, undefined);
});

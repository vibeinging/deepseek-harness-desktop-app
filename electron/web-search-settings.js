function clean(value) {
  return String(value || '').trim();
}

function normalizeWebSearchSettings(value = {}) {
  return {
    webSearchApiUrl: clean(value.webSearchApiUrl),
    webSearchApiKey: clean(value.webSearchApiKey),
  };
}

function applyWebSearchEnv(env, value = {}) {
  const settings = normalizeWebSearchSettings(value);

  for (const key of [
    'DSH_WEB_SEARCH_PROVIDER',
    'DUCKDUCKGO_SEARCH_URL',
    'SERPAPI_API_URL',
    'SERPAPI_API_KEY',
    'TAVILY_API_URL',
    'TAVILY_API_KEY',
    'BING_SEARCH_API_KEY',
    'DSH_WEB_SEARCH_API_URL',
    'DSH_WEB_SEARCH_API_KEY',
  ]) {
    delete env[key];
  }

  if (settings.webSearchApiUrl) env.DSH_WEB_SEARCH_API_URL = settings.webSearchApiUrl;
  if (settings.webSearchApiKey) env.DSH_WEB_SEARCH_API_KEY = settings.webSearchApiKey;
  return settings;
}

module.exports = {
  normalizeWebSearchSettings,
  applyWebSearchEnv,
};

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent as UndiciAgent } from "undici";
import { Type } from "../agent_host/json_schema.js";
import { WebSearchTool } from "../tools/web_search_tool.js";

const WEB_TOOL_NAMES = new Set(["web_search", "web_open", "web_find"]);
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_TEXT = 120_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DNS_TIMEOUT_MS = 5_000;
const PROXY_ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

function compact(value, max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function hasConfiguredProxy(env = process.env) {
  return PROXY_ENV_KEYS.some((key) => String(env?.[key] || "").trim());
}

function toolResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], details: data };
}

function toolError(message, extra = {}) {
  return { ...toolResult({ success: false, error: compact(message, 2000), ...extra }), isError: true };
}

export function isWebToolName(name) {
  return WEB_TOOL_NAMES.has(String(name || ""));
}

function normalizedHostname(value) {
  const hostname = String(value || "").trim().toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isPrivateNetworkAddress(address) {
  const value = normalizedHostname(String(address || "").toLowerCase().split("%")[0]);
  const version = isIP(value);
  if (version === 4) {
    const parts = value.split(".").map(Number);
    const [a, b] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2))
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && parts[2] === 100)
      || (a === 203 && b === 0 && parts[2] === 113)
      || a >= 224;
  }
  if (version === 6) {
    // Only globally routable unicast IPv6 space is allowed. This conservative
    // rule also rejects loopback, unspecified, ULA, link-local, multicast,
    // IPv4-mapped/NAT64 and other special transition ranges.
    const firstGroup = Number.parseInt(value.split(":", 1)[0] || "0", 16);
    if (firstGroup < 0x2000 || firstGroup > 0x3fff) return true;
    if (value.startsWith("2001:db8:")) return true;
    // 6to4 embeds an IPv4 address in the next 32 bits. Do not let a private
    // IPv4 target hide inside an otherwise globally-routable IPv6 literal.
    if (value.startsWith("2002:")) {
      const groups = value.split(":");
      if (groups.length > 2) {
        const high = Number.parseInt(groups[1] || "", 16);
        const low = Number.parseInt(groups[2] || "", 16);
        if (Number.isInteger(high) && Number.isInteger(low)) {
          const embedded = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
          if (isPrivateNetworkAddress(embedded)) return true;
        }
      }
    }
  }
  return false;
}

async function resolveDnsOverHttps(hostname, fetchImpl) {
  if (typeof fetchImpl !== "function") return [];
  const answers = await Promise.allSettled(["A", "AAAA"].map(async (type) => {
    const response = await fetchImpl(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      {
        method: "GET",
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
      },
    );
    if (!response.ok) return [];
    return (await response.json())?.Answer || [];
  }));
  const records = [];
  for (const result of answers) {
    if (result.status !== "fulfilled") continue;
    for (const answer of Array.isArray(result.value) ? result.value : []) {
      const address = String(answer?.data || "").trim();
      const family = isIP(address);
      if (family === 4 || family === 6) records.push({ address, family });
    }
  }
  return records;
}

async function resolveCheckedHost(hostname, { resolveHost, resolvePublicHost, fetchImpl } = {}) {
  const customResolver = typeof resolveHost === "function";
  let records = [];
  try {
    records = await (customResolver
      ? resolveHost(hostname)
      : lookup(hostname, { all: true, verbatim: true }));
  } catch {
    records = [];
  }
  const normalized = (Array.isArray(records) ? records : [records])
    .map((record) => ({ address: String(record?.address || ""), family: Number(record?.family || isIP(record?.address)) }))
    .filter((record) => record.address && (record.family === 4 || record.family === 6));
  if (normalized.length && normalized.every((record) => !isPrivateNetworkAddress(record.address))) return normalized;
  // Some desktop/VPN networks resolve every public domain to a private egress
  // proxy. A public DNS answer is used only together with a pinned connection,
  // so this does not weaken the private-address or DNS-rebinding boundary.
  if ((!normalized.length || normalized.some((record) => isPrivateNetworkAddress(record.address)))
    && (!customResolver || typeof resolvePublicHost === "function")) {
    try {
      const rawPublicRecords = typeof resolvePublicHost === "function"
        ? await resolvePublicHost(hostname)
        : await resolveDnsOverHttps(hostname, fetchImpl);
      const publicRecords = (Array.isArray(rawPublicRecords) ? rawPublicRecords : [rawPublicRecords])
        .map((record) => ({ address: String(record?.address || ""), family: Number(record?.family || isIP(record?.address)) }))
        .filter((record) => record.address && (record.family === 4 || record.family === 6));
      if (publicRecords.length && publicRecords.every((record) => !isPrivateNetworkAddress(record.address))) return publicRecords;
    } catch {
      // Keep the original private records so the caller rejects the URL.
    }
  }
  return normalized;
}

async function assertPublicUrl(rawUrl, { resolveHost, resolvePublicHost, fetchImpl } = {}) {
  let url;
  try { url = new URL(String(rawUrl || "")); } catch { throw new Error("网页地址无效"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("只允许打开 HTTP(S) 网页");
  if (url.username || url.password) throw new Error("网页地址不能包含账号信息");
  const hostname = normalizedHostname(url.hostname);
  if (!hostname || hostname === "localhost" || hostname === "metadata"
    || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("不能访问本机或局域网地址");
  }
  const directVersion = isIP(hostname);
  const records = directVersion
    ? [{ address: hostname, family: directVersion }]
    : await resolveCheckedHost(hostname, { resolveHost, resolvePublicHost, fetchImpl });
  if (!Array.isArray(records) || !records.length) throw new Error("网页域名无法解析");
  if (records.some((record) => isPrivateNetworkAddress(record?.address))) throw new Error("不能访问本机或局域网地址");
  return { url, records };
}

function pinnedDispatcher(hostname, records) {
  hostname = normalizedHostname(hostname);
  if (isIP(hostname) || !Array.isArray(records) || !records.length) return null;
  let cursor = 0;
  return new UndiciAgent({
    connect: {
      lookup(requestedHostname, options, callback) {
        if (String(requestedHostname).toLowerCase() !== String(hostname).toLowerCase()) {
          callback(new Error("网页连接域名与已校验域名不一致"));
          return;
        }
        if (options?.all) {
          callback(null, records.map((record) => ({ address: record.address, family: record.family })));
          return;
        }
        const record = records[cursor % records.length];
        cursor += 1;
        callback(null, record.address, record.family);
      },
    },
  });
}

/**
 * Fetch one JSON API through the same public-network boundary used by web_open.
 * Every DNS answer is checked, the connection is pinned to those answers, and
 * redirects are either rejected or resolved and checked one hop at a time.
 */
export async function fetchPublicJson(rawUrl, {
  fetchImpl = globalThis.fetch,
  resolveHost,
  resolvePublicHost,
  proxyConfigured = hasConfiguredProxy(),
  method = "GET",
  headers = {},
  body,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = MAX_PAGE_BYTES,
  maxRedirects = 0,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境不能访问网络 API");
  let current = await assertPublicUrl(rawUrl, { resolveHost, resolvePublicHost, fetchImpl });
  let requestMethod = String(method || "GET").toUpperCase();
  let requestBody = body;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const dispatcher = proxyConfigured ? null : pinnedDispatcher(current.url.hostname, current.records);
    try {
      const response = await fetchImpl(current.url, {
        method: requestMethod,
        headers,
        ...(requestBody == null ? {} : { body: requestBody }),
        redirect: "manual",
        signal: requestSignal,
        ...(dispatcher ? { dispatcher } : {}),
      });
      if ([301, 302, 303, 307, 308].includes(response?.status)) {
        const location = response.headers?.get?.("location");
        await response.body?.cancel().catch(() => null);
        if (!location) throw new Error("网络 API 跳转缺少目标地址");
        if (redirect >= maxRedirects) throw new Error("网络 API 不允许跳转");
        current = await assertPublicUrl(new URL(location, current.url).toString(), {
          resolveHost,
          resolvePublicHost,
          fetchImpl,
        });
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestMethod === "POST")) {
          requestMethod = "GET";
          requestBody = undefined;
        }
        continue;
      }
      if (!response || response.ok === false) throw new Error(`网络 API 返回 HTTP ${response?.status || 500}`);
      const contentLength = Number(response.headers?.get?.("content-length") || 0);
      if (contentLength > maxBytes) throw new Error("网络 API 响应过大");
      const bytes = await readBoundedBody(response, maxBytes);
      try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("网络 API 没有返回合法 JSON"); }
    } finally {
      await dispatcher?.close().catch(() => null);
    }
  }
  throw new Error("网络 API 跳转次数过多");
}

async function readBoundedBody(response, maxBytes) {
  if (!response?.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error("网页内容超过 2 MB 限制");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > maxBytes) throw new Error("网页内容超过 2 MB 限制");
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => null);
    throw error;
  }
  return Buffer.concat(chunks, total);
}

function htmlEntityDecode(value) {
  const codePoint = (raw, radix = 10) => {
    const parsed = Number.parseInt(String(raw || ""), radix);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0x10ffff ? String.fromCodePoint(parsed) : "�";
  };
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => codePoint(hex, 16))
    .replace(/&#(\d+);/g, (_match, decimal) => codePoint(decimal));
}

function tagContent(html, tag) {
  const match = String(html || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return htmlEntityDecode(match?.[1]?.replace(/<[^>]+>/g, " ") || "").replace(/\s+/g, " ").trim();
}

function attributeValue(tag, name) {
  const match = String(tag || "").match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return htmlEntityDecode(match?.[1] || "").trim();
}

function metadataValue(html, names) {
  const tags = [...String(html || "").matchAll(/<meta\b[^>]*>/gi)];
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const match of tags) {
    const key = (attributeValue(match[0], "name") || attributeValue(match[0], "property")).toLowerCase();
    if (wanted.has(key)) return attributeValue(match[0], "content");
  }
  return "";
}

export function extractWebPage(html, pageUrl) {
  const source = String(html || "");
  const title = compact(tagContent(source, "title") || pageUrl, 500);
  const canonicalTag = [...source.matchAll(/<link\b[^>]*>/gi)]
    .find((match) => attributeValue(match[0], "rel").toLowerCase().split(/\s+/).includes("canonical"));
  const canonicalRaw = canonicalTag ? attributeValue(canonicalTag[0], "href") : "";
  let canonicalUrl = pageUrl;
  try { if (canonicalRaw) canonicalUrl = new URL(canonicalRaw, pageUrl).toString(); } catch { /* keep final URL */ }
  const publishedAt = metadataValue(source, [
    "article:published_time",
    "datepublished",
    "date",
    "pubdate",
  ]) || null;
  const withoutNoise = source
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|p|div|section|article|main|li|h[1-6]|tr|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const text = htmlEntityDecode(withoutNoise)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, MAX_PAGE_TEXT);
  return { title, canonical_url: canonicalUrl, published_at: publishedAt, text };
}

async function fetchPublicPage(rawUrl, {
  fetchImpl = globalThis.fetch,
  resolveHost,
  resolvePublicHost,
  proxyConfigured = false,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("当前运行环境不能访问网页");
  let current = await assertPublicUrl(rawUrl, { resolveHost, resolvePublicHost, fetchImpl });
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const dispatcher = proxyConfigured ? null : pinnedDispatcher(current.url.hostname, current.records);
    try {
      const response = await fetchImpl(current.url, {
        method: "GET",
        redirect: "manual",
        signal: requestSignal,
        ...(dispatcher ? { dispatcher } : {}),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; DshWeb/1.0)",
          accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("网页跳转缺少目标地址");
        await response.body?.cancel().catch(() => null);
        current = await assertPublicUrl(new URL(location, current.url).toString(), { resolveHost, resolvePublicHost, fetchImpl });
        continue;
      }
      if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}`);
      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_PAGE_BYTES) throw new Error("网页内容超过 2 MB 限制");
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (contentType && !contentType.includes("text/html") && !contentType.includes("text/plain")) {
        throw new Error(`暂不支持这种网页内容: ${contentType.split(";")[0]}`);
      }
      const bytes = await readBoundedBody(response, MAX_PAGE_BYTES);
      const html = bytes.toString("utf8");
      return { finalUrl: current.url.toString(), html, page: extractWebPage(html, current.url.toString()) };
    } finally {
      await dispatcher?.close().catch(() => null);
    }
  }
  throw new Error("网页跳转次数过多");
}

export function createWebResearchSession({
  fetchImpl = globalThis.fetch,
  env = process.env,
  resolveHost,
  resolvePublicHost,
  signal = null,
} = {}) {
  const searchEngine = new WebSearchTool({ fetch: fetchImpl, env });
  const searchResults = new Map();
  const pages = new Map();
  const sources = [];
  const activity = { search_count: 0, open_count: 0, find_count: 0 };

  return {
    async search(query, { maxResults = 8 } = {}) {
      activity.search_count += 1;
      const result = await searchEngine.execute({}, { query: compact(query, 1000), max_results: Math.min(10, Math.max(1, Number(maxResults || 8))) });
      if (!result?.success) throw new Error(result?.error || "搜索没有返回结果");
      const rows = Array.isArray(result.data?.results) ? result.data.results : [];
      const normalized = rows.flatMap((row) => {
        const url = compact(row?.url, 4000);
        if (!/^https?:\/\//i.test(url)) return [];
        const resultId = `R${searchResults.size + 1}`;
        const item = {
          result_id: resultId,
          title: compact(row?.title, 500),
          url,
          snippet: compact(row?.snippet, 1200),
          site_name: compact(row?.displayed_link || (() => { try { return new URL(url).hostname; } catch { return ""; } })(), 300),
        };
        searchResults.set(resultId, item);
        return [item];
      });
      if (!normalized.length) throw new Error("搜索没有返回可用网页");
      return { query: compact(query, 1000), search_engine: result.data?.search_engine || "unknown", results: normalized };
    },

    async open({ resultId, url }) {
      activity.open_count += 1;
      const candidate = resultId ? searchResults.get(String(resultId)) : null;
      const targetUrl = compact(candidate?.url || url, 4000);
      if (!targetUrl) throw new Error("需要提供 result_id 或 url");
      const loaded = await fetchPublicPage(targetUrl, {
        fetchImpl,
        resolveHost,
        resolvePublicHost,
        proxyConfigured: hasConfiguredProxy(env),
        signal,
      });
      if (!loaded.page.text) throw new Error("网页没有可读取的正文");
      const existing = sources.find((source) => source.url === loaded.finalUrl || source.canonical_url === loaded.page.canonical_url);
      if (existing) return { source: existing, content: pages.get(existing.source_id)?.text || loaded.page.text };
      const sourceId = `S${sources.length + 1}`;
      const source = {
        source_id: sourceId,
        url: loaded.finalUrl,
        canonical_url: loaded.page.canonical_url,
        title: loaded.page.title || candidate?.title || loaded.finalUrl,
        site_name: (() => { try { return new URL(loaded.finalUrl).hostname; } catch { return ""; } })(),
        published_at: loaded.page.published_at,
        accessed_at: new Date().toISOString(),
        content_hash: `sha256:${createHash("sha256").update(loaded.page.text).digest("hex")}`,
        excerpt: loaded.page.text.slice(0, 600),
        anchor: { kind: "text", start: 0, end: Math.min(600, loaded.page.text.length) },
      };
      sources.push(source);
      pages.set(sourceId, { ...loaded.page, text: loaded.page.text });
      return { source, content: loaded.page.text };
    },

    find(sourceId, pattern) {
      activity.find_count += 1;
      const page = pages.get(String(sourceId || ""));
      if (!page) throw new Error("请先用 web_open 打开这个来源");
      const needle = compact(pattern, 500);
      if (!needle) throw new Error("pattern 不能为空");
      const lower = page.text.toLowerCase();
      const target = needle.toLowerCase();
      const matches = [];
      let from = 0;
      while (matches.length < 10) {
        const index = lower.indexOf(target, from);
        if (index < 0) break;
        const start = Math.max(0, index - 180);
        const end = Math.min(page.text.length, index + target.length + 260);
        matches.push({ start, end, excerpt: page.text.slice(start, end) });
        from = index + Math.max(1, target.length);
      }
      if (matches.length) {
        const source = sources.find((item) => item.source_id === String(sourceId || ""));
        if (source) {
          source.excerpt = matches[0].excerpt;
          source.anchor = { kind: "text", start: matches[0].start, end: matches[0].end };
        }
      }
      return { source_id: sourceId, pattern: needle, matches };
    },

    getSources() {
      return sources.map((source) => ({ ...source, anchor: { ...source.anchor } }));
    },

    getActivity() {
      return { ...activity };
    },
  };
}

export function createWebTools(agentContext, dependencies = {}) {
  const mode = ["auto", "required", "off"].includes(agentContext?.settings?.searchMode)
    ? agentContext.settings.searchMode
    : "auto";
  const session = createWebResearchSession({
    signal: agentContext?.signal || null,
    ...dependencies,
  });
  agentContext.webResearch = session;
  const run = async (handler) => {
    if (mode === "off") return toolError("本轮已关闭联网搜索", { code: "WEB_SEARCH_DISABLED" });
    try { return toolResult({ success: true, ...(await handler()) }); }
    catch (error) { return toolError(error?.message || String(error)); }
  };
  return [
    {
      name: "web_search",
      namespace: "web",
      description: "搜索最新网页。返回候选结果 R1、R2；需要据此回答时，必须继续用 web_open 打开实际网页。",
      parameters: Type.Object({
        query: Type.String({ description: "搜索关键词" }),
        max_results: Type.Optional(Type.Number({ description: "结果数量，1 到 10，默认 8" })),
      }),
      side_effect: "external_read",
      execute: async (_callId, params = {}) => run(() => session.search(params.query, { maxResults: params.max_results })),
    },
    {
      name: "web_open",
      namespace: "web",
      description: "打开搜索结果或公开 HTTP(S) 网页并读取正文。成功后返回可在回答中引用的来源编号 S1、S2。",
      parameters: Type.Object({
        result_id: Type.Optional(Type.String({ description: "web_search 返回的 R 编号" })),
        url: Type.Optional(Type.String({ description: "要打开的公开 HTTP(S) URL" })),
      }),
      side_effect: "external_read",
      execute: async (_callId, params = {}) => run(async () => {
        const opened = await session.open({ resultId: params.result_id, url: params.url });
        return { source: opened.source, content: opened.content.slice(0, 12_000), truncated: opened.content.length > 12_000 };
      }),
    },
    {
      name: "web_find",
      namespace: "web",
      description: "在 web_open 已打开的网页正文中定位关键词，返回支持回答的原文片段。",
      parameters: Type.Object({
        source_id: Type.String({ description: "web_open 返回的 S 编号" }),
        pattern: Type.String({ description: "要在网页中定位的关键词" }),
      }),
      side_effect: "external_read",
      execute: async (_callId, params = {}) => run(() => session.find(params.source_id, params.pattern)),
    },
  ];
}

export const WEB_RESEARCH_LIMITS = Object.freeze({ max_page_bytes: MAX_PAGE_BYTES, max_page_text: MAX_PAGE_TEXT });

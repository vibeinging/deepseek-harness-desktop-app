import { existsSync } from "node:fs";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

function proxyLogLabel(raw) {
  try {
    const parsed = new URL(String(raw || "").includes("://") ? raw : `http://${raw}`);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "(configured)";
  }
}

const PROXY_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

function firstEnv(keys) {
  for (const key of keys) {
    const value = String(process.env[key] || "").trim();
    if (value) return value;
  }
  return "";
}

function normalizeNoProxy(value) {
  const parts = String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(parts)].join(",");
}

export function configureServerNetwork() {
  const proxy = firstEnv(PROXY_KEYS);
  const noProxy = normalizeNoProxy(process.env.NO_PROXY || process.env.no_proxy);
  const customCert = String(process.env.NODE_EXTRA_CA_CERTS || "").trim();

  if (noProxy) {
    process.env.NO_PROXY = noProxy;
    process.env.no_proxy = noProxy;
  }

  if (customCert && !existsSync(customCert)) {
    console.warn(`[network] NODE_EXTRA_CA_CERTS 不存在,证书不会生效: ${customCert}`);
  }

  if (!proxy) {
    if (noProxy) console.info(`[network] NO_PROXY=${noProxy}`);
    return;
  }

  try {
    setGlobalDispatcher(new EnvHttpProxyAgent());
    const certInfo = customCert ? ", custom CA enabled" : "";
    console.info(`[network] HTTP proxy enabled: ${proxyLogLabel(proxy)}; NO_PROXY=${noProxy || "(empty)"}${certInfo}`);
  } catch (e) {
    console.warn("[network] HTTP proxy 初始化失败:", e?.message || e);
  }
}

configureServerNetwork();

import { ApiError } from "../../errors.js";
import { getDshRuntimeClient } from "../../engine/dsh_runtime/client.js";

const CREDENTIAL_REF = /^[A-Z][A-Z0-9_]{1,126}$/;

function collectCredentialRefs(value, refs = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialRefs(item, refs);
    return refs;
  }
  if (!value || typeof value !== "object") return refs;
  for (const [key, item] of Object.entries(value)) {
    if (key === "apiKeyEnv" && typeof item === "string" && CREDENTIAL_REF.test(item)) refs.add(item);
    else collectCredentialRefs(item, refs);
  }
  return refs;
}

function dshError(error, fallback) {
  const status = error?.code === "settings-conflict" ? 409
    : error?.code === "settings-rejected" || error?.code === "credential-rejected"
      || error?.code === "model-discovery-failed" ? 400 : 503;
  const output = new ApiError(
    error?.message || fallback,
    status,
    error?.code || "DSH_MODEL_SETTINGS_FAILED",
  );
  output.details = error?.details || {};
  return output;
}

async function clientRequest(method, payload, fallback) {
  try {
    const client = getDshRuntimeClient();
    await client.start();
    return await client.request(method, payload);
  } catch (error) {
    throw dshError(error, fallback);
  }
}

async function exposedProviderState() {
  const [providers, settings] = await Promise.all([
    clientRequest("llm.providers", {}, "无法读取 DSH 模型提供方"),
    clientRequest("settings.describe", {}, "无法读取 DSH 模型设置"),
  ]);
  return { providers, settings };
}

function assertNamespace(ns, providers) {
  const allowed = new Set((providers?.providers || []).map((provider) => provider.settingsNs).filter(Boolean));
  if (!allowed.has(ns)) throw new ApiError("这个 DSH 模型设置空间不可写", 400);
}

function normalizeOps(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new ApiError("DSH 模型设置修改不能为空", 400);
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || !["set", "unset"].includes(item.op)
      || !Array.isArray(item.path) || item.path.some((part) => typeof part !== "string" || !part)) {
      throw new ApiError("DSH 模型设置修改格式无效", 400);
    }
    return item.op === "set"
      ? { op: "set", path: item.path, value: item.value }
      : { op: "unset", path: item.path };
  });
}

/** Read the redacted DSH provider/settings/credential join used by the page. */
export async function getDshModelSettings() {
  const [{ providers, settings }, catalog] = await Promise.all([
    exposedProviderState(),
    clientRequest("llm.models", {}, "无法读取 DSH 模型目录"),
  ]);
  const refs = new Set();
  for (const namespace of settings?.namespaces || []) collectCredentialRefs(namespace?.value, refs);
  let credentials = { credentials: {} };
  let credentialError = null;
  if (refs.size) {
    try {
      credentials = await clientRequest("credentials.describe", { refs: [...refs] }, "无法读取 DSH 凭据状态");
    } catch (error) {
      // Credential status enriches the settings/catalog join. A missing
      // credential provider must not hide otherwise editable provider rows.
      credentialError = error?.message || "无法读取 DSH 凭据状态";
    }
  }
  return {
    data: {
      providers: providers?.providers || [],
      groups: catalog?.groups || [],
      failures: catalog?.failures || [],
      writable: settings?.writable === true,
      has_document: settings?.hasDocument === true,
      namespaces: settings?.namespaces || [],
      credentials: credentials?.credentials || {},
      credential_error: credentialError,
    },
    message: "DSH 模型设置已读取",
  };
}

/** Apply path edits to the official DSH user settings layer. */
export async function mutateDshModelSettings(_ctx, input) {
  const body = input.body || {};
  const ns = String(body.ns || "").trim();
  const { providers } = await exposedProviderState();
  assertNamespace(ns, providers);
  const value = await clientRequest("settings.mutate", {
    ns,
    ops: normalizeOps(body.ops),
    ...(Number.isInteger(body.expected_revision) ? { expectedRevision: body.expected_revision } : {}),
  }, "DSH 模型设置保存失败");
  return { data: value, message: "DSH 模型设置已保存" };
}

/** Store one write-only credential through the DSH credential provider. */
export async function setDshModelCredential(_ctx, input) {
  const ref = String(input.body?.ref || "").trim();
  const value = String(input.body?.value || "");
  if (!CREDENTIAL_REF.test(ref) || !value) throw new ApiError("DSH 凭据引用或密钥无效", 400);
  await clientRequest("credentials.set", { ref, value }, "DSH 模型密钥保存失败");
  return { data: { ref, configured: true }, message: "DSH 模型密钥已保存" };
}

/** Remove one DSH credential without ever reading its value. */
export async function unsetDshModelCredential(_ctx, input) {
  const ref = String(input.params?.ref || "").trim();
  if (!CREDENTIAL_REF.test(ref)) throw new ApiError("DSH 凭据引用无效", 400);
  await clientRequest("credentials.unset", { ref }, "DSH 模型密钥删除失败");
  return { data: { ref, configured: false }, message: "DSH 模型密钥已删除" };
}

/** Ask the selected DSH adapter about one draft endpoint; this does not write. */
export async function discoverDshModels(_ctx, input) {
  const body = input.body || {};
  const settingsNs = String(body.settings_ns || "").trim();
  const { providers } = await exposedProviderState();
  assertNamespace(settingsNs, providers);
  const value = await clientRequest("llm.discoverModels", {
    settingsNs,
    ...(body.provider ? { provider: String(body.provider) } : {}),
    ...(body.base_url ? { baseURL: String(body.base_url) } : {}),
    ...(body.api ? { api: String(body.api) } : {}),
    ...(body.api_key ? { apiKey: String(body.api_key) } : {}),
  }, "DSH 模型发现失败");
  return { data: value, message: "DSH 模型目录已发现" };
}

export default {
  getDshModelSettings,
  mutateDshModelSettings,
  setDshModelCredential,
  unsetDshModelCredential,
  discoverDshModels,
};

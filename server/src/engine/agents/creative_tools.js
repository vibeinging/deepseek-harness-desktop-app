import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { Type } from "../agent_host/json_schema.js";
import {
  buildRequestData,
  buildRequestHeaders,
  extractErrorDetail,
  getApiUrl,
  ModelConfigResolver,
  ResponseExtractor,
} from "../core/llm.js";
import { recordTraceLlmCall } from "../trace/trace_context.js";
import { lookup as defaultDnsLookup } from "node:dns/promises";
import { isPrivateNetworkAddress } from "./web_tools.js";

/** 图片下载大小上限（32MB，覆盖典型高清图，防止被恶意 URL 耗尽内存）。 */
const MAX_DOWNLOAD_IMAGE_BYTES = 32 * 1024 * 1024;

// DNS 解析器：生产用 node:dns/promises.lookup；测试可替换以绕过环境 DNS 劫持。
let dnsLookup = defaultDnsLookup;
export function _setDnsLookupForTests(fn) {
  const previous = dnsLookup;
  dnsLookup = fn || defaultDnsLookup;
  return previous;
}

export const CREATIVE_TOOL_CATALOG = Object.freeze([
  Object.freeze({
    name: "image_gen",
    description: "使用已配置的图片模型生成图片，或参考一张本地图片进行编辑。",
    safety: "write",
    produces_artifact: true,
    host_action_capable: true,
    availability_requirement: Object.freeze({
      kind: "model_category",
      value: "IMAGE",
      missing_reason: "请先配置图片生成模型；主模型不需要支持看图",
    }),
    output_contract: Object.freeze({
      role: "deliverable",
      surface: "both",
      persistence: "library",
      kind: "image",
      path_field: "path",
      trusted_generated_path: true,
    }),
  }),
]);

function result(data, content = [], modelMessage = "", modelData = null) {
  const { host_actions: _hostActions, ...visibleData } = data || {};
  const serialized = JSON.stringify(modelData && typeof modelData === "object" ? modelData : visibleData, null, 2);
  return {
    content: [{
      type: "text",
      text: modelMessage ? `${modelMessage}\n\n${serialized}` : serialized,
    }, ...content],
    details: data,
  };
}

function error(message, extra = {}) {
  return result({ success: false, error: String(message || "未知错误"), ...extra });
}

function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function requireReadablePath(path, roots, expectedExtensions = null) {
  const target = resolve(String(path || ""));
  if (!roots.some((root) => isInside(root, target))) throw new Error("文件不在本轮允许访问的工作区内");
  if (!existsSync(target)) throw new Error(`文件不存在: ${target}`);
  const allowed = Array.isArray(expectedExtensions) ? expectedExtensions : expectedExtensions ? [expectedExtensions] : [];
  if (allowed.length && !allowed.includes(extname(target).toLowerCase())) {
    throw new Error("只支持 PNG、JPEG 或 WebP 图片文件");
  }
  return target;
}

function imageEndpoint(apiBase, operation) {
  const base = String(apiBase || "").replace(/\/+$/, "");
  if (!base) throw new Error("图片模型缺少 API 地址");
  if (/\/images\/(generations|edits)$/.test(base)) return base.replace(/\/(generations|edits)$/, `/${operation}`);
  return `${base}/images/${operation}`;
}

function authHeaders(config) {
  const extra = config?.extra_config && typeof config.extra_config === "object" ? config.extra_config : {};
  return {
    ...(config?.api_key ? { Authorization: `Bearer ${config.api_key}` } : {}),
    ...(extra.extra_headers && typeof extra.extra_headers === "object" ? extra.extra_headers : {}),
  };
}

function imageMime(path) {
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  })[extname(path).toLowerCase()] || "application/octet-stream";
}

function detectedImageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: ".png", mimeType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: ".jpg", mimeType: "image/jpeg" };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return { extension: ".webp", mimeType: "image/webp" };
  }
  return null;
}

async function describeReferenceImage(agentContext, referencePath) {
  let config;
  let modelRole = "VISION";
  try {
    config = await ModelConfigResolver.resolve({ project_id: agentContext?.project_id, category: "VISION" });
  } catch {
    modelRole = "PRIMARY";
    try {
      config = await ModelConfigResolver.resolve({ project_id: agentContext?.project_id, category: "PRIMARY" });
    } catch {
      config = null;
    }
    const primaryExtra = config?.extra_config && typeof config.extra_config === "object" ? config.extra_config : {};
    if (!config || primaryExtra.supports_image_input !== true) {
      throw new Error("当前图片模型不支持参考图输入。请配置视觉模型、把主模型标记为“支持图片输入”，或启用图片模型的参考图编辑能力");
    }
  }
  const format = String(config.api_format || "chat_completions").toLowerCase();
  const dataUrl = `data:${imageMime(referencePath)};base64,${(await readFile(referencePath)).toString("base64")}`;
  const instruction = "请准确描述这张参考图的构图、主体、颜色、材质、光线、字体和整体视觉风格。只输出可直接交给图片生成模型的中文描述，不要猜测看不见的信息。";
  const content = format === "responses"
    ? [{ type: "input_text", text: instruction }, { type: "input_image", image_url: dataUrl }]
    : [{ type: "text", text: instruction }, { type: "image_url", image_url: { url: dataUrl } }];
  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(getApiUrl(config), {
      method: "POST",
      headers: buildRequestHeaders(config),
      body: JSON.stringify(buildRequestData(config, {
        messages: [{ role: "user", content }],
        temperature: 0.2,
        max_tokens: 1000,
      })),
      signal: agentContext?.signal || undefined,
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!response.ok) throw new Error(`视觉模型调用失败: ${extractErrorDetail(text) || `HTTP ${response.status}`}`);
    const description = ResponseExtractor.extract_chat_content(data);
    if (!String(description || "").trim()) throw new Error("视觉模型没有返回图片描述");
    recordTraceLlmCall({
      callSite: "image_vision",
      model: config.model_name,
      modelId: config.id || "",
      input: instruction,
      output: description,
      status: 0,
      durationMs: Date.now() - startedAt,
      usage: data?.usage || null,
      attrs: { operation: "describe_reference", model_role: modelRole },
    });
    return String(description).trim();
  } catch (cause) {
    recordTraceLlmCall({
      callSite: "image_vision",
      model: config.model_name,
      modelId: config.id || "",
      input: instruction,
      error: cause,
      status: 1,
      durationMs: Date.now() - startedAt,
      attrs: { operation: "describe_reference", model_role: modelRole },
    });
    throw cause;
  }
}

async function parseImageResponse(response) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || text || `HTTP ${response.status}`;
    throw new Error(`图片模型调用失败: ${String(detail).slice(0, 800)}`);
  }
  const dashScopeContent = data?.output?.choices?.[0]?.message?.content;
  const dashScopeItem = Array.isArray(dashScopeContent) ? dashScopeContent.find((entry) => entry?.image) : null;
  const item = Array.isArray(data?.data) ? data.data[0] : dashScopeItem || data?.output?.[0] || data;
  const base64 = item?.b64_json || item?.base64 || item?.image_base64 || null;
  const url = item?.url || item?.image_url || item?.image || null;
  if (!base64 && !url) throw new Error("图片模型响应中没有图片数据");
  return { data, base64, url, revisedPrompt: item?.revised_prompt || null };
}

async function imageGenTool(agentContext, params = {}, toolCallId = null) {
  const prompt = String(params.prompt || "").trim();
  if (!prompt) return error("prompt 为必填项");
  let config;
  try {
    config = await ModelConfigResolver.resolve({ project_id: agentContext?.project_id, category: "IMAGE" });
  } catch {
    return error("尚未配置图片模型。请在“设置 → 模型 → 图片模型”中添加并启用一个 OpenAI 兼容图片模型。", {
      code: "IMAGE_MODEL_NOT_CONFIGURED",
    });
  }

  const roots = (agentContext?.workspace_roots || []).map(String).filter(Boolean);
  const referencePath = params.reference_image_path
    ? requireReadablePath(params.reference_image_path, roots)
    : null;
  const extra = config?.extra_config && typeof config.extra_config === "object" ? config.extra_config : {};
  const supportsReferenceImage = extra.supports_reference_image !== false;
  const modelReferencePath = referencePath && supportsReferenceImage ? referencePath : null;
  const visualDescription = referencePath && !supportsReferenceImage
    ? await describeReferenceImage(agentContext, referencePath)
    : null;
  const effectivePrompt = visualDescription
    ? `${prompt}\n\n参考图视觉描述：\n${visualDescription}`
    : prompt;
  const operation = modelReferencePath ? "edits" : "generations";
  const provider = String(extra.image_provider || "openai_images");
  const startedAt = Date.now();
  let response;
  if (provider === "dashscope_multimodal") {
    const base = String(config.api_base || "").replace(/\/+$/, "");
    const endpoint = /\/services\/aigc\/multimodal-generation\/generation$/.test(base)
      ? base
      : `${base}/services/aigc/multimodal-generation/generation`;
    const content = [{ text: effectivePrompt }];
    if (modelReferencePath) {
      content.push({ image: `data:${imageMime(modelReferencePath)};base64,${(await readFile(modelReferencePath)).toString("base64")}` });
    }
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(config) },
      body: JSON.stringify({
        model: config.model_name,
        input: { messages: [{ role: "user", content }] },
        parameters: {
          ...(extra.extra_body && typeof extra.extra_body === "object" ? extra.extra_body : {}),
          ...(params.size ? { size: String(params.size).replace("x", "*") } : {}),
        },
      }),
      signal: agentContext?.signal || undefined,
    });
  } else if (modelReferencePath) {
    const form = new FormData();
    form.set("model", config.model_name);
    form.set("prompt", effectivePrompt);
    form.set("image", new Blob([await readFile(modelReferencePath)]), basename(modelReferencePath));
    if (params.size) form.set("size", String(params.size));
    if (params.quality) form.set("quality", String(params.quality));
    response = await fetch(imageEndpoint(config.api_base, operation), {
      method: "POST",
      headers: authHeaders(config),
      body: form,
      signal: agentContext?.signal || undefined,
    });
  } else {
    response = await fetch(imageEndpoint(config.api_base, operation), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(config) },
      body: JSON.stringify({
        ...(extra.extra_body && typeof extra.extra_body === "object" ? extra.extra_body : {}),
        model: config.model_name,
        prompt: effectivePrompt,
        n: 1,
        ...(params.size ? { size: params.size } : {}),
        ...(params.quality ? { quality: params.quality } : {}),
        response_format: "b64_json",
      }),
      signal: agentContext?.signal || undefined,
    });
  }

  let parsed;
  try {
    parsed = await parseImageResponse(response);
    recordTraceLlmCall({
      callSite: "image_gen",
      model: config.model_name,
      modelId: config.id || "",
      input: effectivePrompt,
      output: parsed.url ? "image_url" : "base64_image",
      status: 0,
      durationMs: Date.now() - startedAt,
      usage: parsed.data?.usage || null,
      attrs: { provider, operation, composed_with_vision: !!visualDescription },
    });
  } catch (cause) {
    recordTraceLlmCall({
      callSite: "image_gen",
      model: config.model_name,
      modelId: config.id || "",
      input: effectivePrompt,
      error: cause,
      status: 1,
      durationMs: Date.now() - startedAt,
      attrs: { provider, operation, composed_with_vision: !!visualDescription },
    });
    throw cause;
  }
  let bytes;
  if (parsed.base64) bytes = Buffer.from(parsed.base64, "base64");
  else {
    bytes = await downloadGeneratedImage(parsed.url, agentContext?.signal || undefined);
  }
  const format = detectedImageFormat(bytes);
  if (!format) throw new Error("图片模型返回了不支持的图片格式；目前支持 PNG、JPEG 和 WebP");
  const outputRoot = join(
    String(agentContext?.workspace_write_root || roots[0] || process.cwd()),
    ".dsh",
    "outputs",
    "images",
  );
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const outputPath = join(outputRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}${format.extension}`);
  await writeFile(outputPath, bytes, { mode: 0o600 });
  return result({
    success: true,
    path: outputPath,
    model: config.model_name,
    revised_prompt: parsed.revisedPrompt,
    usage: parsed.data?.usage || null,
  }, [{ type: "image", data: bytes.toString("base64"), mimeType: format.mimeType }],
  "图片已根据本轮用户要求生成成功，图片内容已随工具结果返回。请承接当前图片请求完成回复，简短说明图片已生成，不要回到旧话题或重新问候用户，也不要向用户展示内部文件路径或保存位置。",
  {
    success: true,
    revised_prompt: parsed.revisedPrompt,
  });
}

const PARAMS = {
  image_gen: Type.Object({
    prompt: Type.String({ description: "完整的图片生成或编辑要求" }),
    reference_image_path: Type.Optional(Type.String({ description: "可选，本轮工作区内的参考图片绝对路径" })),
    size: Type.Optional(Type.String({ description: "图片尺寸，例如 1024x1024" })),
    quality: Type.Optional(Type.String({ description: "图片质量，例如 low、medium、high" })),
  }),
};

const HANDLERS = { image_gen: imageGenTool };

/**
 * 下载模型返回的图片 URL。
 * 安全约束：模型返回的 URL 不受信任——校验解析结果不指向私有/本机网络（SSRF），
 * 且流式读取带大小上限，避免被恶意或被攻破的模型用超大响应耗尽内存。
 */
async function downloadGeneratedImage(rawUrl, signal) {
  let parsedUrl;
  try { parsedUrl = new URL(String(rawUrl)); }
  catch { throw new Error("图片模型返回了无效的下载地址"); }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("图片下载地址必须是 http/https 协议");
  }
  const hostname = parsedUrl.hostname;
  // SSRF 防护：解析主机名，命中私有/本网地址则拒绝。DNS 解析失败时不阻塞——
  // 生产环境的模型返回 URL 通常可解析，解析失败交给后续 fetch 报网络错误即可。
  const records = await dnsLookup(hostname, { all: true }).catch(() => []);
  if (records.length && records.some((record) => isPrivateNetworkAddress(record.address))) {
    throw new Error("图片下载地址指向内网或本机，已拒绝");
  }
  const downloaded = await fetch(parsedUrl, {
    signal,
    // 严格限制重定向：模型返回的 URL 不应跳转到内网地址。
    redirect: "error",
  });
  if (!downloaded.ok) throw new Error(`下载生成图片失败: HTTP ${downloaded.status}`);
  const contentLength = Number(downloaded.headers.get("content-length") || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_IMAGE_BYTES) {
    throw new Error(`图片超过大小限制（${contentLength} 字节）`);
  }
  // 读取后再次校验实际大小：content-length 可缺失或被伪造。
  const buffer = await downloaded.arrayBuffer();
  const bytes = Buffer.from(buffer);
  if (bytes.byteLength > MAX_DOWNLOAD_IMAGE_BYTES) {
    throw new Error(`图片超过大小限制（${bytes.byteLength} 字节）`);
  }
  return bytes;
}

export function createCreativeTools(agentContext) {
  return CREATIVE_TOOL_CATALOG.map((definition) => ({
    ...definition,
    parameters: PARAMS[definition.name],
    provider_type: "host",
    exposure: "deferred",
    execute: async (toolCallId, params) => {
      try { return await HANDLERS[definition.name](agentContext, params || {}, toolCallId); }
      catch (cause) { return error(cause?.message || String(cause), { tool: definition.name }); }
    },
  }));
}

export default { createCreativeTools, CREATIVE_TOOL_CATALOG };

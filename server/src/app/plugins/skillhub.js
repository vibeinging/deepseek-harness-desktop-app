import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { APP_DISPLAY_NAME } from "../../config/app_name.js";
import { dirname, join, relative, resolve } from "node:path";
import JSZip from "jszip";
import { ApiError } from "../../errors.js";
import { userSkillsRoot } from "../../config/paths.js";
import {
  getAppSkill,
  isBuiltinSkill,
  normalizeSkillName,
  setAppSkillEnabled,
} from "../../engine/agents/skill_registry.js";
import { loadSkillManifest } from "../../engine/skills/skill_file_loader.js";

export const SKILLHUB_API_BASE = "https://api.skillhub.cn";
export const SKILLHUB_MARKET_URL = "https://skillhub.cloud.tencent.com";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 500;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function clean(value, max = 2_000) {
  return String(value ?? "").trim().slice(0, max);
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSlug(value) {
  const slug = clean(value, 128).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(slug) || slug.includes("..")) {
    throw new ApiError("SkillHub 技能标识不合法", 400);
  }
  return slug;
}

function isInside(base, target) {
  const rel = relative(resolve(base), resolve(target));
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function securityView(reports = {}) {
  const items = Object.entries(reports || {}).map(([provider, report]) => ({
    provider,
    status: clean(report?.status, 40).toLowerCase() || "unknown",
    status_text: clean(report?.statusText, 200),
    report_url: clean(report?.reportUrl, 1_000),
  }));
  const blocked = items.some((item) => /(malicious|danger|risk|blocked|unsafe)/i.test(item.status));
  const passed = items.length > 0 && items.every((item) => item.status === "benign");
  return {
    status: blocked ? "blocked" : passed ? "passed" : "unchecked",
    reports: items,
  };
}

async function skillHubFetch(path, { fetchImpl = globalThis.fetch, timeoutMs = 12_000 } = {}) {
  if (typeof fetchImpl !== "function") throw new ApiError("当前运行环境不支持访问技能广场", 500);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL(path, SKILLHUB_API_BASE), {
      headers: { accept: "application/json, application/zip" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new ApiError(`腾讯 SkillHub 请求失败 (${response.status})`, 502);
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error?.name === "AbortError" ? "腾讯 SkillHub 请求超时" : "无法连接腾讯 SkillHub";
    throw new ApiError(message, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseBuffer(response, limit, tooLargeMessage) {
  const declaredSize = number(response.headers.get("content-length"));
  if (declaredSize > limit) throw new ApiError(tooLargeMessage, 400);
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new ApiError(tooLargeMessage, 400);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new ApiError(tooLargeMessage, 400);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

async function skillHubJson(path, options = {}) {
  const response = await skillHubFetch(path, options);
  const text = (await readResponseBuffer(response, MAX_JSON_BYTES, "腾讯 SkillHub 返回内容过大")).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError("腾讯 SkillHub 返回了无效数据", 502);
  }
}

async function skillHubArchive(slug, options = {}) {
  const response = await skillHubFetch(`/api/v1/download?slug=${encodeURIComponent(slug)}`, {
    ...options,
    timeoutMs: 30_000,
  });
  const buffer = await readResponseBuffer(response, MAX_ARCHIVE_BYTES, "该技能包超过 20 MB，暂不支持安装");
  if (!buffer.length) throw new ApiError("技能包为空", 400);
  return buffer;
}

export function normalizeSkillHubSearch(payload = {}, { page = 1, pageSize = 24 } = {}) {
  if (payload?.code !== 0 || !payload?.data || !Array.isArray(payload.data.skills)) {
    throw new ApiError(clean(payload?.message, 300) || "腾讯 SkillHub 返回了无效列表", 502);
  }
  const items = payload.data.skills.map((skill) => ({
    slug: clean(skill?.slug, 128),
    name: clean(skill?.name || skill?.slug, 200),
    description: clean(skill?.description_zh || skill?.description, 2_000),
    version: clean(skill?.version, 80),
    owner: clean(skill?.publisher?.name || skill?.ownerName || skill?.namespace?.displayName, 160),
    publisher_verified: Boolean(skill?.publisher?.verified || skill?.verified),
    source: clean(skill?.source, 80),
    category: clean(skill?.category, 120),
    categories: Array.isArray(skill?.subCategories)
      ? skill.subCategories.map((item) => clean(item?.name, 80)).filter(Boolean)
      : [],
    requires_api_key: String(skill?.labels?.requires_api_key || "false") === "true",
    downloads: number(skill?.downloads),
    installs: number(skill?.installs),
    stars: number(skill?.stars),
    detail_url: `${SKILLHUB_MARKET_URL}/skills/${encodeURIComponent(clean(skill?.slug, 128))}`,
  })).filter((item) => item.slug);
  return {
    items,
    total: Math.max(0, number(payload.data.total)),
    page,
    page_size: pageSize,
    source: {
      id: "tencent-skillhub",
      name: "腾讯 SkillHub",
      url: SKILLHUB_MARKET_URL,
    },
  };
}

export function normalizeSkillHubDetail(payload = {}) {
  if (!payload?.skill?.slug || !payload?.latestVersion?.version) {
    throw new ApiError("腾讯 SkillHub 返回了无效技能详情", 502);
  }
  const skill = payload.skill;
  return {
    slug: normalizeSlug(skill.slug),
    name: clean(skill.displayName || skill.slug, 200),
    description: clean(skill.summary_zh || skill.summary, 8_000),
    version: clean(payload.latestVersion.version, 80),
    owner: clean(payload?.publisher?.name || payload?.owner?.displayName || payload?.namespace?.displayName, 160),
    publisher_verified: Boolean(skill.isAuthorVerified || payload?.publisher?.verified),
    source: clean(skill.source, 80),
    categories: Array.isArray(skill.subCategories)
      ? skill.subCategories.map((item) => clean(item?.name, 80)).filter(Boolean)
      : [],
    requires_api_key: String(skill?.labels?.requires_api_key || "false") === "true",
    stats: {
      downloads: number(skill?.stats?.downloads),
      installs: number(skill?.stats?.installs),
      stars: number(skill?.stats?.stars),
      versions: number(skill?.stats?.versions),
    },
    security: securityView(payload.securityReports),
    detail_url: `${SKILLHUB_MARKET_URL}/skills/${encodeURIComponent(skill.slug)}`,
  };
}

function safeArchivePath(entry) {
  const raw = String(entry?.unsafeOriginalName || entry?.name || "");
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    throw new ApiError("技能包包含不安全的文件路径", 400);
  }
  const segments = raw.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    throw new ApiError("技能包包含目录越界路径", 400);
  }
  return segments.join("/");
}

function excludedFromContentHash(path) {
  const segments = path.split("/");
  const name = segments.at(-1) || "";
  return path === "_meta.json"
    || segments.includes("__MACOSX")
    || name === ".DS_Store"
    || name.startsWith("._")
    || name === "Thumbs.db";
}

export async function inspectSkillHubArchive(buffer) {
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
  } catch {
    throw new ApiError("技能包不是有效的 ZIP 文件", 400);
  }
  const entries = [];
  let expandedBytes = 0;
  for (const entry of Object.values(zip.files)) {
    const path = safeArchivePath(entry);
    if (entry.dir) continue;
    if ((Number(entry.unixPermissions) & 0o170000) === 0o120000) {
      throw new ApiError("技能包不能包含符号链接", 400);
    }
    const declaredSize = number(entry?._data?.uncompressedSize);
    expandedBytes += declaredSize;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new ApiError("技能包解压后超过 50 MB", 400);
    entries.push({ entry, path, declaredSize });
  }
  if (!entries.length || entries.length > MAX_ARCHIVE_FILES) throw new ApiError("技能包文件数量不合法", 400);
  if (!entries.some((item) => item.path === "SKILL.md")) throw new ApiError("技能包根目录缺少 SKILL.md", 400);

  const contentRows = [];
  let actualBytes = 0;
  for (const item of entries) {
    const content = await item.entry.async("nodebuffer");
    actualBytes += content.length;
    if (actualBytes > MAX_EXPANDED_BYTES) throw new ApiError("技能包解压后超过 50 MB", 400);
    item.content = content;
    if (!excludedFromContentHash(item.path)) {
      contentRows.push(`${item.path}:${createHash("sha256").update(content).digest("hex")}`);
    }
  }
  contentRows.sort();
  const contentHash = createHash("sha256").update(`${contentRows.join("\n")}\n`, "utf8").digest("hex");
  return { entries, content_hash: contentHash, file_count: contentRows.length };
}

export function verifySkillHubSignature({ signature, keys, inspection, slug, version }) {
  if (signature?.signed !== true || !signature?.payload || !signature?.signature || !signature?.key_id) {
    throw new ApiError("该技能版本尚未获得腾讯 SkillHub 内容签名", 400);
  }
  let payload;
  try {
    payload = JSON.parse(signature.payload);
  } catch {
    throw new ApiError("腾讯 SkillHub 签名载荷无效", 502);
  }
  if (payload.skill_slug !== slug || payload.skill_version !== version) {
    throw new ApiError("技能包版本与签名不一致", 400);
  }
  if (payload.content_hash !== inspection.content_hash || signature.content_hash !== inspection.content_hash) {
    throw new ApiError("技能包内容指纹校验失败", 400);
  }
  if (number(payload.file_count, -1) !== inspection.file_count) {
    throw new ApiError("技能包文件数量与签名不一致", 400);
  }
  const key = Array.isArray(keys?.keys) ? keys.keys.find((item) => item?.key_id === signature.key_id) : null;
  if (!key?.public_key_raw_b64 || key.algorithm !== "Ed25519") {
    throw new ApiError("腾讯 SkillHub 签名公钥不可用", 502);
  }
  let publicKey;
  try {
    const raw = Buffer.from(key.public_key_raw_b64, "base64");
    if (raw.length !== 32) throw new Error("invalid key");
    publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
  } catch {
    throw new ApiError("腾讯 SkillHub 签名公钥无效", 502);
  }
  const valid = verifySignature(
    null,
    Buffer.from(signature.payload, "utf8"),
    publicKey,
    Buffer.from(signature.signature, "base64"),
  );
  if (!valid) throw new ApiError("腾讯 SkillHub 数字签名校验失败", 400);
  return {
    key_id: signature.key_id,
    content_hash: inspection.content_hash,
    signed_at: number(signature.signed_at),
  };
}

export async function installSkillHubArchive({
  inspection,
  detail,
  signature,
  skillsRoot = userSkillsRoot(),
}) {
  await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
  let staging = await mkdtemp(join(skillsRoot, ".skillhub-install-"));
  try {
    for (const item of inspection.entries) {
      const file = join(staging, item.path);
      if (!isInside(staging, file)) throw new ApiError("技能包文件路径越界", 400);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const executable = (Number(item.entry.unixPermissions) & 0o111) !== 0;
      await writeFile(file, item.content, { mode: executable ? 0o700 : 0o600 });
    }
    const manifest = loadSkillManifest(staging, {
      builtin: false,
      source: "skillhub",
      version: detail.version,
    });
    if (!manifest?.name || !manifest?.description) throw new ApiError("技能包的 SKILL.md 缺少名称或描述", 400);
    const name = normalizeSkillName(manifest.name);
    if (isBuiltinSkill(name)) throw new ApiError(`不能安装与${APP_DISPLAY_NAME}内置技能同名的技能`, 409);
    const target = join(skillsRoot, name);
    if (existsSync(target)) throw new ApiError(`技能「${name}」已安装`, 409);
    await writeFile(join(staging, ".dsh-market.json"), `${JSON.stringify({
      schema_version: 1,
      source: "tencent-skillhub",
      slug: detail.slug,
      version: detail.version,
      detail_url: detail.detail_url,
      owner: detail.owner,
      security: detail.security,
      signature,
      installed_at: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(staging, target);
    staging = null;
    return { name, path: target };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}

async function loadSkillHubDetail(slug, options = {}) {
  return normalizeSkillHubDetail(await skillHubJson(`/api/v1/skills/${encodeURIComponent(slug)}`, options));
}

export async function listSkillHubMarket(_ctx, input, options = {}) {
  const page = Math.max(1, Math.floor(number(input?.query?.page, 1)));
  const pageSize = Math.min(50, Math.max(1, Math.floor(number(input?.query?.page_size || input?.query?.pageSize, 24))));
  const keyword = clean(input?.query?.keyword, 100);
  const payload = await skillHubJson(`/api/skills?page=${page}&pageSize=${pageSize}&keyword=${encodeURIComponent(keyword)}`, options);
  return { data: normalizeSkillHubSearch(payload, { page, pageSize }), message: "获取腾讯 SkillHub 技能成功" };
}

export async function getSkillHubMarketDetail(_ctx, input, options = {}) {
  const slug = normalizeSlug(input?.params?.slug);
  return { data: await loadSkillHubDetail(slug, options), message: "获取腾讯 SkillHub 技能详情成功" };
}

export async function installSkillHubMarketSkill(ctx, input, options = {}) {
  const slug = normalizeSlug(input?.params?.slug);
  const detail = await loadSkillHubDetail(slug, options);
  if (detail.security.status === "blocked") throw new ApiError("腾讯安全扫描认为该技能存在风险，已阻止安装", 400);
  const [archive, signaturePayload, keysPayload] = await Promise.all([
    skillHubArchive(slug, options),
    skillHubJson(`/api/v1/open/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(detail.version)}/signature`, options),
    skillHubJson("/api/v1/open/platform/keys", options),
  ]);
  const inspection = await inspectSkillHubArchive(archive);
  const signature = verifySkillHubSignature({
    signature: signaturePayload,
    keys: keysPayload,
    inspection,
    slug,
    version: detail.version,
  });
  const installed = await installSkillHubArchive({ inspection, detail, signature });
  try {
    await setAppSkillEnabled(ctx, installed.name, false);
    const skill = await getAppSkill(ctx, installed.name);
    return {
      data: { skill, market: detail, signature },
      message: "技能已安装并保持停用，请检查后手动启用",
    };
  } catch (error) {
    await rm(installed.path, { recursive: true, force: true });
    throw error;
  }
}

export default {
  listSkillHubMarket,
  getSkillHubMarketDetail,
  installSkillHubMarketSkill,
};

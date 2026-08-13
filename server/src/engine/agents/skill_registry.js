import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { APP_DISPLAY_NAME } from "../../config/app_name.js";
import { homedir } from "node:os";
import { delimiter, dirname, extname, join, relative, resolve } from "node:path";
import { ApiError } from "../../errors.js";
import { agentRuntimeHome, userSkillsRoot } from "../../config/paths.js";
import { getAgentRuntime, writeAgentSkillConfig } from "../agent_kernel/agent_runtime.js";
import { PRODUCT_TOOL_CATALOG } from "./product_tool_catalog.js";
import { CREATIVE_TOOL_CATALOG } from "./creative_tools.js";
import { loadBuiltinSkills, loadSkillManifest } from "../skills/skill_file_loader.js";
import { skillIdentityView } from "../skills/skill_identity.js";
import { workspaceCwd } from "./workspace_paths.js";

export const AGENT_TOOL_CATALOG = [
  { name: "update_plan", description: "更新当前任务计划,用于让用户看到多步任务进度。", safety: "meta" },
  { name: "read", description: "读取工作区内文件内容。", safety: "read" },
  { name: "grep", description: "按内容搜索工作区文件。", safety: "read" },
  { name: "ls", description: "列出工作区目录内容。", safety: "read" },
  { name: "find", description: "按 glob 模式查找工作区文件。", safety: "read" },
  { name: "write", description: "创建或覆盖工作区文件,执行前受权限确认控制。", safety: "write" },
  { name: "edit", description: "编辑工作区文件,执行前受权限确认控制。", safety: "write" },
  { name: "bash", description: "在工作区执行 shell 命令,执行前受权限确认控制。", safety: "execute" },
  ...PRODUCT_TOOL_CATALOG,
  ...CREATIVE_TOOL_CATALOG,
];

export const BUILTIN_SKILLS = await loadBuiltinSkills();
export const APP_SKILL_SCOPE = "__app__";
export const CHAT_SKILL_SCOPE = "__chat__";

const BUILTIN_BY_NAME = new Map(BUILTIN_SKILLS.map((skill) => [skill.name, skill]));
function canonicalPath(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

const BUILTIN_BY_PATH = new Map(BUILTIN_SKILLS.map((skill) => [canonicalPath(skill.path), skill]));
const BUILTIN_SKILL_ROOTS = [...new Set(BUILTIN_SKILLS.map((skill) => dirname(dirname(skill.path))))];
const APP_SKILL_ROOTS = [...new Set([userSkillsRoot(), ...BUILTIN_SKILL_ROOTS])];
const REPORTED_SCAN_ERRORS = new Set();
const EXECUTABLE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/;

function cleanString(value, max = 20_000) {
  return String(value || "").trim().slice(0, max);
}

function skillDigest(value) {
  return `sha256:${createHash("sha256").update(String(value || "")).digest("hex")}`;
}

function isInside(base, target) {
  const rel = relative(canonicalPath(base), canonicalPath(target));
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
}

function machineUserSkillsRoot() {
  return join(homedir(), ".agents", "skills");
}

export function isRuntimePluginCacheSkillPath(path) {
  return [
    join(agentRuntimeHome(), "plugins", "cache"),
    join(agentRuntimeHome(), ".tmp", "plugins"),
  ].some((root) => isInside(root, path));
}

export function executableAvailable(name, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const executable = String(name || "").trim();
  if (!EXECUTABLE_NAME_PATTERN.test(executable)) return false;
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  const hasExtension = platform === "win32" && !!extname(executable);
  const candidates = String(env.PATH || "")
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean)
    .flatMap((directory) => (hasExtension ? [join(directory, executable)] : extensions.map((extension) => join(directory, `${executable}${extension}`))));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function readManagedMarketplaceMetadata(skillPath) {
  const file = join(dirname(skillPath), ".dsh-market.json");
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (value?.source !== "tencent-skillhub" || !value?.slug) return null;
    return {
      id: "tencent-skillhub",
      name: "腾讯 SkillHub",
      slug: cleanString(value.slug, 128),
      version: cleanString(value.version, 80) || null,
      detail_url: cleanString(value.detail_url, 1_000),
      owner: cleanString(value.owner, 160),
      security: value.security || null,
      signature: value.signature || null,
      installed_at: cleanString(value.installed_at, 80),
    };
  } catch {
    return null;
  }
}

export function normalizeSkillName(value) {
  const name = cleanString(value, 64);
  if (!name) throw new ApiError("Skill 名称不能为空", 400);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) {
    throw new ApiError("Skill 名称只能使用小写字母、数字和短横线", 400);
  }
  return name;
}

function normalizeSkillLookupName(value) {
  const name = cleanString(value, 160);
  if (!name) throw new ApiError("Skill 名称不能为空", 400);
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?(?::[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)?$/.test(name)) {
    throw new ApiError("Skill 名称不合法", 400);
  }
  return name;
}

function normalizeSkillConfig(data = {}) {
  return {
    description: cleanString(data.description, 1_000),
    instructions: cleanString(data.instructions, 20_000),
    allow_implicit_invocation: data.allow_implicit_invocation !== false,
  };
}

function appSkillPackageRoot(name) {
  return join(userSkillsRoot(), normalizeSkillName(name));
}

function yamlString(value) {
  return JSON.stringify(String(value || ""));
}

function throwIfSkillMutationAborted(signal) {
  if (signal?.aborted !== true) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  const error = new Error("Agent Turn 已取消");
  error.name = "AbortError";
  throw error;
}

async function writeAppSkillPackage(name, config, { signal = null } = {}) {
  const root = appSkillPackageRoot(name);
  const parent = dirname(root);
  const transactionId = randomUUID();
  const stagingRoot = join(parent, `.${name}.staging-${transactionId}`);
  const backupRoot = join(parent, `.${name}.backup-${transactionId}`);
  const agentsDir = join(stagingRoot, "agents");
  const markdown = [
    "---",
    `name: ${name}`,
    `description: ${yamlString(config.description)}`,
    "---",
    "",
    config.instructions,
    "",
  ].join("\n");
  const openAiYaml = [
    "interface:",
    `  display_name: ${yamlString(name)}`,
    `  short_description: ${yamlString(config.description.slice(0, 120))}`,
    `  default_prompt: ${yamlString(`Use $${name} for this task.`)}`,
    "policy:",
    `  allow_implicit_invocation: ${config.allow_implicit_invocation !== false}`,
    "",
  ].join("\n");
  let previousMoved = false;
  try {
    throwIfSkillMutationAborted(signal);
    if (existsSync(root)) {
      // App-managed Skills may still contain user-added scripts or assets.
      // Stage the whole package without following symlinks, then replace only
      // the two files owned by this editor.
      await cp(root, stagingRoot, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: false,
        verbatimSymlinks: true,
      });
      throwIfSkillMutationAborted(signal);
    }
    await mkdir(agentsDir, { recursive: true, mode: 0o700 });
    throwIfSkillMutationAborted(signal);
    await writeFile(join(stagingRoot, "SKILL.md"), markdown, { encoding: "utf8", mode: 0o600 });
    throwIfSkillMutationAborted(signal);
    await writeFile(join(agentsDir, "openai.yaml"), openAiYaml, { encoding: "utf8", mode: 0o600 });
    // Cancellation is allowed before the commit point. Once the old package is
    // moved aside, finish the two renames so readers never observe a half-written
    // SKILL.md/openai.yaml pair.
    throwIfSkillMutationAborted(signal);
    if (existsSync(root)) {
      await rename(root, backupRoot);
      previousMoved = true;
    }
    await rename(stagingRoot, root);
    if (previousMoved) await rm(backupRoot, { recursive: true, force: true });
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    if (previousMoved && !existsSync(root) && existsSync(backupRoot)) {
      await rename(backupRoot, root).catch(() => undefined);
    }
    throw error;
  } finally {
    // If restoring the previous package failed, leave the backup recoverable
    // instead of deleting the user's last complete copy.
    if (existsSync(root)) {
      await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function skillCatalogRuntime() {
  return getAgentRuntime({
    runtimeKey: "skill-catalog",
    cwd: agentRuntimeHome(),
    requestTimeoutMs: 30_000,
  });
}

async function nativeSkillsForCwd(cwd, { forceReload = true } = {}) {
  await mkdir(agentRuntimeHome(), { recursive: true, mode: 0o700 });
  await mkdir(userSkillsRoot(), { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const runtime = skillCatalogRuntime();
  await runtime.setSkillExtraRoots(APP_SKILL_ROOTS);
  const response = await runtime.listSkills({ cwds: [cwd], forceReload });
  const entry = Array.isArray(response?.data) ? response.data[0] : null;
  if (entry?.errors?.length) {
    const message = entry.errors.map((error) => `${error.path}: ${error.message}`).join("; ");
    if (!REPORTED_SCAN_ERRORS.has(message)) {
      REPORTED_SCAN_ERRORS.add(message);
      console.warn(`[skills] Agent 跳过 ${entry.errors.length} 个无效 Skill 文件: ${message}`);
    }
  }
  return Array.isArray(entry?.skills) ? entry.skills : [];
}

function builtinToSkill(def, enabled = def.default_enabled !== false) {
  const effective = enabled !== false;
  const requiresProject = def.requires_project === true;
  return {
    ...def,
    ...skillIdentityView(def),
    id: `file:${def.path}`,
    author: "system",
    builtin: true,
    editable: false,
    scope: def.plugin_name ? "plugin" : "system",
    source: def.source || "builtin_file",
    version: def.version || "1.0.0",
    digest: def.digest || skillDigest(def.instructions),
    modified: false,
    required_tools: def.required_tools || [],
    required_bins: def.required_bins || [],
    runtime: def.runtime || "prompt",
    requires_project: requiresProject,
    requires_datasource: requiresProject,
    is_active: true,
    default_enabled: effective,
    effective_enabled: effective,
    is_enabled: effective,
    availability: effective ? "enabled" : "disabled",
    verification_status: "verified",
    can_run: effective,
    config: {
      description: def.description,
      instructions: def.instructions,
      allow_implicit_invocation: def.allow_implicit_invocation !== false,
    },
  };
}

function nativeSkillToView(metadata) {
  const path = canonicalPath(String(metadata?.path || ""));
  const builtin = BUILTIN_BY_PATH.get(path);
  if (builtin) return builtinToSkill(builtin, metadata.enabled !== false);
  if (isRuntimePluginCacheSkillPath(path)) return null;

  const scope = cleanString(metadata?.scope, 24) || "user";
  const managed = isInside(userSkillsRoot(), path) && !isInside(join(agentRuntimeHome(), "skills", ".system"), path);
  const machineExternal = scope === "user" && isInside(machineUserSkillsRoot(), path);
  const marketplace = managed ? readManagedMarketplaceMetadata(path) : null;
  const managedSource = marketplace ? "skillhub" : "user_created";
  const manifest = loadSkillManifest(path, {
    builtin: scope === "system" || scope === "admin",
    source: managed ? managedSource : `agent_${scope}`,
    version: marketplace?.version || undefined,
  });
  const enabled = metadata?.enabled !== false;
  const dependencyItems = [
    ...(Array.isArray(metadata?.dependencies?.tools) ? metadata.dependencies.tools : []),
    ...(Array.isArray(manifest?.dependencies?.tools) ? manifest.dependencies.tools : []),
  ].flatMap((dependency) => {
    const type = cleanString(dependency?.type, 64).toLowerCase();
    const value = cleanString(dependency?.value, 240);
    if (!type || !value) return [];
    return [{ ...dependency, type, value }];
  }).filter((dependency, index, all) => (
    all.findIndex((candidate) => candidate.type === dependency.type && candidate.value === dependency.value) === index
  ));
  const runtimeDependencies = dependencyItems
    .filter((dependency) => dependency.type === "host")
    .map((dependency) => dependency.value);
  const dependencies = [...new Set([
    ...runtimeDependencies,
    ...(manifest?.tool_dependencies || manifest?.required_tools || []),
  ].map((dependency) => cleanString(dependency, 240)).filter(Boolean))];
  const runtimeBins = dependencyItems
    .filter((dependency) => dependency.type === "cli")
    .map((dependency) => dependency.value);
  const requiredBins = [...new Set([
    ...runtimeBins,
    ...(manifest?.required_bins || []),
  ].map((dependency) => cleanString(dependency, 240)).filter(Boolean))];
  const name = cleanString(metadata?.name || manifest?.name, 160);
  if (!name) return null;
  const description = cleanString(metadata?.description || manifest?.description, 1_000);
  const instructions = manifest?.instructions || "";
  const isBuiltin = scope === "system" || scope === "admin";
  const requiredMcpServers = [...new Set([
    ...dependencyItems
      .filter((dependency) => dependency.type === "mcp")
      .map((dependency) => dependency.value),
    ...(manifest?.required_mcp_servers || []),
  ])];
  const allowImplicitInvocation = manifest?.allow_implicit_invocation !== false;
  const view = {
    ...(manifest || {}),
    ...skillIdentityView({ ...(manifest || {}), ...metadata, path }),
    id: `file:${path}`,
    name,
    description,
    instructions,
    path: managed || scope === "repo" ? path : "",
    scope,
    builtin: isBuiltin,
    editable: managed && !isBuiltin && !marketplace,
    removable: managed && !isBuiltin,
    source: managed ? managedSource : `agent_${scope}`,
    author: isBuiltin ? "system" : "",
    version: manifest?.version || null,
    digest: manifest?.digest || skillDigest(`${name}\n${description}`),
    modified: false,
    required_tools: dependencies,
    tool_dependencies: dependencies,
    dependencies: { tools: dependencyItems },
    required_bins: requiredBins,
    required_mcp_servers: requiredMcpServers,
    tool_visibility_limit: null,
    requires_project: scope === "repo",
    requires_datasource: scope === "repo",
    allow_implicit_invocation: allowImplicitInvocation,
    machine_external: machineExternal,
    verification_status: machineExternal ? "agent_user" : managed ? "user_managed" : isBuiltin ? "verified" : "project_managed",
    interface: {
      ...(manifest?.interface && typeof manifest.interface === "object" ? manifest.interface : {}),
      ...(metadata?.interface && typeof metadata.interface === "object" ? metadata.interface : {}),
    },
    marketplace,
    is_active: true,
    default_enabled: enabled,
    effective_enabled: enabled,
    is_enabled: enabled,
    availability: enabled ? "enabled" : "disabled",
    availability_reason: enabled ? "" : "已在 项目配置 中关闭",
    config: {
      description,
      instructions,
      allow_implicit_invocation: allowImplicitInvocation,
    },
  };
  Object.defineProperty(view, "_runtimePath", {
    value: path,
    enumerable: false,
  });
  return view;
}

function sortSkills(skills) {
  return skills.sort((left, right) => {
    if (!!left.plugin_name !== !!right.plugin_name) return left.plugin_name ? -1 : 1;
    if (!!left.builtin !== !!right.builtin) return left.builtin ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

function cloneSkillRuntimeView(sourceSkill) {
  const skill = { ...sourceSkill };
  const runtimePath = String(sourceSkill?._runtimePath || "").trim();
  if (runtimePath) {
    Object.defineProperty(skill, "_runtimePath", {
      value: runtimePath,
      enumerable: false,
    });
  }
  return skill;
}

async function listForCwd(cwd) {
  const native = await nativeSkillsForCwd(cwd, { forceReload: true });
  const discoveredRuntimeSkillPaths = [...new Set(native
    .map((metadata) => canonicalPath(String(metadata?.path || "")))
    .filter(Boolean))];
  const blockedRuntimeSkillPaths = discoveredRuntimeSkillPaths
    .filter((path) => isRuntimePluginCacheSkillPath(path));
  return {
    skills: sortSkills(native.map(nativeSkillToView).filter(Boolean)),
    blocked_runtime_skill_paths: blockedRuntimeSkillPaths,
    discovered_runtime_skill_paths: discoveredRuntimeSkillPaths,
  };
}

async function catalogForCwd(cwd, ctx, projectId = null) {
  const catalog = await listForCwd(cwd);
  const enrichedSkills = await enrichSkillAvailability(catalog.skills, ctx, projectId);
  return {
    ...catalog,
    skills: enrichedSkills,
  };
}

export async function enrichSkillAvailability(skills, ctx, projectId = null, {
  env = process.env,
  platform = process.platform,
  availableMcpServers = new Set(),
} = {}) {
  const knownTools = new Set(AGENT_TOOL_CATALOG.map((tool) => tool.name));
  const toolDefinitions = new Map(AGENT_TOOL_CATALOG.map((tool) => [tool.name, tool]));
  const knownMcpServers = availableMcpServers instanceof Set
    ? availableMcpServers
    : new Set((availableMcpServers || []).map(String));
  const availabilityChecks = new Map();
  const unavailableToolReason = async (toolName) => {
    const requirement = toolDefinitions.get(toolName)?.availability_requirement;
    if (!requirement || !ctx?.queryOne) return "";
    const key = `${requirement.kind}:${requirement.value}`;
    if (!availabilityChecks.has(key)) {
      if (requirement.kind === "model_category") {
        availabilityChecks.set(key, Promise.resolve().then(() => ctx.queryOne(
          `SELECT id FROM llm_models
            WHERE category=$1 AND is_enabled=true AND api_key IS NOT NULL AND deleted_at IS NULL
              AND (project_id=$2 OR project_id IS NULL)
            ORDER BY (project_id=$2) DESC, created_at DESC LIMIT 1`,
          [requirement.value, projectId || null],
        )).then(Boolean).catch(() => false));
      } else {
        availabilityChecks.set(key, Promise.resolve(false));
      }
    }
    return await availabilityChecks.get(key) ? "" : String(requirement.missing_reason || `Host 能力不可用: ${toolName}`);
  };
  return Promise.all(skills.map(async (sourceSkill) => {
    // Plugin release snapshots are immutable. Availability is request-scoped
    // derived state, so calculate it on a shallow view instead of mutating the
    // snapshot. Preserve the intentionally non-enumerable Host runtime path;
    // object spread would otherwise turn a listed system Skill into a catalog
    // item that the turn router cannot execute.
    const skill = cloneSkillRuntimeView(sourceSkill);
    if (!skill.effective_enabled) {
      skill.availability = "disabled";
      skill.availability_reason ||= "已在项目配置中关闭";
      skill.can_run = false;
      return skill;
    }
    const missing = (skill.tool_dependencies || skill.required_tools || []).filter((tool) => !knownTools.has(tool));
    if (missing.length) {
      skill.availability = "unavailable";
      skill.availability_reason = `缺少 Host 能力: ${missing.join(", ")}`;
      skill.can_run = false;
      return skill;
    }
    for (const toolName of skill.tool_dependencies || skill.required_tools || []) {
      const unavailableReason = await unavailableToolReason(toolName);
      if (!unavailableReason) continue;
      skill.availability = "unavailable";
      skill.availability_reason = unavailableReason;
      skill.can_run = false;
      return skill;
    }
    const missingBins = (skill.required_bins || []).filter((name) => !executableAvailable(name, { env, platform }));
    if (missingBins.length) {
      skill.availability = "unavailable";
      skill.availability_reason = `缺少本机命令: ${missingBins.join(", ")}`;
      skill.can_run = false;
      return skill;
    }
    const missingMcpServers = (skill.required_mcp_servers || []).filter((name) => !knownMcpServers.has(name));
    if (missingMcpServers.length) {
      skill.availability = "configuration_required";
      skill.availability_reason = `缺少 MCP 连接: ${missingMcpServers.join(", ")}`;
      skill.can_run = false;
      return skill;
    }
    skill.availability = "enabled";
    skill.availability_reason = "";
    skill.can_run = true;
    return skill;
  }));
}

async function writeEnabled(path, enabled) {
  await writeAgentSkillConfig(
    { path: resolve(path), enabled: !!enabled },
    { runtimeKey: "skill-catalog", cwd: agentRuntimeHome(), requestTimeoutMs: 30_000 },
  );
}

export function isBuiltinSkill(name) {
  return BUILTIN_BY_NAME.has(String(name || ""));
}

export async function listAppSkills(ctx) {
  return (await catalogForCwd(agentRuntimeHome(), ctx, null)).skills;
}

export async function listEnabledAppSkills(ctx) {
  return (await listAppSkills(ctx)).filter((skill) => (
    skill.effective_enabled && skill.availability === "enabled" && !skill.requires_project
  ));
}

export function listGlobalSkills() {
  return BUILTIN_SKILLS.map((def) => builtinToSkill(def)).filter((skill) => skill.default_enabled && !skill.requires_project);
}

export async function getAppSkill(ctx, rawName) {
  const name = normalizeSkillLookupName(rawName);
  const skill = (await listAppSkills(ctx)).find((item) => item.name === name);
  if (!skill) throw new ApiError("Skill 不存在", 404);
  return skill;
}

export async function createAppSkill(ctx, data = {}) {
  const name = normalizeSkillName(data.name);
  if (BUILTIN_BY_NAME.has(name)) throw new ApiError("不能创建与内置 Skill 同名的自定义 Skill", 400);
  if ((await listAppSkills(ctx)).some((skill) => skill.name === name) || existsSync(appSkillPackageRoot(name))) {
    throw new ApiError("Skill 已存在", 409);
  }
  const config = normalizeSkillConfig(data);
  if (!config.description) throw new ApiError("Skill 描述不能为空", 400);
  if (!config.instructions) throw new ApiError("Skill 指令不能为空", 400);
  throwIfSkillMutationAborted(ctx?.signal);
  await writeAppSkillPackage(name, config, { signal: ctx?.signal });
  if (data.default_enabled === false || data.is_enabled === false || data.is_active === false) {
    await writeEnabled(join(appSkillPackageRoot(name), "SKILL.md"), false);
  }
  return getAppSkill(ctx, name);
}

export async function updateAppSkill(ctx, rawName, data = {}) {
  const name = normalizeSkillLookupName(rawName);
  const existing = await getAppSkill(ctx, name);
  if (!existing.editable) throw new ApiError("该 Skill 不是 App 创建的用户文件,不能在这里修改", 400);
  const config = normalizeSkillConfig({
    description: existing.description,
    instructions: existing.instructions,
    allow_implicit_invocation: existing.allow_implicit_invocation,
    ...data,
  });
  if (!config.description) throw new ApiError("Skill 描述不能为空", 400);
  if (!config.instructions) throw new ApiError("Skill 指令不能为空", 400);
  throwIfSkillMutationAborted(ctx?.signal);
  await writeAppSkillPackage(name, config, { signal: ctx?.signal });
  return getAppSkill(ctx, name);
}

export async function deleteAppSkill(ctx, rawName) {
  const name = normalizeSkillLookupName(rawName);
  const existing = await getAppSkill(ctx, name);
  if (!existing.removable && !existing.editable) throw new ApiError(`该 Skill 不是${APP_DISPLAY_NAME}管理的用户文件,不能在这里删除`, 400);
  throwIfSkillMutationAborted(ctx?.signal);
  await writeEnabled(existing.path, true);
  await rm(appSkillPackageRoot(name), { recursive: true, force: true });
  return { name };
}

export async function setAppSkillEnabled(ctx, rawName, value) {
  const name = normalizeSkillLookupName(rawName);
  const existing = await getAppSkill(ctx, name);
  const patch = typeof value === "object" && value !== null ? value : { is_enabled: value };
  const raw = patch.default_enabled ?? patch.is_enabled ?? patch.is_active;
  if (typeof raw !== "boolean") throw new ApiError("enabled 必须为布尔值", 400);
  throwIfSkillMutationAborted(ctx?.signal);
  await writeEnabled(existing._runtimePath || existing.path, raw);
  return getAppSkill(ctx, name);
}

export async function listSkills(ctx, projectId) {
  return (await catalogForCwd(workspaceCwd(projectId), ctx, projectId)).skills;
}

/**
 * Build the runnable Skill list and the per-thread deny rules together so the
 * native Runtime cannot re-discover catalog-only user or Plugin cache Skills.
 */
export async function skillRuntimePolicyForWorkspace(ctx, projectId) {
  const appScope = projectId === CHAT_SKILL_SCOPE || projectId === APP_SKILL_SCOPE;
  const catalog = appScope
    ? await catalogForCwd(agentRuntimeHome(), ctx, null)
    : await catalogForCwd(workspaceCwd(projectId), ctx, projectId);
  const skills = catalog.skills.filter((skill) => (
      skill.effective_enabled
      && skill.availability === "enabled"
      && (!appScope || !skill.requires_project)
    ));
  const runnablePaths = new Set(skills
    .map((skill) => canonicalPath(String(skill?._runtimePath || skill?.path || "")))
    .filter(Boolean));
  return {
    skills,
    catalog_skills: catalog.skills,
    blocked_runtime_skill_paths: [...new Set([
      ...(catalog.blocked_runtime_skill_paths || []),
      ...(catalog.discovered_runtime_skill_paths || []).filter((path) => !runnablePaths.has(canonicalPath(path))),
    ])],
  };
}

export async function listEnabledSkills(ctx, projectId) {
  return (await listSkills(ctx, projectId)).filter((skill) => (
    skill.effective_enabled && skill.availability === "enabled"
  ));
}

export async function getSkill(ctx, projectId, rawName) {
  const name = normalizeSkillLookupName(rawName);
  const skill = (await listSkills(ctx, projectId)).find((item) => item.name === name);
  if (!skill) throw new ApiError("Skill 不存在", 404);
  return skill;
}

export async function isSkillEnabled(ctx, projectId, rawName) {
  const skill = await getSkill(ctx, projectId, rawName);
  return !!skill.effective_enabled && skill.availability === "enabled";
}

export async function isAppSkillEnabled(ctx, rawName) {
  const skill = await getAppSkill(ctx, rawName);
  return !!skill.effective_enabled && skill.availability === "enabled";
}

export async function isSkillEnabledForWorkspace(ctx, projectId, rawName) {
  const pid = String(projectId || "");
  if (pid === CHAT_SKILL_SCOPE || pid === APP_SKILL_SCOPE) {
    return isAppSkillEnabled(ctx, rawName);
  }
  return isSkillEnabled(ctx, projectId, rawName);
}

export function renderSkillsIndexPrompt(skills = []) {
  const promptSkills = skills.filter((skill) => (
    skill.plugin_name
    && (skill.effective_enabled ?? skill.is_enabled)
    && (skill.runtime || "prompt") === "prompt"
    && skill.allow_implicit_invocation !== false
    && skill.availability === "enabled"
  ));
  if (!promptSkills.length) return "";
  const blocks = promptSkills.map((skill) => {
    const qualifiedName = `${skill.plugin_name}:${skill.name}`;
    const path = String(skill.path || "").trim();
    return `- ${qualifiedName}: ${skill.description || "无描述"}${path ? ` (file: ${path})` : ""}`;
  });
  return `

## 当前工作区可用的${APP_DISPLAY_NAME} Plugin Skills

下面是${APP_DISPLAY_NAME} Plugin 提供的领域工作说明。Agent 自身发现的用户、项目和系统 Skill 由 app-server 自动注入，不在这里重复。
当任务明显匹配某个 Skill 时，先读取对应 SKILL.md 的完整内容，再按说明执行。

${blocks.join("\n")}`;
}

export function renderSkillsPrompt(skills = []) {
  return renderSkillsIndexPrompt(skills);
}

export function formatSkillInstructions(skill) {
  const tools = (skill?.tool_visibility_limit || []).length
    ? skill.tool_visibility_limit.join(", ")
    : "determined by the host";
  const qualifiedName = skill?.plugin_name ? `${skill.plugin_name}:${skill.name}` : skill?.name || "";
  return `Skill: ${skill?.name || ""}
Qualified name: ${qualifiedName}
Description: ${skill?.description || ""}
Source file: ${skill?.path || ""}
Host tool visibility limit: ${tools}

Execution contract:
- This is the Skill's execution guide, not evidence that execution has already happened.
- A Skill cannot expand host permissions. Tool access remains controlled by the host, MCP, project permissions, and approvals.
- Call visible host or MCP tools when needed. If the required capability is unavailable, explain what is missing.

Instructions:
${skill?.instructions || ""}`;
}

export function generateSkillDraft(description = "") {
  const desc = cleanString(description, 1_000);
  if (!desc) throw new ApiError("请输入 Skill 需求描述", 400);
  const compact = desc
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return {
    name: compact ? `${compact}-skill`.slice(0, 64).replace(/-+$/g, "") : "custom-skill",
    description: desc,
    allow_implicit_invocation: true,
    instructions: `# Basic template
${desc}

# Working method
1. Decide whether this Skill applies to the user's request.
2. Identify the objective, inputs, and expected output.
3. Read workspace files or update the task plan when needed.
4. Return a concise, verifiable result.

# Output
- Explain the key evidence and limitations.
- When essential information is missing, state what must be provided.`,
  };
}

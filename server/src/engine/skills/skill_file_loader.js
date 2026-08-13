import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinHostSkillContract } from "./builtin_host_skill_contracts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, "builtin");

function parseScalar(value) {
  const raw = String(value || "").trim();
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return raw.slice(1, -1).split(",").map((item) => parseScalar(item)).filter(Boolean);
    }
  }
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function parseFrontmatter(markdown = "") {
  const text = String(markdown || "");
  if (!text.startsWith("---")) return [{}, text.trim()];
  const end = text.indexOf("\n---", 3);
  if (end < 0) return [{}, text.trim()];
  const header = text.slice(3, end).trim();
  const body = text.slice(end + 4).trim();
  const meta = {};
  let currentListKey = null;

  for (const line of header.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && currentListKey) {
      if (!Array.isArray(meta[currentListKey])) meta[currentListKey] = [];
      meta[currentListKey].push(parseScalar(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2];
    if (!value.trim()) {
      meta[key] = [];
      currentListKey = key;
    } else {
      meta[key] = parseScalar(value);
      currentListKey = null;
    }
  }

  return [meta, body, header];
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.map((x) => String(x || "").trim()).filter(Boolean) : [];
}

function parseOpenAiMetadata(text = "") {
  const source = String(text || "").trim();
  if (!source) return {};
  if (source.startsWith("{")) {
    try {
      const value = JSON.parse(source);
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      // Continue with the small YAML reader below. Codex accepts YAML and JSON.
    }
  }
  const parsed = {};
  let section = null;
  let listKey = null;
  let listItem = null;
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^\s*/)?.[0].length || 0;
    const root = line.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (root) {
      section = root[1];
      parsed[section] = parsed[section] || {};
      listKey = null;
      listItem = null;
      continue;
    }
    if (!section) continue;
    const listRoot = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*$/);
    if (listRoot) {
      listKey = listRoot[1];
      parsed[section][listKey] = [];
      listItem = null;
      continue;
    }
    if (listKey) {
      const itemStart = line.match(/^\s*-\s*([A-Za-z0-9_-]+):\s*(.*)$/);
      if (itemStart) {
        listItem = { [itemStart[1]]: parseScalar(itemStart[2]) };
        parsed[section][listKey].push(listItem);
        continue;
      }
      const itemField = line.match(/^\s{4,}([A-Za-z0-9_-]+):\s*(.*)$/);
      if (itemField && listItem) {
        listItem[itemField[1]] = parseScalar(itemField[2]);
        continue;
      }
      const scalarItem = line.match(/^\s*-\s*(.+)$/);
      if (scalarItem) {
        parsed[section][listKey].push(parseScalar(scalarItem[1]));
        continue;
      }
      if (indent <= 2) {
        listKey = null;
        listItem = null;
      }
    }
    const nested = line.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!nested || !section) continue;
    parsed[section][nested[1]] = parseScalar(nested[2]);
  }
  return parsed;
}

function normalizeToolDependencies(value) {
  return (Array.isArray(value) ? value : []).flatMap((dependency) => {
    if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) return [];
    const type = String(dependency.type || "").trim();
    const toolValue = String(dependency.value || "").trim();
    if (!type || !toolValue) return [];
    return [{
      type,
      value: toolValue,
      ...(dependency.description ? { description: String(dependency.description).trim() } : {}),
      ...(dependency.transport ? { transport: String(dependency.transport).trim() } : {}),
      ...(dependency.command ? { command: String(dependency.command).trim() } : {}),
      ...(dependency.url ? { url: String(dependency.url).trim() } : {}),
    }];
  });
}

function loadOpenAiMetadata(skillDirectory) {
  const path = join(skillDirectory, "agents", "openai.yaml");
  if (!existsSync(path)) return {};
  return parseOpenAiMetadata(readFileSync(path, "utf8"));
}

function loadArtifactTemplate(skillDirectory) {
  const path = join(skillDirectory, "artifact-template.json");
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || value.kind !== "image") return null;
    return {
      ...value,
      preview_path: value.preview ? join(skillDirectory, String(value.preview)) : null,
      reference_path: value.reference ? join(skillDirectory, String(value.reference)) : null,
    };
  } catch {
    return null;
  }
}

export function loadSkillManifest(skillPath, overrides = {}) {
  const file = String(skillPath || "").endsWith("SKILL.md") ? skillPath : join(skillPath, "SKILL.md");
  if (!existsSync(file)) return null;
  const skillDirectory = dirname(file);
  const markdown = readFileSync(file, "utf8");
  const [meta, instructions] = parseFrontmatter(markdown);
  const openAiMetadata = loadOpenAiMetadata(skillDirectory);
  const metadataDependencies = normalizeToolDependencies(openAiMetadata.dependencies?.tools);
  const artifactTemplate = loadArtifactTemplate(skillDirectory);
  const name = String(meta.name || "").trim();
  if (!name) return null;
  const fileStat = statSync(file);
  const bundledContract = builtinHostSkillContract(name) || {};
  const requiredTools = [...new Set([
    ...normalizeArray(bundledContract.tool_dependencies),
    ...metadataDependencies
      .filter((dependency) => dependency.type.toLowerCase() === "host")
      .map((dependency) => dependency.value),
  ])];
  const visibilityLimit = normalizeArray(bundledContract.tool_visibility_limit);
  const requiredBins = [...new Set(metadataDependencies
    .filter((dependency) => dependency.type.toLowerCase() === "cli")
    .map((dependency) => dependency.value))];
  const requiredMcpServers = [...new Set(metadataDependencies
    .filter((dependency) => dependency.type.toLowerCase() === "mcp")
    .map((dependency) => dependency.value))];
  return {
    name,
    description: String(meta.description || "").trim(),
    category: String(bundledContract.category || "general").trim(),
    tags: normalizeArray(bundledContract.tags),
    required_tools: requiredTools,
    tool_dependencies: requiredTools,
    tool_visibility_limit: visibilityLimit,
    dependencies: { tools: metadataDependencies },
    required_bins: requiredBins,
    required_mcp_servers: requiredMcpServers,
    instructions,
    builtin: overrides.builtin !== false,
    runtime: String(bundledContract.runtime || "prompt").trim(),
    side_effect: String(bundledContract.side_effect || "read").trim(),
    requires_project: bundledContract.requires_project === true,
    allow_implicit_invocation: bundledContract.allow_implicit_invocation != null
      ? bundledContract.allow_implicit_invocation !== false
      : openAiMetadata.policy?.allow_implicit_invocation !== false,
    interface: openAiMetadata.interface || null,
    artifact_template: artifactTemplate,
    default_enabled: bundledContract.default_enabled !== false,
    global: bundledContract.global === true,
    handler: String(bundledContract.handler || "").trim(),
    analysis_method: String(bundledContract.analysis_method || "").trim() || null,
    path: file,
    source: String(overrides.source || meta.source || "builtin_file").trim(),
    version: String(overrides.version || meta.version || "").trim() || null,
    digest: `sha256:${createHash("sha256").update(markdown).digest("hex")}`,
    installed_at: fileStat.birthtime.toISOString(),
    updated_at: fileStat.mtime.toISOString(),
    modified: false,
    plugin_name: overrides.plugin_name || null,
    plugin_root: overrides.plugin_root || null,
    marketplace: overrides.marketplace || null,
  };
}

function loadSkillDirectory(baseDir, overrides = {}) {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => loadSkillManifest(join(baseDir, entry.name), overrides))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadBuiltinSkills(baseDir = BUILTIN_DIR) {
  return loadSkillDirectory(baseDir);
}

export { parseOpenAiMetadata };
export default { loadBuiltinSkills, loadSkillManifest };

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";

import {
  canonicalDirectory,
  hasHiddenOrGeneratedPath,
  isInsideDirectory,
  listSearchableFileRoots,
  resolveAuthorizedRootPath,
} from "./project_files.js";

const MAX_QUERY_LENGTH = 160;
const MAX_RESULT_LIMIT = 100;
const MAX_ROOTS = 160;
const MAX_CONTENT_MATCHES = 240;
const MAX_NAME_SCAN_ENTRIES = 20_000;
const NAME_SEARCH_TIMEOUT_MS = 750;
const CONTENT_SEARCH_TIMEOUT_MS = 1_500;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
const TABLE_EXTENSIONS = new Set([".csv", ".tsv", ".xlsx", ".xls", ".parquet"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".md", ".markdown", ".txt"]);
const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".sql", ".sh", ".zsh",
  ".java", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".cs", ".php", ".rb",
  ".swift", ".kt", ".vue", ".svelte", ".html", ".css", ".scss", ".json", ".yaml", ".yml",
]);
const ALLOWED_FILE_KINDS = new Set(["image", "table", "document", "code", "file"]);
const activeContentSearches = new Map();
let packagedRipgrepPromise;

function normalizeQuery(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_LENGTH);
}

export function fileKind(name) {
  const extension = extname(String(name || "")).toLocaleLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (TABLE_EXTENSIONS.has(extension)) return "table";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return "file";
}

function requestedFileKinds(query = {}) {
  return new Set(String(query.file_kind || query.file_kinds || query.kinds || "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => ALLOWED_FILE_KINDS.has(value)));
}

function requestedSince(query = {}) {
  const raw = String(query.since || "").trim();
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? time : null;
}

function physicalRootGroups(roots) {
  const groups = new Map();
  for (const root of roots.slice(0, MAX_ROOTS)) {
    const path = canonicalDirectory(root.path);
    if (!path) continue;
    if (!groups.has(path)) groups.set(path, { path, roots: [] });
    groups.get(path).roots.push(root);
  }
  return [...groups.values()];
}

function findPhysicalGroup(groups, path) {
  const candidate = resolve(String(path || ""));
  return groups
    .filter((group) => isInsideDirectory(group.path, candidate))
    .sort((left, right) => right.path.length - left.path.length)[0] || null;
}

function buildResult(root, resolved, { matchType, score = 0, snippet = "", lineNumber = null } = {}) {
  const name = resolved.relativePath.split("/").pop() || resolved.relativePath;
  return {
    project_id: root.project_id,
    project_name: root.project_name,
    session_id: root.session_id || null,
    session_title: root.session_title || null,
    root_id: root.id,
    root_name: root.name,
    root_kind: root.kind,
    path: resolved.relativePath,
    name,
    extension: extname(name).replace(/^\./, "").toLocaleLowerCase(),
    file_kind: fileKind(name),
    size: Number(resolved.stat.size || 0),
    modified_at: resolved.stat.mtime?.toISOString?.() || null,
    match_type: matchType,
    match_types: [matchType],
    snippet,
    line_number: lineNumber,
    score,
  };
}

function passesFilters(item, kinds, since) {
  if (kinds.size && !kinds.has(item.file_kind)) return false;
  if (since != null) {
    const modified = Date.parse(String(item.modified_at || ""));
    if (!Number.isFinite(modified) || modified < since) return false;
  }
  return true;
}

export async function searchFileNamesLocally({ groups, query }) {
  if (!groups.length) return { items: [], truncated: false };
  const loweredQuery = query.toLocaleLowerCase();
  const items = [];
  const deadline = Date.now() + NAME_SEARCH_TIMEOUT_MS;
  let scanned = 0;
  let truncated = false;

  for (const group of groups) {
    const directories = [{ fullPath: group.path, relativePath: "" }];
    while (directories.length) {
      if (scanned >= MAX_NAME_SCAN_ENTRIES || Date.now() >= deadline) {
        truncated = true;
        break;
      }
      const directory = directories.shift();
      let entries;
      try {
        entries = await readdir(directory.fullPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        scanned += 1;
        if (scanned > MAX_NAME_SCAN_ENTRIES || Date.now() >= deadline) {
          truncated = true;
          break;
        }
        if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
        const relativePath = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
        if (hasHiddenOrGeneratedPath(relativePath)) continue;
        if (entry.isDirectory()) {
          directories.push({ fullPath: resolve(group.path, relativePath), relativePath });
          continue;
        }
        if (!entry.isFile()) continue;
        const loweredPath = relativePath.toLocaleLowerCase();
        if (!loweredPath.includes(loweredQuery)) continue;
        const resolved = resolveAuthorizedRootPath({ path: group.path }, relativePath, { type: "file" });
        if (!resolved) continue;
        const loweredName = entry.name.toLocaleLowerCase();
        const matchType = loweredName.includes(loweredQuery) ? "name" : "path";
        const score = loweredName === loweredQuery
          ? 1_000
          : loweredName.startsWith(loweredQuery)
            ? 800
            : matchType === "name"
              ? 600
              : 400;
        for (const root of group.roots) {
          items.push(buildResult(root, resolved, { matchType, score }));
        }
      }
    }
    if (truncated) break;
  }
  return { items, truncated };
}

export async function resolveDshWorkRipgrep() {
  packagedRipgrepPromise ??= import("@vscode/ripgrep").then((module) => module.rgPath);
  return packagedRipgrepPromise;
}

function parseRipgrepLine(line, matches) {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event?.type !== "match" || !event.data?.path?.text) return;
  matches.push({
    path: String(event.data.path.text),
    lineNumber: Number(event.data.line_number || 0) || null,
    snippet: String(event.data.lines?.text || "").replace(/[\r\n]+$/g, "").slice(0, 500),
  });
}

export async function searchFileContentsWithRipgrep({ binary, groups, query, cancellationKey }) {
  if (!groups.length) return { items: [], truncated: false };
  const previous = activeContentSearches.get(cancellationKey);
  if (previous) previous.kill();

  const args = [
    "--json",
    "--fixed-strings",
    "--ignore-case",
    "--line-number",
    "--color", "never",
    "--max-count", "1",
    "--max-filesize", "25M",
    "--glob", "!node_modules/**",
    "--glob", "!.git/**",
    "--glob", "!__pycache__/**",
    "--",
    query,
    ...groups.map((group) => group.path),
  ];

  const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  activeContentSearches.set(cancellationKey, child);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const matches = [];
  let pending = "";
  let stderr = "";
  let truncated = false;
  let timedOut = false;
  let spawnError = null;

  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() || "";
    for (const line of lines) {
      parseRipgrepLine(line, matches);
      if (matches.length >= MAX_CONTENT_MATCHES) {
        truncated = true;
        child.kill();
        break;
      }
    }
  });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  child.on("error", (error) => { spawnError = error; });

  const timer = setTimeout(() => {
    timedOut = true;
    truncated = true;
    child.kill();
  }, CONTENT_SEARCH_TIMEOUT_MS);
  const code = await new Promise((finish) => child.on("close", finish));
  clearTimeout(timer);
  if (activeContentSearches.get(cancellationKey) === child) activeContentSearches.delete(cancellationKey);
  if (pending && matches.length < MAX_CONTENT_MATCHES) parseRipgrepLine(pending, matches);
  if (spawnError) throw spawnError;
  if (!timedOut && code !== 0 && code !== 1 && !truncated) {
    throw new Error(stderr.trim() || `文件正文搜索失败（退出码 ${code}）`);
  }

  const items = [];
  for (const match of matches.slice(0, MAX_CONTENT_MATCHES)) {
    const group = findPhysicalGroup(groups, match.path);
    if (!group) continue;
    const relativePath = relative(group.path, resolve(match.path)).split(sep).join("/");
    if (hasHiddenOrGeneratedPath(relativePath)) continue;
    const resolved = resolveAuthorizedRootPath({ path: group.path }, relativePath, { type: "file" });
    if (!resolved || hasHiddenOrGeneratedPath(resolved.relativePath)) continue;
    for (const root of group.roots) {
      items.push(buildResult(root, resolved, {
        matchType: "content",
        score: 100,
        snippet: match.snippet,
        lineNumber: match.lineNumber,
      }));
    }
  }
  return { items, truncated };
}

function mergeSearchItems(items) {
  const merged = new Map();
  for (const item of items) {
    const key = `${item.project_id}:${item.session_id || ""}:${item.root_id}:${item.path}`;
    const current = merged.get(key);
    if (!current) {
      merged.set(key, item);
      continue;
    }
    current.score = Math.max(current.score, item.score);
    current.match_types = [...new Set([...current.match_types, ...item.match_types])];
    if (!current.snippet && item.snippet) {
      current.snippet = item.snippet;
      current.line_number = item.line_number;
    }
    if (current.match_type === "content" && item.match_type !== "content") current.match_type = item.match_type;
  }
  return [...merged.values()];
}

// GET /api/agent/search/files?q=...
// File-name/path matching stays inside the host process. File-body matching
// uses the same maintained packaged ripgrep dependency as the DSH fs plugin.
export async function searchAgentFiles(ctx, input) {
  const query = normalizeQuery(input.query?.q || input.query?.query);
  const limit = Math.max(1, Math.min(MAX_RESULT_LIMIT, Number(input.query?.limit) || 60));
  if (!query) return { data: { query: "", items: [], truncated: false, partial: false, warnings: [] }, message: "ok" };

  const projectId = String(input.query?.project_id || input.query?.projectId || "").trim();
  const sessionId = String(input.query?.session_id || input.query?.sessionId || "").trim();
  const mode = ["all", "name", "content"].includes(String(input.query?.mode || "all"))
    ? String(input.query?.mode || "all")
    : "all";
  const kinds = requestedFileKinds(input.query);
  const since = requestedSince(input.query);
  const roots = await listSearchableFileRoots(ctx, { projectId, sessionId });
  const groups = physicalRootGroups(roots);
  const cancellationKey = `file-search:${ctx.userId || "anonymous"}`;
  const searches = [];
  const labels = [];
  if (mode !== "content") {
    labels.push("name");
    searches.push(searchFileNamesLocally({ groups, query }));
  }
  if (mode !== "name") {
    labels.push("content");
    searches.push(resolveDshWorkRipgrep().then((binary) => searchFileContentsWithRipgrep({
      binary,
      groups,
      query,
      cancellationKey,
    })));
  }

  const settled = await Promise.allSettled(searches);
  const warnings = [];
  let truncated = roots.length > MAX_ROOTS;
  const found = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      found.push(...result.value.items);
      truncated = truncated || result.value.truncated;
      return;
    }
    warnings.push({
      search: labels[index],
      code: result.reason?.code || "FILE_SEARCH_UNAVAILABLE",
      message: result.reason?.message || String(result.reason || "文件搜索暂时不可用"),
    });
  });

  const items = mergeSearchItems(found)
    .filter((item) => passesFilters(item, kinds, since))
    .sort((left, right) => (
      right.score - left.score
      || String(right.modified_at || "").localeCompare(String(left.modified_at || ""))
      || String(left.path).localeCompare(String(right.path))
    ));

  return {
    data: {
      query,
      items: items.slice(0, limit).map(({ score: _score, ...item }) => item),
      truncated: truncated || items.length > limit,
      partial: warnings.length > 0,
      warnings,
      engines: { name: "dsh_work_local", content: "dsh_packaged_ripgrep" },
    },
    message: "ok",
  };
}

export default searchAgentFiles;

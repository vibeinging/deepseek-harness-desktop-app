import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { effectiveProjectSourceFolders } from "./git_workspace.js";
import { loadProjectSourceFolders } from "./project_source_folders.js";
import { resolveWorkspace } from "./workspace_paths.js";

const MEDIA_TYPES = new Map([
  [".mp4", { mediaKind: "video", mimeType: "video/mp4" }],
  [".webm", { mediaKind: "video", mimeType: "video/webm" }],
  [".mov", { mediaKind: "video", mimeType: "video/quicktime" }],
  [".m4v", { mediaKind: "video", mimeType: "video/x-m4v" }],
  [".mp3", { mediaKind: "audio", mimeType: "audio/mpeg" }],
  [".wav", { mediaKind: "audio", mimeType: "audio/wav" }],
  [".m4a", { mediaKind: "audio", mimeType: "audio/mp4" }],
  [".ogg", { mediaKind: "audio", mimeType: "audio/ogg" }],
  [".aac", { mediaKind: "audio", mimeType: "audio/aac" }],
  [".flac", { mediaKind: "audio", mimeType: "audio/flac" }],
]);

function sha256(value) {
  return `sha256:${createHash("sha256").update(String(value || "")).digest("hex")}`;
}

function codePointOffset(text, codeUnitOffset) {
  return Array.from(String(text || "").slice(0, codeUnitOffset)).length;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function parseCandidate(rawValue) {
  let value = String(rawValue || "").trim().replace(/^<|>$/g, "");
  try { value = decodeURIComponent(value); } catch { /* keep original */ }
  const hashLine = value.match(/#L(\d+)(?:-L?(\d+))?$/i);
  const colonLine = !hashLine && value.match(/:(\d+)(?:-(\d+))?$/);
  const lineMatch = hashLine || colonLine;
  if (lineMatch) value = value.slice(0, lineMatch.index);
  return {
    value,
    lineStart: lineMatch ? Math.max(1, Number(lineMatch[1])) : 1,
    lineEnd: lineMatch ? Math.max(Number(lineMatch[1]), Number(lineMatch[2] || lineMatch[1])) : 1,
  };
}

async function resolveCandidate(cwd, rawValue) {
  const parsed = parseCandidate(rawValue);
  if (!parsed.value || /^(?:https?|mailto|data):/i.test(parsed.value)) return null;
  const root = await realpath(cwd);
  const absolute = path.isAbsolute(parsed.value)
    ? path.resolve(parsed.value)
    : path.resolve(root, parsed.value.replace(/^\.\//, ""));
  let resolved;
  let fileSize = 0;
  try {
    resolved = await realpath(absolute);
    const fileStat = await stat(resolved);
    if (!fileStat.isFile() || !inside(root, resolved)) return null;
    fileSize = fileStat.size;
  } catch {
    return null;
  }
  return {
    ...parsed,
    absolutePath: resolved,
    size: fileSize,
    path: path.relative(root, resolved).split(path.sep).join("/"),
  };
}

function candidates(text) {
  const output = [];
  const occupied = [];
  const fenced = [...text.matchAll(/```[\s\S]*?```/g)].map((match) => {
    const start = Number(match.index || 0);
    return [start, start + match[0].length];
  });
  const inFence = (start, end) => fenced.some(([from, to]) => start >= from && end <= to);
  const markdownLink = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  for (const match of text.matchAll(markdownLink)) {
    const destination = String(match[2] || "").trim().split(/\s+["']/)[0];
    const start = Number(match.index || 0);
    const end = start + match[0].length;
    if (inFence(start, end)) continue;
    occupied.push([start, end]);
    output.push({
      rawTarget: destination,
      displayText: match[1],
      start: start + 1,
      end: start + 1 + match[1].length,
      sourceStart: start,
      sourceEnd: end,
    });
  }
  const codeSpan = /`([^`\n]+)`/g;
  for (const match of text.matchAll(codeSpan)) {
    const start = Number(match.index || 0);
    const end = start + match[0].length;
    if (inFence(start, end)) continue;
    if (occupied.some(([from, to]) => start >= from && end <= to)) continue;
    output.push({
      rawTarget: match[1],
      displayText: match[1],
      start: start + 1,
      end: start + 1 + match[1].length,
      sourceStart: start,
      sourceEnd: end,
    });
  }
  return output;
}

function lineAnchors(content, lineStart, lineEnd) {
  const lines = String(content || "").split("\n");
  const from = Math.max(0, lineStart - 1);
  const to = Math.min(lines.length, Math.max(lineEnd, lineStart));
  const selected = lines.slice(from, to).join("\n");
  const before = lines.slice(Math.max(0, from - 2), from).join("\n");
  const after = lines.slice(to, Math.min(lines.length, to + 2)).join("\n");
  return {
    selectedTextHash: sha256(selected),
    contextBeforeHash: sha256(before),
    contextAfterHash: sha256(after),
  };
}

export async function workspaceRoot(db, projectId, sessionId) {
  const sourceFolders = await loadProjectSourceFolders(db, projectId);
  const effectiveFolders = await effectiveProjectSourceFolders(
    db,
    projectId,
    sourceFolders.filter((folder) => folder.available),
  );
  return resolveWorkspace(projectId, sessionId, {
    sourceFolders: effectiveFolders,
  }).cwd;
}

export async function buildFileReferenceAnnotations({ text, cwd, sessionId, runtimeThreadId, turnId, itemId }) {
  const source = String(text || "");
  const annotations = [];
  for (const candidate of candidates(source).slice(0, 100)) {
    const target = await resolveCandidate(cwd, candidate.rawTarget);
    if (!target) continue;
    const media = MEDIA_TYPES.get(path.extname(target.absolutePath).toLowerCase()) || null;
    if (!media && target.size > 2 * 1024 * 1024) continue;
    const content = media ? null : await readFile(target.absolutePath, "utf8").catch(() => null);
    if (!media && content == null) continue;
    annotations.push({
      id: `file-ref:${randomUUID()}`,
      type: "fileReference",
      range: {
        start: codePointOffset(source, candidate.start),
        end: codePointOffset(source, candidate.end),
        unit: "unicodeCodePoint",
      },
      sourceRange: {
        start: codePointOffset(source, candidate.sourceStart),
        end: codePointOffset(source, candidate.sourceEnd),
        unit: "unicodeCodePoint",
      },
      displayText: candidate.displayText,
      target: {
        workspaceId: sessionId,
        path: target.path,
        lineStart: target.lineStart,
        lineEnd: target.lineEnd,
        runtimeThreadId,
        turnId,
        messageItemId: itemId,
        ...(media
          ? { ...media, sizeBytes: target.size }
          : {
              blobHash: sha256(content),
              ...lineAnchors(content, target.lineStart, target.lineEnd),
            }),
      },
    });
  }
  return { textHash: sha256(source), annotations };
}

function safeRelativePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.includes("\0") || path.isAbsolute(normalized)) return null;
  const clean = path.normalize(normalized);
  if (clean === ".." || clean.startsWith(`..${path.sep}`)) return null;
  return clean;
}

function anchorLine(content, target) {
  const lines = String(content || "").split("\n");
  const lineCount = Math.max(1, Number(target.lineEnd || target.lineStart || 1) - Number(target.lineStart || 1) + 1);
  const matches = [];
  for (let index = 0; index + lineCount <= lines.length; index += 1) {
    const selected = lines.slice(index, index + lineCount).join("\n");
    if (target.selectedTextHash && sha256(selected) !== target.selectedTextHash) continue;
    const before = lines.slice(Math.max(0, index - 2), index).join("\n");
    const after = lines.slice(index + lineCount, Math.min(lines.length, index + lineCount + 2)).join("\n");
    const contextScore = Number(Boolean(target.contextBeforeHash && sha256(before) === target.contextBeforeHash))
      + Number(Boolean(target.contextAfterHash && sha256(after) === target.contextAfterHash));
    matches.push({ lineStart: index + 1, lineEnd: index + lineCount, contextScore });
  }
  if (!matches.length) return null;
  matches.sort((a, b) => b.contextScore - a.contextScore);
  if (matches.length > 1 && matches[0].contextScore === matches[1].contextScore) return null;
  return matches[0];
}

async function workspaceFiles(root, limit = 2500) {
  const output = [];
  const queue = [root];
  const ignored = new Set([".git", "node_modules", "dist", "build", "target", ".cache", ".next"]);
  while (queue.length && output.length < limit) {
    const directory = queue.shift();
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(absolutePath);
      else if (entry.isFile()) output.push(absolutePath);
      if (output.length >= limit) break;
    }
  }
  return output;
}

export async function locateFileReference(cwd, target = {}) {
  const root = await realpath(cwd);
  const relativePath = safeRelativePath(target.path);
  if (!relativePath) return null;
  const expectedBlobHash = String(target.blobHash || "");
  const requested = path.resolve(root, relativePath);
  const candidates = [];
  try {
    const resolved = await realpath(requested);
    const fileStat = await stat(resolved);
    if (fileStat.isFile() && inside(root, resolved)) candidates.push(resolved);
  } catch { /* try hash-based relocation below */ }

  if (candidates.length) {
    if (!expectedBlobHash) {
      return {
        absolutePath: candidates[0],
        path: path.relative(root, candidates[0]).split(path.sep).join("/"),
        lineStart: Math.max(1, Number(target.lineStart || 1)),
        lineEnd: Math.max(1, Number(target.lineEnd || target.lineStart || 1)),
        locationStatus: "exact",
      };
    }
    const content = await readFile(candidates[0], "utf8").catch(() => null);
    if (content != null) {
      if (!expectedBlobHash || sha256(content) === expectedBlobHash) {
        return {
          absolutePath: candidates[0],
          path: path.relative(root, candidates[0]).split(path.sep).join("/"),
          lineStart: Math.max(1, Number(target.lineStart || 1)),
          lineEnd: Math.max(1, Number(target.lineEnd || target.lineStart || 1)),
          locationStatus: "exact",
        };
      }
      const anchored = anchorLine(content, target);
      if (anchored) {
        return {
          absolutePath: candidates[0],
          path: path.relative(root, candidates[0]).split(path.sep).join("/"),
          ...anchored,
          locationStatus: "anchored",
        };
      }
    }
  }

  if (expectedBlobHash) {
    for (const absolutePath of await workspaceFiles(root)) {
      if (candidates.includes(absolutePath)) continue;
      const fileStat = await stat(absolutePath).catch(() => null);
      if (!fileStat?.isFile() || fileStat.size > 2 * 1024 * 1024) continue;
      const content = await readFile(absolutePath, "utf8").catch(() => null);
      if (content == null || sha256(content) !== expectedBlobHash) continue;
      return {
        absolutePath,
        path: path.relative(root, absolutePath).split(path.sep).join("/"),
        lineStart: Math.max(1, Number(target.lineStart || 1)),
        lineEnd: Math.max(1, Number(target.lineEnd || target.lineStart || 1)),
        locationStatus: "moved",
      };
    }
  }

  return null;
}

export default buildFileReferenceAnnotations;

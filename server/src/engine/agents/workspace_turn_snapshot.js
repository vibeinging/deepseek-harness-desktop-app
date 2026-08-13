import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MANIFEST_FILES = 2_000;
const DEFAULT_MANIFEST_BYTES = 32 * 1024 * 1024;
const MANIFEST_IGNORED_DIRECTORIES = new Set([".git", "node_modules"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function normalizedRelativePath(value) {
  return String(value || "").split(path.sep).join("/").replace(/^\.\//, "");
}

function runProcess(command, args, {
  cwd,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let closed = false;
    const finishError = (error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* best-effort */ }
      reject(error);
    };
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        const error = new Error(`工作区快照输出超过上限 (${maxOutputBytes} bytes)`);
        error.code = "WORKSPACE_SNAPSHOT_OUTPUT_LIMIT";
        finishError(error);
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", finishError);
    child.once("close", (code) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      resolve({
        code: Number(code ?? 1),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    const timer = setTimeout(() => {
      const error = new Error(`工作区快照命令超时 (${timeoutMs}ms)`);
      error.code = "WORKSPACE_SNAPSHOT_TIMEOUT";
      finishError(error);
    }, Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    timer.unref?.();
  });
}

async function runGit(cwd, args, options = {}) {
  return runProcess("git", args, {
    cwd,
    ...options,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_OPTIONAL_LOCKS: "0",
      ...(options.env || {}),
    },
  });
}

async function gitText(cwd, args, options = {}) {
  const result = await runGit(cwd, args, options);
  return { ...result, text: result.stdout.toString("utf8").trim() };
}

function parseNameStatus(buffer, rootId) {
  const tokens = buffer.toString("utf8").split("\0");
  const changes = [];
  for (let index = 0; index < tokens.length;) {
    let status = tokens[index++] || "";
    let firstPath = "";
    if (status.includes("\t")) {
      const splitAt = status.indexOf("\t");
      firstPath = status.slice(splitAt + 1);
      status = status.slice(0, splitAt);
    } else {
      firstPath = tokens[index++] || "";
    }
    if (!status || !firstPath) continue;
    const code = status[0];
    if (code === "R" || code === "C") {
      const nextPath = tokens[index++] || "";
      if (!nextPath) continue;
      changes.push({
        rootId,
        path: nextPath,
        previousPath: firstPath,
        kind: code === "R" ? "rename" : "copy",
      });
      continue;
    }
    changes.push({
      rootId,
      path: firstPath,
      kind: code === "A" ? "create" : code === "D" ? "delete" : "update",
    });
  }
  return changes;
}

async function writeWorkspaceTree({ root, gitEnv }) {
  let readTree = await runGit(root, ["read-tree", "HEAD"], { env: gitEnv });
  if (readTree.code !== 0) readTree = await runGit(root, ["read-tree", "--empty"], { env: gitEnv });
  if (readTree.code !== 0) throw new Error(readTree.stderr.toString("utf8") || "无法初始化临时 Git index");
  const added = await runGit(root, ["add", "-A", "--", "."], { env: gitEnv });
  if (added.code !== 0) throw new Error(added.stderr.toString("utf8") || "无法建立工作区 Git 快照");
  const tree = await gitText(root, ["write-tree"], { env: gitEnv });
  if (tree.code !== 0 || !tree.text) throw new Error(tree.stderr.toString("utf8") || "无法写入临时 Git tree");
  return tree.text;
}

async function beginGitSnapshot(rootId, root, limits) {
  const topLevel = await gitText(root, ["rev-parse", "--show-toplevel"], limits);
  if (topLevel.code !== 0 || !topLevel.text) return null;
  const repoRoot = await realpath(path.resolve(root, topLevel.text));
  if (!isInside(repoRoot, root)) return null;
  const commonDirResult = await gitText(root, ["rev-parse", "--git-common-dir"], limits);
  if (commonDirResult.code !== 0 || !commonDirResult.text) return null;
  const commonDir = path.resolve(root, commonDirResult.text);
  const alternateObjects = path.join(commonDir, "objects");
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "dsh-workspace-turn-"));
  const objectDirectory = path.join(temporaryRoot, "objects");
  await mkdir(objectDirectory, { recursive: true });
  const gitEnv = {
    GIT_INDEX_FILE: path.join(temporaryRoot, "index"),
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: [
      alternateObjects,
      process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,
    ].filter(Boolean).join(path.delimiter),
  };
  try {
    const beforeTree = await writeWorkspaceTree({ root, gitEnv });
    return {
      rootId,
      root,
      kind: "git",
      temporaryRoot,
      gitEnv,
      beforeTree,
      limits,
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => null);
    throw error;
  }
}

async function scanManifest(root, limits) {
  const entries = new Map();
  const stack = [root];
  let fileCount = 0;
  let totalBytes = 0;
  let truncated = false;
  while (stack.length) {
    const directory = stack.pop();
    let children = [];
    try { children = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      if (child.name === "." || child.name === "..") continue;
      if (child.isDirectory() && MANIFEST_IGNORED_DIRECTORIES.has(child.name)) continue;
      const absolute = path.join(directory, child.name);
      const relative = normalizedRelativePath(path.relative(root, absolute));
      if (!relative || !isInside(root, absolute)) continue;
      if (child.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (fileCount >= limits.maxManifestFiles || totalBytes >= limits.maxManifestBytes) {
        truncated = true;
        continue;
      }
      if (child.isSymbolicLink()) {
        const target = await readlink(absolute).catch(() => null);
        if (target != null) entries.set(relative, { type: "symlink", hash: sha256(Buffer.from(target)) });
        fileCount += 1;
        continue;
      }
      if (!child.isFile()) continue;
      const content = await readFile(absolute).catch(() => null);
      if (!content) continue;
      if (totalBytes + content.length > limits.maxManifestBytes) {
        truncated = true;
        continue;
      }
      totalBytes += content.length;
      fileCount += 1;
      entries.set(relative, { type: "file", hash: sha256(content) });
    }
  }
  return { entries, truncated };
}

async function beginManifestSnapshot(rootId, root, limits) {
  const before = await scanManifest(root, limits);
  return { rootId, root, kind: "manifest", before, limits };
}

async function finishGitSnapshot(snapshot) {
  const afterTree = await writeWorkspaceTree(snapshot);
  const diff = await runGit(snapshot.root, [
    "diff",
    "--binary",
    "--find-renames",
    "--no-ext-diff",
    "--no-textconv",
    snapshot.beforeTree,
    afterTree,
    "--",
    ".",
  ], { env: snapshot.gitEnv, ...snapshot.limits });
  if (diff.code !== 0) throw new Error(diff.stderr.toString("utf8") || "无法计算本轮 Git 更改");
  const unifiedDiff = diff.stdout.toString("utf8");
  if (!unifiedDiff.trim()) {
    return {
      rootId: snapshot.rootId,
      changes: [],
      unifiedDiff: "",
      truncated: false,
      reviewable: true,
      reversible: true,
    };
  }
  const names = await runGit(snapshot.root, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    snapshot.beforeTree,
    afterTree,
    "--",
    ".",
  ], { env: snapshot.gitEnv, ...snapshot.limits });
  if (names.code !== 0) throw new Error(names.stderr.toString("utf8") || "无法读取本轮更改文件");
  const changes = parseNameStatus(names.stdout, snapshot.rootId);
  if (changes.length) changes[0] = { ...changes[0], diff: unifiedDiff };
  return {
    rootId: snapshot.rootId,
    changes,
    unifiedDiff,
    truncated: false,
    reviewable: true,
    reversible: true,
  };
}

async function finishManifestSnapshot(snapshot) {
  const after = await scanManifest(snapshot.root, snapshot.limits);
  const paths = new Set([...snapshot.before.entries.keys(), ...after.entries.keys()]);
  const changes = [];
  for (const relative of [...paths].sort()) {
    const before = snapshot.before.entries.get(relative);
    const current = after.entries.get(relative);
    if (before?.type === current?.type && before?.hash === current?.hash) continue;
    changes.push({
      rootId: snapshot.rootId,
      path: relative,
      kind: !before ? "create" : !current ? "delete" : "update",
    });
  }
  return {
    rootId: snapshot.rootId,
    changes,
    unifiedDiff: "",
    truncated: snapshot.before.truncated || after.truncated,
    reviewable: false,
    reversible: false,
  };
}

function combinedSummary(parts) {
  const changes = parts.flatMap((part) => part.changes || []);
  const unifiedDiff = parts.map((part) => part.unifiedDiff || "").filter(Boolean).join("\n");
  return {
    changes,
    unifiedDiff,
    diffHash: unifiedDiff ? sha256(unifiedDiff) : null,
    truncated: parts.some((part) => part.truncated),
    reviewable: parts.length > 0 && parts.every((part) => part.reviewable),
    reversible: parts.length > 0 && parts.every((part) => part.reversible),
    source: "workspace_snapshot",
  };
}

/**
 * Capture the user-visible write roots before a Turn and compute only the net
 * changes made while that Turn ran. Git roots use temporary index/tree objects,
 * so existing dirty, staged and untracked files cancel out exactly without
 * touching the real index, refs or working tree.
 */
export async function beginWorkspaceTurnSnapshot({ roots = [], limits = {} } = {}) {
  const normalizedLimits = {
    timeoutMs: Math.max(1_000, Number(limits.timeoutMs) || DEFAULT_TIMEOUT_MS),
    maxOutputBytes: Math.max(1024, Number(limits.maxOutputBytes) || DEFAULT_MAX_OUTPUT_BYTES),
    maxManifestFiles: Math.max(1, Number(limits.maxManifestFiles) || DEFAULT_MANIFEST_FILES),
    maxManifestBytes: Math.max(1024, Number(limits.maxManifestBytes) || DEFAULT_MANIFEST_BYTES),
  };
  const snapshots = [];
  const canonicalRoots = [];
  for (const [index, entry] of (Array.isArray(roots) ? roots : []).entries()) {
    const requested = String(entry?.path || "").trim();
    if (!requested) continue;
    const root = await realpath(requested).catch(() => null);
    if (!root) continue;
    // 双向包含去重：新根既可能落在已登记根内部，也可能包住已登记根（后者需移除子根）。
    // 原先只做单向 isInside，子根先登记时同一文件会出现在两个 rootId 下。
    if (canonicalRoots.some((candidate) => isInside(candidate, root))) continue;
    for (let i = canonicalRoots.length - 1; i >= 0; i -= 1) {
      if (isInside(root, canonicalRoots[i])) canonicalRoots.splice(i, 1);
    }
    canonicalRoots.push(root);
    const rootId = String(entry?.id || `root-${index + 1}`);
    try {
      const gitSnapshot = await beginGitSnapshot(rootId, root, normalizedLimits);
      snapshots.push(gitSnapshot || await beginManifestSnapshot(rootId, root, normalizedLimits));
    } catch (error) {
      console.warn("[workspace turn snapshot] baseline skipped", error?.message || error);
    }
  }
  let finished = null;
  const dispose = async () => {
    await Promise.all(snapshots.map((snapshot) => (
      snapshot.temporaryRoot
        ? rm(snapshot.temporaryRoot, { recursive: true, force: true }).catch(() => null)
        : Promise.resolve()
    )));
  };
  const finish = async () => {
    if (finished) return finished;
    finished = (async () => {
      const parts = [];
      for (const snapshot of snapshots) {
        try {
          parts.push(snapshot.kind === "git"
            ? await finishGitSnapshot(snapshot)
            : await finishManifestSnapshot(snapshot));
        } catch (error) {
          console.warn("[workspace turn snapshot] finish skipped", error?.message || error);
        }
      }
      return combinedSummary(parts);
    })();
    return finished;
  };
  return Object.freeze({ finish, dispose });
}

export default { beginWorkspaceTurnSnapshot };

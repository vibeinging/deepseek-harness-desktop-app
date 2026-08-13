import { createHash, randomUUID } from "node:crypto";
import { createReadStream, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { dataPath } from "../../config/paths.js";
import { ApiError } from "../../errors.js";

const MAX_ARTIFACT_BYTES = 1024 * 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const HIDDEN_OR_GENERATED_DIRECTORIES = new Set([".git", "node_modules", "__pycache__"]);
const artifactMutationLocks = new Map();

const MIME_BY_EXTENSION = new Map([
  [".md", "text/markdown"], [".txt", "text/plain"], [".csv", "text/csv"],
  [".json", "application/json"], [".html", "text/html"], [".css", "text/css"],
  [".js", "text/javascript"], [".jsx", "text/javascript"], [".ts", "text/typescript"],
  [".tsx", "text/typescript"], [".py", "text/x-python"], [".sql", "application/sql"],
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".png", "image/png"], [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"],
  [".gif", "image/gif"], [".webp", "image/webp"], [".svg", "image/svg+xml"],
  [".zip", "application/zip"],
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);
const TABLE_EXTENSIONS = new Set([".csv", ".tsv", ".xlsx", ".xls", ".parquet", ".pq"]);
const DOCUMENT_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".html"]);
const CODE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".sql", ".sh", ".zsh",
  ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".css", ".scss", ".vue", ".svelte",
]);

function clean(value) {
  return String(value || "").trim();
}

async function withProjectArtifactMutation(projectId, work) {
  const key = safeIdentifier(projectId, "项目 ID");
  const previous = artifactMutationLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolveGate) => { release = resolveGate; });
  const tail = previous.catch(() => undefined).then(() => gate);
  artifactMutationLocks.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (artifactMutationLocks.get(key) === tail) artifactMutationLocks.delete(key);
  }
}

function optionalText(value, maxLength) {
  if (value == null) return null;
  const text = clean(value);
  if (!text) return null;
  return text.slice(0, maxLength);
}

function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function safeIdentifier(value, label) {
  const id = clean(value);
  if (!id || !/^[a-zA-Z0-9._-]{1,180}$/.test(id) || id === "." || id === "..") {
    throw new ApiError(`${label}无效`, 400);
  }
  return id;
}

function safeFilename(value) {
  const raw = basename(clean(value) || "artifact");
  const safe = raw.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").slice(0, 160);
  return safe || "artifact";
}

function inside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hiddenRelativePath(value) {
  return clean(value).split(/[\\/]+/).filter(Boolean).some((part) => (
    part.startsWith(".") || HIDDEN_OR_GENERATED_DIRECTORIES.has(part)
  ));
}

function canonicalDirectory(value) {
  try {
    const path = realpathSync(value);
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

function pathContainsSymlink(root, candidate) {
  const rawRoot = resolve(root);
  const rawCandidate = resolve(candidate);
  if (!inside(rawRoot, rawCandidate)) return true;
  const parts = relative(rawRoot, rawCandidate).split(sep).filter(Boolean);
  let cursor = rawRoot;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function resolveAuthorizedSource(sourcePath, allowedRoots) {
  const requested = resolve(clean(sourcePath));
  let realSource;
  let sourceStat;
  try {
    if (lstatSync(requested).isSymbolicLink()) throw new Error("symlink");
    realSource = realpathSync(requested);
    sourceStat = statSync(realSource);
  } catch {
    throw new ApiError("产物源文件不存在或不是普通文件", 404);
  }
  if (!sourceStat.isFile()) throw new ApiError("产物只能来自普通文件", 400);
  if (sourceStat.size > MAX_ARTIFACT_BYTES) throw new ApiError("单个产物不能超过 1 GB", 413);

  const roots = (Array.isArray(allowedRoots) ? allowedRoots : [])
    .map((root) => {
      const raw = resolve(clean(typeof root === "string" ? root : root?.path));
      const real = canonicalDirectory(raw);
      return real ? { raw, real } : null;
    })
    .filter(Boolean);
  const matched = roots.find((root) => (
    inside(root.real, realSource) && (inside(root.raw, requested) || inside(root.real, requested))
  ));
  if (!matched) throw new ApiError("产物源文件不在当前项目授权目录中", 403);
  const requestedRoot = inside(matched.raw, requested) ? matched.raw : matched.real;
  const rawRelative = relative(requestedRoot, requested);
  const realRelative = relative(matched.real, realSource);
  if (hiddenRelativePath(rawRelative) || hiddenRelativePath(realRelative)) {
    throw new ApiError("隐藏目录或生成目录中的文件不能加入产物库", 403);
  }
  if (pathContainsSymlink(requestedRoot, requested)) throw new ApiError("符号链接中的文件不能加入产物库", 403);
  return { path: realSource, stat: sourceStat, root: matched.real };
}

async function sha256File(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function sourceChanged(before, after) {
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs || (before.ino && after.ino && before.ino !== after.ino);
}

function inferKind(path, requested = "") {
  const explicit = clean(requested).toLowerCase();
  if (explicit && /^[a-z][a-z0-9_-]{0,31}$/.test(explicit)) return explicit;
  const extension = extname(path).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (TABLE_EXTENSIONS.has(extension)) return "table";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return "file";
}

function mimeType(path, requested = "") {
  return clean(requested) || MIME_BY_EXTENSION.get(extname(path).toLowerCase()) || "application/octet-stream";
}

function publicVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    artifact_id: row.artifact_id,
    version_number: Number(row.version_number || 0),
    snapshot_path: row.snapshot_path,
    snapshot_root: row.snapshot_path ? dirname(row.snapshot_path) : null,
    original_path: row.original_path || null,
    mime_type: row.mime_type || "application/octet-stream",
    size_bytes: Number(row.size_bytes || 0),
    sha256: row.sha256 || null,
    change_summary: row.change_summary || "",
    source_session_id: row.source_session_id || null,
    source_session_title: row.source_session_title || null,
    source_turn_id: row.source_turn_id || null,
    source_run_id: row.source_run_id || null,
    source_item_id: row.source_item_id || null,
    source_tool_call_id: row.source_tool_call_id || null,
    restored_from_version_id: row.restored_from_version_id || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function publicArtifact(row) {
  if (!row) return null;
  const currentVersion = row.current_version_number == null ? null : publicVersion({
    id: row.current_version_id,
    artifact_id: row.id,
    version_number: row.current_version_number,
    snapshot_path: row.current_snapshot_path,
    original_path: row.current_original_path,
    mime_type: row.current_mime_type,
    size_bytes: row.current_size_bytes,
    sha256: row.current_sha256,
    change_summary: row.current_change_summary,
    source_session_id: row.current_source_session_id,
    source_session_title: row.current_source_session_title,
    source_turn_id: row.current_source_turn_id,
    source_run_id: row.current_source_run_id,
    source_item_id: row.current_source_item_id,
    source_tool_call_id: row.current_source_tool_call_id,
    restored_from_version_id: row.current_restored_from_version_id,
    created_by: row.current_created_by,
    created_at: row.current_created_at,
    metadata_json: row.current_metadata_json,
  });
  return {
    id: row.id,
    project_id: row.project_id,
    project_name: row.project_name || "项目",
    name: row.name,
    kind: row.kind,
    description: row.description || "",
    source_locator: row.source_locator || null,
    current_version_id: row.current_version_id || null,
    current_version: currentVersion,
    version_count: Number(row.version_count || 0),
    source_session_id: row.source_session_id || null,
    source_session_title: row.source_session_title || null,
    source_turn_id: row.source_turn_id || null,
    source_run_id: row.source_run_id || null,
    source_item_id: row.source_item_id || null,
    source_tool_call_id: row.source_tool_call_id || null,
    created_by: row.created_by || null,
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    metadata: parseJson(row.metadata_json, {}),
  };
}

async function assertProjectAccess(db, userId, projectId) {
  const uid = clean(userId);
  const pid = safeIdentifier(projectId, "项目 ID");
  if (!uid) throw new ApiError("需要登录后才能使用产物库", 403);
  if (pid === "__chat__") return { id: pid, name: "我的 Library" };
  const project = await db.queryOne(
    `SELECT p.id,p.name
       FROM projects p
       JOIN project_members pm ON pm.project_id=p.id AND pm.deleted_at IS NULL
      WHERE p.id=$1 AND pm.user_id=$2 AND p.deleted_at IS NULL
      LIMIT 1`,
    [pid, uid],
  );
  if (!project) throw new ApiError("项目不存在或无权限", 404);
  return project;
}

const ARTIFACT_SELECT = `
  SELECT a.*,CASE WHEN a.project_id='__chat__' THEN '我的 Library' ELSE p.name END AS project_name,
         s.title AS source_session_title,
         v.version_number AS current_version_number,
         v.snapshot_path AS current_snapshot_path,v.original_path AS current_original_path,
         v.mime_type AS current_mime_type,v.size_bytes AS current_size_bytes,v.sha256 AS current_sha256,
         v.change_summary AS current_change_summary,v.source_session_id AS current_source_session_id,
         vs.title AS current_source_session_title,v.source_turn_id AS current_source_turn_id,
         v.source_run_id AS current_source_run_id,v.source_item_id AS current_source_item_id,
         v.source_tool_call_id AS current_source_tool_call_id,
         v.restored_from_version_id AS current_restored_from_version_id,
         v.created_by AS current_created_by,v.created_at AS current_created_at,
         v.metadata_json AS current_metadata_json,
         (SELECT COUNT(*) FROM project_artifact_versions av WHERE av.artifact_id=a.id) AS version_count
    FROM project_artifacts a
    LEFT JOIN projects p ON p.id=a.project_id AND p.deleted_at IS NULL
    LEFT JOIN project_members pm ON pm.project_id=a.project_id AND pm.deleted_at IS NULL
    LEFT JOIN sessions s ON s.id=a.source_session_id AND s.deleted_at IS NULL
    LEFT JOIN project_artifact_versions v ON v.id=a.current_version_id
    LEFT JOIN sessions vs ON vs.id=v.source_session_id AND vs.deleted_at IS NULL`;

async function ownedArtifactRow(db, userId, artifactId, projectId = "") {
  const params = [clean(userId), clean(artifactId)];
  const projectScope = clean(projectId) ? ` AND a.project_id=$${params.push(clean(projectId))}` : "";
  const row = await db.queryOne(
    `${ARTIFACT_SELECT}
      WHERE ((a.project_id='__chat__' AND a.created_by=$1)
          OR (a.project_id<>'__chat__' AND pm.user_id=$1))
        AND a.id=$2 AND a.deleted_at IS NULL${projectScope}
      LIMIT 1`,
    params,
  );
  if (!row) throw new ApiError("产物不存在或无权限", 404);
  return row;
}

async function versionRows(db, artifactId) {
  return db.query(
    `SELECT v.*,s.title AS source_session_title
       FROM project_artifact_versions v
       LEFT JOIN sessions s ON s.id=v.source_session_id AND s.deleted_at IS NULL
      WHERE v.artifact_id=$1
      ORDER BY v.version_number DESC`,
    [artifactId],
  );
}

export async function getProjectArtifact(db, { userId, projectId = "", artifactId } = {}) {
  const row = await ownedArtifactRow(db, userId, artifactId, projectId);
  const versions = await versionRows(db, row.id);
  return { ...publicArtifact(row), versions: versions.map(publicVersion) };
}

export async function getProjectArtifactVersion(db, { userId, projectId = "", artifactId, versionId } = {}) {
  await ownedArtifactRow(db, userId, artifactId, projectId);
  const row = await db.queryOne(
    `SELECT v.*,s.title AS source_session_title
       FROM project_artifact_versions v
       LEFT JOIN sessions s ON s.id=v.source_session_id AND s.deleted_at IS NULL
      WHERE v.id=$1 AND v.artifact_id=$2 LIMIT 1`,
    [versionId, artifactId],
  );
  if (!row) throw new ApiError("产物版本不存在", 404);
  await verifyImmutableSnapshot(row);
  return publicVersion(row);
}

export async function searchProjectArtifacts(db, {
  userId,
  projectId = "",
  query = "",
  kind = "",
  since = "",
  limit = 80,
} = {}) {
  const uid = clean(userId);
  if (!uid) return [];
  const params = [uid];
  const where = [
    "((a.project_id='__chat__' AND a.created_by=$1) OR (a.project_id<>'__chat__' AND pm.user_id=$1))",
    "a.deleted_at IS NULL",
  ];
  if (clean(projectId)) where.push(`a.project_id=$${params.push(clean(projectId))}`);
  if (clean(kind) && clean(kind) !== "all") where.push(`a.kind=$${params.push(clean(kind).toLowerCase())}`);
  if (clean(since)) where.push(`COALESCE(v.created_at,a.updated_at,a.created_at)>=$${params.push(clean(since))}`);
  if (clean(query)) {
    params.push(`%${clean(query).toLowerCase()}%`);
    const placeholder = `$${params.length}`;
    where.push(`(LOWER(a.name) LIKE ${placeholder} OR LOWER(COALESCE(a.description,'')) LIKE ${placeholder} OR LOWER(COALESCE(v.change_summary,'')) LIKE ${placeholder})`);
  }
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 80));
  const rows = await db.query(
    `${ARTIFACT_SELECT}
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(v.created_at,a.updated_at,a.created_at) DESC
      LIMIT ${safeLimit}`,
    params,
  );
  return rows.map(publicArtifact);
}

async function nextVersionNumber(db, artifactId) {
  const row = await db.queryOne(
    "SELECT COALESCE(MAX(version_number),0)+1 AS next_version FROM project_artifact_versions WHERE artifact_id=$1",
    [artifactId],
  );
  return Math.max(1, Number(row?.next_version || 1));
}

async function ensureArtifactStorageDirectory(projectId, artifactId, storageRoot) {
  const rootInput = resolve(storageRoot || dataPath("project_artifacts"));
  await mkdir(rootInput, { recursive: true, mode: 0o700 });
  let rootStat;
  try {
    rootStat = lstatSync(rootInput);
  } catch {
    throw new ApiError("产物存储目录不可用", 503);
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ApiError("产物存储目录无效", 409);
  }
  await chmod(rootInput, 0o700).catch(() => {});
  const root = realpathSync(rootInput);
  let current = root;
  for (const segment of [safeIdentifier(projectId, "项目 ID"), safeIdentifier(artifactId, "产物 ID")]) {
    const next = join(current, segment);
    try {
      await mkdir(next, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw new ApiError("无法创建产物存储目录", 503);
    }
    let nextStat;
    try {
      nextStat = lstatSync(next);
    } catch {
      throw new ApiError("产物存储目录不可用", 503);
    }
    if (nextStat.isSymbolicLink() || !nextStat.isDirectory()) {
      throw new ApiError("产物存储目录无效", 409);
    }
    current = realpathSync(next);
    if (!inside(root, current)) throw new ApiError("产物存储目录无效", 409);
    await chmod(current, 0o700).catch(() => {});
  }
  return current;
}

function versionSnapshotPath(directory, versionNumber, versionId, filename) {
  return join(
    directory,
    `v${String(versionNumber).padStart(6, "0")}-${safeIdentifier(versionId, "版本 ID")}-${safeFilename(filename)}`,
  );
}

async function copyImmutableSnapshot({ sourcePath, targetPath, expectedHash, expectedSize }) {
  await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
  await chmod(targetPath, 0o400).catch(() => {});
  const copiedStat = statSync(targetPath);
  const copiedHash = await sha256File(targetPath);
  if (copiedStat.size !== expectedSize || copiedHash !== expectedHash) {
    await rm(targetPath, { force: true }).catch(() => {});
    throw new ApiError("保存产物版本时文件发生变化，请重试", 409);
  }
  return { stat: copiedStat, sha256: copiedHash };
}

async function verifyImmutableSnapshot(version) {
  let snapshotStat;
  try {
    if (lstatSync(version.snapshot_path).isSymbolicLink()) throw new Error("symlink");
    snapshotStat = statSync(version.snapshot_path);
  } catch {
    throw new ApiError("历史版本文件已损坏或不存在", 409);
  }
  if (!snapshotStat.isFile()) throw new ApiError("历史版本文件已损坏或不存在", 409);
  if (snapshotStat.size !== Number(version.size_bytes || 0)) {
    throw new ApiError("历史版本指纹校验失败", 409);
  }
  const snapshotHash = await sha256File(version.snapshot_path);
  if (snapshotHash !== version.sha256) throw new ApiError("历史版本指纹校验失败", 409);
  return { stat: snapshotStat, sha256: snapshotHash };
}

function trustedSource(value = {}) {
  return {
    sessionId: optionalText(value.sessionId ?? value.session_id, 180),
    turnId: optionalText(value.turnId ?? value.turn_id, 180),
    runId: optionalText(value.runId ?? value.run_id, 180),
    itemId: optionalText(value.itemId ?? value.item_id, 180),
    toolCallId: optionalText(value.toolCallId ?? value.tool_call_id, 180),
  };
}

async function insertVersion(db, {
  artifact,
  project,
  userId,
  sourcePath,
  sourceHash,
  sourceSize,
  requestedName,
  requestedKind,
  requestedDescription,
  changeSummary,
  mime,
  source,
  metadata,
  restoredFromVersionId = null,
  storageRoot,
  newArtifact,
} = {}) {
  const artifactId = artifact.id;
  const versionNumber = await nextVersionNumber(db, artifactId);
  const versionId = randomUUID();
  const snapshotDirectory = await ensureArtifactStorageDirectory(project.id, artifactId, storageRoot);
  const snapshotPath = versionSnapshotPath(snapshotDirectory, versionNumber, versionId, requestedName);

  await copyImmutableSnapshot({
    sourcePath,
    targetPath: snapshotPath,
    expectedHash: sourceHash,
    expectedSize: sourceSize,
  });

  try {
    if (newArtifact) {
      await db.query(
        `INSERT INTO project_artifacts
          (id,project_id,source_locator,name,kind,description,current_version_id,
           source_session_id,source_turn_id,source_run_id,source_item_id,source_tool_call_id,
           metadata_json,created_by,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,$7,$8,$9,$10,$11,$12,$13,now(),now())`,
        [
          artifactId, project.id, artifact.source_locator, requestedName, requestedKind,
          requestedDescription, source.sessionId, source.turnId, source.runId, source.itemId,
          source.toolCallId, JSON.stringify(metadata || {}), userId || null,
        ],
      );
    }
    await db.query(
      `INSERT INTO project_artifact_versions
        (id,artifact_id,version_number,snapshot_path,original_path,mime_type,size_bytes,sha256,
         change_summary,source_session_id,source_turn_id,source_run_id,source_item_id,source_tool_call_id,
         restored_from_version_id,metadata_json,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())`,
      [
        versionId, artifactId, versionNumber, snapshotPath, sourcePath, mime, sourceSize, sourceHash,
        changeSummary, source.sessionId, source.turnId, source.runId, source.itemId, source.toolCallId,
        restoredFromVersionId, JSON.stringify(metadata || {}), userId || null,
      ],
    );
    const updated = await db.query(
      `UPDATE project_artifacts
          SET current_version_id=$2,name=$3,kind=$4,
              description=CASE WHEN $5 IS NULL THEN description ELSE $5 END,
              updated_at=now()
        WHERE id=$1
        RETURNING id`,
      [artifactId, versionId, requestedName, requestedKind, requestedDescription],
    );
    if (!Array.isArray(updated) || updated.length !== 1) throw new ApiError("产物当前版本更新失败", 409);
  } catch (error) {
    await rm(snapshotPath, { force: true }).catch(() => {});
    await db.query("DELETE FROM project_artifact_versions WHERE id=$1", [versionId]).catch(() => {});
    if (newArtifact) await db.query("DELETE FROM project_artifacts WHERE id=$1 AND current_version_id IS NULL", [artifactId]).catch(() => {});
    throw error;
  }
  return { versionId, versionNumber, snapshotPath };
}

export async function publishProjectArtifact(db, {
  userId,
  projectId,
  sourcePath,
  allowedRoots = [],
  artifactId = "",
  expectedCurrentVersionId = "",
  name = "",
  kind = "",
  description,
  changeSummary = "",
  mimeType: requestedMime = "",
  source: sourceInput = {},
  metadata = {},
  storageRoot,
} = {}) {
  if (!(db?.query && db?.queryOne)) throw new ApiError("产物存储不可用", 503);
  const project = await assertProjectAccess(db, userId, projectId);
  return withProjectArtifactMutation(project.id, async () => {
    // Resolve and hash after entering the project lock. A native multi-agent turn may
    // publish the same file in parallel; every waiter must observe the latest version.
    const resolvedSource = resolveAuthorizedSource(sourcePath, allowedRoots);
    const before = statSync(resolvedSource.path);
    const sourceHash = await sha256File(resolvedSource.path);
    const afterHash = statSync(resolvedSource.path);
    if (sourceChanged(before, afterHash)) throw new ApiError("源文件正在变化，请保存完成后重试", 409);

    const sourceLocator = resolvedSource.path;
    let artifact = null;
    if (clean(artifactId)) {
      artifact = await ownedArtifactRow(db, userId, artifactId, project.id);
    } else {
      artifact = project.id === "__chat__"
        ? await db.queryOne(
            `SELECT * FROM project_artifacts
              WHERE project_id=$1 AND source_locator=$2 AND created_by=$3 AND deleted_at IS NULL LIMIT 1`,
            [project.id, sourceLocator, clean(userId)],
          )
        : await db.queryOne(
            `SELECT * FROM project_artifacts
              WHERE project_id=$1 AND source_locator=$2 AND deleted_at IS NULL LIMIT 1`,
            [project.id, sourceLocator],
          );
    }

    const newArtifact = !artifact;
    const id = artifact?.id || randomUUID();
    const expectedVersionId = clean(expectedCurrentVersionId);
    if (expectedVersionId && clean(artifact?.current_version_id) !== expectedVersionId) {
      throw new ApiError("产物已经产生新版本，请重新打开后再保存", 409);
    }
    const currentVersion = artifact?.current_version_id
      ? await db.queryOne("SELECT * FROM project_artifact_versions WHERE id=$1 LIMIT 1", [artifact.current_version_id])
      : null;
    if (currentVersion?.sha256 === sourceHash && Number(currentVersion?.size_bytes || 0) === before.size) {
      return {
        artifact: await getProjectArtifact(db, { userId, projectId: project.id, artifactId: id }),
        created: false,
        deduplicated: true,
      };
    }

    const requestedName = safeFilename(name || artifact?.name || basename(resolvedSource.path));
    const requestedKind = inferKind(resolvedSource.path, kind || artifact?.kind);
    const requestedDescription = description === undefined
      ? (artifact?.description ?? null)
      : optionalText(description, 2_000);
    const source = trustedSource(sourceInput);
    await insertVersion(db, {
      artifact: artifact || { id, source_locator: sourceLocator },
      project,
      userId: clean(userId),
      sourcePath: resolvedSource.path,
      sourceHash,
      sourceSize: before.size,
      requestedName,
      requestedKind,
      requestedDescription,
      changeSummary: optionalText(changeSummary, 2_000) || (newArtifact ? "创建产物" : "更新产物"),
      mime: mimeType(resolvedSource.path, requestedMime),
      source,
      metadata,
      storageRoot,
      newArtifact,
    });

    return {
      artifact: await getProjectArtifact(db, { userId, projectId: project.id, artifactId: id }),
      created: newArtifact,
      deduplicated: false,
    };
  });
}

export async function restoreProjectArtifactVersion(db, {
  userId,
  projectId,
  artifactId,
  versionId,
  changeSummary = "",
  source: sourceInput = {},
  storageRoot,
} = {}) {
  const project = await assertProjectAccess(db, userId, projectId);
  return withProjectArtifactMutation(project.id, async () => {
    const artifact = await ownedArtifactRow(db, userId, artifactId, project.id);
    const target = await db.queryOne(
      "SELECT * FROM project_artifact_versions WHERE id=$1 AND artifact_id=$2 LIMIT 1",
      [versionId, artifact.id],
    );
    if (!target) throw new ApiError("要恢复的版本不存在", 404);
    const current = artifact.current_version_id
      ? await db.queryOne("SELECT * FROM project_artifact_versions WHERE id=$1 LIMIT 1", [artifact.current_version_id])
      : null;
    if (current?.sha256 === target.sha256 && Number(current?.size_bytes || 0) === Number(target.size_bytes || 0)) {
      return {
        artifact: await getProjectArtifact(db, { userId, projectId: project.id, artifactId: artifact.id }),
        restored: false,
        deduplicated: true,
      };
    }
    const verifiedTarget = await verifyImmutableSnapshot(target);
    const source = trustedSource(sourceInput);
    await insertVersion(db, {
      artifact,
      project,
      userId: clean(userId),
      sourcePath: target.snapshot_path,
      sourceHash: verifiedTarget.sha256,
      sourceSize: verifiedTarget.stat.size,
      requestedName: artifact.name,
      requestedKind: artifact.kind,
      requestedDescription: artifact.description ?? null,
      changeSummary: optionalText(changeSummary, 2_000) || `恢复版本 v${target.version_number}`,
      mime: target.mime_type || mimeType(target.snapshot_path),
      source,
      metadata: { restored_from_version_id: target.id },
      restoredFromVersionId: target.id,
      storageRoot,
      newArtifact: false,
    });
    return {
      artifact: await getProjectArtifact(db, { userId, projectId: project.id, artifactId: artifact.id }),
      restored: true,
      deduplicated: false,
    };
  });
}

function probablyText(buffer) {
  if (!buffer.length) return true;
  let controls = 0;
  for (const byte of buffer) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  return controls / buffer.length < 0.02;
}

function coarseUnifiedDiff(beforeText, afterText, fromLabel, toLabel) {
  const before = beforeText.replace(/\r\n?/g, "\n").split("\n");
  const after = afterText.replace(/\r\n?/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix += 1;
  const contextBeforeStart = Math.max(0, prefix - 3);
  const beforeEnd = before.length - suffix;
  const afterEnd = after.length - suffix;
  const contextAfterCount = Math.min(3, suffix);
  const lines = [
    `--- ${fromLabel}`,
    `+++ ${toLabel}`,
    `@@ -${contextBeforeStart + 1},${Math.max(0, beforeEnd - contextBeforeStart + contextAfterCount)} +${contextBeforeStart + 1},${Math.max(0, afterEnd - contextBeforeStart + contextAfterCount)} @@`,
    ...before.slice(contextBeforeStart, prefix).map((line) => ` ${line}`),
    ...before.slice(prefix, beforeEnd).map((line) => `-${line}`),
    ...after.slice(prefix, afterEnd).map((line) => `+${line}`),
    ...after.slice(afterEnd, afterEnd + contextAfterCount).map((line) => ` ${line}`),
  ];
  return {
    diff: lines.join("\n"),
    removed_lines: Math.max(0, beforeEnd - prefix),
    added_lines: Math.max(0, afterEnd - prefix),
  };
}

export async function compareProjectArtifactVersions(db, {
  userId,
  projectId,
  artifactId,
  fromVersionId = "",
  toVersionId = "",
} = {}) {
  const artifact = await getProjectArtifact(db, { userId, projectId, artifactId });
  const versions = artifact.versions;
  const to = versions.find((version) => version.id === clean(toVersionId))
    || versions.find((version) => version.id === artifact.current_version_id)
    || versions[0];
  const from = versions.find((version) => version.id === clean(fromVersionId))
    || versions.find((version) => version.version_number === Number(to?.version_number || 0) - 1)
    || versions[1];
  if (!from || !to) throw new ApiError("至少需要两个版本才能比较", 409);
  await Promise.all([verifyImmutableSnapshot(from), verifyImmutableSnapshot(to)]);
  if (from.id === to.id || (from.sha256 === to.sha256 && from.size_bytes === to.size_bytes)) {
    return { mode: "identical", from, to, summary: "两个版本内容相同", diff: "", added_lines: 0, removed_lines: 0 };
  }
  if (from.size_bytes > MAX_DIFF_BYTES || to.size_bytes > MAX_DIFF_BYTES) {
    return { mode: "metadata", from, to, summary: "文件较大，仅比较大小和指纹", diff: "" };
  }
  const [before, after] = await Promise.all([readFile(from.snapshot_path), readFile(to.snapshot_path)]).catch(() => {
    throw new ApiError("版本文件不存在或无法读取", 409);
  });
  if (!probablyText(before) || !probablyText(after)) {
    return { mode: "binary", from, to, summary: "二进制内容不同", diff: "" };
  }
  const result = coarseUnifiedDiff(
    before.toString("utf8"),
    after.toString("utf8"),
    `v${from.version_number}/${artifact.name}`,
    `v${to.version_number}/${artifact.name}`,
  );
  return {
    mode: "text",
    from,
    to,
    summary: `新增 ${result.added_lines} 行，删除 ${result.removed_lines} 行`,
    ...result,
  };
}

export default {
  publishProjectArtifact,
  searchProjectArtifacts,
  getProjectArtifact,
  getProjectArtifactVersion,
  restoreProjectArtifactVersion,
  compareProjectArtifactVersions,
};

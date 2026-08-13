import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { tmpdir } from "node:os";

import { dataPath } from "../../config/paths.js";
import { ApiError } from "../../errors.js";
import {
  compareOfficeArtifacts,
  createOfficeArtifactFile,
  editOfficeArtifact,
  extensionForOfficeFormat,
  inspectOfficeArtifact,
  officeFormatForPath,
} from "./office_artifact_editor.js";
import {
  getProjectArtifact,
  getProjectArtifactVersion,
  publishProjectArtifact,
} from "./project_artifact_store.js";

function clean(value) {
  return String(value || "").trim();
}

function safeIdentifier(value, label) {
  const text = clean(value);
  if (!text || !/^[a-zA-Z0-9._-]{1,180}$/.test(text) || text === "." || text === "..") throw new ApiError(`${label}无效`, 400);
  return text;
}

function safeFilename(value, extension) {
  const raw = basename(clean(value) || `未命名${extension}`);
  const stem = raw.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").slice(0, 120) || "未命名";
  return `${stem}${extension}`;
}

async function secureDirectory(root, segments) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw new ApiError("办公产物存储目录无效", 409);
  await chmod(root, 0o700).catch(() => null);
  let current = realpathSync(root);
  for (const segment of segments.map((value) => safeIdentifier(value, "目录标识"))) {
    const next = join(current, segment);
    try { await mkdir(next, { mode: 0o700 }); } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const stat = lstatSync(next);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ApiError("办公产物存储目录无效", 409);
    await chmod(next, 0o700).catch(() => null);
    current = realpathSync(next);
  }
  return current;
}

async function assertProject(ctx, projectId) {
  if (projectId === "__chat__" && ctx.userId) return { id: projectId, name: "我的 Library" };
  const project = await ctx.queryOne(
    `SELECT p.id,p.name
       FROM projects p
       JOIN project_members pm ON pm.project_id=p.id AND pm.deleted_at IS NULL
      WHERE p.id=$1 AND pm.user_id=$2 AND p.deleted_at IS NULL LIMIT 1`,
    [projectId, ctx.userId || ""],
  );
  if (!project) throw new ApiError("项目不存在或无权限", 404);
  return project;
}

export async function inspectProjectOfficeArtifact(ctx, {
  projectId,
  artifactId,
  versionId = "",
} = {}) {
  const artifact = await getProjectArtifact(ctx, { userId: ctx.userId, projectId, artifactId });
  const selectedVersionId = clean(versionId) || artifact.current_version_id;
  const version = await getProjectArtifactVersion(ctx, {
    userId: ctx.userId,
    projectId,
    artifactId,
    versionId: selectedVersionId,
  });
  const format = officeFormatForPath(version.snapshot_path);
  if (!format) throw new ApiError("这个产物格式暂不支持内置编辑", 400);
  const document = await inspectOfficeArtifact(version.snapshot_path, { metadata: version.metadata, format });
  return { artifact, version, document };
}

export async function editProjectOfficeArtifact(ctx, {
  projectId,
  artifactId,
  baseVersionId,
  operations,
  changeSummary = "",
  source = {},
} = {}) {
  const artifact = await getProjectArtifact(ctx, { userId: ctx.userId, projectId, artifactId });
  const baseId = clean(baseVersionId);
  if (!baseId) throw new ApiError("缺少编辑基线版本", 400);
  if (artifact.current_version_id !== baseId) throw new ApiError("产物已经产生新版本，请重新打开后再保存", 409);
  const version = await getProjectArtifactVersion(ctx, {
    userId: ctx.userId,
    projectId,
    artifactId,
    versionId: baseId,
  });
  const format = officeFormatForPath(version.snapshot_path);
  if (!format) throw new ApiError("这个产物格式暂不支持内置编辑", 400);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "dsh-office-edit-"));
  const extension = extensionForOfficeFormat(format);
  const outputPath = join(temporaryDirectory, safeFilename(artifact.name, extension));
  try {
    const edit = await editOfficeArtifact(version.snapshot_path, outputPath, operations, { metadata: version.metadata, format });
    const anchors = edit.changes?.map((item) => item.anchor).filter(Boolean).slice(0, 200) || [];
    const metadata = {
      ...(version.metadata || {}),
      ...(edit.metadata || {}),
      office_edit: {
        format,
        base_version_id: baseId,
        operation_count: Array.isArray(operations) ? operations.length : 0,
        anchors,
      },
    };
    const published = await publishProjectArtifact(ctx, {
      userId: ctx.userId,
      projectId,
      sourcePath: outputPath,
      allowedRoots: [temporaryDirectory],
      artifactId,
      expectedCurrentVersionId: baseId,
      name: artifact.name,
      kind: artifact.kind,
      description: artifact.description,
      changeSummary: clean(changeSummary).slice(0, 2_000) || `编辑 ${format.toUpperCase()} 产物`,
      source,
      metadata,
    });
    return {
      ...published,
      edit: { format, changes: edit.changes || [], warnings: edit.warnings || [] },
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => null);
  }
}

export async function createProjectOfficeArtifact(ctx, {
  projectId,
  format,
  name = "",
  title = "",
  content = "",
  specification = {},
  description = "",
  source = {},
} = {}) {
  const project = await assertProject(ctx, clean(projectId));
  const extension = extensionForOfficeFormat(format);
  if (!extension) throw new ApiError("不支持的办公产物格式", 400);
  const creationId = randomUUID();
  const managedRoot = dataPath("project_office_sources");
  const directory = await secureDirectory(managedRoot, [project.id, creationId]);
  const filename = safeFilename(name || title || `未命名${extension}`, extension);
  const outputPath = join(directory, filename);
  try {
    await createOfficeArtifactFile(outputPath, { ...specification, format, title, content });
    const published = await publishProjectArtifact(ctx, {
      userId: ctx.userId,
      projectId: project.id,
      sourcePath: outputPath,
      allowedRoots: [managedRoot],
      name: filename,
      kind: format === "xlsx" ? "table" : "document",
      description,
      changeSummary: `创建 ${format.toUpperCase()} 产物`,
      source,
      metadata: { office_format: format, managed_source: true },
    });
    return published;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => null);
    throw error;
  }
}

export async function compareProjectOfficeArtifactVersions(ctx, {
  projectId,
  artifactId,
  fromVersionId,
  toVersionId,
} = {}) {
  const [from, to] = await Promise.all([
    getProjectArtifactVersion(ctx, { userId: ctx.userId, projectId, artifactId, versionId: fromVersionId }),
    getProjectArtifactVersion(ctx, { userId: ctx.userId, projectId, artifactId, versionId: toVersionId }),
  ]);
  const diff = await compareOfficeArtifacts(from.snapshot_path, to.snapshot_path, {
    fromMetadata: from.metadata,
    toMetadata: to.metadata,
  });
  return { from, to, ...diff };
}

export default {
  inspectProjectOfficeArtifact,
  editProjectOfficeArtifact,
  createProjectOfficeArtifact,
  compareProjectOfficeArtifactVersions,
};

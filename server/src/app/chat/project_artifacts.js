import { ApiError } from "../../errors.js";
import {
  compareProjectArtifactVersions,
  getProjectArtifact,
  getProjectArtifactVersion,
  publishProjectArtifact,
  restoreProjectArtifactVersion,
  searchProjectArtifacts,
} from "../../engine/agents/project_artifact_store.js";
import {
  compareProjectOfficeArtifactVersions,
  createProjectOfficeArtifact,
  editProjectOfficeArtifact,
  inspectProjectOfficeArtifact,
} from "../../engine/agents/office_artifact_service.js";
import { buildAgentFilePreview } from "./agent_misc.js";
import {
  hasHiddenOrGeneratedPath,
  listProjectFileRoots,
  resolveAuthorizedRootPath,
} from "./project_files.js";

function clean(value) {
  return String(value || "").trim();
}

function number(value, fallback = 80) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function temporaryArtifactError() {
  return new ApiError("临时聊天不会保存到 Library；请切换到普通聊天或项目聊天。", 400);
}

function sessionConfig(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function persistentSource(ctx, projectId, sessionId = "", temporary = false) {
  if (temporary === true) throw temporaryArtifactError();
  const sid = clean(sessionId);
  if (!sid) return {};
  const session = await ctx.queryOne(
    `SELECT id,action_type,session_config FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL LIMIT 1`,
    [sid, projectId, ctx.userId || ""],
  );
  if (!session) throw new ApiError("来源对话不存在或无权限", 404);
  if (session.action_type === "temporary_chat" || sessionConfig(session.session_config).temporary === true) {
    throw temporaryArtifactError();
  }
  return { sessionId: sid };
}

async function sourceFileFromRequest(ctx, input) {
  const projectId = clean(input.params?.pid);
  const sessionId = clean(input.body?.session_id || input.query?.session_id);
  const rootId = clean(input.body?.root_id);
  const path = clean(input.body?.path);
  if (!rootId || !path) throw new ApiError("需要指定文件根目录和相对路径", 400);
  const roots = await listProjectFileRoots(ctx, { projectId, sessionId });
  const root = roots.find((item) => clean(item.id) === rootId);
  if (!root) throw new ApiError("文件根目录不存在或无权限", 404);
  const resolved = resolveAuthorizedRootPath(root, path, { type: "file" });
  if (!resolved || hasHiddenOrGeneratedPath(resolved.relativePath)) {
    throw new ApiError("文件不存在或无权限", 404);
  }
  return { projectId, sessionId, root, resolved };
}

// GET /api/agent/projects/:pid/artifacts
export async function listProjectArtifacts(ctx, input) {
  const projectId = clean(input.params?.pid);
  const items = await searchProjectArtifacts(ctx, {
    userId: ctx.userId,
    projectId,
    query: input.query?.q,
    kind: input.query?.kind,
    since: input.query?.since,
    limit: number(input.query?.limit, 100),
  });
  return { data: { items }, message: "获取项目产物成功" };
}

// GET /api/agent/search/artifacts
export async function searchAgentArtifacts(ctx, input) {
  const items = await searchProjectArtifacts(ctx, {
    userId: ctx.userId,
    projectId: input.query?.project_id || input.query?.projectId,
    query: input.query?.q,
    kind: input.query?.kind,
    since: input.query?.since,
    limit: number(input.query?.limit, 80),
  });
  return { data: { items }, message: "搜索项目产物成功" };
}

// POST /api/agent/projects/:pid/artifacts
export async function createProjectArtifact(ctx, input) {
  const sourceFile = await sourceFileFromRequest(ctx, input);
  const source = await persistentSource(ctx, sourceFile.projectId, sourceFile.sessionId, input.body?.temporary === true);
  const result = await publishProjectArtifact(ctx, {
    userId: ctx.userId,
    projectId: sourceFile.projectId,
    sourcePath: sourceFile.resolved.fullPath,
    allowedRoots: [sourceFile.root.path],
    artifactId: input.body?.artifact_id,
    name: input.body?.name,
    kind: input.body?.kind,
    description: input.body?.description,
    changeSummary: input.body?.change_summary,
    source,
    metadata: { source_root_id: sourceFile.root.id, source_relative_path: sourceFile.resolved.relativePath },
  });
  return { data: result, message: result.deduplicated ? "当前内容已在产物库中" : "已加入项目产物库" };
}

// POST /api/agent/projects/:pid/artifacts/office
export async function createProjectOfficeDocument(ctx, input) {
  const projectId = clean(input.params?.pid);
  const source = await persistentSource(ctx, projectId, input.body?.session_id, input.body?.temporary === true);
  const data = await createProjectOfficeArtifact(ctx, {
    projectId,
    format: input.body?.format,
    name: input.body?.name,
    title: input.body?.title,
    content: input.body?.content,
    specification: input.body?.specification,
    description: input.body?.description,
    source,
  });
  return { data, message: "已创建办公产物" };
}

// GET /api/agent/projects/:pid/artifacts/:artifactId
export async function getProjectArtifactDetail(ctx, input) {
  const data = await getProjectArtifact(ctx, {
    userId: ctx.userId,
    projectId: input.params?.pid,
    artifactId: input.params?.artifactId,
  });
  return { data, message: "获取产物详情成功" };
}

// GET /api/agent/projects/:pid/artifacts/:artifactId/versions/:versionId/preview
export async function previewProjectArtifactVersion(ctx, input) {
  const version = await getProjectArtifactVersion(ctx, {
    userId: ctx.userId,
    projectId: input.params?.pid,
    artifactId: input.params?.artifactId,
    versionId: input.params?.versionId,
  });
  const preview = await buildAgentFilePreview(
    version.snapshot_path,
    `v${version.version_number}`,
    `artifact:${input.params?.artifactId}:${version.id}`,
  );
  return { data: { version, preview }, message: "获取产物预览成功" };
}

// GET /api/agent/projects/:pid/artifacts/:artifactId/office
export async function inspectProjectOfficeDocument(ctx, input) {
  const data = await inspectProjectOfficeArtifact(ctx, {
    projectId: input.params?.pid,
    artifactId: input.params?.artifactId,
    versionId: input.query?.version_id || input.query?.versionId,
  });
  return { data, message: "获取办公产物结构成功" };
}

// POST /api/agent/projects/:pid/artifacts/:artifactId/office/edits
export async function editProjectOfficeDocument(ctx, input) {
  const projectId = clean(input.params?.pid);
  const source = await persistentSource(ctx, projectId, input.body?.session_id, input.body?.temporary === true);
  const data = await editProjectOfficeArtifact(ctx, {
    projectId,
    artifactId: input.params?.artifactId,
    baseVersionId: input.body?.base_version_id || input.body?.baseVersionId,
    operations: input.body?.operations,
    changeSummary: input.body?.change_summary || input.body?.changeSummary,
    source,
  });
  return { data, message: data.deduplicated ? "修改内容没有变化" : "已保存为新的产物版本" };
}

// GET /api/agent/projects/:pid/artifacts/:artifactId/office/diff
export async function compareProjectOfficeDocument(ctx, input) {
  const data = await compareProjectOfficeArtifactVersions(ctx, {
    projectId: input.params?.pid,
    artifactId: input.params?.artifactId,
    fromVersionId: input.query?.from_version_id || input.query?.fromVersionId,
    toVersionId: input.query?.to_version_id || input.query?.toVersionId,
  });
  return { data, message: "比较办公产物内容成功" };
}

// GET /api/agent/projects/:pid/artifacts/:artifactId/diff
export async function compareProjectArtifact(ctx, input) {
  const data = await compareProjectArtifactVersions(ctx, {
    userId: ctx.userId,
    projectId: input.params?.pid,
    artifactId: input.params?.artifactId,
    fromVersionId: input.query?.from_version_id || input.query?.fromVersionId,
    toVersionId: input.query?.to_version_id || input.query?.toVersionId,
  });
  return { data, message: "比较产物版本成功" };
}

// POST /api/agent/projects/:pid/artifacts/:artifactId/restore
export async function restoreProjectArtifact(ctx, input) {
  const projectId = clean(input.params?.pid);
  const source = await persistentSource(ctx, projectId, input.body?.session_id, input.body?.temporary === true);
  const data = await restoreProjectArtifactVersion(ctx, {
    userId: ctx.userId,
    projectId,
    artifactId: input.params?.artifactId,
    versionId: input.body?.version_id,
    changeSummary: input.body?.change_summary,
    source,
  });
  return { data, message: data.deduplicated ? "该版本已经是当前内容" : "已恢复为新的当前版本" };
}

export default {
  listProjectArtifacts,
  searchAgentArtifacts,
  createProjectArtifact,
  createProjectOfficeDocument,
  getProjectArtifactDetail,
  previewProjectArtifactVersion,
  inspectProjectOfficeDocument,
  editProjectOfficeDocument,
  compareProjectOfficeDocument,
  compareProjectArtifact,
  restoreProjectArtifact,
};

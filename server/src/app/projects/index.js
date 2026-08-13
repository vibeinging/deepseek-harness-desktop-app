// L1 use-case layer for project CRUD, source folders, skills, web search, and health check.
// Aligned line-by-line with index.js. Signature is always async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
//
// Coverage:
//   projects: GET list / POST create / GET detail / PUT / DELETE
//   folders:  GET/PUT project source folders
//   skills:    Agent effective skill list / enabled list / detail
//   misc:      roles/list / health(/api/health,/health,auth:false) /
//              web-search-models(project-level) / web-search-models/support
//
// Note: app/projects/ is one layer deeper than routes/, so engine/db uses ../../.
// workspace helper / getUserProjects / getCompanyId are private helpers from index.js, copied here by recipe.
import { randomUUID } from 'node:crypto';
import {
  listEnabledSkills as listEnabledRegisteredSkills,
  listSkills as listRegisteredSkills,
} from '../../engine/agents/skill_registry.js';
import { ApiError } from '../../errors.js';
import { listProjectSourceFolders, normalizeProjectSourceFolders, replaceProjectSourceFolders } from './source_folders.js';
import { isProjectSourceFolderAvailable } from '../../engine/agents/project_source_folders.js';
import { requireProjectMember } from './access.js';
import { WEB_SEARCH_SUPPORTED_TYPES } from '../models/web_search_models.js';
export { getProjectRules, updateProjectRules } from '../agents/index.js';

export const MAX_PROJECT_INSTRUCTIONS_LENGTH = 8_000;

export function normalizeProjectInstructions(value) {
  const instructions = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (instructions.length > MAX_PROJECT_INSTRUCTIONS_LENGTH) {
    throw new ApiError(`项目指令不能超过 ${MAX_PROJECT_INSTRUCTIONS_LENGTH} 个字符`, 400);
  }
  return instructions;
}

// ── User/project data (copied from index.js)──
async function getUserProjects(ctx, userId) {
  const rows = await ctx.query(
    `SELECT p.id, p.name, p.description, p.instructions, p.status, p.is_open,
            p.created_at, p.updated_at, pm.is_owner, pm.role_id,
            (SELECT COUNT(*) FROM sessions s WHERE s.project_id=p.id AND s.deleted_at IS NULL) AS conversation_count,
            (SELECT COUNT(*) FROM business_data_sources b WHERE b.project_id=p.id AND b.deleted_at IS NULL) AS data_source_count
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.deleted_at IS NULL
      WHERE pm.user_id = $1 AND p.deleted_at IS NULL
      ORDER BY p.created_at DESC`,
    [userId],
  );
  const projectIds = rows.map((row) => String(row.id || '')).filter(Boolean);
  const folderRows = projectIds.length
    ? await ctx.query(
      `SELECT id, project_id, local_path, display_name, access_mode, sort_order, created_at, updated_at
         FROM project_source_folders
        WHERE project_id::text = ANY($1::text[]) AND deleted_at IS NULL
        ORDER BY project_id, sort_order ASC, created_at ASC`,
      [projectIds],
    ).catch(() => [])
    : [];
  const foldersByProject = new Map();
  for (const row of folderRows) {
    const list = foldersByProject.get(row.project_id) || [];
    list.push({
      ...row,
      access_mode: row.access_mode === 'write' ? 'write' : 'read',
      write_target: row.access_mode === 'write',
      path: row.local_path,
      name: row.display_name,
      available: isProjectSourceFolderAvailable(row.local_path),
    });
    foldersByProject.set(row.project_id, list);
  }
  return rows.map((p) => ({
    id: p.id,
    project_id: p.id,
    name: p.name,
    project_name: p.name,
    description: p.description,
    instructions: p.instructions || '',
    status: p.status,
    is_open: p.is_open,
    created_at: p.created_at,
    updated_at: p.updated_at,
    is_owner: !!p.is_owner,
    role: p.is_owner ? 'owner' : 'member',
    role_id: p.role_id,
    permissions: p.is_owner ? ['*'] : [],
    conversation_count: Number(p.conversation_count || 0),
    data_source_count: Number(p.data_source_count || 0),
    source_folders: foldersByProject.get(p.id) || [],
  }));
}

async function getCompanyId(ctx, userId) {
  const u = await ctx.queryOne(`SELECT company_id FROM users WHERE id=$1`, [userId]);
  return u?.company_id;
}

// ════════════════════════════════════════════
// Health check (auth:false)
// ════════════════════════════════════════════

// GET /api/health
export async function health(_ctx, _input) {
  return { data: { ok: true }, message: 'ok' };
}

// GET /health — legacy contract returns raw { ok:true }; transport follows standard envelope and data field is { ok:true }
export async function healthPlain(_ctx, _input) {
  return { data: { ok: true } };
}

// ════════════════════════════════════════════
// Project CRUD
// ════════════════════════════════════════════

// GET /api/projects — list projects (server-side fuzzy name match via search)
export async function listProjects(ctx, input) {
  let projects = await getUserProjects(ctx, ctx.userId);
  // Match production contract: search supports server-side fuzzy matching on project name (used by old-project cleanup in eval).
  const search = (input.query?.search || '').trim();
  if (search) {
    const kw = search.toLowerCase();
    projects = projects.filter((p) => String(p.name || '').toLowerCase().includes(kw));
  }
  return { data: { items: projects, total: projects.length, page: 1, per_page: projects.length }, message: '获取项目列表成功' };
}

// POST /api/projects — create project (project + creator as owner + admin role)
export async function createProject(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const { name, description, instructions, source_folders: sourceFolders = [] } = input.body || {};
  const projectName = String(name || '').trim();
  const projectDescription = String(description || '').trim();
  const projectInstructions = normalizeProjectInstructions(instructions);
  if (projectName.length < 2 || projectName.length > 100) throw new ApiError('项目名称长度需要在 2 到 100 个字符之间', 400);
  if (projectDescription.length > 500) throw new ApiError('项目描述不能超过 500 个字符', 400);
  const normalizedFolders = normalizeProjectSourceFolders(sourceFolders);
  const pid = randomUUID();
  if (typeof ctx.transaction !== 'function') {
    throw new ApiError('项目存储暂时不可用', 503, 'PROJECT_TRANSACTION_UNAVAILABLE');
  }
  // Project identity, its owner, and initial source folders are one invariant.
  // Cancellation is checked before entering this synchronous SQLite transaction;
  // once dispatched, the complete project either commits or rolls back together.
  const { adminRole } = ctx.transaction((tx) => {
    tx.query(
      `INSERT INTO projects (id,company_id,name,description,instructions,status,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,'active',now(),now())`,
      [pid, cid, projectName, projectDescription || null, projectInstructions],
    );
    let selectedAdminRole = null;
    try {
      selectedAdminRole = tx.queryOne(
        `SELECT id FROM roles WHERE deleted_at IS NULL AND (code='project_admin' OR (is_system=true AND (name LIKE '%管理员%' OR code LIKE '%admin%')))
          ORDER BY (code='project_admin') DESC, is_system DESC LIMIT 1`,
      );
    } catch {
      selectedAdminRole = null;
    }
    tx.query(
      `INSERT INTO project_members (id,project_id,user_id,role_id,is_owner,created_at,updated_at)
       VALUES ($1,$2,$3,$4,true,now(),now())`,
      [randomUUID(), pid, ctx.userId, selectedAdminRole?.id || null],
    );
    for (let index = 0; index < normalizedFolders.length; index += 1) {
      const folder = normalizedFolders[index];
      tx.query(
        `INSERT INTO project_source_folders
          (id, project_id, local_path, display_name, access_mode, sort_order, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now(),now())`,
        [randomUUID(), pid, folder.path, folder.name, folder.access_mode, index],
      );
    }
    return { adminRole: selectedAdminRole };
  }, { mode: 'immediate' });
  const p = await ctx.queryOne(
    `SELECT id, company_id, name, description, instructions, status, is_open, created_at, updated_at FROM projects WHERE id=$1`,
    [pid],
  );
  const folders = await listProjectSourceFolders(ctx, pid);
  return { data: { ...p, project_id: p.id, project_name: p.name, is_owner: true, role: 'owner', role_id: adminRole?.id || null, permissions: ['*'], source_folders: folders, conversation_count: 0, data_source_count: 0 }, message: '创建项目成功' };
}

// GET /api/projects/:id — get project detail
export async function getProject(ctx, input) {
  const projects = await getUserProjects(ctx, ctx.userId);
  const p = projects.find((x) => x.id === input.params.id);
  if (!p) throw new ApiError('项目不存在或无权限', 404);
  return { data: p, message: '获取项目成功' };
}

// PUT /api/projects/:id — update lightweight project identity.
export async function updateProject(ctx, input) {
  const projects = await getUserProjects(ctx, ctx.userId);
  const project = projects.find((item) => item.id === input.params.id);
  if (!project) throw new ApiError('项目不存在或无权限', 404);
  if (!project.is_owner) throw new ApiError('只有项目所有者可以编辑项目', 403);
  const name = String(input.body?.name ?? project.name).trim();
  const description = String(input.body?.description ?? project.description ?? '').trim();
  const instructions = normalizeProjectInstructions(input.body?.instructions ?? project.instructions ?? '');
  if (name.length < 2 || name.length > 100) throw new ApiError('项目名称长度需要在 2 到 100 个字符之间', 400);
  if (description.length > 500) throw new ApiError('项目描述不能超过 500 个字符', 400);
  await ctx.query(
    `UPDATE projects SET name=$2, description=$3, instructions=$4, updated_at=now() WHERE id=$1 AND deleted_at IS NULL`,
    [project.id, name, description || null, instructions],
  );
  const updated = (await getUserProjects(ctx, ctx.userId)).find((item) => item.id === project.id);
  return { data: updated, message: '项目已更新' };
}

export async function getSourceFolders(ctx, input) {
  const project = (await getUserProjects(ctx, ctx.userId)).find((item) => item.id === input.params.id);
  if (!project) throw new ApiError('项目不存在或无权限', 404);
  return { data: await listProjectSourceFolders(ctx, project.id), message: 'ok' };
}

export async function replaceSourceFolders(ctx, input) {
  const project = (await getUserProjects(ctx, ctx.userId)).find((item) => item.id === input.params.id);
  if (!project) throw new ApiError('项目不存在或无权限', 404);
  if (!project.is_owner) throw new ApiError('只有项目所有者可以编辑本地文件夹', 403);
  const folders = await replaceProjectSourceFolders(ctx, project.id, input.body?.folders || [], ctx.userId || null);
  return { data: folders, message: '项目文件夹已更新' };
}

// DELETE /api/projects/:id — soft-delete project
export async function deleteProject(ctx, input) {
  const { id } = input.params;
  const projects = await getUserProjects(ctx, ctx.userId);
  const project = projects.find((x) => x.id === id);
  if (!project) throw new ApiError('项目不存在或无权限', 404);
  if (!project.is_owner) throw new ApiError('只有项目所有者可以删除项目', 403);
  await ctx.query(`UPDATE projects SET deleted_at=now(), updated_at=now() WHERE id=$1`, [id]);
  await ctx.query(
    `UPDATE project_source_folders SET deleted_at=now(), deleted_by=$2, updated_at=now()
      WHERE project_id=$1 AND deleted_at IS NULL`,
    [id, ctx.userId || null],
  );
  return { data: { id, deleted: true, recoverable: true }, message: '项目已移到已删除项目' };
}

// ════════════════════════════════════════════
// Skill management
// ════════════════════════════════════════════

// GET /api/projects/:pid/skills — Agent effective Skill list for this workspace
export async function listSkills(ctx, input) {
  await requireProjectMember(ctx, input.params.pid);
  const skills = await listRegisteredSkills(ctx, input.params.pid);
  return {
    data: skills,
    message: '获取技能列表成功',
  };
}

// GET /api/projects/:pid/skills/enabled/list
export async function listEnabledSkills(ctx, input) {
  await requireProjectMember(ctx, input.params.pid);
  const skills = await listEnabledRegisteredSkills(ctx, input.params.pid);
  return {
    data: skills,
    message: '获取启用技能成功',
  };
}

// GET /api/projects/:pid/skills/:skillName
export async function getSkillDetail(ctx, input) {
  await requireProjectMember(ctx, input.params.pid);
  const skills = await listRegisteredSkills(ctx, input.params.pid);
  const rawName = String(input.params.skillName || '').trim();
  const skill = skills.find((candidate) => (
    candidate.name === rawName || `${candidate.plugin_name || ''}:${candidate.name}` === rawName
  ));
  if (!skill) throw new ApiError('Skill 不存在或所属 Plugin 未挂载到当前项目', 404);
  return { data: skill, message: '获取技能详情成功' };
}

// ════════════════════════════════════════════
// Web search models (service list support — project-level web-search-models CRUD belongs to models domain)
// ════════════════════════════════════════════

// GET /api/web-search-models/support
export async function listWebSearchSupport(_ctx, _input) {
  return {
    data: WEB_SEARCH_SUPPORTED_TYPES.map(({ value, label }) => ({ api: value, name: label })),
    message: '获取支持的搜索服务成功',
  };
}

// ── Worktree management (re-exported for route registration) ──
export {
  listProjectWorktrees,
  createProjectWorktree,
  activateProjectWorktree,
  deactivateProjectWorktrees,
  removeProjectWorktree,
} from './worktrees.js';

// projects 域路由表(项目 CRUD / Source folders / 技能 / 网络搜索支持 / 健康检查,
// 抽自 index.js)。一域一文件,避免多 agent 扇出冲突。
// /health 类无鉴权,显式标 auth:false。
//
// 路由顺序:字面段路由(skills/*)排在 :id 参数路由前,避免被参数段误捕获。
import * as projects from '../app/projects/index.js';

export const projectsRoutes = [
  // ── 健康检查(免鉴权)──
  { m: 'GET', p: '/api/health', fn: projects.health, auth: false },
  { m: 'GET', p: '/health', fn: projects.healthPlain, auth: false },

  // ── 网络搜索支持(字面路径)──
  { m: 'GET', p: '/api/web-search-models/support', fn: projects.listWebSearchSupport, auth: true },

  // ── 项目 CRUD ──
  { m: 'GET', p: '/api/projects', fn: projects.listProjects, auth: true },
  { m: 'POST', p: '/api/projects', fn: projects.createProject, auth: true },

  // ── 技能(:pid/skills/* 字面子段,排在 :id 前)──
  { m: 'GET', p: '/api/projects/:pid/skills', fn: projects.listSkills, auth: true },
  { m: 'GET', p: '/api/projects/:pid/skills/enabled/list', fn: projects.listEnabledSkills, auth: true },
  { m: 'GET', p: '/api/projects/:pid/skills/:skillName', fn: projects.getSkillDetail, auth: true },

  // ── 当前设备上的项目 Source folders ──
  { m: 'GET', p: '/api/projects/:id/source-folders', fn: projects.getSourceFolders, auth: true },
  { m: 'PUT', p: '/api/projects/:id/source-folders', fn: projects.replaceSourceFolders, auth: true },

  // ── 项目 Git Worktree 管理 ──
  { m: 'GET', p: '/api/projects/:id/worktrees', fn: projects.listProjectWorktrees, auth: true },
  { m: 'POST', p: '/api/projects/:id/worktrees', fn: projects.createProjectWorktree, auth: true },
  { m: 'POST', p: '/api/projects/:id/worktrees/:worktreeId/activate', fn: projects.activateProjectWorktree, auth: true },
  { m: 'POST', p: '/api/projects/:id/worktrees/deactivate', fn: projects.deactivateProjectWorktrees, auth: true },
  { m: 'DELETE', p: '/api/projects/:id/worktrees/:worktreeId', fn: projects.removeProjectWorktree, auth: true },

  // ── 项目规则 ──
  { m: 'GET', p: '/api/projects/:pid/rules/:ruleType', fn: projects.getProjectRules, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/rules/:ruleType', fn: projects.updateProjectRules, auth: true },

  // ── 项目详情 / 删除(参数 :id 兜底,排在字面路由后)──
  { m: 'GET', p: '/api/projects/:id', fn: projects.getProject, auth: true },
  { m: 'PUT', p: '/api/projects/:id', fn: projects.updateProject, auth: true },
  { m: 'DELETE', p: '/api/projects/:id', fn: projects.deleteProject, auth: true },
];

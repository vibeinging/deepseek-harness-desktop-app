import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const EVAL_LAYERS = new Set([
  'service_integration',
  'app_integration',
  'ui_e2e',
  'model_eval',
  'reliability',
  'release',
]);

export const EVAL_RISKS = new Set(['P0', 'P1', 'P2']);
export const EVAL_INTERACTIONS = new Set(['none', 'api', 'app', 'cdp']);
export const EVAL_MODELS = new Set(['none', 'deterministic', 'real', 'optional', 'unspecified']);
export const EVAL_DATA_MODES = new Set(['none', 'synthetic', 'fixture', 'external', 'user', 'unspecified']);
export const EVAL_PLUGIN_SOURCES = new Set(['builtin', 'user', 'fixture']);
export const EVAL_PLUGIN_MOUNTS = new Set(['app', 'project']);
export const EVAL_FILE_SELECTIONS = new Set(['file_picker', 'folder_picker', 'prepared']);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function probability(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1 ? number : fallback;
}

function strings(value, fallback = []) {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function validTaskId(value) {
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(value);
}

function inferredMetadata(task) {
  const id = String(task?.id || 'legacy');
  const isAccuracy = id.startsWith('kdd-') || id.startsWith('func-');
  return {
    feature: isAccuracy ? 'ask-data.accuracy' : `legacy.${id}`,
    layer: isAccuracy ? 'model_eval' : 'app_integration',
    risk: 'P1',
    interaction: isAccuracy ? 'app' : 'api',
    model: isAccuracy ? 'real' : 'unspecified',
    data: id.startsWith('kdd-') ? 'external' : (id.startsWith('func-') ? 'fixture' : 'unspecified'),
    platforms: ['darwin', 'win32', 'linux'],
    timeoutMs: isAccuracy ? 900_000 : 600_000,
    repeats: 1,
    minPassRate: 1,
    requirements: [],
    tags: ['legacy'],
    criteria: [],
  };
}

function normalizeCriteria(value, taskId) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`Eval 任务 ${taskId} 的 criteria 必须是数组`);
  const seen = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Eval 任务 ${taskId} 的 criteria[${index}] 必须是对象`);
    const id = String(item.id || '').trim();
    const description = String(item.description || '').trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new Error(`Eval 任务 ${taskId} 的判分标准 id 无效: ${id || '(empty)'}`);
    if (seen.has(id)) throw new Error(`Eval 任务 ${taskId} 的判分标准重复: ${id}`);
    if (!description) throw new Error(`Eval 任务 ${taskId} 的判分标准 ${id} 缺少 description`);
    seen.add(id);
    return {
      id,
      description,
      required: item.required !== false,
      evidence: strings(item.evidence),
    };
  });
}

function normalizeScenario(value, criteria, taskId) {
  if (value == null) return { project: null, plugins: [], files: [], turns: [] };
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`Eval 任务 ${taskId} 的 scenario 必须是对象`);
  if (value.project != null && (typeof value.project !== 'object' || Array.isArray(value.project))) {
    throw new Error(`Eval 任务 ${taskId} 的 scenario.project 必须是对象`);
  }
  for (const field of ['plugins', 'files', 'turns']) {
    if (value[field] != null && !Array.isArray(value[field])) throw new Error(`Eval 任务 ${taskId} 的 scenario.${field} 必须是数组`);
  }

  const project = value.project == null
    ? null
    : {
        mode: validateEnum(String(value.project.mode || 'new'), new Set(['none', 'new', 'existing']), 'scenario.project.mode', taskId),
        name: String(value.project.name || '').trim(),
      };
  if (project && project.mode !== 'none' && !project.name) throw new Error(`Eval 任务 ${taskId} 的 scenario.project 缺少 name`);

  const pluginIds = new Set();
  const plugins = (Array.isArray(value.plugins) ? value.plugins : []).map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Eval 任务 ${taskId} 的 scenario.plugins[${index}] 必须是对象`);
    const id = String(item.id || '').trim();
    if (!id) throw new Error(`Eval 任务 ${taskId} 的 scenario.plugins[${index}] 缺少 id`);
    if (pluginIds.has(id)) throw new Error(`Eval 任务 ${taskId} 的 scenario Plugin 重复: ${id}`);
    pluginIds.add(id);
    return {
      id,
      source: validateEnum(String(item.source || 'builtin'), EVAL_PLUGIN_SOURCES, 'scenario.plugins.source', taskId),
      mount: validateEnum(String(item.mount || 'project'), EVAL_PLUGIN_MOUNTS, 'scenario.plugins.mount', taskId),
    };
  });

  const fileIds = new Set();
  const files = (Array.isArray(value.files) ? value.files : []).map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Eval 任务 ${taskId} 的 scenario.files[${index}] 必须是对象`);
    const id = String(item.id || '').trim();
    const path = String(item.path || '').trim();
    if (!id || !path) throw new Error(`Eval 任务 ${taskId} 的 scenario.files[${index}] 必须包含 id 和 path`);
    if (fileIds.has(id)) throw new Error(`Eval 任务 ${taskId} 的 scenario 文件重复: ${id}`);
    fileIds.add(id);
    return {
      id,
      path,
      selection: validateEnum(String(item.selection || 'prepared'), EVAL_FILE_SELECTIONS, 'scenario.files.selection', taskId),
      purpose: String(item.purpose || '').trim(),
    };
  });

  const criterionIds = new Set(criteria.map((item) => item.id));
  const turnIds = new Set();
  const resources = new Set([
    ...plugins.map((item) => `plugin:${item.id}`),
    ...files.map((item) => `file:${item.id}`),
  ]);
  const turns = (Array.isArray(value.turns) ? value.turns : []).map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`Eval 任务 ${taskId} 的 scenario.turns[${index}] 必须是对象`);
    const id = String(item.id || '').trim();
    const user = String(item.user || '').trim();
    if (!id || !user) throw new Error(`Eval 任务 ${taskId} 的 scenario.turns[${index}] 必须包含 id 和 user`);
    if (turnIds.has(id)) throw new Error(`Eval 任务 ${taskId} 的 scenario 轮次重复: ${id}`);
    turnIds.add(id);
    const uses = strings(item.uses);
    const linkedCriteria = strings(item.criteria);
    const unknownResources = uses.filter((ref) => !resources.has(ref));
    if (unknownResources.length) throw new Error(`Eval 任务 ${taskId} 的场景轮次 ${id} 引用了未知资源: ${unknownResources.join(', ')}`);
    const unknownCriteria = linkedCriteria.filter((ref) => !criterionIds.has(ref));
    if (unknownCriteria.length) throw new Error(`Eval 任务 ${taskId} 的场景轮次 ${id} 引用了未知判分标准: ${unknownCriteria.join(', ')}`);
    return { id, user, uses, criteria: linkedCriteria };
  });

  return { project, plugins, files, turns };
}

function validateEnum(value, allowed, field, taskId) {
  if (!allowed.has(value)) throw new Error(`Eval 任务 ${taskId} 的 ${field} 无效: ${value}`);
  return value;
}

function definitionHash(sourceFile) {
  if (!sourceFile) return '';
  try {
    return `sha256:${createHash('sha256').update(readFileSync(sourceFile)).digest('hex')}`;
  } catch {
    return '';
  }
}

export function normalizeEvalTask(task, { sourceFile = '' } = {}) {
  if (!task || typeof task !== 'object') throw new Error(`Eval 任务导出无效: ${sourceFile || '(unknown source)'}`);
  const id = String(task.id || '').trim();
  if (!validTaskId(id)) throw new Error(`Eval 任务 id 无效: ${id || '(empty)'} (${sourceFile})`);
  if (typeof task.run !== 'function') throw new Error(`Eval 任务 ${id} 缺少 run 函数`);

  const declared = !!task.eval;
  const defaults = inferredMetadata(task);
  const input = task.eval || {};
  const criteria = normalizeCriteria(input.criteria ?? defaults.criteria, id);
  const metadata = {
    feature: String(input.feature || defaults.feature).trim(),
    layer: validateEnum(String(input.layer || defaults.layer), EVAL_LAYERS, 'layer', id),
    risk: validateEnum(String(input.risk || defaults.risk), EVAL_RISKS, 'risk', id),
    interaction: validateEnum(String(input.interaction || defaults.interaction), EVAL_INTERACTIONS, 'interaction', id),
    model: validateEnum(String(input.model || defaults.model), EVAL_MODELS, 'model', id),
    data: validateEnum(String(input.data || defaults.data), EVAL_DATA_MODES, 'data', id),
    platforms: strings(input.platforms, defaults.platforms),
    timeoutMs: positiveInteger(input.timeoutMs, defaults.timeoutMs),
    repeats: positiveInteger(input.repeats, defaults.repeats),
    minPassRate: probability(input.minPassRate, defaults.minPassRate),
    requirements: strings(input.requirements, defaults.requirements),
    tags: strings(input.tags, defaults.tags),
    criteria,
    scenario: normalizeScenario(input.scenario, criteria, id),
    declared,
  };
  if (!metadata.feature) throw new Error(`Eval 任务 ${id} 缺少 feature`);
  if (!metadata.platforms.length) throw new Error(`Eval 任务 ${id} 至少声明一个 platform`);

  return {
    ...task,
    id,
    desc: String(task.desc || '').trim(),
    eval: metadata,
    source_file: sourceFile,
    definition_hash: definitionHash(sourceFile),
  };
}

export function validateEvalTaskCatalog(tasks) {
  const seen = new Map();
  for (const task of tasks) {
    if (seen.has(task.id)) throw new Error(`Eval 任务 id 重复: ${task.id} (${seen.get(task.id)} / ${task.source_file})`);
    seen.set(task.id, task.source_file || '(unknown)');
  }
  return tasks;
}

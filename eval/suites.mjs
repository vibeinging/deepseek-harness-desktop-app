export const EVAL_SUITES = Object.freeze({
  pr: {
    description: '提交门禁：隔离、确定性、不依赖外部模型',
    tags: ['pr'],
    blockedFails: true,
  },
  ui: {
    description: '真实 Electron 用户流程',
    tags: ['ui'],
    blockedFails: true,
  },
  'model-nightly': {
    description: '真实模型稳定性任务',
    tags: ['model-nightly'],
    blockedFails: true,
  },
  'dsh-alignment': {
    description: 'DSH 本地能力的真实模型闭环',
    tags: ['dsh-alignment'],
    blockedFails: true,
  },
  manual: {
    description: '全部任务，供显式本地运行',
    all: true,
    blockedFails: false,
  },
});

function matchesSuite(task, suite) {
  if (suite.all) return true;
  const tags = new Set(task.eval?.tags || []);
  return (suite.tags || []).some((tag) => tags.has(tag))
    || (suite.idPrefixes || []).some((prefix) => task.id.startsWith(prefix));
}

export function selectEvalTasks(tasks, { suiteName = 'pr', taskIds = [], legacyFilter = '' } = {}) {
  const suite = EVAL_SUITES[suiteName];
  if (!suite) throw new Error(`未知 Eval Suite: ${suiteName}。可选: ${Object.keys(EVAL_SUITES).join(', ')}`);
  const exactIds = new Set(taskIds);
  let selected = tasks.filter((task) => matchesSuite(task, suite));
  if (exactIds.size) selected = tasks.filter((task) => exactIds.has(task.id));
  if (legacyFilter) selected = selected.filter((task) => task.id.includes(legacyFilter));
  const missing = [...exactIds].filter((id) => !tasks.some((task) => task.id === id));
  if (missing.length) throw new Error(`找不到 Eval 任务: ${missing.join(', ')}`);
  if (!selected.length) throw new Error(`Eval 没有选中任务(suite=${suiteName}${legacyFilter ? `, filter=${legacyFilter}` : ''})`);
  return { suite, tasks: selected };
}

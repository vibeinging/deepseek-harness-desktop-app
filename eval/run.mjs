#!/usr/bin/env node
// dsh-work Eval 入口。默认运行隔离、确定性的 pr Suite；真实模型和外部数据集必须显式选择。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { openSession } from './lib/cdp.mjs';
import { makeDriver } from './lib/driver.mjs';
import { defaultConfiguredModelSourcePath, seedConfiguredModels } from './lib/configured-models.mjs';
import { runTasks, report, summarizeResults } from './lib/runner.mjs';
import { normalizeEvalTask, validateEvalTaskCatalog } from './task-schema.mjs';
import { EVAL_SUITES, selectEvalTasks } from './suites.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function requiredValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数`);
  return value;
}

export function parseEvalArgs(args = process.argv.slice(2)) {
  const options = {
    suiteName: 'pr',
    taskIds: [],
    legacyFilter: '',
    port: Number(process.env.CDP_PORT || 9333),
    reuseExisting: false,
    isolate: true,
    keepData: false,
    preserveFailureData: true,
    useConfiguredModels: false,
    list: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--suite') options.suiteName = requiredValue(args, index++, '--suite');
    else if (token === '--task') options.taskIds.push(requiredValue(args, index++, '--task'));
    else if (token === '--filter') {
      options.legacyFilter = requiredValue(args, index++, '--filter');
      options.suiteName = 'manual';
    } else if (token === '--all') options.suiteName = 'manual';
    else if (token === '--cdp-port') options.port = Number(requiredValue(args, index++, '--cdp-port'));
    else if (token === '--reuse-running-app') options.reuseExisting = true;
    else if (token === '--reuse-data') options.isolate = false;
    else if (token === '--use-configured-models') options.useConfiguredModels = true;
    else if (token === '--keep-data') options.keepData = true;
    else if (token === '--discard-failure-data') options.preserveFailureData = false;
    else if (token === '--list') options.list = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else if (!token.startsWith('--') && !options.legacyFilter) {
      options.legacyFilter = token;
      options.suiteName = 'manual';
    } else throw new Error(`未知 Eval 参数: ${token}`);
  }
  if (!Number.isInteger(options.port) || options.port <= 0) throw new Error(`CDP 端口无效: ${options.port}`);
  if (options.useConfiguredModels && (!options.isolate || options.reuseExisting)) {
    throw new Error('--use-configured-models 只允许用于新建的隔离 Eval，不能写入现有 App 或用户数据库');
  }
  return options;
}

function helpText() {
  return [
    '用法:',
    '  npm run eval                         # 隔离运行 pr Suite',
    '  npm run eval -- --suite ui            # 运行真实 UI Suite',
    '  npm run eval -- --task smoke           # 精确运行一个任务',
    '  npm run eval -- smoke                  # 兼容旧的模糊过滤',
    '  npm run eval -- --list                 # 列出任务和判分元数据',
    '  npm run eval -- --suite model-nightly --use-configured-models',
    '                                         # 只读复制当前模型配置到隔离测试库',
    '',
    '危险选项:',
    '  --reuse-running-app                    # 显式连接已有 Electron',
    '  --reuse-data                           # 显式关闭数据隔离',
  ].join('\n');
}

function gitValue(args, fallback = '') {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return fallback;
  }
}

function runManifest(options, selectedTasks) {
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const status = gitValue(['status', '--porcelain']);
  return {
    schema_version: 'eval_run.v2',
    suite: options.suiteName,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    app_version: packageJson.version || '',
    repository: {
      commit: gitValue(['rev-parse', 'HEAD']),
      tree: gitValue(['rev-parse', 'HEAD^{tree}']),
      dirty: Boolean(status),
    },
    isolation_requested: options.isolate,
    reuse_existing_requested: options.reuseExisting,
    configured_models_requested: options.useConfiguredModels,
    tasks: selectedTasks.map((task) => ({
      id: task.id,
      feature: task.eval.feature,
      layer: task.eval.layer,
      risk: task.eval.risk,
      interaction: task.eval.interaction,
      model: task.eval.model,
      data: task.eval.data,
      repeats: task.eval.repeats,
      min_pass_rate: task.eval.minPassRate,
      requirements: task.eval.requirements,
      criteria: task.eval.criteria,
      scenario: task.eval.scenario,
      metadata_declared: task.eval.declared,
      definition_hash: task.definition_hash,
    })),
  };
}

const options = parseEvalArgs();
if (options.help) {
  console.log(helpText());
  process.exit(0);
}

const tasksDir = path.join(__dirname, 'tasks');
const loadedTasks = [];
for (const file of readdirSync(tasksDir).filter((name) => name.endsWith('.task.mjs')).sort()) {
  const sourceFile = path.join(tasksDir, file);
  const module = await import(pathToFileURL(sourceFile).href);
  if (module.default) loadedTasks.push(normalizeEvalTask(module.default, { sourceFile }));
}
validateEvalTaskCatalog(loadedTasks);

if (options.list) {
  for (const task of loadedTasks) {
    console.log([
      task.id,
      task.eval.layer,
      task.eval.risk,
      task.eval.interaction,
      task.eval.model,
      task.eval.tags.join(','),
      task.eval.scenario.plugins.map((plugin) => plugin.id).join(',') || '-',
      task.eval.declared ? 'declared' : 'legacy',
    ].join('\t'));
  }
  process.exit(0);
}

const selection = selectEvalTasks(loadedTasks, options);
const selectedTasks = selection.tasks;
console.log(`加载 ${loadedTasks.length} 个任务；选择 ${selectedTasks.length} 个(suite=${options.suiteName})；连接 app(CDP :${options.port})…`);

const startedAt = new Date().toISOString();
const runId = startedAt.replace(/[:.]/g, '-');
const resultsDir = process.env.EVAL_REPORT_DIR || path.join(__dirname, 'results');
const reportSuffix = options.taskIds.length === 1
  ? options.taskIds[0]
  : (options.legacyFilter || options.suiteName);
const safeSuffix = String(reportSuffix).replace(/[^a-zA-Z0-9_-]/g, '_');
const reportFile = path.join(resultsDir, `${runId}-${safeSuffix}.json`);
const artifactsDir = path.join(resultsDir, `${runId}-${safeSuffix}-artifacts`);
mkdirSync(resultsDir, { recursive: true });

const manifest = runManifest(options, selectedTasks);
let sessionInfo = null;
function persistRun(results, status, error = null) {
  writeFileSync(reportFile, JSON.stringify({
    runId,
    startedAt,
    updatedAt: new Date().toISOString(),
    status,
    filter: options.legacyFilter || null,
    suite: options.suiteName,
    cdpPort: options.port,
    totalLoadedTasks: loadedTasks.length,
    selectedTasks: selectedTasks.length,
    completedTasks: results.length,
    manifest,
    runtime: sessionInfo,
    summary: summarizeResults(results),
    error,
    results,
  }, null, 2));
}

let session = null;
let ok = false;
let results = [];
let interrupting = false;
let finalStatus = 'running';
let finalError = null;

async function interrupt(signal) {
  if (interrupting) return;
  interrupting = true;
  persistRun(results, 'interrupted', signal);
  await session?.close?.({ preserveData: true }).catch(() => {});
  console.log(`\n报告: ${reportFile}`);
  process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.once('SIGINT', () => { void interrupt('SIGINT'); });
process.once('SIGTERM', () => { void interrupt('SIGTERM'); });

try {
  session = await openSession({
    port: options.port,
    reuseExisting: options.reuseExisting,
    isolate: options.isolate,
    keepData: options.keepData,
  });
  sessionInfo = session.info || null;
  const driver = makeDriver(session);
  await driver.login();
  if (options.useConfiguredModels) {
    const configuredModels = await seedConfiguredModels(driver.raw.api, {
      sourceDbPath: defaultConfiguredModelSourcePath(),
    });
    sessionInfo = { ...(sessionInfo || {}), configured_models: configuredModels };
    console.log(`已复制 ${configuredModels.count} 个当前模型到隔离测试库: ${configuredModels.models.map((item) => `${item.category}=${item.model_name}`).join(', ')}`);
  }
  results = await runTasks(driver, selectedTasks, {
    artifactsDir,
    environment: { manifest, runtime: sessionInfo },
    onResult: (_result, partialResults) => {
      results = partialResults;
      persistRun(partialResults, 'running');
    },
  });
  ok = report(results, { blockedFails: selection.suite.blockedFails });
  finalStatus = ok ? 'passed' : 'failed';
} catch (error) {
  const message = error?.stack || error?.message || String(error);
  console.error('eval 运行异常:', message);
  finalStatus = 'error';
  finalError = message;
} finally {
  await session?.close?.({
    preserveData: options.keepData || (!ok && options.preserveFailureData),
  }).catch(() => {});
  persistRun(results, finalStatus, finalError);
}

console.log(`报告: ${reportFile}`);
process.exit(ok ? 0 : 1);

export { EVAL_SUITES };

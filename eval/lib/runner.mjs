// Task runner + assertions + report. Task files only define assertions with assert.*, runner executes flow, collects results, and writes report.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export class EvalControlSignal extends Error {
  constructor(status, reason) {
    super(reason);
    this.name = 'EvalControlSignal';
    this.status = status;
  }
}

function checkMeta(options = {}) {
  if (typeof options === 'string') return { criterion: options };
  if (!options || typeof options !== 'object') return {};
  return {
    ...(options.criterion ? { criterion: String(options.criterion) } : {}),
    ...(options.evidence ? { evidence: options.evidence } : {}),
  };
}

export function makeAssert() {
  const checks = [];
  const metrics = [];
  const push = (ok, msg, options = {}, detail = null) => {
    checks.push({ ok: !!ok, msg, ...checkMeta(options), ...(detail ? { detail } : {}) });
  };
  const blockSqlText = (block) => {
    if (!block) return '';
    const parts = [block.type, block.title];
    const content = block.content;
    if (typeof content === 'string') parts.push(content);
    else if (content != null) {
      try { parts.push(JSON.stringify(content)); } catch { parts.push(String(content)); }
    }
    const metadata = block.metadata || {};
    for (const key of ['sql', 'query_sql', 'trace_input', 'trace_output', 'traceInput', 'traceOutput']) {
      if (metadata[key] != null) parts.push(String(metadata[key]));
    }
    return parts.filter(Boolean).join(' ');
  };
  return {
    ok(cond, msg, options = {}) { push(cond, msg, options); },
    eq(a, b, msg, options = {}) { push(a === b, `${msg}(期望 ${JSON.stringify(b)},实得 ${JSON.stringify(a)})`, options); },
    status(resp, expected, msg, options = {}) { push(resp?.status === expected, `${msg}(期望 ${expected},实得 ${resp?.status})`, options); },
    contains(blocks, sub, msg, options = {}) {
      const text = (blocks || []).map((b) => b.content).join(' ');
      push(text.includes(sub), `${msg}(含 "${sub}")`, options);
    },
    hasSql(blocks, msg, options = {}) {
      const ok = (blocks || []).some((b) => /\bSELECT\b/i.test(blockSqlText(b)) || /sql/i.test(b?.type || ''));
      push(ok, msg, options);
    },
    blockType(blocks, type, msg, options = {}) {
      const ok = (blocks || []).some((b) => new RegExp(type, 'i').test(b.type || ''));
      push(ok, msg, options);
    },
    blocked(reason) { throw new EvalControlSignal('blocked', String(reason || '前置条件不满足')); },
    skipped(reason) { throw new EvalControlSignal('skipped', String(reason || '当前 Suite 明确跳过')); },
    fail(msg, options = {}) { push(false, msg, options); },
    metric(name, value, unit = '') {
      metrics.push({ name: String(name), value: Number(value), unit: String(unit || '') });
    },

    /**
     * column_match assertion (KDD Cup official scorer).
     * predictedColumns / goldColumns: one value array per column, e.g. [[v1,v2,...], [v1,v2,...]]
     * score = recall - lambda * (extra_cols / pred_cols), recall = matched_gold / total_gold
     * task pass defaults to recall; leaderboard score uses weighted score by default.
     */
    columnsMatch(predictedColumns, goldColumns, msg, opts = {}) {
      const {
        extraColLambda = 0.3,
        caseSensitive = true,
        roundDecimals = 2,
        passMetric = 'recall',
        passThreshold = 1.0,
      } = opts;
      const result = scoreKddColumns(predictedColumns || [], goldColumns || [], { extraColLambda, caseSensitive, roundDecimals });
      const metricValue = Number(result[passMetric] ?? result.score ?? 0);
      const ok = metricValue >= passThreshold;
      const detail = result.unmatchedGold.length
        ? `未匹配 gold 列 ${JSON.stringify(result.goldSample)} vs 最接近 pred ${JSON.stringify(result.predSample)}`
        : '';
      push(
        ok,
        `${msg}(score=${result.score} recall=${result.recall} penalty=${result.extraColPenalty} ${passMetric}>=${passThreshold}${detail ? ' | ' + detail : ''})`,
        opts,
        { kind: 'column_match', passMetric, passThreshold, ...result },
      );
    },

    _checks: checks,
    _metrics: metrics,
  };
}

function finalizeCriteria(task, checks) {
  const criteria = task.eval?.criteria || [];
  if (!criteria.length) return;
  const declared = new Set(criteria.map((criterion) => criterion.id));
  for (const check of [...checks]) {
    if (check.criterion && !declared.has(check.criterion)) {
      checks.push({
        ok: false,
        msg: `使用了未声明的判分标准: ${check.criterion}`,
        criterion: check.criterion,
      });
    }
  }
  for (const criterion of criteria) {
    if (criterion.required === false) continue;
    if (!checks.some((check) => check.criterion === criterion.id)) {
      checks.push({
        ok: false,
        msg: `必需判分标准没有执行: ${criterion.id} — ${criterion.description}`,
        criterion: criterion.id,
      });
    }
  }
}

// ── KDD official scorer (replicates official column signature + recall/lambda formula) ──
function kddNormalize(v, caseSensitive, roundDecimals) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && (Number.isNaN(v) || !Number.isFinite(v))) return '';
  const s = String(v).trim();
  if (s === '' || /^(null|none|nan|nat|<na>)$/i.test(s)) return '';

  const rounded = roundDecimalStringHalfUp(s, roundDecimals);
  if (rounded !== null) return rounded;

  const percentNumber = normalizeTrailingPercentNumber(s, roundDecimals);
  if (percentNumber !== null) return percentNumber;

  const normalizedDateTime = normalizeDateTime(s);
  if (normalizedDateTime !== null) return normalizedDateTime;

  return caseSensitive ? s : s.toLowerCase();
}

function normalizeTrailingPercentNumber(raw, decimals) {
  const m = String(raw).trim().match(/^(.+?)\s*[％%]$/);
  if (!m) return null;
  return roundDecimalStringHalfUp(m[1].trim(), decimals);
}

function roundDecimalStringHalfUp(raw, decimals) {
  const s = String(raw).trim();
  const m = s.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!m) return null;

  const sign = m[1] === '-' ? '-' : '';
  const intPartRaw = m[2] || '0';
  const fracPartRaw = m[3] ?? m[4] ?? '';
  const exp = Number(m[5] || 0);
  let digits = intPartRaw + fracPartRaw;
  let decimalPos = intPartRaw.length + exp;

  if (decimalPos <= 0) {
    digits = '0'.repeat(-decimalPos) + digits;
    decimalPos = 0;
  } else if (decimalPos >= digits.length) {
    digits = digits + '0'.repeat(decimalPos - digits.length);
  }

  const whole = decimalPos > 0 ? digits.slice(0, decimalPos) : '0';
  const frac = decimalPos < digits.length ? digits.slice(decimalPos) : '';
  const keep = frac.slice(0, decimals).padEnd(decimals, '0');
  const next = frac[decimals] || '0';
  let scaled = BigInt((whole.replace(/^0+(?=\d)/, '') || '0') + keep);
  if (next >= '5') scaled += 1n;

  if (decimals === 0) {
    const out = scaled.toString();
    return sign && out !== '0' ? `-${out}` : out;
  }

  const scaledText = scaled.toString().padStart(decimals + 1, '0');
  const outWhole = scaledText.slice(0, -decimals).replace(/^0+(?=\d)/, '') || '0';
  const outFrac = scaledText.slice(-decimals);
  const isZero = /^0+$/.test(outWhole) && /^0+$/.test(outFrac);
  return sign && !isZero ? `-${outWhole}.${outFrac}` : `${outWhole}.${outFrac}`;
}

function normalizeDateTime(s) {
  const dateOnly = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2].padStart(2, '0')}-${dateOnly[3].padStart(2, '0')}`;

  const dateTime = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})([T\s].*)$/);
  if (!dateTime) return null;
  const padded = `${dateTime[1]}-${dateTime[2].padStart(2, '0')}-${dateTime[3].padStart(2, '0')}${dateTime[4]}`;
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(padded)) return padded;

  const d = new Date(padded);
  if (Number.isNaN(d.getTime())) return padded;
  return d.toISOString().replace('.000Z', 'Z');
}

function columnSignature(column, caseSensitive, roundDecimals) {
  const sig = {};
  for (const v of column) {
    const nv = kddNormalize(v, caseSensitive, roundDecimals);
    sig[nv] = (sig[nv] || 0) + 1;
  }
  return sig;
}

function signaturesEqual(a, b) {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}

export function scoreKddColumns(predCols, goldCols, { extraColLambda = 0.3, caseSensitive = true, roundDecimals = 2 } = {}) {
  if (!goldCols.length) {
    return {
      score: 1.0,
      recall: 1.0,
      extraColPenalty: 0.0,
      matchedCols: [],
      unmatchedGold: [],
      goldSample: {},
      predSample: {},
    };
  }
  if (!predCols.length) {
    const goldSample = {};
    goldCols.forEach((c, i) => goldSample[i] = c.slice(0, 5).map(v => kddNormalize(v, caseSensitive, roundDecimals)));
    return {
      score: 0.0,
      recall: 0.0,
      extraColPenalty: 0.0,
      matchedCols: [],
      unmatchedGold: goldCols.map((_, i) => i),
      goldSample,
      predSample: {},
    };
  }
  const goldSigs = goldCols.map(c => columnSignature(c, caseSensitive, roundDecimals));
  const predSigs = predCols.map(c => columnSignature(c, caseSensitive, roundDecimals));
  const usedPred = new Set();
  const matched = [];
  const unmatchedGold = [];
  const goldSample = {};
  const predSample = {};
  for (let gi = 0; gi < goldSigs.length; gi++) {
    let hit = -1;
    for (let pi = 0; pi < predSigs.length; pi++) {
      if (usedPred.has(pi)) continue;
      if (signaturesEqual(predSigs[pi], goldSigs[gi])) { hit = pi; break; }
    }
    if (hit >= 0) { matched.push([gi, hit]); usedPred.add(hit); }
    else {
      unmatchedGold.push(gi);
      goldSample[gi] = goldCols[gi].slice(0, 5).map(v => kddNormalize(v, caseSensitive, roundDecimals));
      // Find pred column with largest overlap
      let bestPi = -1, bestCommon = 0;
      for (let pi = 0; pi < predSigs.length; pi++) {
        let common = 0;
        for (const [k, cnt] of Object.entries(goldSigs[gi])) common += Math.min(cnt, predSigs[pi][k] || 0);
        if (common > bestCommon) { bestCommon = common; bestPi = pi; }
      }
      if (bestPi >= 0) predSample[gi] = predCols[bestPi].slice(0, 5).map(v => kddNormalize(v, caseSensitive, roundDecimals));
    }
  }
  const recall = matched.length / goldCols.length;
  const extraPred = predCols.length - matched.length;
  const penalty = predCols.length > 0 ? extraColLambda * (extraPred / predCols.length) : 0;
  const score = Math.max(0, Math.min(1, recall - penalty));
  return {
    score: Math.round(score * 10000) / 10000,
    recall: Math.round(recall * 10000) / 10000,
    extraColPenalty: Math.round(penalty * 10000) / 10000,
    matchedCols: matched,
    unmatchedGold,
    goldSample,
    predSample,
  };
}

let _fxSeq = 0;
export function writeFixture(name, content) {
  const p = path.join(tmpdir(), `dsh-eval-${++_fxSeq}-${name}`);
  writeFileSync(p, content);
  return p;
}

/**
 * Read KDD gold.csv and transpose into column vectors (one value array per column).
 * Align with Python pandas.read_csv defaults: first row as header (discarded), remaining rows as data, then transpose.
 * Skip AppleDouble ._* files and empty lines.
 */
export function loadGold(csvPath) {
  const text = readFileSync(csvPath, 'utf-8');
  const lines = text.trim().split(/\r?\n/).filter(l => l && !l.startsWith('._'));
  if (lines.length < 2) return []; // 只有表头或空 → 无数据列
  // Simple CSV parse with basic quote handling
  const parseLine = (line) => {
    const out = []; let cur = ''; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  // First row is header (dropped, matching pandas default); remaining rows are data
  const dataRows = lines.slice(1).map(parseLine);
  const ncol = Math.max(...dataRows.map(r => r.length));
  const cols = [];
  for (let c = 0; c < ncol; c++) cols.push(dataRows.map(r => r[c]));
  return cols;
}

function resultStatus(result) {
  if (result?.status) return result.status;
  return result?.pass ? 'passed' : 'failed';
}

function infrastructurePollutionMessage(pollution) {
  const changes = Array.isArray(pollution?.changes) ? pollution.changes : [];
  const modules = [...new Set(changes.map((change) => change?.module).filter(Boolean))];
  const suffix = modules.length ? `: ${modules.slice(0, 3).join(', ')}` : '';
  return `${pollution?.code || 'EVAL_INFRASTRUCTURE_POLLUTED'} renderer 在任务运行期间发生 HMR/source revision 变化${suffix}`;
}

async function captureFailureScreenshot(driver, artifactsDir, taskId, attempt) {
  if (!artifactsDir || !driver?.ui?.screenshot) return null;
  try {
    mkdirSync(artifactsDir, { recursive: true });
    const base64 = await driver.ui.screenshot();
    const safeId = String(taskId).replace(/[^a-zA-Z0-9_-]/g, '_');
    const file = path.join(artifactsDir, `${safeId}-attempt-${attempt}.png`);
    writeFileSync(file, Buffer.from(base64, 'base64'));
    return file;
  } catch {
    return null;
  }
}

async function runTaskAttempt(driver, task, attempt, { artifactsDir, environment } = {}) {
  const assert = makeAssert();
  const started = Date.now();
  const controller = new AbortController();
  let timer = null;
  let error = null;
  let reason = null;
  let details = null;
  let status = 'passed';
  let infrastructureCheckpoint = null;
  let infrastructurePollution = null;
  if (typeof driver?.raw?.infrastructureCheckpoint === 'function') {
    infrastructureCheckpoint = await driver.raw.infrastructureCheckpoint();
  }
  try {
    if (typeof task.preflight === 'function') {
      const prerequisite = await task.preflight({ driver, task, attempt, environment, signal: controller.signal });
      if (prerequisite === false || prerequisite?.ok === false) {
        throw new EvalControlSignal('blocked', prerequisite?.reason || '前置条件不满足');
      }
    }
    const timeoutMs = Number(task.eval?.timeoutMs || 600_000);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`任务总超时(${timeoutMs}ms)`));
      }, timeoutMs);
    });
    details = await Promise.race([
      Promise.resolve(task.run({
        driver,
        assert,
        writeFixture,
        loadGold,
        task,
        attempt,
        environment,
        signal: controller.signal,
      })),
      timeout,
    ]) || null;
    finalizeCriteria(task, assert._checks);
    if (assert._checks.some((check) => !check.ok)) status = 'failed';
  } catch (caught) {
    if (caught instanceof EvalControlSignal) {
      status = caught.status;
      reason = caught.message;
    } else {
      status = 'error';
      error = caught?.stack || caught?.message || String(caught);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (typeof driver?.raw?.infrastructurePollutionSince === 'function') {
    try {
      infrastructurePollution = await driver.raw.infrastructurePollutionSince(infrastructureCheckpoint);
    } catch (diagnosticError) {
      infrastructurePollution = {
        polluted: true,
        code: 'EVAL_INFRASTRUCTURE_MONITOR_FAILED',
        changes: [],
        monitor_error: diagnosticError?.message || String(diagnosticError),
      };
    }
  }
  if (infrastructurePollution?.polluted) {
    status = 'infra-polluted';
    reason = infrastructurePollutionMessage(infrastructurePollution);
    error = error || reason;
  }
  const screenshot = ['failed', 'error', 'infra-polluted'].includes(status)
    ? await captureFailureScreenshot(driver, artifactsDir, task.id, attempt)
    : null;
  return {
    attempt,
    status,
    pass: status === 'passed',
    ms: Date.now() - started,
    details,
    checks: assert._checks,
    metrics: assert._metrics,
    error,
    reason,
    infrastructure_pollution: infrastructurePollution?.polluted ? infrastructurePollution : null,
    artifacts: screenshot ? [{ type: 'screenshot', path: screenshot }] : [],
  };
}

export async function runTasks(driver, tasks, { filter, onResult, artifactsDir = '', environment = null } = {}) {
  const results = [];
  for (const task of tasks) {
    if (filter && !task.id.includes(filter)) continue;
    const started = Date.now();
    const attempts = [];
    const repeatCount = Number(task.eval?.repeats || 1);
    for (let attempt = 1; attempt <= repeatCount; attempt += 1) {
      const result = await runTaskAttempt(driver, task, attempt, { artifactsDir, environment });
      attempts.push(result);
      if (['blocked', 'skipped', 'infra-polluted'].includes(result.status)) break;
    }
    const executed = attempts.filter((item) => !['blocked', 'skipped', 'infra-polluted'].includes(item.status));
    const passedAttempts = executed.filter((item) => item.status === 'passed').length;
    const passRate = executed.length ? passedAttempts / executed.length : 0;
    let status = 'failed';
    if (attempts.some((item) => item.status === 'infra-polluted')) status = 'infra-polluted';
    else if (!executed.length) status = attempts.some((item) => item.status === 'blocked') ? 'blocked' : 'skipped';
    else if (passRate >= Number(task.eval?.minPassRate || 1)) status = 'passed';
    else if (executed.every((item) => item.status === 'error')) status = 'error';
    const result = {
      id: task.id,
      desc: task.desc,
      status,
      pass: status === 'passed',
      ms: Date.now() - started,
      pass_rate: passRate,
      metadata: task.eval || null,
      source_file: task.source_file || '',
      definition_hash: task.definition_hash || '',
      attempts,
      details: attempts.length === 1 ? attempts[0].details : attempts.map((item) => item.details),
      checks: attempts.flatMap((item) => item.checks.map((check) => ({ attempt: item.attempt, ...check }))),
      metrics: attempts.flatMap((item) => item.metrics.map((metric) => ({ attempt: item.attempt, ...metric }))),
      error: attempts.find((item) => item.error)?.error || null,
      reason: attempts.find((item) => item.reason)?.reason || null,
      infrastructure_pollution: attempts.find((item) => item.infrastructure_pollution)?.infrastructure_pollution || null,
      artifacts: attempts.flatMap((item) => item.artifacts),
    };
    results.push(result);
    await onResult?.(result, results);
  }
  return results;
}

export function report(results, { blockedFails = true } = {}) {
  console.log('\n══════ Eval 报告══════');
  const symbols = { passed: '✓', failed: '✗', blocked: '■', skipped: '○', error: '!', 'infra-polluted': '⚠' };
  for (const r of results) {
    const status = resultStatus(r);
    console.log(`${symbols[status] || '?'} ${r.id} [${status}] (${(r.ms / 1000).toFixed(1)}s)${r.desc ? ' — ' + r.desc : ''}`);
    if (r.details?.phases) {
      const preparation = Number(r.details.phases.offline_preparation_ms || 0);
      const query = Number(r.details.phases.online_query_ms || 0);
      console.log(`    · 离线准备 ${(preparation / 1000).toFixed(1)}s / 在线问数 ${(query / 1000).toFixed(1)}s`);
    }
    if (r.reason) console.log(`    · ${status}: ${r.reason}`);
    if (r.error) console.log(`    ⚠ 异常: ${r.error}`);
    for (const c of r.checks) console.log(`    ${c.ok ? '·' : '✗ FAIL'} ${c.msg}`);
    for (const artifact of r.artifacts || []) console.log(`    · 证据: ${artifact.path}`);
  }

  const summary = summarizeResults(results);
  if (summary.columnChecks.total) {
    console.log('\n列匹配汇总:');
    console.log(`  官方平均 score: ${summary.columnChecks.avgScore.toFixed(4)}`);
    console.log(`  平均 recall: ${summary.columnChecks.avgRecall.toFixed(4)}`);
    console.log(`  gold 覆盖率(recall=1): ${summary.columnChecks.goldCovered}/${summary.columnChecks.total} (${summary.columnChecks.goldCoverageRate.toFixed(2)}%)`);
    console.log(`  满分率(score=1): ${summary.columnChecks.perfect}/${summary.columnChecks.total} (${summary.columnChecks.perfectRate.toFixed(2)}%)`);
    if (summary.columnChecks.syntheticZero) console.log(`  未进入列判分的 KDD 任务按 0 计入: ${summary.columnChecks.syntheticZero}`);
  }

  console.log(`\n结果: passed=${summary.passed} failed=${summary.failed} blocked=${summary.blocked} skipped=${summary.skipped} error=${summary.error} infra-polluted=${summary.infraPolluted}\n`);
  if (!results.length) return false;
  return summary.failed === 0 && summary.error === 0 && summary.infraPolluted === 0 && (!blockedFails || summary.blocked === 0);
}

export function summarizeResults(results) {
  const total = results.length;
  const statuses = results.map(resultStatus);
  const passed = statuses.filter((status) => status === 'passed').length;
  const failed = statuses.filter((status) => status === 'failed').length;
  const blocked = statuses.filter((status) => status === 'blocked').length;
  const skipped = statuses.filter((status) => status === 'skipped').length;
  const error = statuses.filter((status) => status === 'error').length;
  const infraPolluted = statuses.filter((status) => status === 'infra-polluted').length;
  const executed = passed + failed + error;
  const columnChecks = collectColumnChecks(results);
  const n = columnChecks.length;
  const avgScore = n ? columnChecks.reduce((s, c) => s + Number(c.detail.score || 0), 0) / n : 0;
  const avgRecall = n ? columnChecks.reduce((s, c) => s + Number(c.detail.recall || 0), 0) / n : 0;
  const goldCovered = columnChecks.filter((c) => Number(c.detail.recall || 0) >= 1).length;
  const perfect = columnChecks.filter((c) => Number(c.detail.score || 0) >= 1).length;
  const syntheticZero = columnChecks.filter((c) => c.detail.syntheticZero).length;
  return {
    total,
    passed,
    failed,
    blocked,
    skipped,
    error,
    infraPolluted,
    executed,
    passRate: executed ? passed / executed : 0,
    columnChecks: {
      total: n,
      avgScore,
      avgRecall,
      goldCovered,
      goldCoverageRate: n ? goldCovered / n * 100 : 0,
      perfect,
      perfectRate: n ? perfect / n * 100 : 0,
      syntheticZero,
    },
  };
}

function collectColumnChecks(results) {
  const columnChecks = [];
  for (const r of results) {
    const matches = (r.checks || []).filter((c) => c.detail?.kind === 'column_match');
    if (matches.length) {
      columnChecks.push(...matches);
    } else if (/^kdd-/.test(r.id)) {
      columnChecks.push({
        ok: false,
        detail: {
          kind: 'column_match',
          score: 0,
          recall: 0,
          extraColPenalty: 0,
          syntheticZero: true,
        },
      });
    }
  }
  return columnChecks;
}

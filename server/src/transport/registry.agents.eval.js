// Destructive diagnostic routes used only by the isolated Eval runtime.
// They are deliberately kept out of the normal desktop route list.
import * as agents from '../app/agents/index.js';

export const agentEvalRoutes = [
  { m: 'POST', p: '/api/agents/recovery/diagnostics/prepare', fn: agents.prepareRunRecoveryDiagnostic, auth: true },
  { m: 'POST', p: '/api/agents/recovery/diagnostics/prepare-running-exit', fn: agents.prepareRunningElectronExitDiagnostic, auth: true },
  { m: 'POST', p: '/api/agents/retention/diagnostics/prepare', fn: agents.prepareRunRetentionDiagnostic, auth: true },
  { m: 'POST', p: '/api/agents/retention/diagnostics/cleanup', fn: agents.cleanupRunRetentionDiagnostic, auth: true },
  { m: 'POST', p: '/api/agents/run-writeback/diagnostics', fn: agents.diagnoseRunWriteback, auth: true },
  { m: 'POST', p: '/api/agents/query-evidence/diagnostics', fn: agents.diagnoseQueryExecutionEvidence, auth: true },
  { m: 'POST', p: '/api/agents/query-evidence/diagnostics/replace-rows', fn: agents.replaceQueryEvidenceDiagnosticRows, auth: true },
];

export function agentEvalRoutesEnabled(env = process.env) {
  const mode = String(env?.DSH_EVAL_MODE || '').trim();
  return Boolean(mode) && mode !== '0' && mode !== 'false';
}

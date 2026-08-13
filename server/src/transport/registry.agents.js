// Agent 运行、恢复、证据和诊断接口。
import * as agents from '../app/agents/index.js';

export const agentsRoutes = [
  { m: 'GET', p: '/api/agent/settings/instructions', fn: agents.getAppInstructions, auth: true },
  { m: 'PUT', p: '/api/agent/settings/instructions', fn: agents.updateAppInstructions, auth: true },
  { m: 'GET', p: '/api/agents/runtime', fn: agents.getAgentRuntimeStatus, auth: true },
  { m: 'POST', p: '/api/agents/runtime/probe', fn: agents.probeAgentRuntime, auth: true },
  { m: 'GET', p: '/api/agents/projects/:pid/runs', fn: agents.listAgentRuns, auth: true },
  { m: 'GET', p: '/api/agents/runs/:runId', fn: agents.getAgentRun, auth: true },
  { m: 'GET', p: '/api/agents/runs/:runId/subagents/:threadId', fn: agents.getAgentSubagentThread, auth: true },
  { m: 'GET', p: '/api/agents/runs/:runId/environment', fn: agents.getAgentRunEnvironment, auth: true },
  { m: 'GET', p: '/api/agents/runs/:runId/deletion-impact', fn: agents.getAgentRunDeletionImpact, auth: true },
  { m: 'GET', p: '/api/agents/runs/:runId/evidence-bundles', fn: agents.listRunEvidenceBundles, auth: true },
  { m: 'GET', p: '/api/agents/evidence-bundles/:bundleId', fn: agents.getRunEvidenceBundle, auth: true },
  { m: 'POST', p: '/api/agents/evidence-bundles/:bundleId/rerun', fn: agents.rerunRunEvidenceBundle, auth: true },
  { m: 'POST', p: '/api/agents/runs/:runId/stop', fn: agents.stopAgentRun, auth: true },
  { m: 'POST', p: '/api/agents/runs/:runId/subagents/:threadId/stop', fn: agents.stopAgentSubagentThread, auth: true },
  { m: 'POST', p: '/api/agents/runs/:runId/recover', fn: agents.prepareAgentRunRecovery, auth: true },
  { m: 'POST', p: '/api/agents/runs/:runId/archive', fn: agents.archiveAgentRun, auth: true },
  { m: 'DELETE', p: '/api/agents/runs/:runId', fn: agents.deleteAgentRun, auth: true },
];

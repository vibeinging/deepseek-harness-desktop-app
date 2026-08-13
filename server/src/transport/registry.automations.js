import * as automations from '../app/agents/automations.js';
import * as executor from '../app/agents/automation_executor.js';

export const automationRoutes = [
  { m: 'GET', p: '/api/agents/projects/:pid/automations', fn: automations.listAgentAutomations, auth: true },
  { m: 'POST', p: '/api/agents/projects/:pid/automations', fn: automations.createAgentAutomation, auth: true },
  { m: 'GET', p: '/api/agents/automations/:automationId', fn: automations.getAgentAutomation, auth: true },
  { m: 'PUT', p: '/api/agents/automations/:automationId', fn: automations.updateAgentAutomation, auth: true },
  { m: 'POST', p: '/api/agents/automations/:automationId/status', fn: automations.setAgentAutomationStatus, auth: true },
  { m: 'POST', p: '/api/agents/automations/:automationId/run', fn: executor.runAgentAutomation, auth: true },
  { m: 'DELETE', p: '/api/agents/automations/:automationId', fn: automations.deleteAgentAutomation, auth: true },
  { m: 'GET', p: '/api/agents/projects/:pid/automation-runs', fn: executor.listAgentAutomationRuns, auth: true },
  { m: 'POST', p: '/api/agents/projects/:pid/automation-runs/read-all', fn: executor.markAllAgentAutomationRunsRead, auth: true },
  { m: 'POST', p: '/api/agents/automation-runs/:runId/read', fn: executor.markAgentAutomationRunRead, auth: true },
  { m: 'POST', p: '/api/agents/projects/:pid/automation-events', fn: automations.publishAgentAutomationEvent, auth: true },
];

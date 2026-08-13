// Main route registry: aggregates sub-registries (registry.<domain>.js).
// When adding a domain migration, add one import and one spread entry here.
import { unstructuredRoutes } from './registry.unstructured.js';
import { dashboardRoutes } from './registry.dashboard.js';
import { sessionRoutes } from './registry.session.js';
import { agentsRoutes } from './registry.agents.js';
import { agentEvalRoutes, agentEvalRoutesEnabled } from './registry.agents.eval.js';
import { datasourceRoutes } from './registry.datasource.js';
import { structuredRoutes } from './registry.structured.js';
import { businessRoutes } from './registry.business.js';
import { projectsRoutes } from './registry.projects.js';
import { modelsRoutes } from './registry.models.js';
import { readsRoutes } from './registry.reads.js';
import { chatRoutes } from './registry.chat.js';
import { agentActionRoutes } from './registry.agent_actions.js';
import { imRoutes } from './registry.im.js';
import { traceRoutes } from './registry.traces.js';
import { automationRoutes } from './registry.automations.js';

export const ROUTES = [
  // Batch 1
  ...unstructuredRoutes,
  ...dashboardRoutes,
  // Batch 2
  ...sessionRoutes,
  ...agentsRoutes,
  ...(agentEvalRoutesEnabled() ? agentEvalRoutes : []),
  ...datasourceRoutes,
  ...structuredRoutes,
  // Batch 3
  ...businessRoutes,
  // Batch 4
  ...projectsRoutes,
  ...modelsRoutes,
  ...readsRoutes,
  ...imRoutes,
  ...traceRoutes,
  ...automationRoutes,
  // Batch 5 (streaming)
  ...agentActionRoutes,
  ...chatRoutes,
];

// agent actions 域路由表:跨 chat / workflow / future agent 的控制面动作。
import * as pendingActions from "../app/agent_actions/pending_actions.js";

export const agentActionRoutes = [
  // Only durable automation/background actions are resolved here. Native
  // in-turn interactions are hydrated from session messages and stay on the
  // native Agent turn endpoints.
  {
    m: "POST",
    p: "/api/agent/projects/:pid/sessions/:sid/pending-actions/:requestId/resolve",
    fn: pendingActions.resolveAgentPendingAction,
    auth: true,
    stream: true,
  },
];

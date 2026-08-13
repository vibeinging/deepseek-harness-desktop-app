import * as traces from "../app/traces/yitrace_service.js";

export const traceRoutes = [
  { m: "GET", p: "/api/agent/projects/:pid/sessions/:sid/traces", fn: traces.listSessionTraces, auth: true },
];

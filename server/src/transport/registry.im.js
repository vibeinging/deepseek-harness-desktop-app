// IM Gateway routes: provider-neutral remote control core.
import * as im from "../app/im/gateway.js";
import * as imAdapters from "../app/im/adapters.js";
import * as imWorker from "../app/im/worker_supervisor.js";

export const imRoutes = [
  { m: "GET", p: "/api/im/connectors", fn: im.listConnectors, auth: true },
  { m: "POST", p: "/api/im/connectors", fn: im.createConnector, auth: true },
  { m: "PUT", p: "/api/im/connectors/:cid", fn: im.updateConnector, auth: true },
  { m: "DELETE", p: "/api/im/connectors/:cid", fn: im.deleteConnector, auth: true },
  { m: "POST", p: "/api/im/connectors/:cid/identities", fn: im.upsertIdentity, auth: true },
  { m: "GET", p: "/api/im/connectors/:cid/contexts", fn: im.listContexts, auth: true },
  { m: "POST", p: "/api/im/connectors/:cid/worker/start", fn: imWorker.startConnectorWorker, auth: true },
  { m: "POST", p: "/api/im/connectors/:cid/worker/stop", fn: imWorker.stopConnectorWorker, auth: true },
  { m: "GET", p: "/api/im/connectors/:cid/worker/status", fn: imWorker.getConnectorWorkerStatus, auth: true },
  { m: "POST", p: "/api/im/connectors/:cid/worker/heartbeat", fn: imWorker.heartbeatConnectorWorker, auth: true },
  { m: "POST", p: "/api/im/connectors/:cid/events", fn: im.handleConnectorEvent, auth: true },
  { m: "POST", p: "/api/im/connectors/:cid/feishu/events", fn: imAdapters.handleFeishuEvent, auth: true },
  { m: "POST", p: "/api/im/connectors/:cid/wecom/events", fn: imAdapters.handleWecomEvent, auth: true },
  { m: "POST", p: "/api/im/fake/events", fn: im.handleFakeEvent, auth: true },
];

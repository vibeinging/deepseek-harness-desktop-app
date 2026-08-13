// Intelligent analytics desktop backend: bootstrap and transport layer startup.
// App uses process IPC; development and eval/CI can additionally enable loopback HTTP.
import "./config/network.js";
import { closeDatabase, query, queryOne } from "./db.js";
import { ensureLocalIdentity } from "./app/local_identity.js";
import { closeYiTraceDb } from "./app/traces/yitrace_service.js";
import { registerDbModelConfigProvider } from "./engine/core/model_config_provider.js";
import { cleanupExpiredRunFacts, recoverStaleAgentRuns } from "./engine/agents/run_fact_store.js";
import { rebuildInterruptedTurnsFromNative } from "./engine/agent_kernel/native_turn_history_recovery.js";
import { resumeRecoverableAgentRuns } from "./app/agents/run_recovery_scheduler.js";
import { dshRuntimeEnabled } from "./engine/dsh_runtime/source_locator.js";
import { publishDshModelSettingsChanged } from "./engine/dsh_runtime/model_settings_events.js";
import { startAgentRunRetentionScheduler } from "./app/agents/run_retention_scheduler.js";
import { startAgentAutomationScheduler } from "./app/agents/automation_scheduler.js";
import { reconcileAgentAutomationRuns, syncAgentAutomationRun } from "./app/agents/automation_executor.js";

function resolveServerPort() {
  const configured = Number(process.env.DSH_SERVER_PORT || process.env.SERVER_PORT);
  return Number.isInteger(configured) && configured >= 1 && configured <= 65535 ? configured : 52838;
}

const PORT = resolveServerPort();
const DOCUMENT_DRAIN_TIMEOUT_MS = Number(process.env.DSH_DOCUMENT_DRAIN_TIMEOUT_MS || 5_000);

let shuttingDown = false;
let httpServer = null;
let abortAllIpcStreams = () => {};
let stopMetadataSyncScheduler = () => {};
let recoveryAbortController = null;
let runRetentionScheduler = null;
let automationScheduler = null;
let dshMuxSubscriber = null;

function sendLifecycle(event, detail = {}) {
  if (typeof process.send !== "function" || !process.connected) return;
  try {
    process.send({ type: "lifecycle", event, ...detail });
  } catch {
    // Main process has already exited.
  }
}

function closeHttpServer() {
  const server = httpServer;
  httpServer = null;
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function shutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  sendLifecycle("stopping", { reason });

  try { abortAllIpcStreams(); } catch { /* ignore */ }
  try { stopMetadataSyncScheduler(); } catch { /* ignore */ }
  try { recoveryAbortController?.abort(); } catch { /* ignore */ }
  try { runRetentionScheduler?.stop(); } catch { /* ignore */ }
  try { automationScheduler?.stop(); } catch { /* ignore */ }
  try { dshMuxSubscriber?.stop(); } catch { /* ignore */ }

  const tasks = [
    closeHttpServer(),
    import("./engine/dsh_runtime/client.js")
      .then(({ closeDshRuntimeClient }) => closeDshRuntimeClient()),
    import("./engine/dsh_runtime/temporary_runtime.js")
      .then(({ closeTemporaryDshRuntimes }) => closeTemporaryDshRuntimes()),
    import("./engine/agent_kernel/agent_runtime.js")
      .then(({ stopAgentRuntime }) => stopAgentRuntime()),
    import("./engine/datasources/unstructured/document_processing_service.js")
      .then(({ drainDocumentProcessingQueue }) => drainDocumentProcessingQueue(DOCUMENT_DRAIN_TIMEOUT_MS)),
    closeYiTraceDb(),
  ];
  const results = await Promise.allSettled(tasks);
  for (const result of results) {
    if (result.status === "rejected") console.warn("[shutdown] 资源关闭失败:", result.reason?.message || result.reason);
  }

  try {
    closeDatabase();
  } catch (error) {
      console.warn("[shutdown] Failed to close local database:", error?.message || error);
    exitCode = exitCode || 1;
  }

  sendLifecycle("shutdown-complete", { reason, exitCode });
  setImmediate(() => process.exit(exitCode));
}

process.on("SIGTERM", () => { void shutdown("SIGTERM", 0); });
process.on("SIGINT", () => { void shutdown("SIGINT", 0); });
process.on("disconnect", () => { void shutdown("disconnect", 0); });
process.on("unhandledRejection", (error) => {
  console.error("[unhandledRejection]", error?.stack || error?.message || error);
  void shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (error) => {
  console.error("[uncaughtException]", error?.stack || error?.message || error);
  void shutdown("uncaughtException", 1);
});

async function migrateApiFormat() {
  try {
    await query(`ALTER TABLE llm_models ADD COLUMN api_format TEXT DEFAULT 'chat_completions'`);
    console.info("[migrate] llm_models.api_format 列已补齐");
  } catch (error) {
    if (!String(error?.message || error).toLowerCase().includes("duplicate column")) throw error;
  }
}

async function startIpcTransport() {
  if (typeof process.send !== "function") return;
  const ipc = await import("./transport/ipc_server.js");
  abortAllIpcStreams = ipc.abortAllIpcStreams;
  process.on("message", (msg) => {
    if (msg?.type === "lifecycle" && msg.event === "shutdown") {
      void shutdown("parent-request", 0);
      return;
    }
    if (!msg || msg.id == null || shuttingDown) return;
    if (msg.type === "abort") {
      ipc.abortIpcStream(msg.id);
      return;
    }
    ipc.handleIpcMessage(msg, (reply) => {
      if (typeof process.send !== "function" || !process.connected) return;
      try { process.send(reply); } catch { /* main 退出 */ }
    });
  });
  console.log("🟢 desktop server ready on process IPC channel");
}

async function startHttpTransport() {
  if (typeof process.send === "function" && process.env.DSH_TCP !== "1") return;
  const { startHttpServer } = await import("./transport/http_server.js");
  httpServer = startHttpServer(PORT);
}

async function startBackgroundServices() {
  const [{ resumePendingDocuments }, sync] = await Promise.all([
    import("./engine/datasources/unstructured/document_processing_service.js"),
    import("./app/datasource/sync_settings.js"),
  ]);
  stopMetadataSyncScheduler = sync.stopMetadataSyncScheduler;
  await resumePendingDocuments();
  sync.startMetadataSyncScheduler();
}

async function start() {
  registerDbModelConfigProvider({ queryOne });
  await migrateApiFormat();
  await ensureLocalIdentity({ query });
  const recoveredRuns = await recoverStaleAgentRuns(
    { query, queryOne },
    { includeUnexpiredLeases: true },
  ).catch((error) => {
    console.warn("[startup] Agent 运行恢复检查失败:", error?.message || error);
    return [];
  });
  if (recoveredRuns.length) {
    console.info(`[startup] Agent 运行恢复检查完成: ${recoveredRuns.length} 个未结束运行`);
  }
  await reconcileAgentAutomationRuns({ query, queryOne }).catch((error) => {
    console.warn("[startup] 自动化运行收件箱同步失败:", error?.message || error);
  });
  const retention = await cleanupExpiredRunFacts({ query, queryOne }).catch((error) => {
    console.warn("[startup] Agent 运行记录清理失败:", error?.message || error);
    return null;
  });
  if (retention?.failed_runs?.length) {
    console.warn(`[startup] ${retention.failed_runs.length} 个过期运行目录清理失败`);
  }
  await startIpcTransport();
  await startHttpTransport();
  await startBackgroundServices();
  runRetentionScheduler = startAgentRunRetentionScheduler({ query, queryOne });
  automationScheduler = startAgentAutomationScheduler({ query, queryOne });
  sendLifecycle("ready", {
    pid: process.pid,
    node: process.version,
    arch: process.arch,
    httpPort: process.env.DSH_TCP === "1" || typeof process.send !== "function" ? PORT : null,
  });
  const recoverableIds = recoveredRuns
    .filter((run) => run.status === "recovering")
    .map((run) => run.run_id);
  const interruptedIds = recoveredRuns
    .filter((run) => run.status === "interrupted")
    .map((run) => run.run_id);
  if (interruptedIds.length) {
    setImmediate(() => {
      void rebuildInterruptedTurnsFromNative(
        { query, queryOne },
        { runIds: interruptedIds },
      ).then((results) => {
        const rebuilt = results.filter((result) => result.status === "rebuilt").length;
        if (rebuilt) console.info(`[startup] Native Thread 历史重建完成: ${rebuilt} 个运行`);
      }).catch((error) => {
        console.warn("[startup] Native Thread 历史重建失败:", error?.message || error);
      });
    });
  }
  if (recoverableIds.length) {
    recoveryAbortController = new AbortController();
    setImmediate(() => {
      void resumeRecoverableAgentRuns(
        { query, queryOne },
        { runIds: recoverableIds, signal: recoveryAbortController.signal },
      ).then((results) => {
        console.info(`[startup] Agent 自动恢复完成: ${results.length} 个运行`);
        return Promise.allSettled(recoverableIds.map((runId) => syncAgentAutomationRun({ query, queryOne }, runId)));
      }).catch((error) => {
        console.warn("[startup] Agent 自动恢复失败:", error?.message || error);
      });
    });
  }

  // DSH resident mux baseline subscriber: mount a Turn-independent listener so
  // pending approval/question frames replayed by DSH on mux-stream open are
  // restored into pendingDecisions after a refresh or server restart.
  if (dshRuntimeEnabled()) {
    setImmediate(() => {
      void (async () => {
        try {
          const { getDshRuntimeClient } = await import("./engine/dsh_runtime/client.js");
          const { ensureDshWorkspaceSession } = await import("./engine/dsh_runtime/session_attachment.js");
          const { recoverMissingDshSessionCwds } = await import("./engine/dsh_runtime/session_binding.js");
          const { pendingDecisions } = await import("./app/chat/agent_misc.js");
          const { createMuxBaselineSubscriber, createApprovalRegistrar, createQuestionRegistrar } = await import("./engine/dsh_runtime/mux_baseline_subscriber.js");
          const {
            applyDshMuxFrame,
            bindDshSessionState,
            listDshSessionBindings,
            markDshStreamError,
            resolveDshSessionIdentity,
          } = await import("./engine/dsh_runtime/session_state.js");
          const client = getDshRuntimeClient();
          const dshSessions = await query(
            "SELECT id, project_id, created_by, session_config FROM sessions WHERE deleted_at IS NULL AND session_config::text LIKE '%dsh_runtime_session_id%'",
          ).catch(() => []);
          for (const row of dshSessions) {
            try {
              const config = typeof row.session_config === "string" ? JSON.parse(row.session_config) : row.session_config;
              const dshSessionId = String(config?.dsh_runtime_session_id || "").trim();
              if (!dshSessionId) continue;
              bindDshSessionState({
                dshSessionId,
                userId: String(row.created_by || "").trim(),
                projectId: String(row.project_id || "").trim(),
                appSessionId: String(row.id || "").trim(),
                cwd: String(config?.dsh_runtime_cwd || "").trim() || null,
              });
            } catch (error) {
              console.error("[startup] DSH session identity binding failed:", error?.message || error);
            }
          }
          const resolveIdentity = (dshSessionId) => resolveDshSessionIdentity(dshSessionId);
          const syncArchivedSessions = (archivedSessionIds) => {
            const archived = new Set(Array.isArray(archivedSessionIds) ? archivedSessionIds.map(String) : []);
            for (const identity of listDshSessionBindings()) {
              const status = archived.has(identity.dshSessionId) ? "archived" : "active";
              void query(
                "UPDATE sessions SET status=$1,updated_at=now() WHERE id=$2 AND deleted_at IS NULL AND status<>$1",
                [status, identity.appSessionId],
              ).catch((error) => console.error("[startup] DSH archive projection sync failed:", error?.message || error));
            }
          };
          const approvalRegistrar = createApprovalRegistrar({
            pendingDecisions, client, resolveIdentity,
            createBlock: (payload) => ({ id: payload.approvalId, type: "confirm", content: "DSH 审批（恢复）" }),
          });
          const questionRegistrar = createQuestionRegistrar({
            pendingDecisions, client, resolveIdentity,
            createBlock: (payload) => ({ id: "recovered-question", type: "user_input", content: JSON.stringify(payload.questions || []) }),
          });
          try {
            await client.start();
            const cwdRecovery = await recoverMissingDshSessionCwds(
              { query, queryOne },
              client,
              dshSessions,
            );
            if (cwdRecovery.recovered) {
              console.info(`[startup] 从 DSH Session 元数据恢复 ${cwdRecovery.recovered} 条 cwd 绑定`);
            }
            for (const dshSessionId of cwdRecovery.unresolved) {
              console.warn(`[startup] DSH session ${dshSessionId} 没有可恢复的固定 cwd，保留只读历史`);
            }
          } catch (error) {
            console.warn("[startup] DSH cwd 绑定恢复失败:", error?.code || error?.message || error);
          }
          dshMuxSubscriber = createMuxBaselineSubscriber({
            client,
            isPending: (key) => pendingDecisions.has(key),
            registerPendingApproval: approvalRegistrar,
            registerPendingQuestion: questionRegistrar,
            applyStateFrame: (frame) => {
              const state = applyDshMuxFrame(frame);
              const payload = frame?.payload;
              if (state?.appSessionId && payload?.type === "session/projection" && payload.key === "title" && typeof payload.value === "string") {
                void query(
                  "UPDATE sessions SET title=$1,updated_at=now() WHERE id=$2 AND deleted_at IS NULL",
                  [payload.value, state.appSessionId],
                ).catch((error) => console.error("[startup] DSH title projection sync failed:", error?.message || error));
              }
              return state;
            },
            applyHostFrame: (frame) => {
              publishDshModelSettingsChanged(frame?.payload);
              if (frame?.payload?.type === "host/archived-sessions-changed") {
                syncArchivedSessions(frame.payload.archivedSessionIds);
              }
            },
            resolvePendingApproval: (approvalId) => { if (approvalId) pendingDecisions.delete(approvalId); },
            resolvePendingQuestion: (rpcId) => { if (rpcId) pendingDecisions.delete(rpcId); },
            markStreamError: markDshStreamError,
          });
          await dshMuxSubscriber.start();
          // Resume all DSH-bound sessions so ApiProxy re-attaches and the mux
          // baseline replays their pending approval/question frames. Identity
          // was bound before opening the stream, so replay can never outrun it.
          let resumedDshSessions = 0;
          for (const row of dshSessions) {
            try {
              const config = typeof row.session_config === "string" ? JSON.parse(row.session_config) : row.session_config;
              const dshSid = String(config?.dsh_runtime_session_id || "").trim();
              if (!dshSid) continue;
              const identity = {
                userId: String(row.created_by || "").trim(),
                projectId: String(row.project_id || "").trim(),
                appSessionId: String(row.id || "").trim(),
                cwd: String(config?.dsh_runtime_cwd || "").trim() || null,
              };
              bindDshSessionState({ dshSessionId: dshSid, ...identity });
              if (!identity.cwd) {
                console.warn(`[startup] DSH session ${dshSid} 缺少保存的 cwd，跳过自动挂接`);
                continue;
              }
              await ensureDshWorkspaceSession(client, { sessionId: dshSid, cwd: identity.cwd });
              resumedDshSessions += 1;
            } catch (error) {
              console.error("[startup] DSH session 自动挂接失败:", error?.code || error?.message || error);
            }
          }
          const workspaceBaseline = await client.request("workspace.list", {}).catch((error) => {
            console.error("[startup] DSH workspace baseline load failed:", error?.message || error);
            return null;
          });
          if (workspaceBaseline) syncArchivedSessions(workspaceBaseline.archivedSessionIds);
          console.info(`[startup] DSH mux baseline subscriber mounted, resumed ${resumedDshSessions}/${dshSessions.length} DSH session(s)`);
        } catch (error) {
          console.warn("[startup] DSH mux baseline subscriber failed:", error?.message || error);
        }
      })();
    });
  }
}

start().catch((error) => {
  console.error("[startup] Server 启动失败:", error?.stack || error?.message || error);
  sendLifecycle("startup-error", { error: error?.message || String(error) });
  void shutdown("startup-error", 1);
});

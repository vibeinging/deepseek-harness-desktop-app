// High-level app driver: wraps real app operations (prepare workspace, create project,
// import data, bind business sources, run query to final blocks) into reusable APIs.
// Everything runs in the real renderer via CDP -> window.electronAPI (ipc) -> process channel -> registry use case. No HTTP.
// Task files should only use these high-level actions for assertions and avoid CDP/ipc internals.

import { makeUiDriver } from './ui-driver.mjs';

const DEFAULT_STREAM_TIMEOUT_MS = 360000;
const TERMINAL_CONVERSATION_TURN_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const DEFAULT_CLIENT_CAPABILITIES = Object.freeze({
  surface: 'desktop',
  projectChatMemory: true,
  globalChatMemory: true,
  renderMarkdown: true,
  renderChart: true,
  pageDataResult: true,
  openLocalFile: true,
  reviewWorkspaceDiff: true,
  mutateWorkspace: true,
  downloadArtifact: true,
});

/** A stopped send button is only a UI signal; runtime and Turn state must also be terminal. */
export function isConversationTurnComplete(state, { capturedRunning = false } = {}) {
  if (!capturedRunning || !state || state.busy === true || state.runtimeRunning === true) return false;
  return TERMINAL_CONVERSATION_TURN_STATUSES.has(String(state.turnStatus || '').trim().toLowerCase());
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function buildAgentRequestBody(body = {}) {
  return {
    input: Array.isArray(body.input)
      ? body.input
      : [{ type: 'text', text: String(body.message || body.question || body.content || '') }],
    approvalMode: body.approval || 'ask',
    clientCapabilities: {
      ...DEFAULT_CLIENT_CAPABILITIES,
      ...(body.clientCapabilities && typeof body.clientCapabilities === 'object' ? body.clientCapabilities : {}),
    },
    ...(body.skill ? { skill: body.skill } : {}),
    ...(Array.isArray(body.skills) ? { skills: body.skills } : {}),
    ...(body.mode ? { mode: body.mode } : {}),
    ...(body.collaborationMode ? { collaborationMode: body.collaborationMode } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.effort ? { effort: body.effort } : {}),
    ...(body.summary ? { summary: body.summary } : {}),
    ...(body.verbosity ? { verbosity: body.verbosity } : {}),
    ...(body.searchMode ? { searchMode: body.searchMode } : {}),
    ...(Array.isArray(body.attachments) ? { attachments: body.attachments } : {}),
  };
}

export function makeDriver(session) {
  const ev = session.evalJs;
  const ui = makeUiDriver(session);
  // Send local API requests from the renderer.
  const api = (method, url, body) =>
    ev(
      `return await window.electronAPI.apiRequest({method:${JSON.stringify(method)},url:${JSON.stringify(url)},` +
        `headers:{'Content-Type':'application/json'},` +
        `body:${body != null ? JSON.stringify(JSON.stringify(body)) : 'null'}})`,
    );

  const activateProject = async (projectOrId) => {
    let project = typeof projectOrId === 'object' ? projectOrId : null;
    if (!project?.id) {
      const pid = String(projectOrId || '');
      if (!pid) return;
      const detail = await api('GET', `/api/projects/${pid}`).catch(() => null);
      project = detail?.json?.data;
    }
    if (!project?.id) return;

    await ev(`
      const project = ${JSON.stringify(project)};
      const { useProjectStore } = await import('/src/store/project.ts');
      const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus.ts');
      const store = useProjectStore.getState();
      const projects = store.projects || [];
      if (!projects.some(p => p.id === project.id)) {
        useProjectStore.setState({ projects: [project, ...projects] });
      }
      useProjectStore.getState().setCurrentProject(project);
      eventBus.emit(EVENT_TYPES.REFRESH_HISTORY);
    `).catch(() => {});
  };

  const notifySessionCreated = async (sid, question = '') => {
    if (!sid) return;
    await ev(`
      const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus.ts');
      eventBus.emit(EVENT_TYPES.NEW_session_CREATED, {
        sessionId: ${JSON.stringify(sid)},
        question: ${JSON.stringify(question || '')},
      });
      eventBus.emit(EVENT_TYPES.REFRESH_HISTORY);
    `).catch(() => {});
  };

  // Drive real frontend subscribeStream and reuse Renderer reducer to collect final blocks.
  // Keep eval and UI on one turn/item interpretation rule set.
  const streamBlocks = (url, body, {
    timeoutMs = DEFAULT_STREAM_TIMEOUT_MS,
    autoApprove = false,
    autoResolveUserInput = false,
    interruptOnItemType = null,
    interruptThreadId = null,
  } = {}) => {
    const safeTimeoutMs = positiveInt(timeoutMs, DEFAULT_STREAM_TIMEOUT_MS);
    return ev(`
      const { subscribeStream } = await import('/src/utils/api-stream.ts');
      const { createAPIURL } = await import('/src/utils/url-helper.ts');
      const { reduceStreamEvent } = await import('/src/views/agent/stream/reducer.ts');
      const { parseSseJsonLine } = await import('/src/views/agent/stream/streamAdapter.ts');
      const blocks = new Map(); const events = []; let raw = 0;
      const approvalRequests = [];
      const approvalErrorsDuringStream = [];
      const approvedToolCallIds = new Set();
      const completedApprovalToolCallIds = new Set();
      const userInputRequests = [];
      const userInputErrorsDuringStream = [];
      const resolvedUserInputIds = new Set();
      const interruptRequests = [];
      const interruptErrorsDuringStream = [];
      let interruptRequested = false;
      const timeoutMs = ${safeTimeoutMs};
      const autoApprove = ${autoApprove === true};
      const autoResolveUserInput = ${autoResolveUserInput === true};
      const interruptOnItemType = ${JSON.stringify(interruptOnItemType || '')};
      const interruptThreadId = ${JSON.stringify(interruptThreadId || '')};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const req = { url: createAPIURL(${JSON.stringify(url)}), method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Language': 'zh-CN' },
        body: JSON.stringify(${JSON.stringify(body)}),
        signal: controller.signal };
      const handleLine = (line) => {
          const e = parseSseJsonLine(line); if (!e) return;
          raw++;
          const item = e.payload?.item || null;
          const isItemStarted = e.type === 'item/started' || String(e.type || '').endsWith('/item/started');
          const isItemCompleted = e.type === 'item/completed' || String(e.type || '').endsWith('/item/completed');
          const approvalToolCallId = item?.type === 'approval'
            ? String(item.toolCallId || item.tool_call_id || e.item_id || item.id || '').replace(/^confirm:/, '')
            : '';
          let toolResultSummary = null;
          if (item?.type === 'dynamicToolCall' && item.result) {
            try {
              const parsed = typeof item.result === 'string' ? JSON.parse(item.result) : item.result;
              toolResultSummary = {
                success: parsed?.success ?? null,
                status: parsed?.status || null,
                embedding_status: parsed?.embedding?.status || null,
                step_statuses: parsed?.steps && typeof parsed.steps === 'object'
                  ? Object.fromEntries(Object.entries(parsed.steps).map(([name, step]) => [name, step?.status || null]))
                  : null,
              };
            } catch {}
          }
          events.push({
            type: e.type,
            thread_id: e.thread_id || null,
            turn_id: e.turn_id || null,
            item_id: e.item_id || null,
            seq: e.seq ?? null,
            item_type: item?.type || null,
            skill_name: item?.type === 'skill' ? item.name || null : null,
            tool_name: item?.type === 'dynamicToolCall' ? item.tool || null : null,
            tool_result_summary: toolResultSummary,
            tool_call_id: item?.toolCallId || item?.tool_call_id || approvalToolCallId || null,
            status: e.payload?.turn?.status || e.payload?.status || item?.status || null,
          });
          if (
            interruptOnItemType && interruptThreadId && !interruptRequested && isItemStarted
            && item?.type === interruptOnItemType && e.turn_id
          ) {
            interruptRequested = true;
            interruptRequests.push((async () => {
              const response = await window.electronAPI.apiRequest({
                method: 'POST',
                url: '/api/agent/threads/' + encodeURIComponent(interruptThreadId) +
                  '/turns/' + encodeURIComponent(e.turn_id) + '/interrupt',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
              });
              if (!(response?.status >= 200 && response?.status < 300)) {
                throw new Error('停止任务失败: HTTP ' + String(response?.status || 0));
              }
              return response?.json?.data || null;
            })().catch((error) => {
              interruptErrorsDuringStream.push(String(error?.message || error || 'interrupt request failed'));
              return null;
            }));
          }
          if (
            isItemCompleted &&
            item?.type === 'approval' &&
            approvalToolCallId &&
            (item.status === 'approved' || item.approved === true)
          ) {
            completedApprovalToolCallIds.add(approvalToolCallId);
          }
          if (
            autoApprove &&
            (isItemStarted || isItemCompleted) &&
            item?.type === 'approval' &&
            item.status !== 'approved' &&
            item.status !== 'rejected' &&
            item.approved == null &&
            approvalToolCallId &&
            !approvedToolCallIds.has(approvalToolCallId)
          ) {
            approvedToolCallIds.add(approvalToolCallId);
            const approvalPromise = (async () => {
              const approvalRequest = item.approvalRequest || item.approval_request || {};
              if (
                approvalRequest.deferred === true &&
                approvalRequest.request_id &&
                approvalRequest.run_id &&
                approvalRequest.project_id &&
                approvalRequest.session_id
              ) {
                const response = await window.electronAPI.apiRequest({
                  method: 'POST',
                  url: '/api/agent/projects/' + encodeURIComponent(approvalRequest.project_id) +
                    '/sessions/' + encodeURIComponent(approvalRequest.session_id) +
                    '/pending-actions/' + encodeURIComponent(approvalRequest.request_id) + '/resolve',
                  headers: { 'Content-Type': 'application/json', 'Accept-Language': 'zh-CN' },
                  body: JSON.stringify({
                    action_type: 'approval',
                    approved: true,
                    value: 'approved',
                    run_id: approvalRequest.run_id,
                    resume_handle: approvalRequest.resume_handle || null,
                    approval: 'ask',
                    mode: 'workspace',
                  }),
                });
                if (!(response?.status >= 200 && response?.status < 300)) {
                  throw new Error('持久化审批恢复失败: HTTP ' + String(response?.status || 0));
                }
                for (const nestedLine of String(response?.body || '').split(/\\r?\\n/)) handleLine(nestedLine);
                return;
              }
              if (!approvalRequest.threadId || !approvalRequest.turnId || !approvalRequest.itemId) {
                throw new Error('批准请求缺少 threadId / turnId / itemId');
              }
              const response = await window.electronAPI.apiRequest({
                method: 'POST',
                url: '/api/agent/runtime-threads/' + encodeURIComponent(approvalRequest.threadId) +
                  '/turns/' + encodeURIComponent(approvalRequest.turnId) +
                  '/items/' + encodeURIComponent(approvalRequest.itemId) + '/approval',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision: 'accept' }),
              });
              if (!(response?.status >= 200 && response?.status < 300)) {
                throw new Error('批准失败: HTTP ' + String(response?.status || 0));
              }
            })().catch((error) => {
              approvalErrorsDuringStream.push(String(error?.message || error || 'approval request failed'));
              controller.abort();
            });
            approvalRequests.push(approvalPromise);
          }
          const userInputId = item?.type === 'userInput'
            ? String(item.request_id || item.itemId || e.item_id || item.id || '').replace(/^user_input:/, '')
            : '';
          if (
            autoResolveUserInput &&
            (isItemStarted || isItemCompleted) &&
            item?.type === 'userInput' &&
            item.status !== 'answered' &&
            userInputId &&
            !resolvedUserInputIds.has(userInputId)
          ) {
            resolvedUserInputIds.add(userInputId);
            const userInputPromise = (async () => {
              const threadId = item.threadId || e.thread_id;
              const turnId = item.turnId || e.turn_id;
              const itemId = item.itemId || e.item_id || userInputId;
              const questions = Array.isArray(item.questions) ? item.questions : [];
              const answers = Object.fromEntries(questions.map((question) => {
                const first = Array.isArray(question.options) ? question.options[0] : null;
                const value = first?.label || first?.value || '按推荐选项继续';
                return [String(question.id || ''), { answers: [String(value)] }];
              }).filter(([questionId]) => questionId));
              if (!threadId || !turnId || !itemId || !Object.keys(answers).length) {
                throw new Error('自动回答缺少 threadId / turnId / itemId / questions');
              }
              const response = await window.electronAPI.apiRequest({
                method: 'POST',
                url: '/api/agent/runtime-threads/' + encodeURIComponent(threadId) +
                  '/turns/' + encodeURIComponent(turnId) +
                  '/items/' + encodeURIComponent(itemId) + '/user-input',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ answers }),
              });
              if (!(response?.status >= 200 && response?.status < 300)) {
                throw new Error('自动回答失败: HTTP ' + String(response?.status || 0));
              }
            })().catch((error) => {
              userInputErrorsDuringStream.push(String(error?.message || error || 'user input request failed'));
              controller.abort();
            });
            userInputRequests.push(userInputPromise);
          }
          const patch = reduceStreamEvent(e);
          const block = patch?.block;
          if (!block?.id) return;
          const previous = blocks.get(block.id) || { content: '' };
          const content = block.content == null ? '' : String(block.content);
          blocks.set(block.id, {
            ...previous,
            ...block,
            content: block.metadata?.mode === 'append' ? String(previous.content || '') + content : content,
          });
      };
      try {
        await subscribeStream(req, handleLine);
      } catch (err) {
        if (approvalErrorsDuringStream.length || userInputErrorsDuringStream.length) {
          throw new Error([
            approvalErrorsDuringStream.length ? '自动批准失败: ' + approvalErrorsDuringStream.join('; ') : '',
            userInputErrorsDuringStream.length ? '自动回答失败: ' + userInputErrorsDuringStream.join('; ') : '',
          ].filter(Boolean).join('; '));
        }
        if (controller.signal.aborted) {
          const approvalDiagnostics = events
            .filter((event) => event.item_type === 'approval')
            .map((event) => ({
              type: event.type,
              status: event.status,
              item_id: event.item_id,
              tool_call_id: event.tool_call_id,
            }));
          throw new Error(
            '流式请求超时(' + timeoutMs + 'ms): ' + ${JSON.stringify(url)} +
            '；批准事件=' + JSON.stringify(approvalDiagnostics) +
            '，自动批准=' + String(approvedToolCallIds.size)
          );
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
      const approvalErrors = [...approvalErrorsDuringStream];
      for (let cursor = 0; cursor < approvalRequests.length; cursor++) {
        try {
          await approvalRequests[cursor];
        } catch (error) {
          approvalErrors.push(String(error?.message || error || 'approval request failed'));
        }
      }
      for (let cursor = 0; cursor < userInputRequests.length; cursor++) {
        try {
          await userInputRequests[cursor];
        } catch (error) {
          userInputErrorsDuringStream.push(String(error?.message || error || 'user input request failed'));
        }
      }
      const interruptResults = [];
      for (let cursor = 0; cursor < interruptRequests.length; cursor++) {
        const result = await interruptRequests[cursor];
        if (result) interruptResults.push(result);
      }
      return {
        raw,
        events,
        autoApprovedToolCallIds: [...approvedToolCallIds],
        approvalErrors,
        autoResolvedUserInputIds: [...resolvedUserInputIds],
        userInputErrors: [...userInputErrorsDuringStream],
        interruptResults,
        interruptErrors: [...interruptErrorsDuringStream],
        blocks: [...blocks.values()].map(b => ({ id: b.id, type: b.type, title: b.title, content: b.content || '', metadata: b.metadata || {} })).filter(b => b.content),
      };
    `, { timeoutMs: safeTimeoutMs + 10000 });
  };

  const sleepInPage = (ms) => ev(`await new Promise(r=>setTimeout(r, ${Number(ms) || 0}))`, { timeoutMs: (Number(ms) || 0) + 1000 });

  const poll = async (fn, { timeoutMs = 30000, intervalMs = 500, label = 'condition' } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() <= deadline) {
      try {
        const value = await fn();
        if (value) return value;
      } catch (err) {
        lastError = err;
      }
      await sleepInPage(intervalMs);
    }
    throw new Error(`等待超时: ${label}${lastError ? ` (${lastError.message || lastError})` : ''}`);
  };

  const parseArray = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  const parseDataSourceBindings = (payload) => {
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    const sourceTypes = {
      database_connections: 'database_connection',
      structured_data_sources: 'structured_data_source',
      unstructured_data_sources: 'unstructured_data_source',
      web_search_models: 'web_search_model',
    };
    return Object.entries(sourceTypes).flatMap(([key, sourceType]) => {
      const items = Array.isArray(payload[key]) ? payload[key] : [];
      return items.map((item) => ({ ...item, source_type: item.source_type || sourceType, source_id: item.source_id || item.id }));
    });
  };

  const projectStoreCurrent = () =>
    ev(`
      const { useProjectStore } = await import('/src/store/project.ts');
      return useProjectStore.getState().currentProject || null;
    `).catch(() => null);

  const listProjects = async () => {
    const list = await api('GET', '/api/projects?per_page=100');
    return list.json?.data?.items || list.json?.data || [];
  };

  const findProjectByName = async (name) => {
    const items = await listProjects();
    return items.find((p) => p.name === name) || null;
  };

  const selectProjectInUi = async (project) => {
    await activateProject(project);
    await poll(
      async () => {
        const cur = await projectStoreCurrent();
        return cur?.id === project.id ? cur : null;
      },
      { timeoutMs: 15000, label: `当前项目 ${project.name}` },
    );
    await ui.goto('/agent');
    await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15000 }).catch(() => {});
    await ev(`
      const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus.ts');
      eventBus.emit(EVENT_TYPES.REFRESH_HISTORY);
    `).catch(() => {});
  };

  const createProjectInUi = async (name) => {
    await api('POST', '/api/projects', { name, description: `eval project ${name}` });
    const project = await poll(
      async () => findProjectByName(name),
      { timeoutMs: 20000, label: `创建项目 ${name}` },
    );
    await activateProject(project);
    await poll(
      async () => {
        const cur = await projectStoreCurrent();
        return cur?.id === project.id ? cur : null;
      },
      { timeoutMs: 15000, label: `进入项目 ${name}` },
    );
    await ui.goto('/agent');
    await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15000 }).catch(() => {});
    return project;
  };

  const firstEmbeddingModelName = () =>
    ev(`
      const { embeddingModelsReq } = await import('/src/api/models.ts');
      const res = await embeddingModelsReq();
      const payload = res?.data;
      const list = Array.isArray(payload) ? payload : payload?.items || payload?.data || [];
      const first = Array.isArray(list) ? list[0] : null;
      return first ? String(first.name || first.model_name || '') : '';
    `).catch(() => '');

  const createStructuredDataSource = async (pid, dsName) => {
    await activateProject(pid);
    const existing = await api('GET', `/api/projects/${pid}/structured-datasources`).catch(() => null);
    const existingItems = existing?.json?.data?.items || existing?.json?.data || [];
    const found = existingItems.find((item) => item.name === dsName);
    if (found?.id) return found.id;

    const embedding = await firstEmbeddingModelName();
    const body = {
      name: dsName,
      description: `eval structured datasource ${dsName}`,
    };
    if (embedding) body.embedding_model_name = embedding;
    const created = await api('POST', `/api/projects/${pid}/structured-datasources`, body);
    const row = created?.json?.data;
    if (!row?.id) throw new Error('创建结构化数据源失败: ' + JSON.stringify(created?.json).slice(0, 160));
    return row.id;
  };

  const createUnstructuredDataSource = async (pid, name) => {
    await activateProject(pid);
    const existing = await api('GET', `/api/projects/${pid}/unstructured-datasources`).catch(() => null);
    const existingItems = existing?.json?.data?.items || existing?.json?.data || [];
    const found = existingItems.find((item) => item.name === name);
    if (found?.id) return found.id;

    const embedding = await firstEmbeddingModelName();
    const body = {
      name,
      description: `eval unstructured datasource ${name}`,
    };
    if (embedding) body.embedding_model_name = embedding;
    const created = await api('POST', `/api/projects/${pid}/unstructured-datasources`, body);
    const row = created?.json?.data;
    if (!row?.id) throw new Error('创建非结构化数据源失败: ' + JSON.stringify(created?.json).slice(0, 160));
    return row.id;
  };

  const readMessages = async (pid, sid) => {
    const mr = await api('GET', `/api/projects/${pid}/sessions/${sid}/messages`);
    const data = mr.json?.data;
    return Array.isArray(data) ? data : (data?.messages || data?.items || []);
  };

  const normalizeBlocks = (items) =>
    parseArray(items).map((b) => ({
      id: b.id || b.content_id,
      type: b.type || b.content_type || b.display_type,
      title: b.title,
      content: b.content == null ? '' : (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)),
      display_type: b.display_type,
      metadata: b.metadata || {},
    })).filter((b) => b.content);

  const lastAssistantBlocks = (messages) => {
    const assistant = messages.filter((m) => m.role === 'assistant').pop();
    if (!assistant) return [];
    return normalizeBlocks(assistant.content_items);
  };

  const withExtractedColumns = async (pid, sid, output = {}) => {
    let columns = extractColumnsFromBlocks(output.blocks || []);
    if (!columns.length && sid) {
      const messages = await readMessages(pid, sid).catch(() => []);
      columns = extractColumnsFromBlocks(lastAssistantBlocks(messages));
    }
    return { ...output, sid, columns };
  };

  const waitForAssistantResult = async (pid, sid, { minAssistantCount = 1, timeoutMs = 180000 } = {}) => {
    return poll(
      async () => {
        const messages = await readMessages(pid, sid).catch(() => []);
        const assistants = messages.filter((m) => m.role === 'assistant');
        if (assistants.length < minAssistantCount) return null;
        const blocks = lastAssistantBlocks(messages);
        return blocks.length ? { raw: messages.length, blocks } : null;
      },
      { timeoutMs, intervalMs: 1000, label: `会话 ${sid} assistant 结果` },
    );
  };

  const ensureAgentPage = async () => {
    await ui.goto('/agent');
    await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15000 }).catch(() => {});
  };

  const createQuerySession = async (pid, question) => {
    await activateProject(pid);
    await ensureAgentPage();
    const session = await api('POST', `/api/projects/${pid}/sessions`, {
      source_type: 'agent',
      source_id: pid,
      action_type: 'agentic_chat',
      title: String(question || '').slice(0, 50) || 'eval',
      description: question,
    });
    const sid = session.json?.data?.id || session.json?.data?.session_id;
    if (!sid) throw new Error('创建问数会话失败: ' + JSON.stringify(session.json).slice(0, 180));
    return sid;
  };

  const runQueryTurn = async (pid, sid, question, { minAssistantCount = 1, timeoutMs = DEFAULT_STREAM_TIMEOUT_MS } = {}) => {
    const out = await streamBlocks(
      `/api/agent/projects/${pid}/threads/${sid}/turns`,
      agentRequestBody({
        message: question,
        skill: 'query-project-data',
      }),
      { timeoutMs },
    );
    if (out.blocks?.length) return out;
    return waitForAssistantResult(pid, sid, { minAssistantCount });
  };

  const agentRequestBody = buildAgentRequestBody;

  return {
    ui,
    raw: {
      api,
      streamBlocks,
      ev,
      cdp: session.cdp,
      onCdpEvent: session.onEvent,
      activateProject,
      isConversationTurnComplete,
      infrastructureCheckpoint: session.infrastructureCheckpoint,
      infrastructurePollutionSince: session.infrastructurePollutionSince,
    },

    /** Compatibility alias for legacy eval task call names. App runs in local single-user mode and no longer performs login. */
    async login() {
      const health = await api('GET', '/api/health');
      if (!health?.json?.data?.ok) throw new Error('本地服务未就绪');
      // Isolated eval homes always start without browser storage. Keep product
      // onboarding covered by its dedicated UI test, and unblock functional
      // tasks through the same visible close action a user can take.
      await ev(`
        localStorage.setItem('dsh:onboarding:completed:v1', 'true');
        return true;
      `);
      if (await ui.exists('[aria-labelledby="dsh-onboarding-title"]')) {
        await ui.clickText('跳过', { selector: 'button', exact: true, timeout: 5000 });
        await ui.waitUntil(
          `() => !document.querySelector('[aria-labelledby="dsh-onboarding-title"]')`,
          { timeout: 5000, label: '功能测试已关闭首次引导' },
        );
      }
      return true;
    },

    /**
     * Get or create project (reuse by name). Same task should reuse the same project each run to avoid workspace growth.
     * First find existing project by name (not deleted); if found, clean old data sources and return it, otherwise create new.
     */
    async ensureProject(name) {
      const existing = await findProjectByName(name);
      if (existing) {
        // Clean old data sources to avoid import conflicts.
        await this._cleanDataSources(existing.id).catch(() => {});
        await selectProjectInUi(existing);
        return existing.id;
      }
      // Create new project
      return this.createProject(name);
    },

    /** Prepare project record only, without navigating frontend pages. Suitable for config-only model/integration evals. */
    async ensureProjectRecord(name) {
      const existing = await findProjectByName(name);
      if (existing?.id) return existing.id;
      const created = await api('POST', '/api/projects', { name, description: `eval project ${name}` });
      const row = created?.json?.data;
      if (row?.id) return row.id;
      const project = await poll(
        async () => findProjectByName(name),
        { timeoutMs: 20000, label: `创建项目记录 ${name}` },
      );
      return project.id;
    },

    /** Clean data source bindings under project (structured/db/unstructured) so imports start from a clean state. */
    async _cleanDataSources(pid) {
      // Soft-delete old data-source bindings (business_data_sources).
      const ds = await api('GET', `/api/projects/${pid}/data-sources`).catch(() => null);
      const bindings = parseDataSourceBindings(ds?.json?.data);
      for (const b of bindings) {
        const st = b.source_type || '';
        const si = b.source_id || b.id || '';
        await api('DELETE', `/api/projects/${pid}/data-sources`, { source_type: st, source_id: si }).catch(() => {});
      }
    },

    async createProject(name) {
      const project = await createProjectInUi(name);
      return project.id;
    },

    /**
     * Import a structured file to project. Backend process auto-binds datasource to project
     * (business_data_sources.project_id), so query can run right after import with no extra business steps.
     * fixturePath must be a backend-readable local absolute path.
     * Returns { dsid, connId, table }.
     */
    async importTable(pid, fixturePath, {
      dsName = 'eval-ds',
      preparationMode = 'schema',
      prepareProjectData = false,
      extraNotes = '',
    } = {}) {
      const dsid = await createStructuredDataSource(pid, dsName);
      const paths = Array.isArray(fixturePath) ? fixturePath : [fixturePath];

      const created = await api('POST', `/api/projects/${pid}/structured-documents/create`, {
        data_source_id: dsid,
        file_paths: paths,
      });
      const createdDocs = created?.json?.data?.created_documents || [];
      const documentIds = createdDocs.map((d) => d.document_id).filter(Boolean);
      const processBody = {
        data_source_id: dsid,
        // 完整准备由下面的显式、可等待流程执行，避免后台准备与在线问数并发。
        preparation_mode: prepareProjectData ? 'none' : preparationMode,
      };
      if (documentIds.length) processBody.document_ids = documentIds;
      const processed = await api('POST', `/api/projects/${pid}/structured-documents/process`, processBody);
      const failed = (processed?.json?.data?.processed || []).filter((d) => /failed/i.test(d.status || ''));
      if (failed.length) {
        throw new Error(`结构化导入失败: ${failed.map((d) => d.error || d.document_id).join(', ')}`);
      }

      let connId = processed?.json?.data?.database_connection_id;
      if (!connId) {
        const detail = await poll(
          async () => {
            const ds = await api('GET', `/api/projects/${pid}/structured-datasources/${dsid}`).catch(() => null);
            return ds?.json?.data?.database_connection_id ? ds.json.data : null;
          },
          { timeoutMs: 60000, intervalMs: 1000, label: `结构化导入 ${dsName}` },
        );
        connId = detail.database_connection_id;
      }
      const tableRows = await poll(
        async () => {
          const tr = await api('GET', `/api/projects/${pid}/databases/${connId}/tables?per_page=100`).catch(() => null);
          const items = tr?.json?.data?.items || [];
          return items.length ? items : null;
        },
        { timeoutMs: 60000, intervalMs: 1000, label: `结构化表 ${dsName}` },
      );
      const tables = tableRows.map((t) => t.table_name || t.name).filter(Boolean);
      if (prepareProjectData) {
        const tableIds = tableRows.map((tableRow) => tableRow.id).filter(Boolean);
        const descriptionBody = {
          connection_id: connId,
          table_ids: tableIds,
          only_pending: false,
          ...(extraNotes ? { extra_notes: extraNotes } : {}),
        };
        await api('POST', `/api/projects/${pid}/databases/generate-columns-descriptions`, descriptionBody);
        await api(
          'POST',
          `/api/projects/${pid}/databases/${connId}/tables/batch_sync_example_values`,
          { table_ids: tableIds, limit: 3 },
        );
        await api(
          'POST',
          `/api/projects/${pid}/databases/${connId}/tables/store-vectors`,
          { table_ids: tableIds, only_pending: false },
        ).catch(() => {});
      }
      const table = tables[0];
      return { dsid, connId, table, tables };
    },

    /** Query engine (NL2SQL): create session against datasource, stream chat, return final blocks. */
    async askQuery(pid, connId, question) {
      void connId;
      const sid = await createQuerySession(pid, question);
      await notifySessionCreated(sid, question);
      const out = await runQueryTurn(pid, sid, question);
      await notifySessionCreated(sid, question);
      return { sid, ...out };
    },

    /** Generic agent: create __chat__ or project session, stream, and return final blocks. */
    async askAgent(pid, message, {
      title = 'eval',
      mode = null,
      collaborationMode = null,
      approval = 'ask',
      autoApprove = false,
      autoResolveUserInput = false,
      timeoutMs = DEFAULT_STREAM_TIMEOUT_MS,
      input = null,
      attachments = null,
      searchMode = null,
      model = null,
      effort = null,
      summary = null,
      verbosity = null,
      settings = null,
      skills = null,
      plugins = null,
      clientCapabilities = null,
      interruptOnItemType = null,
    } = {}) {
      const sess = await api('POST', `/api/projects/${pid}/sessions`, {
        title,
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      const sid = sess.json?.data?.id || sess.json?.data?.session_id || sess.json?.data;
      if (!sid) throw new Error('建 agent 会话失败: ' + JSON.stringify(sess.json).slice(0, 150));
      await notifySessionCreated(sid, message);
      const out = await streamBlocks(
        `/api/agent/projects/${pid}/threads/${sid}/turns`,
        agentRequestBody({
          message,
          approval,
          ...(Array.isArray(input) ? { input } : {}),
          ...(Array.isArray(attachments) ? { attachments } : {}),
          ...(mode ? { mode } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
          ...(searchMode ? { searchMode } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(summary ? { summary } : {}),
          ...(verbosity ? { verbosity } : {}),
          ...(settings && typeof settings === 'object' ? { settings } : {}),
          ...(Array.isArray(skills) ? { skills } : {}),
          ...(Array.isArray(plugins) ? { plugins } : {}),
          ...(clientCapabilities && typeof clientCapabilities === 'object' ? { clientCapabilities } : {}),
        }),
        { autoApprove, autoResolveUserInput, interruptOnItemType, interruptThreadId: sid, timeoutMs },
      );
      await notifySessionCreated(sid, message);
      return { sid, ...out };
    },

    /** Continue an existing generic Agent session with the same turn options as askAgent. */
    async continueAgent(pid, sid, message, {
      mode = null,
      collaborationMode = null,
      approval = 'ask',
      autoApprove = false,
      autoResolveUserInput = false,
      timeoutMs = DEFAULT_STREAM_TIMEOUT_MS,
      input = null,
      attachments = null,
      searchMode = null,
      model = null,
      effort = null,
      summary = null,
      verbosity = null,
      settings = null,
      skills = null,
      plugins = null,
      clientCapabilities = null,
      interruptOnItemType = null,
    } = {}) {
      if (!sid) throw new Error('继续 Agent 对话缺少 sid');
      const out = await streamBlocks(
        `/api/agent/projects/${pid}/threads/${sid}/turns`,
        agentRequestBody({
          message,
          approval,
          ...(Array.isArray(input) ? { input } : {}),
          ...(Array.isArray(attachments) ? { attachments } : {}),
          ...(mode ? { mode } : {}),
          ...(collaborationMode ? { collaborationMode } : {}),
          ...(searchMode ? { searchMode } : {}),
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(summary ? { summary } : {}),
          ...(verbosity ? { verbosity } : {}),
          ...(settings && typeof settings === 'object' ? { settings } : {}),
          ...(Array.isArray(skills) ? { skills } : {}),
          ...(Array.isArray(plugins) ? { plugins } : {}),
          ...(clientCapabilities && typeof clientCapabilities === 'object' ? { clientCapabilities } : {}),
        }),
        { autoApprove, autoResolveUserInput, interruptOnItemType, interruptThreadId: sid, timeoutMs },
      );
      await notifySessionCreated(sid, message);
      return { sid, ...out };
    },

    /** Continue one real Agent conversation and score its persisted final table. */
    async continueAgentColumns(pid, sid, message, options = {}) {
      const output = await this.continueAgent(pid, sid, message, options);
      return withExtractedColumns(pid, sid, output);
    },

    /**
     * Generic agent multi-turn: continuous chat within the same session without explicitly passing skill.
     * Used to validate automatic skill selection and multi-turn context chain for project chat.
     */
    async askAgentMultiTurn(pid, questions, { title = 'eval-multiturn' } = {}) {
      const list = Array.isArray(questions) ? questions : [questions].filter(Boolean);
      const sess = await api('POST', `/api/projects/${pid}/sessions`, {
        title,
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      const sid = sess.json?.data?.id || sess.json?.data?.session_id || sess.json?.data;
      if (!sid) throw new Error('建 agent 多轮会话失败: ' + JSON.stringify(sess.json).slice(0, 150));

      const firstMessage = list.find(Boolean) || title;
      await notifySessionCreated(sid, firstMessage);
      const results = [];
      let assistantCount = 0;
      for (const message of list) {
        if (!message) {
          results.push({ sid, raw: 0, blocks: [] });
          continue;
        }
        assistantCount += 1;
        const out = await streamBlocks(
          `/api/agent/projects/${pid}/threads/${sid}/turns`,
          agentRequestBody({ message }),
        );
        const result = out.blocks?.length
          ? out
          : await waitForAssistantResult(pid, sid, { minAssistantCount: assistantCount });
        results.push({ sid, ...result });
      }
      await notifySessionCreated(sid, list.filter(Boolean).at(-1) || firstMessage);
      return results;
    },

    // ═══════════════════════════════════════════════════════
    // KDD Cup import path (replicates Python importer project-level endpoint chain without business layer).
    // ═══════════════════════════════════════════════════════

    /**
     * Import a database file (sqlite/duckdb) into project, reproducing the 7-step chain from Python _import_database.
     * dbPath = backend-readable local absolute path; extraNotes = knowledge.md text for column-description injection.
     * Returns { connId, tables }.
     */
    async importDatabase(pid, dbPath, {
      name,
      extraNotes = '',
      enrich = true,
    } = {}) {
      const stem = name || dbPath.replace(/.*\//, '').replace(/\.\w+$/, '');
      const isSqlite = /\.sqlite3?$|\.db$/i.test(dbPath);
      const dbType = isSqlite ? 'SQLite' : 'DuckDB';

      await activateProject(pid);
      const uploaded = await api('POST', `/api/projects/${pid}/databases/upload-db-file`, { file_path: dbPath });
      const databasePath = uploaded?.json?.data?.path || dbPath;
      const conn = await api('POST', `/api/projects/${pid}/databases`, {
        name: stem,
        db_type: dbType,
        host: databasePath,
        database: databasePath,
        description: `eval database ${stem}`,
      });
      const connId = conn?.json?.data?.id;
      if (!connId) throw new Error('创建数据库连接失败: ' + JSON.stringify(conn?.json).slice(0, 160));

      await api('POST', `/api/projects/${pid}/databases/${connId}/sync-schema`, {});
      const tableRows = await poll(
        async () => {
          const tr = await api('GET', `/api/projects/${pid}/databases/${connId}/tables?per_page=100`).catch(() => null);
          const items = tr?.json?.data?.items || [];
          return items.length ? items : null;
        },
        { timeoutMs: 60000, intervalMs: 1000, label: `数据库表同步 ${stem}` },
      );

      const tables = tableRows.map(t => ({ id: t.id, name: t.table_name || t.name }));
      if (enrich) {
        // Generate column descriptions / sample values / vectors to match backend enrichment after UI sync; import should continue even if this fails.
        const tableIds = tables.map(t => t.id);
        const descBody = { connection_id: connId, table_ids: tableIds, only_pending: false };
        if (extraNotes) descBody.extra_notes = extraNotes;
        await api('POST', `/api/projects/${pid}/databases/generate-columns-descriptions`, descBody).catch(e => console.warn('  [importDatabase] generate-desc 跳过:', e?.message?.slice(0,80)));
        await api('POST', `/api/projects/${pid}/databases/${connId}/tables/batch_sync_example_values`, { table_ids: tableIds, limit: 3 }).catch(() => {});
        await api('POST', `/api/projects/${pid}/databases/${connId}/tables/store-vectors`, { table_ids: tableIds, only_pending: false }).catch(() => {});
      }
      return { connId, tables };
    },

    /**
     * Import unstructured documents (doc/*.md etc.), replicating Python _import_unstructured.
     * files = array of backend-readable local absolute paths. Returns { dsid }.
     */
    async importUnstructured(pid, files, { name = 'eval-docs', prepareProjectData = false } = {}) {
      const dsid = await createUnstructuredDataSource(pid, name);
      const paths = Array.isArray(files) ? files : [files];

      const documentIds = [];
      for (const filePath of paths) {
        const created = await api('POST', `/api/projects/${pid}/unstructured-datasources/${dsid}/documents`, {
          file_path: filePath,
        });
        const docId = created?.json?.data?.document?.id;
        if (docId) documentIds.push(docId);
      }

      await poll(
        async () => {
          const lr = await api('GET', `/api/projects/${pid}/unstructured-datasources/${dsid}/documents?per_page=100`).catch(() => null);
          const docs = lr?.json?.data?.items || lr?.json?.data || [];
          const currentDocs = documentIds.length ? docs.filter((d) => documentIds.includes(d.id)) : docs.slice(0, paths.length);
          if (currentDocs.length < paths.length) return null;
          const terminal = currentDocs.every(d => /completed|done|ready|failed/i.test(d.status || ''));
          if (!terminal) return null;
          const failed = currentDocs.filter(d => /failed/i.test(d.status || ''));
          if (failed.length) throw new Error(`非结构化文档处理失败: ${failed.map(d => d.error_msg || d.title || d.id).join(', ')}`);
          return currentDocs;
        },
        { timeoutMs: 180000, intervalMs: 3000, label: `非结构化导入 ${name}` },
      );
      if (prepareProjectData) {
        await api('POST', `/api/projects/${pid}/unstructured-documents/generate-descriptions`, {
          data_source_id: dsid,
          document_ids: documentIds,
          language: 'zh',
        });
        await api(
          'POST',
          `/api/projects/${pid}/unstructured-datasources/${dsid}/generate-description`,
          { language: 'zh' },
        );
      }
      return { dsid };
    },

    /** Run the same project-level offline preparation capability used by the prepare_project_data Skill. */
    async prepareProjectData(pid, {
      connectionIds = [],
      unstructuredDataSourceIds = [],
      extraNotes = '',
      onlyPending = false,
    } = {}) {
      const response = await api('POST', `/api/projects/${pid}/data-preparation/run`, {
        ...(connectionIds.length ? { connection_ids: connectionIds } : {}),
        ...(unstructuredDataSourceIds.length ? { unstructured_data_source_ids: unstructuredDataSourceIds } : {}),
        only_pending: onlyPending,
        ...(extraNotes ? { extra_notes: extraNotes } : {}),
      });
      const result = response?.json?.data;
      if (!result || result.status !== 'completed') {
        throw new Error(`离线数据准备未完整完成: ${JSON.stringify(result?.failures || result).slice(0, 600)}`);
      }
      return result;
    },

    /**
     * Ask query and extract column vectors (for column_match assertions).
     * Prefer table blocks from streamBlocks first; if no table block comes in stream, fall back to persisted messages.
     * Returns { sid, blocks, raw, columns: [[v1,v2,...], ...] }.
     */
    async askQueryColumns(pid, connId, question) {
      const r = await this.askQuery(pid, connId, question);
      let columns = extractColumnsFromBlocks(r.blocks || []);
      // Fallback: if stream did not return table blocks, read from persisted messages.
      if (!columns.length && r.sid) {
        const mr = await api('GET', `/api/projects/${pid}/sessions/${r.sid}/messages`);
        const data = mr.json?.data;
        const msgs = Array.isArray(data) ? data : (data?.items || data?.messages || []);
        const lastAssistant = msgs.filter(m => m.role === 'assistant').pop();
        if (lastAssistant) {
          const items = typeof lastAssistant.content_items === 'string'
            ? JSON.parse(lastAssistant.content_items) : lastAssistant.content_items;
          columns = extractColumnsFromBlocks(items || []);
        }
      }
      return { ...r, columns };
    },

    /**
     * Multi-turn query (continuous questions in one session, aligned to Python send_question multi-turn logic).
     * @param {string} pid
     * @param {string} connId
     * @param {string[]} questions multi-turn questions
     * @returns {Promise<Array>} { sid, blocks, raw, columns } for each turn
     */
    async askQueryMultiTurn(pid, connId, questions) {
      void connId;
      const firstQuestion = questions.find(Boolean) || '';
      if (!firstQuestion) return questions.map(() => ({ sid: '', blocks: [], raw: 0, columns: [] }));
      const sid = await createQuerySession(pid, firstQuestion);
      const results = [];
      let assistantCount = 0;
      await notifySessionCreated(sid, firstQuestion);

      for (const q of questions) {
        if (!q) {
          results.push({ sid, blocks: [], raw: 0, columns: [] });
          continue;
        }

        assistantCount += 1;
        const out = await runQueryTurn(pid, sid, q, { minAssistantCount: assistantCount });
        // Column-vector extraction (same as askQueryColumns), including messages fallback.
        let columns = extractColumnsFromBlocks(out.blocks || []);
        if (!columns.length) {
          const mr = await api('GET', `/api/projects/${pid}/sessions/${sid}/messages`);
          const data = mr.json?.data;
          const msgs = Array.isArray(data) ? data : (data?.items || data?.messages || []);
          const lastAssistant = msgs.filter(m => m.role === 'assistant').pop();
          if (lastAssistant) {
            const items = typeof lastAssistant.content_items === 'string' ? JSON.parse(lastAssistant.content_items) : lastAssistant.content_items;
            columns = extractColumnsFromBlocks(items || []);
          }
        }
        results.push({ sid, ...out, columns });
      }
      await notifySessionCreated(sid, questions.filter(Boolean).at(-1) || '');
      return results;
    },

    /**
     * Apply manual schema descriptions (table description + column description + vector rebuild).
     * Match Python _apply_schema_descriptions. descriptions format: {tables:[{table,description,columns:{col:desc}}]}
     */
    async applySchemaDescriptions(pid, connId, descriptions) {
      const tables = (descriptions.tables || []);
      if (!tables.length) return;
      // 1. Read existing table list and build a table_name -> table_id map
      const tr = await api('GET', `/api/projects/${pid}/databases/${connId}/tables?per_page=200`);
      const tableItems = tr.json?.data?.items || [];
      const tableMap = {};
      for (const t of tableItems) {
        const name = (t.table_name || t.name || '').toLowerCase();
        if (name && t.id) tableMap[name] = t.id;
      }
      const touchedIds = [];
      for (const spec of tables) {
        const tname = (spec.table || '').trim().toLowerCase();
        const tableId = tableMap[tname];
        if (!tableId) continue;
        // 2. Write table description
        if (spec.description) {
          await api('PUT', `/api/projects/${pid}/databases/${connId}/tables/${tableId}`, { description: spec.description }).catch(() => {});
        }
        // 3. Batch write column descriptions
        const colDescs = spec.columns || {};
        if (Object.keys(colDescs).length) {
          // Read column list
          const cr = await api('GET', `/api/projects/${pid}/databases/${connId}/tables/${tableId}/columns`).catch(() => null);
          const cols = cr?.json?.data?.items || cr?.json?.data || [];
          const payload = [];
          for (const col of cols) {
            const cname = (col.column_name || col.name || '').toLowerCase();
            if (cname && colDescs[cname]) {
              payload.push({ column_id: col.id, description: colDescs[cname] });
            }
          }
          if (payload.length) {
            await api('PUT', `/api/projects/${pid}/databases/${connId}/tables/${tableId}/columns`, { columns: payload }).catch(() => {});
            touchedIds.push(tableId);
          }
        }
      }
      // 4. Rebuild vectors asynchronously. (Large vectorization on many big tables can take minutes.)
      if (touchedIds.length) {
        await api('POST', `/api/projects/${pid}/databases/${connId}/tables/store-vectors`, { table_ids: touchedIds, only_pending: false }).catch(() => {});
        console.log(`  [applySchemaDescriptions] 向量重建已触发(${touchedIds.length} 表,后台异步)`);
      }
    },

    /** Register entity column config. This config has no stable frontend entry yet, so keep it as eval data-setup inside driver. */
    async registerEntityColumn(pid, connId, ec) {
      const tables = await api('GET', `/api/projects/${pid}/databases/${connId}/tables?per_page=100`);
      const items = tables.json?.data?.items || [];
      const tbl = items.find((t) => (t.table_name || t.name) === ec.table);
      if (!tbl) return;
      await api('POST', `/api/projects/${pid}/databases/${connId}/entity_mapping_configs`, {
        table_id: tbl.id,
        column_name: ec.column,
        rule: ec.rule || null,
      }).catch(() => {});
    },

    /** Create metric view. This is hidden eval data setup; task layer does not call backend directly. */
    async createMetricView(pid, mv) {
      await api('POST', `/api/projects/${pid}/metric-views`, {
        name: mv.name,
        description: mv.description || '',
        aliases: mv.aliases || [],
        tables: mv.tables || [],
        projections: mv.projections || [],
        fixed_predicates: mv.fixed_predicates || [],
        query_dimensions: mv.query_dimensions || [],
        time_dimension: mv.time_dimension || null,
        group_by: mv.group_by || [],
        sort_spec: mv.sort_spec || null,
        source_id: mv.source_id || null,
        status: mv.status || 'active',
      }).catch(() => {});
    },

    /** Inject knowledge.md into persistent SQL rules through the project-rule API. */
    async injectKnowledge(pid, knowledge) {
      if (!knowledge) return;
      try {
        await api('PUT', `/api/projects/${pid}/rules/sql`, {
          operation: 'replace',
          content: knowledge,
        });
      } catch (e) {
        console.warn('  [injectKnowledge] 注入 SQL rules 失败(忽略):', e?.message?.slice(0, 80));
      }
    },

    close: session.close,
  };
}

/**
 * Extract column vectors from block arrays (items/blocks).
 * Prefer final structured table blocks first, then final Markdown answers, and finally plain non-intermediate table blocks.
 */
export function extractColumnsFromBlocks(blocks) {
  const list = Array.isArray(blocks) ? blocks.filter(Boolean) : [];
  const finalTableBlocks = list
    .filter((b) => isFinalAnswerBlock(b) && !isIntermediateBlock(b) && isTableLikeBlock(b))
    .reverse();
  for (const b of finalTableBlocks) {
    const cols = extractColumnsFromBlock(b);
    if (cols.length) return cols;
  }

  const finalBlocks = list
    .filter((b) => isFinalAnswerBlock(b) && !isIntermediateBlock(b))
    .reverse();
  for (const b of finalBlocks) {
    const cols = extractColumnsFromBlock(b);
    if (cols.length) return cols;
  }

  const markdownBlocks = list
    .filter((b) => /markdown|text/i.test(b.type || '') && String(b.content || '').includes('|'))
    .reverse();
  for (const b of markdownBlocks) {
    const cols = extractColumnsFromMarkdown(String(b.content || ''));
    if (cols.length) return cols;
  }

  const tableBlocks = list.filter((b) => isTableLikeBlock(b) && !isIntermediateBlock(b)).reverse();
  for (const b of tableBlocks) {
    const cols = extractColumnsFromBlock(b);
    if (cols.length) return cols;
  }
  return [];
}

function isFinalAnswerBlock(block) {
  const meta = block?.metadata || {};
  return meta.answer_status === 'accepted' || meta.result_role === 'deliverable';
}

function isIntermediateBlock(block) {
  return block?.metadata?.result_role === 'intermediate';
}

function isTableLikeBlock(block) {
  return /table/i.test(block?.type || '') || /table/i.test(block?.display_type || '') || /table/i.test(block?.title || '');
}

function extractColumnsFromBlock(block) {
  const jsonCols = extractColumnsFromJsonContent(block?.content);
  if (jsonCols.length) return jsonCols;
  if (/markdown|text/i.test(block?.type || '') || String(block?.content || '').includes('|')) {
    return extractColumnsFromMarkdown(String(block?.content || ''));
  }
  return [];
}

function extractColumnsFromJsonContent(content) {
  let obj = content;
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj); }
    catch { return []; }
  }
  if (!obj || typeof obj !== 'object') return [];

  const rows = Array.isArray(obj.data)
    ? obj.data
    : Array.isArray(obj.rows)
      ? obj.rows
      : Array.isArray(obj.table?.data)
        ? obj.table.data
        : [];
  if (!rows.length) return [];

  if (typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
    const colNames = columnNamesFromMetadata(obj).filter((name) => Object.prototype.hasOwnProperty.call(rows[0], name));
    const names = colNames.length ? colNames : [...new Set(rows.flatMap((r) => Object.keys(r)))];
    return names.map((name) => rows.map((r) => r[name]));
  }

  if (Array.isArray(rows[0])) {
    const ncol = Math.max(...rows.map((row) => Array.isArray(row) ? row.length : 0));
    const columns = [];
    for (let c = 0; c < ncol; c++) columns.push(rows.map((row) => row?.[c]));
    return columns;
  }

  return [rows];
}

function columnNamesFromMetadata(obj) {
  const candidates = [];
  if (Array.isArray(obj.fields)) candidates.push(...obj.fields);
  if (Array.isArray(obj.columns)) candidates.push(...obj.columns);
  if (Array.isArray(obj.table?.columns)) candidates.push(...obj.table.columns);
  return candidates
    .map((field) => {
      if (typeof field === 'string') return field;
      if (!field || typeof field !== 'object') return '';
      return field.name || field.key || field.dataIndex || field.field || field.column_name || field.id || '';
    })
    .filter(Boolean);
}

function extractColumnsFromMarkdown(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  let lastRows = null;
  for (let i = 0; i < lines.length - 1; i++) {
    const header = parseMarkdownTableRow(lines[i]);
    const separator = parseMarkdownTableRow(lines[i + 1]);
    if (!header.length || !isMarkdownSeparatorRow(separator)) continue;

    const rows = [];
    for (let j = i + 2; j < lines.length; j++) {
      const row = parseMarkdownTableRow(lines[j]);
      if (!row.length) break;
      rows.push(row);
    }
    if (rows.length) {
      lastRows = rows;
      i += rows.length + 1;
    }
  }
  if (!lastRows?.length) return [];
  const ncol = Math.max(...lastRows.map((row) => row.length));
  const columns = [];
  for (let c = 0; c < ncol; c++) columns.push(lastRows.map((row) => row[c] ?? ''));
  return columns;
}

function parseMarkdownTableRow(line) {
  const raw = String(line || '').trim();
  if (!raw.includes('|')) return [];
  const trimmed = raw.replace(/^\|/, '').replace(/\|$/, '');
  const cells = trimmed.split('|').map(cleanMarkdownCell);
  return cells.some((cell) => cell !== '') ? cells : [];
}

function cleanMarkdownCell(cell) {
  return String(cell ?? '')
    .trim()
    .replace(/^`([^`]*)`$/g, '$1')
    .replace(/^\*\*([^*]*)\*\*$/g, '$1')
    .trim();
}

function isMarkdownSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(String(cell || '').replace(/\s+/g, '')));
}

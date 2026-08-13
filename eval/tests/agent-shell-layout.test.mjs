import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..', '..');
const readAppFile = (...parts) => fs.readFileSync(path.join(appRoot, ...parts), 'utf8');

test('agent nav defaults open unless the saved width is explicitly zero', () => {
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'AgentShell.tsx');

  assert.match(shell, /const\s+savedNavWidthRaw\s*=\s*localStorage\.getItem\(NAV_STORAGE_KEY\)/);
  assert.match(shell, /useState\(\(\)\s*=>\s*savedNavWidthRaw\s*===\s*'0'\)/);
  assert.doesNotMatch(shell, /localStorage\.getItem\('dsh-layout-nav-width'\)\s*\|\|\s*0/);
});

test('conversation sidebar uses status invalidation events with snapshot reconciliation', () => {
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'AgentShell.tsx');
  const conversation = readAppFile('renderer', 'src', 'views', 'agent', 'AgentConversation.tsx');
  const api = readAppFile('renderer', 'src', 'api', 'agent.ts');
  const chatRoutes = readAppFile('server', 'src', 'transport', 'registry.chat.js');
  const loadConversations = shell.slice(
    shell.indexOf('const loadConvs = useCallback'),
    shell.indexOf('// Load projects + chat/project conversations.'),
  );

  assert.match(shell, /latest_run_id:\s*c\.latest_run_id \|\| null/);
  assert.match(shell, /latest_run_viewed_at:\s*c\.latest_run_viewed_at \|\| null/);
  assert.match(shell, /live_interaction_status:\s*c\.live_interaction_status \|\| null/);
  assert.doesNotMatch(shell, /conversationNeedsStatusPolling\(/);
  assert.doesNotMatch(shell, /window\.setInterval\([\s\S]{0,400}?2500/);
  assert.match(api, /subscribeAgentConversationStatusEvents/);
  assert.match(api, /\/api\/agent\/session-status\/events/);
  assert.match(
    chatRoutes,
    /\{\s*m:\s*["']GET["'],\s*p:\s*["']\/api\/agent\/session-status\/events["'][\s\S]*?stream:\s*true\s*\}/,
  );
  assert.match(shell, /subscribeAgentConversationStatusEvents/);
  assert.match(shell, /markConversationViewedIfNeeded\(wsId, convId, \{ retryFailed: true \}\)/);
  assert.match(shell, /viewedRunRequestsRef\.current\.claim\(runId, options\)/);
  assert.match(shell, /new ConversationStatusRefreshCoordinator/);
  assert.match(shell, /scheduleConversationStatusRefresh/);
  assert.match(shell, /refreshConversationStatusWorkspaces/);
  assert.match(
    shell,
    /CONVERSATION_STATUS_RECONNECT_DELAYS_MS\s*=\s*\[\s*500\s*,\s*1_?000\s*,\s*2_?000\s*,\s*5_?000\s*,\s*10_?000\s*\]/,
  );
  assert.match(
    shell,
    /conversation_status\.ready[\s\S]{0,800}?refreshConversationStatusWorkspaces/,
  );
  assert.match(
    shell,
    /visibilitychange[\s\S]{0,1200}?refreshConversationStatusWorkspaces/,
  );
  assert.match(
    shell,
    /onBackendState[\s\S]{0,500}?state\s*!==\s*'ready'[\s\S]{0,500}?refreshConversationStatusWorkspaces\(\)[\s\S]{0,500}?reconnectConversationStatusStream\(\)/,
  );
  assert.match(loadConversations, /conversationSnapshotVersionRef\.current\.set\(id, requestVersion\)/);
  assert.match(loadConversations, /conversationSnapshotVersionRef\.current\.get\(id\) !== requestVersion\) return/);
  assert.doesNotMatch(loadConversations, /catch\s*\{[\s\S]{0,300}?map\[id\]\s*=\s*\[\]/);
  assert.doesNotMatch(loadConversations, /catch\s*\{[\s\S]{0,300}?archivedMap\[id\]\s*=\s*\[\]/);
  assert.match(shell, /markAgentSessionViewed\(workspaceId, conversationId, runId\)/);
  assert.match(shell, /runningConversationId=\{liveRun\?\.conversationId\}/);
  assert.match(conversation, /onRunningChange\?: \(running: boolean, sessionId\?: string \| null\) => void/);
  assert.match(conversation, /onRunningChange\?\.\(true, sid\)/);
});

test('agent window titlebar stays native-sized and owns the traffic-light safe area', () => {
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'AgentShell.tsx');
  const theme = readAppFile('renderer', 'src', 'views', 'agent', 'agent-theme.scss');
  const moduleCss = readAppFile('renderer', 'src', 'views', 'agent', 'agent.module.scss');

  assert.match(shell, /showWindowTitlebar\s*&&\s*titlebarPortalTarget\s*&&\s*createPortal\([\s\S]*data-agent-window-titlebar/);
  assert.match(shell, /document\.querySelector<HTMLElement>\('\.dsh-root'\)/);
  assert.match(shell, /navigateShellHistory\(-1\)/);
  assert.match(shell, /navigateShellHistory\(1\)/);
  assert.doesNotMatch(shell, /\{navCollapsed\s*&&\s*createPortal\(\s*<button[\s\S]*data-edge-toggle="nav"/);
  assert.doesNotMatch(shell, /styles\.(?:navEdgeToggle|wsEdgeToggle)/);
  assert.match(theme, /body\[data-dsh-shell-titlebar='true'\]\s+\.dsh-root\s*\{\s*padding:\s*52px 10px 10px;/);
  assert.match(theme, /\.dsh-root\s*>\s*\[data-agent-window-titlebar\]/);
  assert.match(moduleCss, /\.rail\[data-collapsed='true'\]\s*\{[\s\S]*padding:\s*0;/);
  assert.match(moduleCss, /\.windowTitlebar\s*\{[\s\S]*padding:\s*0 10px 0 86px;[\s\S]*-webkit-app-region:\s*drag;/);
  assert.match(moduleCss, /\.windowTitlebar\[data-window-full-screen='true'\]\s*\{[\s\S]*-webkit-app-region:\s*no-drag;/);
});

test('project row action buttons do not move when the row becomes hovered', () => {
  const nav = readAppFile('renderer', 'src', 'views', 'agent', 'AgentNav.tsx');
  const moduleCss = readAppFile('renderer', 'src', 'views', 'agent', 'agent.module.scss');
  const plusBlock = moduleCss.slice(moduleCss.indexOf('.wsPlus {'), moduleCss.indexOf('.wsPlus:hover'));
  const hoveredPlusBlock = moduleCss.slice(
    moduleCss.indexOf('.wsFolder:hover .wsPlus {', moduleCss.indexOf('.wsPlus {')),
    moduleCss.indexOf('.wsPlus:hover'),
  );

  assert.match(plusBlock, /width:\s*14px;/);
  assert.match(plusBlock, /min-width:\s*14px;/);
  assert.match(plusBlock, /display:\s*grid;/);
  assert.doesNotMatch(hoveredPlusBlock, /width:/);
  assert.match(nav, /className=\{styles\.wsMore\}[\s\S]*onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
});

test('home and settings expose the same DSH Web Profile bundle authority', () => {
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'AgentShell.tsx');
  const appSettings = readAppFile('renderer', 'src', 'views', 'agent', 'AgentSettings.tsx');
  const settings = readAppFile('renderer', 'src', 'views', 'project', 'settings', 'index.tsx');
  const pluginCenter = readAppFile('renderer', 'src', 'views', 'plugins', 'PluginCenter.tsx');

  assert.match(shell, /onOpenPlugins=\{openPluginDirectory\}/);
  assert.match(shell, /<PluginCenter\s+surface="directory"/);
  assert.match(appSettings, /<PluginCenter\s*\/>/);
  assert.match(pluginCenter, /surface\s*=\s*'settings'/);
  assert.match(pluginCenter, /listPluginCatalogReq\(true\)/);
  assert.match(pluginCenter, /installProfileBundleReq\(source\)/);
  assert.match(pluginCenter, /uninstallProfileBundleReq\(bundle\.id\)/);
  assert.match(pluginCenter, /data-profile-bundle=\{bundle\.id\}/);
  assert.doesNotMatch(settings, /SkillManagement|case\s+'skills'|tabs\.skills/);
  assert.doesNotMatch(settings, /McpProviderListView|case\s+'mcp'|mcpProviders/);
  assert.doesNotMatch(pluginCenter, /listSkillMarketReq|installSkillMarketReq|createAppSkillReq/);
});

test('closing project settings cannot be undone by hash synchronization', () => {
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'AgentShell.tsx');
  const settings = readAppFile('renderer', 'src', 'views', 'project', 'settings', 'index.tsx');

  assert.match(
    shell,
    /const closeProjectSettings = useCallback\(\(\) => \{\s+closingProjectSettingsRef\.current = true\s+setConfigWsId\(null\)/
  );
  assert.match(
    shell,
    /if \(!isProjectSettingsHash\(hashTab\)\) \{\s+closingProjectSettingsRef\.current = false\s+return\s+\}\s+if \(closingProjectSettingsRef\.current\) return/
  );
  assert.match(
    settings,
    /const hash = location\.hash\?\.replace\('#', ''\) \|\| ''\s+if \(!hash\) \{[\s\S]*if \(!isAllowedTab\(tabName\)\) \{[\s\S]*replaceHash\(`#\$\{fallbackTab\}`\)/
  );
});

test('project settings contain only Host-owned tabs and no legacy Plugin page host', () => {
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'AgentShell.tsx');
  const nav = readAppFile('renderer', 'src', 'views', 'agent', 'AgentNav.tsx');
  const settings = readAppFile('renderer', 'src', 'views', 'project', 'settings', 'index.tsx');
  const registryPath = path.join(appRoot, 'renderer', 'src', 'views', 'project', 'settings', 'pluginUiRegistry.tsx');

  for (const tab of ['database', 'structured', 'unstructured', 'definitions', 'entities', 'examples', 'memory']) {
    assert.doesNotMatch(shell, new RegExp(`PROJECT_SETTINGS_HIDDEN_TABS[\\s\\S]*['\"]${tab}['\"]`));
  }
  assert.match(settings, /const HOST_TABS = \['basic', 'instructions', 'chat-memory', 'models'\] as const/);
  assert.doesNotMatch(settings, /PluginPageHost|projectPagesForPlacementRecord|pluginPagesRecord|ui_contributions|ask-data/);
  assert.doesNotMatch(shell, /openProjectPlugins|openPluginPage|exitPluginPage/);
  assert.equal(fs.existsSync(registryPath), false);
  assert.match(nav, /label:\s*'项目设置'/);
  assert.match(nav, /items:\s*workspaceMenuItems\(ws\)/);
  assert.match(nav, /data-agent-workspace-menu-trigger/);
  assert.doesNotMatch(nav, /projectCard/);
  assert.doesNotMatch(nav, /管理项目数据|管理数据/);
});

test('project editing has one project settings entry and one basic info implementation', () => {
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'AgentShell.tsx');
  const nav = readAppFile('renderer', 'src', 'views', 'agent', 'AgentNav.tsx');
  const settings = readAppFile('renderer', 'src', 'views', 'project', 'settings', 'index.tsx');
  const basicInfo = readAppFile('renderer', 'src', 'views', 'project', 'settings', 'components', 'BasicInfo.tsx');

  assert.doesNotMatch(shell, /ProjectEditModal|editProjectId|onEditProject/);
  assert.doesNotMatch(nav, /编辑项目|onEditProject/);
  assert.match(nav, /label:\s*'项目设置'/);
  assert.match(nav, /items:\s*workspaceMenuItems\(ws\)/);
  assert.match(settings, /onDeleteProject/);
  assert.match(basicInfo, /replaceProjectSourceFoldersReq/);
  assert.match(basicInfo, /project\.basicInfo\.deleteProject/);
});

test('DSH shell copy and onboarding do not present Ask Data as a chat feature', () => {
  const files = [
    ['renderer', 'src', 'views', 'agent', 'AgentNav.tsx'],
    ['renderer', 'src', 'views', 'agent', 'AgentShell.tsx'],
    ['renderer', 'src', 'views', 'agent', 'AgentConversation.tsx'],
    ['renderer', 'src', 'views', 'agent', 'AgentSettings.tsx'],
    ['renderer', 'src', 'views', 'agent', 'WorkspacePicker.tsx'],
    ['renderer', 'src', 'views', 'agent', 'onboarding', 'DshOnboarding.tsx'],
  ];
  const source = files.map((parts) => readAppFile(...parts)).join('\n');

  assert.doesNotMatch(source, /问数|数据源|治理数据|问数据/);
  assert.match(source, /DshOnboarding/);
  assert.match(source, /聊天、处理文件，或安排一个多步任务/);
  assert.doesNotMatch(readAppFile('renderer', 'src', 'views', 'agent', 'AgentNav.tsx'), /IconDatabase/);
});

test('the app has one current shell and no legacy Chat compatibility routes', () => {
  const router = readAppFile('renderer', 'src', 'router', 'routes.tsx');
  const chatRoutes = readAppFile('server', 'src', 'transport', 'registry.chat.js');
  const modelRoutes = readAppFile('server', 'src', 'transport', 'registry.models.js');

  assert.match(router, /view:\s*'views\/agent\/index'[\s\S]*?children:\s*\[[\s\S]*?path:\s*'\/agent'[\s\S]*?view:\s*'views\/agent\/AgentWorkspaceRoute'/);
  assert.match(router, /\{ path: '\*', loader: \(\) => redirect\('\/agent'\) \}/);
  assert.doesNotMatch(router, /views\/(?:database|project|dashboard)\//);
  assert.doesNotMatch(chatRoutes, /sessions\/:sid\/chat|tool-decision|agent_chat|query_chat/);
  assert.doesNotMatch(modelRoutes, /\/api\/llm_model\/active|listActiveModels/);
});

test('AI host events separate creation from explicit project and conversation navigation', () => {
  const shell = readAppFile('renderer', 'src', 'views', 'agent', 'AgentShell.tsx');
  const eventHandler = shell.slice(
    shell.indexOf('const handleWorkspaceEvent'),
    shell.indexOf('// Open general project settings'),
  );

  assert.match(shell, /const shouldSwitch = event\.event === 'project_opened' \|\| event\.open === true/);
  assert.match(shell, /eventType === 'conversation_opened'/);
  assert.match(shell, /eventType === 'conversation_created' && event\.open === true/);
  assert.doesNotMatch(eventHandler, /moveAgentSession/);
});

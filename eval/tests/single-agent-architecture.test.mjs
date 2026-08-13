import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const SERVER_ROOT = new URL('../../server/src/', import.meta.url);

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) return javascriptFiles(target);
    return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
  }));
  return nested.flat();
}

test('server production code no longer imports or constructs the Pi Agent', async () => {
  const files = await javascriptFiles(SERVER_ROOT);
  const imports = [];
  const constructors = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/from\s+["']@earendil-works\/pi-agent-core["']/.test(source)) imports.push(file.pathname);
    if (/\bnew\s+Agent\s*\(/.test(source)) constructors.push(file.pathname);
  }

  assert.deepEqual(imports, []);
  assert.deepEqual(constructors, []);
});

test('workspace Agent delegates every conversation to the DSH Profile runtime', async () => {
  const workspaceAgent = await readFile(
    new URL('../../server/src/engine/agents/workspace_agent.js', import.meta.url),
    'utf8',
  );
  const agentChat = await readFile(
    new URL('../../server/src/app/chat/agent_chat.js', import.meta.url),
    'utf8',
  );
  const coreFiles = await readdir(new URL('../../server/src/engine/core/', import.meta.url));
  assert.equal(coreFiles.includes('base_agent.js'), false);
  assert.doesNotMatch(workspaceAgent, /BaseAgent|extends\s+BaseAgent/);
  assert.doesNotMatch(agentChat, /runAgent|base_agent\.js/);
  assert.match(agentChat, /traceAgentCall/);
  assert.doesNotMatch(workspaceAgent, /project_data_query_tool|createProjectDataQueryTool/);
  assert.match(workspaceAgent, /DshWorkspaceRuntime/);
  assert.match(workspaceAgent, /dshRuntimeEnabled/);
  assert.doesNotMatch(workspaceAgent, /resolveProjectPluginMounts|selectedCapabilityRoots|mountedPluginHostTools/);
  assert.doesNotMatch(workspaceAgent, /baseInstructions\s*:/);
  assert.doesNotMatch(workspaceAgent, /loadWorkspaceAgentsPrompt|capability\.systemPrompt/);
  assert.doesNotMatch(workspaceAgent, /QueryAgent/);

  const agentFiles = await readdir(new URL('../../server/src/engine/agents/', import.meta.url));
  assert.equal(agentFiles.includes('project_data_query_tool.js'), false);
  assert.equal(agentFiles.includes('project_data_query_core.js'), false);
  assert.equal(agentFiles.includes('query_tool_adapter.js'), false);
  assert.equal(agentFiles.includes('query_execution_store.js'), false);
});

test('desktop, automation, recovery and IM turns use the Agent chat controller', async () => {
  const files = [
    '../../server/src/app/chat/agent_turns.js',
    '../../server/src/app/agents/automation_executor.js',
    '../../server/src/app/agents/run_recovery_scheduler.js',
    '../../server/src/app/im/gateway.js',
  ];
  for (const path of files) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /agentChat/);
    assert.match(source, /from\s+["'][^"']*agent_chat\.js["']/);
    assert.doesNotMatch(source, /from\s+["'][^"']*query_chat\.js["']/);
  }
});

test('Agent query has no nested SQL or presentation model', async () => {
  const agentFiles = await readdir(new URL('../../server/src/engine/agents/', import.meta.url));
  const toolFiles = await readdir(new URL('../../server/src/engine/tools/', import.meta.url));
  assert.equal(agentFiles.includes('sql_generation_agent.js'), false);
  assert.equal(toolFiles.includes('nl2sql_subtask.js'), false);

  const presenter = await readFile(
    new URL('../../server/src/engine/presentation/result_presenter.js', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(presenter, /from\s+["'][^"']*(?:llm|agent_settings|base_agent)\.js["']/);
  assert.doesNotMatch(presenter, /\bchat\s*\(/);
});

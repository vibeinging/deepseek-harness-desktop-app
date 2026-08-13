import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('main chat surface has one DSH Profile runtime and no project Plugin selection path', async () => {
  const [conversation, chat, workspace, registry] = await Promise.all([
    readFile(new URL('../../renderer/src/views/agent/AgentConversation.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/app/chat/agent_chat.js', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/engine/agents/workspace_agent.js', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/transport/registry.chat.js', import.meta.url), 'utf8'),
  ]);

  assert.match(workspace, /DshWorkspaceRuntime/);
  assert.match(workspace, /dshRuntimeEnabled/);
  assert.doesNotMatch(workspace, /resolveProjectPluginMounts|mountedPluginHostTools|selectedCapabilityRoots/);
  assert.doesNotMatch(chat, /capabilitySelection|selectedPlugins|pluginDecisions|agent_capabilities/);
  assert.doesNotMatch(conversation, /composerCapabilitySelection|capabilitySelection|selectedPlugins/);
  assert.match(registry, /dsh-skills/);
  assert.doesNotMatch(registry, /mcp_connections|project-plugin|plugin-pages/);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { ApprovalHook } from '../../server/src/engine/skills/hooks/approval_hook.js';

test('Agent approval exposes the system sandbox and waiting state', async () => {
  const frames = [];
  const states = [];
  const hook = new ApprovalHook({
    approval: 'ask',
    writeTools: new Set(['write', 'edit', 'bash']),
    sandboxPolicy: {
      mode: 'workspace-write',
      system_enforced: true,
      network: 'blocked',
      read_roots: ['/workspace'],
      write_roots: ['/workspace'],
    },
    streamCallback: async (_content, metadata) => frames.push(metadata),
    awaitDecision: async () => true,
    onApprovalState: async (waiting, request) => states.push({ waiting, request }),
    shortArgs: (args) => JSON.stringify(args),
  });

  await hook.beforeToolCall({
    toolCall: { id: 'call-bash-sandbox', name: 'bash' },
    args: { command: 'node report.js' },
  });

  assert.equal(frames[0].approval_request.risk, 'command_execution');
  assert.equal(frames[0].approval_request.network, 'blocked');
  assert.equal(frames[0].approval_request.sandbox.system_enforced, true);
  assert.equal(frames[1].approval_scope, 'once');
  assert.deepEqual(states.map((state) => state.waiting), [true, false]);
  assert.equal(states[1].request.approved, true);
});

test('external MCP approval is not described as locally sandboxed', () => {
  const hook = new ApprovalHook({
    approval: 'ask',
    writeTools: new Set(['write', 'edit', 'bash']),
    isExternalTool: (name) => name.startsWith('mcp_'),
    sandboxPolicy: { system_enforced: true, network: 'blocked' },
  });

  const request = hook.approvalRequest('mcp_remote_search', { query: 'sales' });
  assert.equal(request.sandbox, null);
  assert.equal(request.network, 'external_tool');
  assert.equal(request.risk, 'external_data');
});

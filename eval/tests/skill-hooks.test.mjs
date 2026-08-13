import test from 'node:test';
import assert from 'node:assert/strict';

import { ApprovalHook } from '../../server/src/engine/skills/hooks/approval_hook.js';
import { PRODUCT_CONFIRM_TOOL_NAMES } from '../../server/src/engine/agents/product_tool_catalog.js';

test('ApprovalHook always confirms product confirm tools in full approval mode', async () => {
  const frames = [];
  const decisions = [];
  const hook = new ApprovalHook({
    approval: 'full',
    confirmToolNames: new Set(['skill_create']),
    writeTools: new Set(['write']),
    streamCallback: async (content, metadata) => frames.push({ content, metadata }),
    awaitDecision: async (id) => {
      decisions.push(id);
      return true;
    },
    shortArgs: (args) => JSON.stringify(args),
  });

  const result = await hook.beforeToolCall({
    toolCall: { id: 'call-skill-create', name: 'skill_create' },
    args: { name: 'demo_skill' },
  });

  assert.equal(result, undefined);
  assert.deepEqual(decisions, ['call-skill-create']);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].metadata.title, 'skill_create');
  assert.equal(frames[1].metadata.title, 'approved');
});

test('ApprovalHook full approval still skips ordinary write tools', async () => {
  const frames = [];
  const hook = new ApprovalHook({
    approval: 'full',
    confirmToolNames: new Set(),
    writeTools: new Set(['write']),
    streamCallback: async (content, metadata) => frames.push({ content, metadata }),
    awaitDecision: async () => false,
  });

  const result = await hook.beforeToolCall({
    toolCall: { id: 'call-write', name: 'write' },
    args: { path: 'a.txt' },
  });

  assert.equal(result, undefined);
  assert.deepEqual(frames, []);
});

test('ApprovalHook confirms AI-triggered entity creation from the shared catalog', async () => {
  assert.ok(PRODUCT_CONFIRM_TOOL_NAMES.has('skill_create'));
  const decisions = [];
  const hook = new ApprovalHook({
    approval: 'full',
    confirmToolNames: PRODUCT_CONFIRM_TOOL_NAMES,
    streamCallback: async () => {},
    awaitDecision: async (id) => { decisions.push(id); return true; },
    shortArgs: (args) => JSON.stringify(args),
  });
  const result = await hook.beforeToolCall({
    toolCall: { id: 'call-skill-create', name: 'skill_create' },
    args: { name: 'weekly-report', content: '生成周报的步骤。' },
  });
  assert.equal(result, undefined);
  assert.deepEqual(decisions, ['call-skill-create']);
});

test('ApprovalHook exposes the real sandbox boundary and one-call scope', async () => {
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
  assert.equal(frames.length, 2);
  assert.equal(frames[0].approval_request.risk, 'command_execution');
  assert.equal(frames[0].approval_request.network, 'blocked');
  assert.equal(frames[0].approval_request.sandbox.system_enforced, true);
  assert.equal(frames[1].approval_scope, 'once');
  assert.deepEqual(states.map((state) => state.waiting), [true, false]);
  assert.equal(states[0].request.action, 'bash');
  assert.equal(states[1].request.approved, true);
});

test('ApprovalHook does not describe external MCP calls as locally sandboxed', () => {
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

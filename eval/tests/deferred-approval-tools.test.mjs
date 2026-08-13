import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approvalArgsFingerprint,
  wrapToolsWithDeferredApprovals,
} from '../../server/src/engine/agents/deferred_approval_tools.js';

test('interactive Agent approval continues the same dynamic tool call', async () => {
  const frames = [];
  let executions = 0;
  let decisionRegistered = false;
  let resolveDecision = null;
  const [tool] = wrapToolsWithDeferredApprovals([{
    name: 'project_rules_update',
    execute: async () => {
      executions += 1;
      return { content: [{ type: 'text', text: 'updated' }], details: { success: true } };
    },
  }], {
    approvalPolicy: {
      needsConfirm: () => true,
      approvalRequest: () => ({ action: 'project_rules_update', risk: 'product_write' }),
    },
    runtime: { runId: 'run-live-1' },
    agentContext: {
      runtime_thread_id: 'thread-live-1',
      runtime_turn_id: 'turn-live-1',
      awaitDecision: (_id, scope) => {
        assert.deepEqual(scope, {
          threadId: 'thread-live-1',
          turnId: 'turn-live-1',
          itemId: 'call-live-1',
          method: 'item/dynamicTool/requestApproval',
        });
        decisionRegistered = true;
        return new Promise((resolve) => { resolveDecision = resolve; });
      },
    },
    streamCallback: async (_content, metadata) => {
      frames.push(metadata);
      if (metadata.title === 'project_rules_update') {
        assert.equal(decisionRegistered, true, '批准事件发出前已登记待确认项');
        resolveDecision?.('accept');
      }
    },
  });

  const result = await tool.execute('call-live-1', { content: '规则' });
  assert.equal(result.content[0].text, 'updated');
  assert.equal(executions, 1);
  assert.equal(frames[0].approval_request.deferred, false);
  assert.equal(frames[0].approval_request.threadId, 'thread-live-1');
  assert.equal(frames[1].title, 'approved');
});

test('deferred approval suspends before execution and exposes a durable resume handle', async () => {
  let executions = 0;
  const frames = [];
  const pending = [];
  const agentContext = {
    task_id: 'run-approval-1',
    project_id: 'project-1',
    session_id: 'session-1',
    input_data: { user_message: '写报告' },
    automation: { id: 'automation-1', run_workspace_only: true },
    data: {},
  };
  const [tool] = wrapToolsWithDeferredApprovals([
    {
      name: 'write',
      execute: async () => {
        executions += 1;
        return { content: [{ type: 'text', text: 'written' }] };
      },
    },
  ], {
    approvalPolicy: {
      needsConfirm: () => true,
      approvalRequest: () => ({ action: 'write', risk: 'file_write', approval_scope: 'once' }),
    },
    runtime: {
      runId: 'run-approval-1',
      requestApproval: async (payload, options) => {
        pending.push(payload);
        pending.push(options);
        return {
          request_id: 'call-write-1',
          run_id: 'run-approval-1',
          resume_handle: {
            type: 'approval_resume',
            run_id: 'run-approval-1',
            session_id: 'session-1',
            request_id: 'call-write-1',
          },
        };
      },
    },
    agentContext,
    streamCallback: async (_content, metadata) => frames.push(metadata),
    shortArgs: (args) => JSON.stringify(args),
  });

  const result = await tool.execute('call-write-1', { content: 'hello', path: 'report.md' });
  assert.equal(result.terminate, true);
  assert.equal(executions, 0);
  assert.equal(agentContext.data._suspended_by_approval, true);
  assert.equal(pending[0].tool_name, 'write');
  assert.equal(pending[0].automation.id, 'automation-1');
  assert.equal(pending[1].checkpoint.automation.run_workspace_only, true);
  assert.equal(frames[0].approval_request.deferred, true);
  assert.equal(frames[0].approval_request.resume_handle.type, 'approval_resume');
});

test('matching one-time approval grant executes once and then requires approval again', async () => {
  let executions = 0;
  let approvalRequests = 0;
  const args = { path: 'report.md', content: 'hello' };
  const agentContext = {
    approvalGrant: {
      approved: true,
      request_id: 'approval-1',
      tool_name: 'write',
      args_fingerprint: approvalArgsFingerprint({ content: 'hello', path: 'report.md' }),
      consumed: false,
    },
    data: {},
  };
  const [tool] = wrapToolsWithDeferredApprovals([
    {
      name: 'write',
      execute: async () => {
        executions += 1;
        return { content: [{ type: 'text', text: 'written' }] };
      },
    },
  ], {
    approvalPolicy: {
      needsConfirm: () => true,
      approvalRequest: () => ({ action: 'write' }),
    },
    runtime: {
      runId: 'run-1',
      recordEvent: async () => {},
      requestApproval: async () => {
        approvalRequests += 1;
        return { request_id: 'approval-2', run_id: 'run-1' };
      },
    },
    agentContext,
    streamCallback: async () => {},
  });

  const approved = await tool.execute('call-approved', args);
  assert.equal(approved.content[0].text, 'written');
  assert.equal(executions, 1);
  assert.equal(agentContext.approvalGrant.consumed, true);

  const repeated = await tool.execute('call-repeated', args);
  assert.equal(repeated.terminate, true);
  assert.equal(executions, 1);
  assert.equal(approvalRequests, 1);
});

test('project writeback is staged before approval and receives an applied receipt only after approval', async () => {
  const args = { project_id: 'project-1', rule_type: 'sql', content: '金额保留两位小数' };
  const staged = [];
  const completed = [];
  let executions = 0;
  let currentRules = '原规则';
  const agentContext = {
    task_id: 'run-writeback-1',
    project_id: 'project-1',
    session_id: 'session-1',
    input_data: { user_message: '更新规则' },
    data: {},
  };
  const runtime = {
    runId: 'run-writeback-1',
    stageWriteback: async (payload) => {
      staged.push(payload);
      return {
        version: 'agent_run_writeback_proposal.v1',
        proposal_hash: 'sha256:proposal',
        path: '/runs/run-writeback-1/work/writebacks/rules.proposal.json',
        kind: payload.proposal.kind,
        target: payload.proposal.target,
        document: payload.proposal,
      };
    },
    completeWriteback: async (payload) => completed.push(payload),
    requestApproval: async () => ({ request_id: 'approval-writeback', run_id: 'run-writeback-1' }),
    recordEvent: async () => {},
  };
  const rawTool = {
    name: 'project_rules_update',
    prepareWriteback: async () => ({
      kind: 'project_rules',
      target: { project_id: 'project-1', rule_type: 'sql' },
      before: { rules: currentRules },
      proposed_after: { rules: `${currentRules}\n\n金额保留两位小数` },
    }),
    readWritebackState: async () => ({ rules: currentRules }),
    execute: async () => {
      executions += 1;
      currentRules = `${currentRules}\n\n金额保留两位小数`;
      return { content: [{ type: 'text', text: 'updated' }], details: { success: true } };
    },
  };
  const makeTool = () => wrapToolsWithDeferredApprovals([rawTool], {
    approvalPolicy: {
      needsConfirm: () => true,
      approvalRequest: () => ({ action: 'project_rules_update' }),
    },
    runtime,
    agentContext,
    streamCallback: async () => {},
  })[0];

  const pending = await makeTool().execute('call-writeback', args);
  assert.equal(pending.terminate, true);
  assert.equal(executions, 0);
  assert.equal(staged.length, 1);
  assert.equal(staged[0].proposal.before.rules, '原规则');
  assert.equal(completed.length, 0);
  assert.equal(agentContext.data._pending_approval.writeback.proposal_hash, 'sha256:proposal');

  agentContext.approvalGrant = {
    approved: true,
    request_id: 'approval-writeback',
    tool_name: 'project_rules_update',
    args_fingerprint: approvalArgsFingerprint(args),
    consumed: false,
  };
  const approved = await makeTool().execute('call-writeback', args);
  assert.equal(approved.content[0].text, 'updated');
  assert.equal(executions, 1);
  assert.equal(staged.length, 2, '恢复执行时幂等读取同一草稿');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].actualAfter.rules, '原规则\n\n金额保留两位小数');
  assert.equal(completed[0].approvedRequestId, 'approval-writeback');
});

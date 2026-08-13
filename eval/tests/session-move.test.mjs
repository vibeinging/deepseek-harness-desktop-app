import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { moveSession } from '../../server/src/app/session/index.js';

function makeCtx() {
  const sessions = new Map([
    ['session-1', {
      id: 'session-1',
      project_id: '__chat__',
      title: '普通聊天',
      description: null,
      source_type: 'agent',
      source_id: '__chat__',
      action_type: 'agentic_chat',
      status: 'active',
      created_by: 'user-1',
      message_count: 2,
      session_config: JSON.stringify({
        agent_runtime_thread_id: 'thread-source',
      }),
      session_summary: null,
      created_at: '2026-07-02T00:00:00.000Z',
      updated_at: '2026-07-02T00:00:00.000Z',
    }],
  ]);
  const project = { id: 'project-1', name: '桌面项目' };
  const updatedTables = [];
  const ctx = {
    userId: 'user-1',
    updatedTables,
    async queryOne(sql, params = []) {
      if (/FROM projects p/.test(sql)) {
        return params[0] === project.id && params[1] === ctx.userId ? project : null;
      }
      if (/FROM sessions/.test(sql) && /project_id=\$2/.test(sql)) {
        const row = sessions.get(params[0]);
        return row && row.project_id === params[1] && row.created_by === params[2] ? { ...row } : null;
      }
      if (/FROM sessions WHERE id=\$1/.test(sql)) {
        const row = sessions.get(params[0]);
        return row ? { ...row } : null;
      }
      if (/FROM agent_runs/.test(sql)) return null;
      return null;
    },
    async query(sql, params = []) {
      if (/UPDATE sessions/.test(sql)) {
        const row = sessions.get(params[1]);
        row.project_id = params[0];
        row.source_type = 'agent';
        row.source_id = params[0];
        row.session_config = params[2];
        row.updated_at = '2026-07-02T00:00:01.000Z';
        return [];
      }
      const table = /UPDATE\s+([a-z_]+)/.exec(sql)?.[1];
      if (table) updatedTables.push({ table, params });
      return [];
    },
  };
  return ctx;
}

test('moveSession migrates a chat session into a project and copies workspace files', async () => {
  const originalDataRoot = process.env.DSH_DATA_ROOT;
  const dataRoot = join(tmpdir(), `dsh-session-move-${Date.now()}`);
  process.env.DSH_DATA_ROOT = dataRoot;
  const sourceDir = join(dataRoot, 'projects', '__chat__', 'session-1');
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, 'note.md'), '# Current chat notes\n');

  try {
    const ctx = makeCtx();
    const res = await moveSession(ctx, {
      params: { pid: '__chat__', sid: 'session-1' },
      body: { target_project_id: 'project-1' },
    });

    assert.equal(res.data.session.project_id, 'project-1');
    assert.equal(res.data.session.source_id, 'project-1');
    assert.equal(res.data.migrated, true);
    assert.equal(res.data.native_thread_fork_pending, true);
    assert.equal(res.data.workspace.copied_files, 1);
    assert.equal(existsSync(join(dataRoot, 'projects', 'project-1', 'note.md')), true);
    const config = JSON.parse(res.data.session.session_config);
    assert.equal(config.agent_runtime_native_move.source_thread_id, 'thread-source');
    assert.equal(config.agent_runtime_native_move.from_project_id, '__chat__');
    assert.equal(config.agent_runtime_native_move.target_project_id, 'project-1');
    assert.equal(config.agent_runtime_thread_id, undefined);
    assert.deepEqual(
      ctx.updatedTables.map((item) => item.table),
      ['agent_runs', 'agent_pending_inputs', 'llm_call_logs', 'message_feedbacks', 'session_shares', 'tasks'],
    );
  } finally {
    if (originalDataRoot === undefined) delete process.env.DSH_DATA_ROOT;
    else process.env.DSH_DATA_ROOT = originalDataRoot;
    rmSync(dataRoot, { recursive: true, force: true });
  }
});

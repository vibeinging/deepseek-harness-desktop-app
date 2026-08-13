import assert from 'node:assert/strict';
import test from 'node:test';

import { createProject } from '../../server/src/app/projects/index.js';

function transactionalContext({ failMember = false, failFolder = false } = {}) {
  const committed = [];
  return {
    committed,
    userId: 'atomic-owner',
    async queryOne(sql) {
      if (sql.includes('FROM users')) return { company_id: 'atomic-company' };
      if (sql.includes('FROM projects')) {
        return { id: 'project', name: '原子项目', description: null };
      }
      return null;
    },
    async query() {
      return [];
    },
    transaction(work) {
      const staged = [];
      const tx = {
        query(sql) {
          if (sql.includes('INSERT INTO project_members') && failMember) {
            throw new Error('member insert failed');
          }
          if (sql.includes('INSERT INTO project_source_folders') && failFolder) {
            throw new Error('source folder insert failed');
          }
          staged.push(sql);
          return [];
        },
        queryOne(sql) {
          if (sql.includes('FROM roles')) return { id: 'owner-role' };
          return null;
        },
      };
      const result = work(tx);
      committed.push(...staged);
      return result;
    },
  };
}

test('project creation rolls back the project when its owner membership cannot be written', async () => {
  const ctx = transactionalContext({ failMember: true });
  await assert.rejects(
    createProject(ctx, {
      body: { name: '原子项目', description: '' },
      params: {},
      query: {},
    }),
    /member insert failed/,
  );
  assert.deepEqual(ctx.committed, [], 'project and owner must commit as one transaction');
});

test('project creation commits the project and owner membership together', async () => {
  const ctx = transactionalContext();
  await createProject(ctx, {
    body: { name: '原子项目', description: '' },
    params: {},
    query: {},
  });
  assert.equal(ctx.committed.filter((sql) => sql.includes('INSERT INTO projects')).length, 1);
  assert.equal(ctx.committed.filter((sql) => sql.includes('INSERT INTO project_members')).length, 1);
});

test('project creation rolls back project, owner, and source folders when a source folder cannot be written', async () => {
  const ctx = transactionalContext({ failFolder: true });
  await assert.rejects(
    createProject(ctx, {
      body: {
        name: '原子项目',
        description: '',
        source_folders: [{ path: process.cwd(), access_mode: 'write' }],
      },
      params: {},
      query: {},
    }),
    /source folder insert failed/,
  );
  assert.equal(ctx.committed.filter((sql) => sql.includes('INSERT INTO projects')).length, 0);
  assert.equal(ctx.committed.filter((sql) => sql.includes('INSERT INTO project_members')).length, 0);
  assert.equal(ctx.committed.filter((sql) => sql.includes('INSERT INTO project_source_folders')).length, 0);
});

test('project creation commits project, owner, and source folders together', async () => {
  const ctx = transactionalContext();
  await createProject(ctx, {
    body: {
      name: '原子项目',
      description: '',
      source_folders: [{ path: process.cwd(), access_mode: 'write' }],
    },
    params: {},
    query: {},
  });
  assert.equal(ctx.committed.filter((sql) => sql.includes('INSERT INTO projects')).length, 1);
  assert.equal(ctx.committed.filter((sql) => sql.includes('INSERT INTO project_members')).length, 1);
  assert.equal(ctx.committed.filter((sql) => sql.includes('INSERT INTO project_source_folders')).length, 1);
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { replaceProjectSourceFolders } from '../../server/src/app/projects/source_folders.js';

test('reordering project roots preserves stable ids and moves the single write target', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-project-roots-'));
  const firstInput = join(temp, 'first');
  const secondInput = join(temp, 'second');
  mkdirSync(firstInput);
  mkdirSync(secondInput);
  const first = realpathSync(firstInput);
  const second = realpathSync(secondInput);
  const rows = [
    {
      id: 'root-first', project_id: 'project-1', local_path: first, display_name: 'First',
      access_mode: 'write', sort_order: 0, created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z', deleted_at: null,
    },
    {
      id: 'root-second', project_id: 'project-1', local_path: second, display_name: 'Second',
      access_mode: 'read', sort_order: 1, created_at: '2026-08-01T00:00:01.000Z',
      updated_at: '2026-08-01T00:00:01.000Z', deleted_at: null,
    },
  ];
  const db = {
    async query(sql, args = []) {
      if (sql.includes('SELECT id, local_path, access_mode, deleted_at')) {
        return rows.map((row) => ({
          id: row.id,
          local_path: row.local_path,
          access_mode: row.access_mode,
          deleted_at: row.deleted_at,
        }));
      }
      if (sql.includes('SET deleted_at=now()')) {
        rows.forEach((row) => { row.deleted_at = 'deleted'; });
        return [];
      }
      if (sql.includes('SET display_name=$3, access_mode=$4')) {
        const [id, projectId, name, accessMode, sortOrder] = args;
        const row = rows.find((item) => item.id === id && item.project_id === projectId);
        Object.assign(row, {
          display_name: name,
          access_mode: accessMode,
          sort_order: sortOrder,
          deleted_at: null,
        });
        return [];
      }
      if (sql.includes('SELECT id, project_id, local_path, display_name, access_mode')) {
        return rows
          .filter((row) => row.project_id === args[0] && row.deleted_at === null)
          .sort((left, right) => left.sort_order - right.sort_order);
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };

  try {
    const result = await replaceProjectSourceFolders(db, 'project-1', [
      { path: second, name: 'Second', write_target: true },
      { path: first, name: 'First' },
    ], 'user-1');
    assert.deepEqual(result.map((row) => ({ id: row.id, access: row.access_mode })), [
      { id: 'root-second', access: 'write' },
      { id: 'root-first', access: 'read' },
    ]);
    assert.equal(result.filter((row) => row.write_target).length, 1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

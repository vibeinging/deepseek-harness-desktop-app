import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { dataPath, dataRoot } from '../../server/src/config/paths.js';
import { INTERMEDIATE_DIR } from '../../server/src/engine/datasources/intermediate_storage_service.js';

test('DSH_DATA_ROOT controls persistent server paths', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-root-'));
  const previous = process.env.DSH_DATA_ROOT;
  try {
    process.env.DSH_DATA_ROOT = tempDir;
    assert.equal(dataRoot(), tempDir);
    assert.equal(dataPath('projects', 'demo'), join(tempDir, 'projects', 'demo'));
  } finally {
    if (previous === undefined) delete process.env.DSH_DATA_ROOT;
    else process.env.DSH_DATA_ROOT = previous;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('intermediate storage no longer points to the removed Python backend', () => {
  assert.equal(INTERMEDIATE_DIR.includes(`${join('backend', 'sources', 'intermediate')}`), false);
  assert.equal(INTERMEDIATE_DIR, dataPath('intermediate'));
});

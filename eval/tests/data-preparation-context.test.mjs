import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProjectDataPreparationContext } from '../../server/src/engine/semantic/data_preparation_context.js';

const db = { query() {}, queryOne() {} };

test('query remains available when the project has never run data preparation', async () => {
  const context = await resolveProjectDataPreparationContext(db, 'raw-project', {
    getLatestRevisionFn: async () => null,
  });
  assert.deepEqual(context, {
    mode: 'no_preparation_run',
    project_id: 'raw-project',
    revision_id: null,
    revision: null,
    status: 'not_run',
    enhancement_level: 'raw',
  });
});

for (const [status, mode, enhancementLevel] of [
  ['running', 'last_run_running', 'raw_or_partial'],
  ['completed', 'last_run_completed', 'complete'],
  ['partial', 'last_run_partial', 'partial'],
  ['failed', 'last_run_failed', 'raw_or_partial'],
]) {
  test(`latest ${status} preparation run is context, never a query gate`, async () => {
    const context = await resolveProjectDataPreparationContext(db, `${status}-project`, {
      getLatestRevisionFn: async () => ({
        id: `revision-${status}`,
        revision: 4,
        status,
        coverage_summary: { source_count: 2 },
        failure_details: status === 'failed' ? [{ message: 'embedding failed' }] : null,
      }),
    });
    assert.equal(context.mode, mode);
    assert.equal(context.status, status);
    assert.equal(context.enhancement_level, enhancementLevel);
    assert.equal(context.revision_id, `revision-${status}`);
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DATA_PREPARATION_MODES,
  resolveDataPreparationPolicy,
} from '../../server/src/engine/semantic/data_preparation_policy.js';

test('interactive import defaults to schema preparation without LLM descriptions', () => {
  assert.deepEqual(resolveDataPreparationPolicy({}), {
    mode: DATA_PREPARATION_MODES.SCHEMA,
    enabled: true,
    descriptions: false,
    phase: 'offline_data_preparation',
  });
});

test('description generation requires explicit full offline preparation', () => {
  assert.equal(resolveDataPreparationPolicy({ preparation_mode: 'full' }).descriptions, true);
  assert.equal(resolveDataPreparationPolicy({ preparation_mode: 'schema' }).descriptions, false);
  assert.deepEqual(resolveDataPreparationPolicy({ preparation_mode: 'none' }), {
    mode: DATA_PREPARATION_MODES.NONE,
    enabled: false,
    descriptions: false,
    phase: 'offline_data_preparation',
  });
});

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inspectIsolatedTestEnvironment,
  requireIsolatedTestEnvironment,
} from './test-environment.mjs'

const isolatedEnv = {
  DSH_TEST_ISOLATED: '1',
  DSH_DATA_ROOT: '/tmp/dsh-unit-example',
  DB_SQLITE_PATH: '/tmp/dsh-unit-example/local.db',
  DSH_AGENT_RUNTIME_HOME: '/tmp/dsh-unit-example/agent_runtime',
  DSH_SKILLS_ROOT: '/tmp/dsh-unit-example/skills',
}

test('isolated test environment requires the setup marker and scoped paths', () => {
  assert.equal(inspectIsolatedTestEnvironment(isolatedEnv).isolated, true)
  assert.throws(
    () => requireIsolatedTestEnvironment('unsafe.test.mjs', {
      ...isolatedEnv,
      DSH_TEST_ISOLATED: '',
    }),
    (error) => error.code === 'TEST_ENVIRONMENT_NOT_ISOLATED'
      && error.message.includes('--import ./eval/tests/setup.mjs'),
  )
  assert.throws(
    () => requireIsolatedTestEnvironment('unsafe.test.mjs', {
      ...isolatedEnv,
      DB_SQLITE_PATH: '/Users/example/.dsh/local.db',
    }),
    (error) => error.code === 'TEST_ENVIRONMENT_NOT_ISOLATED'
      && error.message.includes('outside DSH_DATA_ROOT: DB_SQLITE_PATH'),
  )
})

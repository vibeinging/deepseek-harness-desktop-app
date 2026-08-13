import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after } from 'node:test'

if (!process.env.DB_SQLITE_PATH) {
  const testDataDir = mkdtempSync(join(tmpdir(), 'dsh-unit-'))
  process.env.DSH_TEST_ISOLATED = '1'
  process.env.DB_SQLITE_PATH = join(testDataDir, 'local.db')
  if (!process.env.DSH_DATA_ROOT) process.env.DSH_DATA_ROOT = testDataDir
  if (!process.env.DSH_AGENT_RUNTIME_HOME) process.env.DSH_AGENT_RUNTIME_HOME = join(testDataDir, 'agent_runtime')
  if (!process.env.DSH_SKILLS_ROOT) process.env.DSH_SKILLS_ROOT = join(testDataDir, 'skills')
  process.on('exit', () => {
    rmSync(testDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
}
if (!process.env.DSH_DATA_ROOT && process.env.DB_SQLITE_PATH) {
  process.env.DSH_DATA_ROOT = dirname(process.env.DB_SQLITE_PATH)
}
if (!process.env.DSH_AGENT_RUNTIME_HOME && process.env.DSH_DATA_ROOT) {
  process.env.DSH_AGENT_RUNTIME_HOME = join(process.env.DSH_DATA_ROOT, 'agent_runtime')
}
if (!process.env.DSH_SKILLS_ROOT && process.env.DSH_DATA_ROOT) {
  process.env.DSH_SKILLS_ROOT = join(process.env.DSH_DATA_ROOT, 'skills')
}

after(async () => {
  const [{ stopAgentRuntime }, { closeYiTraceDb }] = await Promise.all([
    import('../../server/src/engine/agent_kernel/agent_runtime.js'),
    import('../../server/src/app/traces/yitrace_service.js'),
  ])
  await Promise.allSettled([stopAgentRuntime(), closeYiTraceDb()])
})

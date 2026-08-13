import { describe, expect, it } from 'vitest'
import {
  canStopRun,
  compactRunValue,
  latestRunFailure,
  runArtifactName,
  runStatusLabel,
  waitingRunMessage
} from './runCenterModel'

describe('run center model', () => {
  it('maps durable waiting states and releases-slot copy', () => {
    expect(runStatusLabel('waiting_approval')).toBe('等待审批')
    expect(waitingRunMessage({ id: 'r1', session_id: 's1', status: 'waiting_approval' })).toContain('释放执行槽')
    expect(canStopRun({ id: 'r1', session_id: 's1', status: 'waiting_approval' })).toBe(true)
  })

  it('finds the latest failure and keeps compact facts readable', () => {
    const failure = latestRunFailure([
      { id: 'e1', seq: 1, event_type: 'run_started' },
      { id: 'e2', seq: 2, event_type: 'run_failed', error_code: 'FAILED', error_message: 'boom' }
    ])
    expect(failure?.error_message).toBe('boom')
    expect(compactRunValue({ path: 'report.md', content: 'x'.repeat(220) }).length).toBeLessThanOrEqual(160)
    expect(runArtifactName('/tmp/project/report.md')).toBe('report.md')
  })
})

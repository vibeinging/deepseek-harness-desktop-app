import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const runCenterSource = readFileSync(fileURLToPath(new URL('./RunCenter.tsx', import.meta.url)), 'utf8')
const workstationSource = readFileSync(
  fileURLToPath(new URL('../../layout/workstation/Workstation.tsx', import.meta.url)),
  'utf8'
)
const shellSource = readFileSync(fileURLToPath(new URL('./AgentShell.tsx', import.meta.url)), 'utf8')

describe('agent run center layout contract', () => {
  it('keeps run facts in the real workstation', () => {
    expect(runCenterSource).toContain('data-run-center')
    expect(runCenterSource).toContain('listAgentRuns')
    expect(runCenterSource).toContain('getAgentRun')
    expect(runCenterSource).not.toContain('data-run-action="stop"')
    expect(runCenterSource).not.toContain('data-run-action="recover"')
    expect(runCenterSource).not.toContain('data-run-action="archive"')
    expect(runCenterSource).not.toContain('data-run-action="delete"')
    expect(runCenterSource).not.toContain('stopAgentRun')
    expect(runCenterSource).toContain('data-run-subtasks')
    expect(runCenterSource).toContain('data-subtask-type')
    expect(runCenterSource).toContain('data-native-subagents')
    expect(runCenterSource).toContain('getAgentSubagentThread')
    expect(runCenterSource).toContain('协作子任务')
    expect(workstationSource).toContain("useState<'runs' | 'trace'>('runs')")
    expect(workstationSource).not.toContain('data-workstation-view="automations"')
    expect(workstationSource).toContain('<RunCenter')
  })

  it('opens the workstation for a selected historical session', () => {
    expect(shellSource).toContain(
      "const mountWorkbench = mainView !== 'plugins' && !showOnboarding && !initializing"
    )
    expect(shellSource).toContain('const hasWorkbenchContext = mountWorkbench && !showSearch')
    expect(shellSource).toContain("openWorkbenchTab('review')")
    expect(shellSource).toContain('{hasWorkbenchContext && (')
  })
})

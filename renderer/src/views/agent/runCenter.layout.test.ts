import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const workstationSource = readFileSync(
  fileURLToPath(new URL('../../layout/workstation/Workstation.tsx', import.meta.url)),
  'utf8'
)
const shellSource = readFileSync(fileURLToPath(new URL('./AgentShell.tsx', import.meta.url)), 'utf8')

describe('agent run center layout contract', () => {
  it('uses the canonical DSH trajectory as the review source', () => {
    expect(workstationSource).toContain('data-dsh-trajectory')
    expect(workstationSource).toContain('data-dsh-trajectory-event')
    expect(workstationSource).toContain('data-dsh-trajectory-projections')
    expect(workstationSource).toContain('getDshSessionTrajectory')
    expect(workstationSource).toContain('session.history')
    expect(workstationSource).toContain("entry.event.type === 'tool/call'")
    expect(workstationSource).toContain("entry.event.type === 'assistant/message'")
    expect(workstationSource).not.toContain('getAgentSessionTraces')
    expect(workstationSource).not.toContain('getAgentRun')
    expect(workstationSource).not.toContain('<RunCenter')
    expect(workstationSource).not.toContain('data-workstation-view="automations"')
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

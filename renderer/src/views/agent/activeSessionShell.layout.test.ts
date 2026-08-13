import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const shell = readFileSync(fileURLToPath(new URL('./AgentShell.tsx', import.meta.url)), 'utf8')
const conversation = readFileSync(fileURLToPath(new URL('./AgentConversation.tsx', import.meta.url)), 'utf8')

describe('Agent workspace restoration wiring', () => {
  it('does not send an unvalidated saved project id to project APIs during first render', () => {
    expect(shell).toContain("const [activeWs, setActiveWs] = useState('')")
    expect(shell).toContain('const [activeId, setActiveId] = useState<string | null>(null)')
    expect(shell).not.toContain('useState(() => loadAgentActiveSessionState().activeWs)')
    expect(shell).toContain('activeSessionResolvedRef.current = true')
    expect(shell).toContain('if (initializing || !activeSessionResolvedRef.current) return')
    expect(shell).toContain('if (initialWorkspaceLoadStartedRef.current) return undefined')
    expect(shell).toContain('initialWorkspaceLoadStartedRef.current = true')
    expect(shell).toContain('}, [loadConvs, setCurrentProject])')
    expect(shell).not.toContain('}, [currentProject?.id, loadConvs, setCurrentProject])')
  })

  it('keeps the current conversation when opening settings for the active workspace', () => {
    const openConfigStart = shell.indexOf('const openConfig = useCallback(')
    const settingsHashEffectStart = shell.indexOf('useEffect(() => {', openConfigStart)
    const openConfig = shell.slice(openConfigStart, settingsHashEffectStart)

    expect(openConfig).toMatch(/if \(activeWs !== wsId\) setActiveId\(null\)/)
    expect(openConfig).toContain('[activeWs, allWorkspaces, leaveTemporaryConversation, setCurrentProject]')
  })

  it('does not clear a newly selected Session from a lagging sidebar refresh', () => {
    const refreshStart = shell.indexOf('const refresh = useCallback(')
    const statusStreamStart = shell.indexOf('// One long-lived status stream', refreshStart)
    const refresh = shell.slice(refreshStart, statusStreamStart)

    expect(refresh).toContain('await loadConvs([workspaceId])')
    expect(refresh).not.toContain('setActiveId(null)')
    expect(refresh).not.toContain('listAgentSessions(workspaceId)')
  })

  it('does not treat a just-created Session as an empty draft before its prompt is durable', () => {
    expect(conversation).toContain('newlyCreatedSessionIdRef.current = sid')
    expect(conversation).toContain('newlyCreatedSessionIdRef.current === selectedId')
    expect(conversation).toContain("setConversationLoadState('idle')")
  })
})

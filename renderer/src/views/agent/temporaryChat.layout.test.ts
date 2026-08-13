import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('temporary chat product contract', () => {
  it('has an explicit entry, local privacy notice and cleanup lifecycle', () => {
    const nav = read('./AgentNav.tsx')
    const shell = read('./AgentShell.tsx')
    const conversation = read('./AgentConversation.tsx')
    const api = read('../../api/agent.ts')

    expect(nav).toContain('data-agent-nav="temporary-chat"')
    expect(nav).toContain('临时对话不会出现在历史记录中')
    expect(shell).toContain('cleanupTemporaryAgentSessions')
    expect(shell).toContain('deleteAgentSession(pending.projectId, pending.id)')
    expect(shell).toContain('setActiveWs(CHAT_WS.id)')
    expect(conversation).toContain('createAgentSession(projectId, title, { temporary })')
    expect(conversation).toContain('这段对话不会出现在历史记录中，也不会读取或写入任何对话记忆')
    expect(conversation).toContain('if (temporary) return')
    expect(api).toContain("url: '/api/sessions/temporary/cleanup'")
  })

  it('leaves a temporary conversation before opening the Profile directory', () => {
    const shell = read('./AgentShell.tsx')
    const start = shell.indexOf('const openPluginDirectory')
    const end = shell.indexOf('useEffect(() => {', start)
    const handler = shell.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(handler).toContain('if (!leaveTemporaryConversation()) return')
    expect(handler).toContain("setMainView('plugins')")
  })

  it('keeps Library readable but disables every artifact write entry', () => {
    const shell = read('./AgentShell.tsx')
    const artifacts = read('./WorkspaceArtifactsSection.tsx')
    const files = read('./WorkspaceFilesSection.tsx')

    expect(shell).toMatch(/<WorkspaceArtifactsSection[\s\S]*temporary=\{temporaryMode\}/)
    expect(shell).toMatch(/<WorkspaceFilesSection[\s\S]*temporary=\{temporaryMode\}/)
    expect(artifacts).toContain('!temporary && officeFormat')
    expect(artifacts).toContain('restoring || temporary')
    expect(files).toContain("preview.scope === 'project' && !temporary")
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('conversation move product contract', () => {
  it('does not offer a dead cross-workspace action while DSH keeps cwd fixed', () => {
    const nav = read('./AgentNav.tsx')
    const shell = read('./AgentShell.tsx')
    const modal = read('./ConversationMoveModal.tsx')
    const api = read('../../api/agent.ts')

    expect(nav).toContain("label: '移动对话（DSH 暂不支持）'")
    expect(nav).toMatch(/key: 'move',[\s\S]*?disabled: true/)
    expect(nav).not.toContain('onMoveConv?.(wsId, c.id, c.title')
    expect(shell).toContain('await moveAgentSession(')
    expect(shell).toContain('moveConversationLocalState(request.fromProjectId, targetProjectId, request.conversationId)')
    expect(shell).toContain('await loadConvs([request.fromProjectId, targetProjectId])')
    expect(shell).toContain('<ConversationMoveModal')
    expect(modal).toContain('移动后会保留历史记录')
    expect(api).toContain('target_project_id: targetProjectId')
  })
})

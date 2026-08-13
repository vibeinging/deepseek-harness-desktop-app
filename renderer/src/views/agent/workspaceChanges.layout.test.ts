import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const conversationSource = readFileSync(fileURLToPath(new URL('./AgentConversation.tsx', import.meta.url)), 'utf8')
const changesSource = readFileSync(fileURLToPath(new URL('./WorkspaceChanges.tsx', import.meta.url)), 'utf8')
const stylesheet = readFileSync(fileURLToPath(new URL('./agent.module.scss', import.meta.url)), 'utf8')

describe('workspace changes review interaction', () => {
  it('keeps one persistent Changes entry and reuses the same panel from file cards', () => {
    expect(conversationSource).toContain('<ChangesButton')
    expect(conversationSource).toContain('<ChangesReviewPanel')
    expect(conversationSource).toContain('onReviewChanges={() => openChanges(m.turnId)}')
    expect(conversationSource).toContain("if (!projectId || projectId === CHAT_WS.id)")
    expect(changesSource).toContain('查看更改')
    expect(changesSource).toContain('role="dialog"')
    expect(changesSource).toContain('本轮生成')
    expect(changesSource).toContain('data-testid="workspace-changes-open"')
    expect(changesSource).toContain('data-testid="workspace-changes-panel"')
    expect(changesSource).toContain('data-testid="workspace-line-edit-open"')
    expect(changesSource).toContain('data-testid="workspace-changes-open-editor"')
    expect(changesSource).toContain('data-selectable="true"')
    expect(stylesheet).toContain(".diffLine[data-selectable='true']")
  })

  it('uses a side panel on desktop and a full-screen review surface on narrow screens', () => {
    const panelRule = stylesheet.match(/\.changesPanel\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    expect(panelRule).toContain('width: min(980px, calc(100vw - 72px))')
    expect(stylesheet).toContain('@media (max-width: 760px)')
    expect(stylesheet).toMatch(/@media \(max-width: 760px\)[\s\S]*?\.changesPanel\s*\{[\s\S]*?width:\s*100vw/)
  })
})

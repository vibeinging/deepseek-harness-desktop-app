import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('local global chat memory contract', () => {
  it('provides two independent controls plus manual entry CRUD and source exclusions', () => {
    const page = read('./GlobalChatMemory.tsx')
    const settings = read('./AgentSettings.tsx')
    const api = read('../../api/agent.ts')

    expect(settings).toContain("{ key: 'memory', label: '记忆'")
    expect(settings).toContain("active === 'memory'")
    expect(page).toContain('data-testid="saved-memory-toggle"')
    expect(page).toContain('data-testid="chat-history-toggle"')
    expect(page).toContain('data-testid="memory-entry-add"')
    expect(page).toContain('data-testid="memory-entry-edit"')
    expect(page).toContain('data-testid="memory-entry-delete"')
    expect(page).toContain('data-testid="memory-source-toggle"')
    expect(page).toContain('data-testid="memory-audit-list"')
    expect(api).toContain("url: '/api/agent/chat-memory'")
    expect(api).toContain('/api/agent/chat-memory/entries/${pe(entryId)}')
    expect(api).toContain('/api/agent/chat-memory/exclusions/${pe(sessionId)}')
  })

  it('shows memory use in the answer timeline and explains temporary chat isolation', () => {
    const conversation = [read('./AgentConversation.tsx'), read('./conversation/AssistantContent.tsx')].join('\n')
    const styles = read('./agent.module.scss')

    expect(conversation).toContain('data-global-memory')
    expect(conversation).toContain('已提供本机记忆')
    expect(conversation).toContain('回答不一定逐项采用')
    expect(conversation).toContain('条记忆')
    expect(conversation).toContain('个对话')
    expect(conversation).toContain('data-global-memory-entry')
    expect(conversation).toContain('data-global-memory-conversation')
    expect(conversation).toContain('不会读取或写入任何对话记忆')
    expect(styles).toContain('.globalMemoryEntry')
    expect(styles).toContain('.projectMemoryDisclosure')
  })

  it('sends the capability explicitly with every desktop and browser turn', () => {
    const conversation = read('./AgentConversation.tsx')
    const api = read('../../api/agent.ts')

    expect(conversation).toContain('globalChatMemory: true')
    expect(api).toContain('globalChatMemory: boolean')
  })
})

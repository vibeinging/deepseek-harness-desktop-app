import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const component = readFileSync(new URL('./components/ProjectChatMemory.tsx', import.meta.url), 'utf8')
const settings = readFileSync(new URL('./index.tsx', import.meta.url), 'utf8')
const conversation = readFileSync(new URL('../../agent/AgentConversation.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../../../api/agent.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./components/ProjectChatMemory.module.scss', import.meta.url), 'utf8')

describe('project conversation memory contract', () => {
  it('adds one host settings page with enable and per-conversation controls', () => {
    expect(settings).toContain("'chat-memory'")
    expect(settings).toContain('<ProjectChatMemory')
    expect(settings).toContain("project.settings.tabs.chatMemory")
    expect(component).toContain('updateProjectChatMemory(projectId, enabled)')
    expect(component).toContain('excludeProjectChatMemoryConversation(projectId, sessionId)')
    expect(component).toContain('includeProjectChatMemoryConversation(projectId, sessionId)')
    expect(component).toContain("conversation.excluded ? t('project.chatMemory.include') : t('project.chatMemory.exclude')")
    expect(styles).toContain(".row[data-excluded='true']")
  })

  it('uses authenticated project endpoints without showing a timeline badge', () => {
    expect(api).toContain('/chat-memory`')
    expect(api).toContain('/chat-memory/exclusions/${pe(sessionId)}`')
    expect(conversation).toContain('projectChatMemory: true')
    expect(conversation).not.toContain('data-project-memory')
    expect(conversation).not.toContain('参考了项目历史')
    expect(conversation).not.toContain('productSurface')
  })
})

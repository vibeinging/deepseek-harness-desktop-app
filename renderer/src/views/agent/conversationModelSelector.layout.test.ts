import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const selector = readFileSync(
  fileURLToPath(new URL('./ConversationModelSelector.tsx', import.meta.url)),
  'utf8'
)
const conversation = readFileSync(
  fileURLToPath(new URL('./AgentConversation.tsx', import.meta.url)),
  'utf8'
)
describe('conversation model selector', () => {
  it('opens inside the composer and exposes model runtime choices', () => {
    expect(conversation).toContain('<ConversationModelSelector')
    expect(conversation).toContain('model: modelRuntime?.modelId')
    expect(selector).toContain("type Section = 'model' | 'reasoning' | 'summary' | 'verbosity'")
    expect(selector).toContain('reasoningSummary')
    expect(selector).toContain('capabilities?.reasoning_efforts')
    expect(selector).toContain('reasoning_effort_options')
    expect(selector).toContain('capabilityOptions(')
    expect(selector).toContain('supportedReasoning.length > 0')
    expect(selector).toContain('supportedVerbosity.length > 0')
    expect(selector).toContain('position="top-end"')
  })

  it('keeps model management as a secondary action', () => {
    expect(selector).toContain('管理模型')
    expect(selector).toContain('onOpenSettings')
    expect(selector).toContain('chooseModel')
  })

  it('uses the DSH Session current target instead of a local model authority', () => {
    expect(selector).toContain('item.id === currentId')
    expect(selector).not.toContain('localStorage')
    expect(conversation).toContain('conversationId={sessionId}')
    expect(conversation).not.toContain('persistConversationModelRuntime')
  })

  it('uses model-specific labels without a built-in recommendation marker', () => {
    expect(selector).not.toContain('（推荐）')
    expect(selector).toContain('configuredByValue.get(value)?.label?.trim()')
    expect(selector).not.toContain('reasoning_effort_default || reasoningEfforts[0]')
  })
})

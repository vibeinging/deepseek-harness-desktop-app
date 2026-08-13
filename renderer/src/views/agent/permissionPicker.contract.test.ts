import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const picker = readFileSync(fileURLToPath(new URL('./PermissionPicker.tsx', import.meta.url)), 'utf8')
const conversation = readFileSync(fileURLToPath(new URL('./AgentConversation.tsx', import.meta.url)), 'utf8')
const api = readFileSync(fileURLToPath(new URL('../../api/agent.ts', import.meta.url)), 'utf8')

describe('DSH session permission picker', () => {
  it('renders only the DSH projection and protects the full-access choice', () => {
    expect(picker).toContain('value.options.map')
    expect(picker).toContain("option.value === 'custom'")
    expect(picker).toContain("option.value === 'danger-full-access'")
    expect(picker).toContain('确认启用完全访问')
    expect(picker).toContain('role="menuitemradio"')
    expect(picker).toContain('aria-checked={selected}')
  })

  it('uses DSH session state as the only read source and command endpoint as the write path', () => {
    expect(conversation).toContain('state?.projections?.permissions')
    expect(conversation).toContain('setDshSessionPermission(projectId, currentSessionId, preset)')
    expect(conversation).not.toContain('loadConversationApproval')
    expect(conversation).not.toContain('persistConversationApproval')
    expect(api).toContain('/dsh-permission`')
  })
})

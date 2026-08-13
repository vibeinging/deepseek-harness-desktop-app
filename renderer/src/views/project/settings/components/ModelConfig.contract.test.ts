import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectSettings = readFileSync(
  fileURLToPath(new URL('./ModelConfig.tsx', import.meta.url)),
  'utf8'
)
const systemModelForm = readFileSync(
  fileURLToPath(new URL('../../../models/components/ModelForm.tsx', import.meta.url)),
  'utf8'
)

describe('Agent model settings contract', () => {
  it('keeps project settings DSH-like and excludes ultra', () => {
    expect(projectSettings).toContain('reasoningEffort')
    expect(projectSettings).not.toContain("'ultra'")
    expect(projectSettings).not.toContain('extraBodyText')
    expect(projectSettings).not.toContain('api_key')
    expect(projectSettings).toContain('items.find((item) => item?.is_enabled')
  })

  it('only offers Agent protocols and hides extra body for direct Responses', () => {
    expect(systemModelForm).toContain("value: 'responses'")
    expect(systemModelForm).toContain("value: 'chat_completions'")
    expect(systemModelForm).not.toContain("value: 'ultra'")
    expect(systemModelForm).toContain("modelForm.api_format === 'chat_completions'")
  })
})

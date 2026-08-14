import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectSettings = readFileSync(
  fileURLToPath(new URL('./ModelConfig.tsx', import.meta.url)),
  'utf8'
)
const systemModels = readFileSync(
  fileURLToPath(new URL('../../../models/index.tsx', import.meta.url)),
  'utf8'
)

describe('Agent model settings contract', () => {
  it('keeps project settings DSH-like and excludes ultra', () => {
    expect(projectSettings).toContain('模型由 DSH Profile 统一管理')
    expect(projectSettings).toContain('<Models showHeader={false} />')
    expect(projectSettings).not.toContain("'ultra'")
    expect(projectSettings).not.toContain('extraBodyText')
    expect(projectSettings).not.toContain('api_key')
    expect(systemModels).toContain('reasoningEffort')
  })

  it('only offers Agent protocols and hides extra body for direct Responses', () => {
    expect(systemModels).toContain("value: 'openai-responses'")
    expect(systemModels).toContain("value: 'openai-completions'")
    expect(systemModels).toContain("value: 'anthropic-messages'")
    expect(systemModels).not.toContain("value: 'ultra'")
    expect(systemModels).not.toContain('extraBodyText')
    expect(systemModels).toContain('getDshModelSettingsReq')
    expect(systemModels).toContain('mutateDshModelSettingsReq')
  })
})

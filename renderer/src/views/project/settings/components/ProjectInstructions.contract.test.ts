import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const component = readFileSync(
  fileURLToPath(new URL('./ProjectInstructions.tsx', import.meta.url)),
  'utf8'
)
const settingsPage = readFileSync(
  fileURLToPath(new URL('../index.tsx', import.meta.url)),
  'utf8'
)

describe('project instructions settings contract', () => {
  it('offers one project-scoped editor backed by the real project update API', () => {
    expect(component).toMatch(/updateProjectReq\(project\.id, \{ instructions \}\)/)
    expect(component).toMatch(/MAX_INSTRUCTIONS_LENGTH = 8_000/)
    expect(component).toMatch(/readOnly=\{!canEdit\}/)
    expect(settingsPage).toMatch(/case 'instructions'/)
    expect(settingsPage).toMatch(/project\.settings\.tabs\.instructions/)
  })
})

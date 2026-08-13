import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  fileURLToPath(new URL('./GuideStepMetadata.tsx', import.meta.url)),
  'utf8'
)

describe('metadata generation flow', () => {
  it('uses one batch vector request and includes vectors in overall completion', () => {
    expect(source).toContain('storeTableVectorsReq')
    expect(source).not.toContain('storeSingleTableVectorReq')
    expect(source).not.toContain('storeTableColumnsVectorReq')
    expect(source).toMatch(/isDatabaseDescCompleted\s*&&\s*allVectorsCompleted/)
  })

  it('exposes progress and busy states to assistive technology', () => {
    expect(source).toContain('role="progressbar"')
    expect(source).toContain('aria-valuenow=')
    expect(source).toContain('aria-busy=')
    expect(source).toContain('aria-live="polite"')
  })
})

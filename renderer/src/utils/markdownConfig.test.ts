import { describe, expect, it } from 'vitest'

import { addHostDocumentSecurityMetadata, renderSafeMarkdown } from './markdownConfig'

describe('safe markdown rendering', () => {
  it('does not execute raw HTML or unsafe link protocols from Skill files', () => {
    const html = renderSafeMarkdown('<img src=x onerror="alert(1)"> [run](javascript:alert(2))')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<a ')
    expect(html).toContain('&lt;img')
  })
})

describe('addHostDocumentSecurityMetadata', () => {
  it('keeps remote images while suppressing referrer data', () => {
    const html = addHostDocumentSecurityMetadata(
      '<html><head></head><body><img src="https://images.example/report.png" alt="report"></body></html>',
    )

    expect(html).toContain('<meta name="referrer" content="no-referrer">')
    expect(html).toContain('src="https://images.example/report.png"')
  })
})

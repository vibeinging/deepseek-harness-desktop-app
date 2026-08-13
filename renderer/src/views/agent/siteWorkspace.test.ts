import { describe, expect, it } from 'vitest'
import {
  buildSitePreviewDocument,
  normalizeSiteElementSelection,
  SITE_PREVIEW_CHANNEL
} from './SiteWorkspace'

describe('local Site preview security contract', () => {
  it('injects a fixed offline CSP and annotation runtime without changing original interactions', () => {
    const html = '<!doctype html><html><head><base href="https://example.com"><meta http-equiv="Content-Security-Policy" content="default-src *"><script src="https://bad.invalid/x.js"></script></head><body><button id="go">运行</button><script>window.localReady=true</script></body></html>'
    const preview = buildSitePreviewDocument(html, 'token-1')

    expect(preview).toContain("default-src 'none'")
    expect(preview).toContain("connect-src 'none'")
    expect(preview).toContain("form-action 'none'")
    expect(preview).toContain("frame-src 'none'")
    expect(preview).toContain(SITE_PREVIEW_CHANNEL)
    expect(preview).toContain('window.localReady=true')
    expect(preview).not.toContain('<base href=')
    expect((preview.match(/Content-Security-Policy/g) || []).length).toBe(1)
  })

  it('wraps fragments and escapes token text before putting it in a script', () => {
    const preview = buildSitePreviewDocument('<button>片段</button>', '</script><script>bad()</script>')
    expect(preview).toMatch(/^<!doctype html><html/)
    expect(preview).toContain('<body><button>片段</button></body>')
    expect(preview).not.toContain('const token = "</script>')
    expect(preview).toContain('\\u003c/script>')
  })
})

describe('local Site element selection validation', () => {
  it('keeps only bounded plain element metadata', () => {
    expect(normalizeSiteElementSelection({
      selector: 'body > main > button:nth-of-type(2)',
      tag: 'BUTTON',
      text: '  保存   页面  ',
      ariaLabel: '保存',
      bounds: { x: 10, y: 20, width: 120, height: 36 }
    })).toEqual({
      selector: 'body > main > button:nth-of-type(2)',
      tag: 'button',
      text: '保存 页面',
      ariaLabel: '保存',
      bounds: { x: 10, y: 20, width: 120, height: 36 }
    })
  })

  it('rejects malformed messages and impossible rectangles', () => {
    expect(normalizeSiteElementSelection(null)).toBeNull()
    expect(normalizeSiteElementSelection({ selector: '', tag: 'button', bounds: {} })).toBeNull()
    expect(normalizeSiteElementSelection({ selector: '#x', tag: 'input[type=password]', bounds: { x: 0, y: 0, width: 10, height: 10 } })).toBeNull()
    expect(normalizeSiteElementSelection({ selector: '#x', tag: 'div', bounds: { x: 0, y: 0, width: -1, height: 10 } })).toBeNull()
    expect(normalizeSiteElementSelection({ selector: `#${'x'.repeat(700)}`, tag: 'div', bounds: { x: 0, y: 0, width: 10, height: 10 } })).toBeNull()
  })
})

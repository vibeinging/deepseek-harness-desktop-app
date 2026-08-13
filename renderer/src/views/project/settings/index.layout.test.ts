import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  fileURLToPath(new URL('./index.module.scss', import.meta.url)),
  'utf8'
)
const source = readFileSync(
  fileURLToPath(new URL('./index.tsx', import.meta.url)),
  'utf8'
)

describe('project settings content layout', () => {
  it('provides a definite full height for child detail pages', () => {
    const shellContentRule = stylesheet.match(/\.shellContent\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(shellContentRule).toMatch(/^\s*height:\s*100%\s*;/m)
    expect(shellContentRule).toMatch(/^\s*min-height:\s*0\s*;/m)
  })

  it('does not activate a host-hidden tab through the URL hash', () => {
    expect(source).toMatch(/const isAllowedTab = useCallback/)
    expect(source).toMatch(/allowedTabs\.has\(tabName\) && !hiddenTabs\.includes\(tabName\)/)
    expect(source).toMatch(/if \(!isAllowedTab\(tabName\)\) \{[\s\S]*replaceHash\(`#\$\{fallbackTab\}`\)/)
    expect(source).toMatch(/if \(!isAllowedTab\(name\)\) return null/)
  })

  it('contains only Host-owned project settings tabs', () => {
    expect(source).toContain("const HOST_TABS = ['basic', 'instructions', 'chat-memory', 'models'] as const")
    expect(source).not.toContain('PluginPageHost')
    expect(source).not.toContain('project_plugin_mounts')
  })
})

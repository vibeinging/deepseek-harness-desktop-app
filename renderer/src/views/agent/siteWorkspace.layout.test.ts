import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const siteSource = readFileSync(new URL('./SiteWorkspace.tsx', import.meta.url), 'utf8')
const shellSource = readFileSync(new URL('./AgentShell.tsx', import.meta.url), 'utf8')
const canvasSource = readFileSync(new URL('./CanvasWorkspace.tsx', import.meta.url), 'utf8')
const preloadSource = readFileSync(new URL('../../../../electron/preload.js', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../../../electron/main.js', import.meta.url), 'utf8')

describe('local Site workbench structure', () => {
  it('is a first-class right workbench tool and handles native Site events', () => {
    expect(shellSource).toContain('data-workbench-empty-action={tool.id}')
    expect(shellSource).toContain('data-workbench-add')
    expect(shellSource).toContain('data-workbench-add-option={tool.id}')
    expect(shellSource).toContain('data-workbench-tab={tool.id}')
    expect(shellSource).toContain("case 'dsh-work/sites':")
    expect(shellSource).toContain('workbenchTabs.opened.map((tab) =>')
    expect(shellSource).toContain("['site_opened', 'site_updated']")
    expect(shellSource).toContain('<SiteWorkspace')
  })

  it('uses a script-only opaque iframe and keeps Site out of generic Canvas', () => {
    expect(siteSource).toContain('sandbox="allow-scripts"')
    expect(siteSource).not.toContain('allow-same-origin')
    expect(siteSource).toContain('data-site-action="annotate"')
    expect(siteSource).toContain('data-site-action="restore"')
    expect(siteSource).toContain('data-site-action="export"')
    expect(canvasSource).toContain("next.filter((item) => item?.kind !== 'site')")
  })

  it('exports through a trusted native bridge and blocks srcdoc frame navigation', () => {
    expect(preloadSource).toContain("exportLocalSite: (payload) => ipcRenderer.invoke('export-local-site', payload)")
    expect(mainSource).toContain("ipcMain.handle('export-local-site'")
    expect(mainSource).toContain("on('will-frame-navigate'")
    expect(mainSource).toContain("/^about:srcdoc")
  })
})

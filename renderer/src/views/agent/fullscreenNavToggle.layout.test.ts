import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')

const shellSource = read('./AgentShell.tsx')
const stylesheet = read('./agent.module.scss')
const themeStylesheet = read('./agent-theme.scss')
const preloadSource = read('../../../../electron/preload.js')
const mainSource = read('../../../../electron/main.js')

describe('agent native-size window titlebar', () => {
  it('follows the native window full-screen state without shrinking with app zoom', () => {
    expect(mainSource).toContain("mainWindow.on('enter-full-screen', sendWindowFullScreenState)")
    expect(mainSource).toContain("mainWindow.on('leave-full-screen', sendWindowFullScreenState)")
    expect(mainSource).toContain("ipcMain.handle('window-full-screen-state'")
    expect(preloadSource).toContain("getWindowFullScreenState: () => ipcRenderer.invoke('window-full-screen-state')")
    expect(preloadSource).toContain("ipcRenderer.on('window-full-screen-changed', handler)")
    expect(mainSource).toContain("trafficLightPosition: { x: 16, y: 18 }")
    expect(shellSource).toContain('data-agent-window-titlebar')
    expect(shellSource).toContain("document.querySelector<HTMLElement>('.dsh-root')")
    expect(shellSource).toContain('shellHeader={showWindowTitlebar}')
    expect(shellSource).toContain('shellHeaderActionsTarget={shellHeaderActionsTarget}')
    expect(themeStylesheet).toContain("body[data-dsh-shell-titlebar='true'] .dsh-root")
  })

  it('uses real navigation controls and removes the old floating edge buttons', () => {
    const titlebarRule = stylesheet.match(/\.windowTitlebar\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''
    const fullScreenRule = stylesheet.match(/\.windowTitlebar\[data-window-full-screen='true'\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? ''

    expect(titlebarRule).toMatch(/^\s*padding:\s*0 10px 0 86px\s*;/m)
    expect(titlebarRule).toMatch(/^\s*-webkit-app-region:\s*drag\s*;/m)
    expect(fullScreenRule).toMatch(/^\s*padding-left:\s*6px\s*;/m)
    expect(stylesheet).toContain('.windowTitlebarButton')
    expect(shellSource).toContain('navigateShellHistory(-1)')
    expect(shellSource).toContain('navigateShellHistory(1)')
    expect(shellSource).toContain('titlebarConversationSurface && navCollapsed && (')
    expect(shellSource).toContain('更多对话操作')
    expect(shellSource).not.toContain('styles.navEdgeToggle')
    expect(shellSource).not.toContain('styles.wsEdgeToggle')
  })
})

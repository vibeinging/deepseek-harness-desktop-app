import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('dsh-work Client shell contract', () => {
  it('owns the standard settings child Slots and renders them inside the existing settings page', () => {
    const shell = read('../../../packages/dsh-work-shell/src/client/index.tsx')
    const settings = read('../views/agent/AgentSettings.tsx')

    expect(shell).toContain("children: { 'settings.general.item': { kind: 'list', scope: 'root' } }")
    expect(shell).not.toContain("children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } }")
    expect(shell).toContain("'sidebar.footer.action': { kind: 'list', scope: 'root' }")
    expect(shell).toContain("renderSlot('sidebar.footer.action', { wide: true })")
    expect(shell).toContain("'conversation.composer.dock': { kind: 'list', scope: 'session' }")
    expect(shell).toContain("renderSlot('conversation.composer.dock'")
    expect(shell).toContain("renderSlot('conversation', {}, { only: 'dsh-work-conversation' })")
    expect(settings).toContain('<DshSettingsSection id="general"')
    expect(settings).toContain('<DshSettingsSection id="models"')
    expect(settings).toContain('<DshSettingsSection id="plugins"')
    expect(read('../views/agent/AgentNav.tsx')).toContain('data-dsh-sidebar-footer-actions')
    expect(read('../views/agent/AgentConversation.tsx')).toContain('data-dsh-conversation-composer-dock')
    expect(read('../../../packages/dsh-work-shell/cordis.patch.yml')).toMatch(/id: ui-sidebar\n\s+disabled: true/)
    expect(read('../../../packages/dsh-work-shell/cordis.patch.yml')).toMatch(/id: ui-conversation\n\s+disabled: true/)
  })

  it('uses DSH Theme and Locale snapshots in the formal Client runtime', () => {
    const shell = read('../../../packages/dsh-work-shell/src/client/index.tsx')
    const host = read('./DshClientHost.tsx')
    const page = read('../views/agent/index.tsx')

    expect(shell).toContain("import { createDshThemePresenter }")
    expect(shell).toContain('const presenter = createDshThemePresenter(document)')
    expect(shell).toContain('presenter.present(snapshot)')
    expect(shell).toContain('presenter.dispose()')
    expect(shell).not.toContain('function applyTheme(')
    expect(host).toContain('themeSnapshot: ThemeSnapshot')
    expect(host).toContain('localeSnapshot: LocaleSnapshot')
    expect(page).toContain('dshClientHost?.themeSnapshot.preference')
    expect(page).toContain('dshClientHost?.themeSnapshot.active.colorScheme')
    expect(page).toContain('dshClientHost?.localeSnapshot.active')
    expect(page).toContain('if (!dshClientHost) localStorage.setItem')
  })

  it('lets rendered overlay children receive pointer input', () => {
    const css = read('./DshClientHost.module.scss')

    expect(css).toContain('pointer-events: none')
    expect(css).toMatch(/> \* \{\s*pointer-events: auto/)
  })
})

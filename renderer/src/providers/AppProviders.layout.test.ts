import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./AppProviders.tsx', import.meta.url), 'utf8')

describe('global overlay order', () => {
  it('keeps confirmation dialogs above notifications', () => {
    expect(source).toContain('const NOTIFICATION_Z_INDEX = 400')
    expect(source).toContain('const MODAL_Z_INDEX = 500')
    expect(source).toContain('<Notifications position="top-center" zIndex={NOTIFICATION_Z_INDEX} />')
    expect(source).toContain('<ModalsProvider modalProps={{ zIndex: MODAL_Z_INDEX }}>{children}</ModalsProvider>')
  })

  it('Mantine 主色同时跟随激活皮肤和暗色色阶', () => {
    expect(source).toContain('s.previewSkin || s.getSkin(s.appliedSkinId)')
    expect(source).toContain('const scheme = useSkinsStore((s) => s.scheme)')
    expect(source).toContain('mantineColorsForScheme(skin, scheme)')
    expect(source).toContain('buildMantineTheme(colors)')
  })
})

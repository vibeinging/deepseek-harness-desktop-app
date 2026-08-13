import { describe, expect, it } from 'vitest'

import {
  BUILTIN_AGENT_PALETTES,
  BUILTIN_SKIN_IDS,
  BUILTIN_SKINS,
  DEFAULT_SKIN_ID,
  builtinAgentPalette
} from './builtin'

describe('内置主题颜色契约', () => {
  it('只保留清透蓝作为内置和默认主题', () => {
    expect(BUILTIN_SKIN_IDS).toEqual(['lighting'])
    expect(BUILTIN_SKINS).toHaveLength(1)
    expect(BUILTIN_SKINS[0]).toMatchObject({
      id: 'lighting',
      name: '清透蓝',
      htmlClass: 'lighting-theme',
      vars: { '--el-color-primary': '#5b8def' }
    })
    expect(DEFAULT_SKIN_ID).toBe('lighting')
  })

  it('清透蓝有一致的亮暗主色、Mantine 色板和语义色', () => {
    const skin = BUILTIN_SKINS[0]
    expect(skin.mantineColors).toHaveLength(10)
    expect(skin.mantineColors?.[6]).toBe('#5b8def')
    expect(skin.dark?.vars?.['--el-color-primary']).toBe('#86b2ff')
    expect(skin.dark?.mantineColors).toHaveLength(10)
    expect(skin.dark?.mantineColors?.[6]).toBe('#86b2ff')
    expect(Object.keys(BUILTIN_AGENT_PALETTES)).toEqual(['lighting'])
    expect(builtinAgentPalette('lighting', 'light').bg).toBe('#f8fbff')
    expect(builtinAgentPalette('lighting', 'dark').bg).toBe('#2c3440')
  })

  it('未知基础主题也安全回落到清透蓝', () => {
    expect(builtinAgentPalette('retired-theme', 'light')).toEqual(
      builtinAgentPalette('lighting', 'light')
    )
  })
})

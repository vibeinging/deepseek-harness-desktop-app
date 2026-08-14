import { describe, expect, it } from 'vitest'

import {
  BUILTIN_AGENT_PALETTES,
  BUILTIN_SKIN_IDS,
  BUILTIN_SKINS,
  DEFAULT_SKIN_ID,
  builtinAgentPalette
} from './builtin'

describe('内置主题颜色契约', () => {
  it('宿主只保留一个不进入产品主题库的安全底座', () => {
    expect(BUILTIN_SKIN_IDS).toEqual(['lighting'])
    expect(BUILTIN_SKINS).toHaveLength(1)
    expect(BUILTIN_SKINS[0]).toMatchObject({
      id: 'lighting',
      name: '系统底座',
      htmlClass: 'lighting-theme',
      vars: { '--el-color-primary': '#3f6fd8' }
    })
    expect(DEFAULT_SKIN_ID).toBe('lighting')
  })

  it('安全底座有一致的亮暗主色、Mantine 色板和语义色', () => {
    const skin = BUILTIN_SKINS[0]
    expect(skin.mantineColors).toHaveLength(10)
    expect(skin.mantineColors?.[6]).toBe('#3f6fd8')
    expect(skin.dark?.vars?.['--el-color-primary']).toBe('#78a2ff')
    expect(skin.dark?.mantineColors).toHaveLength(10)
    expect(skin.dark?.mantineColors?.[6]).toBe('#78a2ff')
    expect(Object.keys(BUILTIN_AGENT_PALETTES)).toEqual(['lighting'])
    expect(builtinAgentPalette('lighting', 'light').bg).toBe('#f4f7fb')
    expect(builtinAgentPalette('lighting', 'dark').bg).toBe('#202733')
  })

  it('未知基础主题安全回落到专业蓝', () => {
    expect(builtinAgentPalette('retired-theme', 'light')).toEqual(
      builtinAgentPalette('lighting', 'light')
    )
  })
})

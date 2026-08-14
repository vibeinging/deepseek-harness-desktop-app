import { describe, expect, it } from 'vitest'

import { findBuiltinSkin } from './builtin'
import { deriveMantineColors } from './colors'
import { mantineColorsForScheme } from './palette'
import { buildMantineTheme } from '@/theme/mantineTheme'
import type { SkinDefinition } from './types'

describe('mantineColorsForScheme', () => {
  const light = deriveMantineColors('#1e6fff')
  const dark = deriveMantineColors('#9aa0aa')
  const skin: SkinDefinition = {
    id: 'test',
    name: '测试',
    builtIn: false,
    base: 'lighting',
    mantineColors: light,
    dark: { mantineColors: dark }
  }

  it('暗色模式选择独立色阶，未配置时沿用明色色阶', () => {
    expect(mantineColorsForScheme(skin, 'light')).toBe(light)
    expect(mantineColorsForScheme(skin, 'dark')).toBe(dark)
    expect(mantineColorsForScheme({ ...skin, dark: undefined }, 'dark')).toBe(light)
    expect(buildMantineTheme(mantineColorsForScheme(skin, 'dark')).colors?.brand?.[6]).toBe('#9aa0aa')
  })

  it('appearance-only 自定义皮肤继承内置 base 色阶', () => {
    const appearanceOnly: SkinDefinition = {
      id: 'blue-wallpaper',
      name: '蓝色底图',
      builtIn: false,
      base: 'lighting',
      appearance: { bgImage: 'dawn' }
    }
    const base = findBuiltinSkin('lighting')
    expect(mantineColorsForScheme(appearanceOnly, 'light')).toBe(base?.mantineColors)
    expect(mantineColorsForScheme(appearanceOnly, 'dark')).toBe(base?.dark?.mantineColors)
    expect(buildMantineTheme(mantineColorsForScheme(appearanceOnly, 'light')).colors?.brand?.[6]).toBe(base?.mantineColors?.[6])
  })
})

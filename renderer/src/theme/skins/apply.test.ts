import { beforeEach, describe, expect, it } from 'vitest'

import { applySkin, refreshSkinScheme } from './apply'
import { DEFAULT_SKIN_ID, findBuiltinSkin } from './builtin'
import { deriveMantineColors } from './colors'
import type { SkinDefinition } from './types'

function mockDocument() {
  const classes = new Set<string>()
  const styles = new Map<string, string>()
  const attrs = new Map<string, string>()
  const removedLegacyStyles = { count: 0 }
  const html = {
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name)
    },
    style: {
      setProperty: (name: string, value: string) => styles.set(name, value),
      removeProperty: (name: string) => styles.delete(name)
    },
    setAttribute: (name: string, value: string) => attrs.set(name, value),
    getAttribute: (name: string) => attrs.get(name) ?? null
  }
  ;(globalThis as { document?: unknown }).document = {
    documentElement: html,
    querySelectorAll: () => [{ remove: () => { removedLegacyStyles.count += 1 } }]
  }
  return { classes, styles, attrs, removedLegacyStyles }
}

function customSkin(overrides: Partial<SkinDefinition> = {}): SkinDefinition {
  const primary = '#1e6fff'
  return {
    id: 'custom',
    name: '自定义',
    builtIn: false,
    source: 'user',
    base: DEFAULT_SKIN_ID,
    vars: { '--el-color-primary': primary },
    mantineColors: deriveMantineColors(primary),
    ...overrides
  }
}

describe('applySkin', () => {
  beforeEach(() => mockDocument())

  it('内置主题应用默认专业蓝的完整颜色', () => {
    const state = mockDocument()
    applySkin(findBuiltinSkin(DEFAULT_SKIN_ID))
    expect(state.classes.has('lighting-theme')).toBe(true)
    expect(state.styles.get('--el-color-primary')).toBe('#3f6fd8')
    expect(state.styles.get('--el-color-primary-rgb')).toBe('63, 111, 216')
    expect(state.styles.get('--skin-dsh-bg')).toBe('#f1f5fb')
    expect(state.styles.get('--skin-dsh-text')).toBe('#111827')
  })

  it('自定义主题继承默认专业蓝，再叠加安全主色', () => {
    const state = mockDocument()
    applySkin(customSkin())
    expect(state.classes.has('lighting-theme')).toBe(true)
    expect(state.styles.get('--el-color-primary')).toBe('#1e6fff')
  })

  it('不信任调用方传入的 htmlClass 或非白名单变量', () => {
    const state = mockDocument()
    applySkin({
      ...findBuiltinSkin(DEFAULT_SKIN_ID)!,
      htmlClass: 'untrusted-global-class',
      vars: {
        '--el-color-primary': 'red; } body { display: none',
        '--untrusted-token': '#ffffff'
      }
    })
    expect(state.classes.has('lighting-theme')).toBe(true)
    expect(state.classes.has('untrusted-global-class')).toBe(false)
    expect(state.styles.get('--el-color-primary')).toBe('#3f6fd8')
    expect(state.styles.has('--untrusted-token')).toBe(false)
  })

  it('明暗切换同步暗色主色', () => {
    const state = mockDocument()
    const darkPrimary = '#9aa0aa'
    applySkin(customSkin({
      dark: {
        vars: { '--el-color-primary': darkPrimary },
        mantineColors: deriveMantineColors(darkPrimary)
      }
    }), 'light')
    expect(state.styles.get('--el-color-primary')).toBe('#1e6fff')
    refreshSkinScheme('dark')
    expect(state.styles.get('--el-color-primary')).toBe(darkPrimary)
    expect(state.styles.get('--skin-dsh-bg')).toBe('#1c2738')
    expect(state.styles.get('--skin-dsh-text')).toBe('#f8fafc')
  })

  it('应用时清理旧版本的内置主题类', () => {
    const state = mockDocument()
    state.classes.add('tsinghua-purple')
    state.classes.add('china-red')
    state.classes.add('base-theme')
    state.classes.add('dark')
    applySkin(findBuiltinSkin(DEFAULT_SKIN_ID))
    expect([...state.classes]).toEqual(['lighting-theme'])
  })

  it('没有自定义主色的主题在暗色模式继承专业蓝暗色变体', () => {
    const state = mockDocument()
    applySkin(customSkin({
      vars: undefined,
      mantineColors: undefined,
      appearance: { bgImage: 'dawn' }
    }), 'dark')
    expect(state.styles.get('--el-color-primary')).toBe('#78a2ff')
  })

  it('旧 raw CSS 只会触发旧 style 清理，不会再次注入', () => {
    const state = mockDocument()
    applySkin({ ...customSkin(), extraCss: 'body { display: none }' })
    expect(state.removedLegacyStyles.count).toBe(1)
  })
})

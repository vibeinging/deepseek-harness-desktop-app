import { describe, expect, it, vi } from 'vitest'

import { applyAppearance, hasAppearanceContent } from './applyAppearance'
import type { BrandAppearance } from './types'

/** 构造一个最小 document mock（无 jsdom 环境下用）。 */
function mockDocument() {
  const styleProps = new Map<string, string>()
  const attrs = new Map<string, string>()
  const classList = new Set<string>()
  const root = {
    style: {
      getPropertyValue: (k: string) => styleProps.get(k) || '',
      setProperty: (k: string, v: string) => { styleProps.set(k, v) },
      removeProperty: (k: string) => { styleProps.delete(k) }
    },
    getAttribute: (k: string) => attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => { attrs.set(k, v) },
    removeAttribute: (k: string) => { attrs.delete(k) },
    classList: {
      add: (c: string) => { classList.add(c) },
      remove: (c: string) => { classList.delete(c) }
    }
  }
  const doc = {
    documentElement: root,
    querySelector: () => null, // 无 .dsh-root，回退读 html
  }
  // applyAppearance 内部用全局 getComputedStyle：模拟 SCSS 的 --dsh-surface-raw。
  vi.stubGlobal('getComputedStyle', () => ({
    getPropertyValue: (k: string) => (k === '--dsh-surface-raw' ? '#fffefa' : '')
  }))
  ;(globalThis as any).document = doc
  return { root, attrs, styleProps, classList, doc }
}

const HAS_BG: BrandAppearance = {
  bgColor: '#102030',
  bgImage: 'aurora',
  bgOpacity: 50,
  panelOpacity: 80
}

describe('applyAppearance', () => {
  it('空外观时清除所有 brand 变量与 override', () => {
    const { root, styleProps } = mockDocument()
    applyAppearance(HAS_BG, 'light', true)
    expect(root.getAttribute('data-active-brand')).toBe('custom')
    expect(root.getAttribute('data-active-brand-image')).toBe('true')
    // 清空
    applyAppearance(null, 'light', false)
    expect(root.getAttribute('data-active-brand')).toBeNull()
    expect(root.getAttribute('data-active-brand-image')).toBeNull()
    expect(styleProps.get('--brand-bg-image')).toBeUndefined()
    expect(styleProps.get('--dsh-surface-override')).toBeUndefined()
  })

  it('有底图时写入 bg-image 与 bg-opacity，无底图时 opacity 为 0', () => {
    const { root, styleProps } = mockDocument()
    applyAppearance({ bgImage: 'aurora' }, 'light', true)
    expect(root.getAttribute('data-active-brand-image')).toBe('true')
    expect(styleProps.get('--brand-bg-image')).toContain('linear-gradient')
    // 未显式设置 bgOpacity → fallback 1（0-1 空间，即完全不透明）。
    expect(styleProps.get('--brand-bg-opacity')).toBe('1')

    // 无底图皮肤：opacity 0（重新 mock，使用新的 styleProps 引用）
    const next = mockDocument()
    applyAppearance({ bgColor: '#fff' }, 'light', true)
    expect(next.root.getAttribute('data-active-brand-image')).toBeNull()
    expect(next.styleProps.get('--brand-bg-image')).toBe('none')
    expect(next.styleProps.get('--brand-bg-opacity')).toBe('0')
  })

  it('panelOpacity 合成 rgba 写入 --dsh-surface-override，100 时清除', () => {
    const { styleProps } = mockDocument()
    applyAppearance({ panelOpacity: 80 }, 'light', true)
    const override = styleProps.get('--dsh-surface-override')
    expect(override).toMatch(/^rgba\(255, 254, 250, 0\.8/)
    // 回到 100：清除 override
    applyAppearance({ panelOpacity: 100 }, 'light', true)
    expect(styleProps.get('--dsh-surface-override')).toBeUndefined()
  })

  it('dark 覆盖生效：scheme=dark 用 dark 值', () => {
    const { styleProps } = mockDocument()
    applyAppearance({ bgImage: 'aurora', dark: { bgImage: 'forest' } }, 'dark', true)
    // forest 预设是深青色渐变（#134e5e → #71b280），aurora 是青粉渐变（#a8edea → #fed6e3）。
    expect(styleProps.get('--brand-bg-image')).toContain('#134e5e')
    expect(styleProps.get('--brand-bg-image')).not.toContain('#a8edea')
  })

  it('不把非法底色写入可执行 CSS 变量', () => {
    const { styleProps } = mockDocument()
    applyAppearance({ bgColor: "red; background-image: url('https://example.com/a')" }, 'light', true)
    expect(styleProps.get('--brand-bg-color')).toBeUndefined()
  })
})

describe('hasAppearanceContent', () => {
  it('全空对象视为无外观', () => {
    expect(hasAppearanceContent({})).toBe(false)
    expect(hasAppearanceContent(undefined)).toBe(false)
    expect(hasAppearanceContent(null)).toBe(false)
  })
  it('任意字段非空视为有外观', () => {
    expect(hasAppearanceContent({ bgColor: '#fff' })).toBe(true)
    expect(hasAppearanceContent({ bgOpacity: 50 })).toBe(true)
    expect(hasAppearanceContent({ bgImageSize: 'cover' })).toBe(true)
    expect(hasAppearanceContent({ dark: { bgImage: 'forest' } })).toBe(true)
  })
})

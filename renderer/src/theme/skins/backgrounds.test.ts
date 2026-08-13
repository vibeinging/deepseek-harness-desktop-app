import { describe, expect, it } from 'vitest'

import { BUILTIN_BG_PRESETS, findBgPreset, resolveBgImageCss, resolveBgImageSize } from './backgrounds'

describe('backgrounds 内置预设', () => {
  it('包含"无底图"占位项', () => {
    const none = BUILTIN_BG_PRESETS.find((p) => p.none)
    expect(none).toBeDefined()
    expect(none?.cssValue).toBe('none')
  })

  it('每个预设有唯一 id 与合法 cssValue', () => {
    const ids = new Set<string>()
    for (const p of BUILTIN_BG_PRESETS) {
      expect(ids.has(p.id)).toBe(false)
      ids.add(p.id)
      expect(p.cssValue.length).toBeGreaterThan(0)
    }
  })

  it('findBgPreset 按 id 查找', () => {
    expect(findBgPreset('aurora')?.name).toBe('极光')
    expect(findBgPreset('does-not-exist')).toBeUndefined()
  })
})

describe('resolveBgImageCss', () => {
  it('内置预设 id 解析为渐变', () => {
    expect(resolveBgImageCss('aurora')).toBe(findBgPreset('aurora')!.cssValue)
  })

  it('none 预设解析为 none', () => {
    expect(resolveBgImageCss('none')).toBe('none')
  })

  it('空值解析为 none', () => {
    expect(resolveBgImageCss(undefined)).toBe('none')
    expect(resolveBgImageCss('')).toBe('none')
  })

  it('本地图片协议包装为 url()', () => {
    const local = 'dsh-skin-asset://0123456789abcdef01234567.png'
    expect(resolveBgImageCss(local)).toBe(`url('${local}')`)
  })

  it('拒绝远程 URL', () => {
    expect(resolveBgImageCss('https://example.com/bg.jpg')).toBe('none')
  })

  it('拒绝裸 CSS 值', () => {
    const grad = 'linear-gradient(45deg, #000, #fff)'
    expect(resolveBgImageCss(grad)).toBe('none')
  })

  it('拒绝伪造的本机资源路径', () => {
    expect(resolveBgImageCss('dsh-skin-asset://../../secret.png')).toBe('none')
    expect(resolveBgImageCss('dsh-skin-asset://0123456789abcdef01234567.svg')).toBe('none')
  })
})

describe('resolveBgImageSize', () => {
  it('显式声明的值优先', () => {
    expect(resolveBgImageSize('aurora', 'contain')).toBe('contain')
  })

  it('无声明时用预设的建议值', () => {
    expect(resolveBgImageSize('aurora')).toBe('cover')
  })

  it('无预设时回退 cover', () => {
    expect(resolveBgImageSize(undefined)).toBe('cover')
    expect(resolveBgImageSize('dsh-skin-asset://0123456789abcdef01234567.png')).toBe('cover')
  })
})

import { describe, expect, it } from 'vitest'

import {
  deriveMantineColors,
  isSafeHexColor,
  isSafeSkinColorVar,
  mixHexColor,
  readableTextColor,
  normalizeHexColor
} from './colors'

describe('皮肤颜色工具', () => {
  it('只允许明确的颜色变量', () => {
    expect(isSafeSkinColorVar('--el-color-primary')).toBe(true)
    expect(isSafeSkinColorVar('--el-color-primary-light-9')).toBe(false)
    expect(isSafeSkinColorVar('--dsh-accent')).toBe(false)
    expect(isSafeSkinColorVar('--side-bar-width')).toBe(false)
  })

  it('拒绝 URL、函数和 CSS 声明逃逸', () => {
    expect(isSafeHexColor('#1e6fff')).toBe(true)
    expect(isSafeHexColor('rgb(30, 111, 255)')).toBe(false)
    expect(isSafeHexColor("red; } body { color: red")).toBe(false)
    expect(isSafeHexColor("url('https://example.com/a')")).toBe(false)
  })

  it('规范化短十六进制颜色，并拒绝透明色', () => {
    expect(normalizeHexColor('#AbC')).toBe('#aabbcc')
    expect(normalizeHexColor('#abcd')).toBeNull()
  })

  it('派生 10 阶色板，且 Mantine 第 6 阶就是输入主色', () => {
    const colors = deriveMantineColors('#1E6FFF')
    expect(colors).toHaveLength(10)
    expect(colors[6]).toBe('#1e6fff')
    expect(colors.every((color) => /^#[0-9a-f]{6}$/.test(color))).toBe(true)
  })

  it('非法主色不会静默回退到其它颜色', () => {
    expect(() => deriveMantineColors('not-a-color')).toThrow(/十六进制/)
  })

  it('生成 Element 色阶并为按钮选择高对比文字', () => {
    expect(mixHexColor('#000000', '#ffffff', 0.5)).toBe('#808080')
    expect(readableTextColor('#59167e')).toBe('#fffefa')
    expect(readableTextColor('#75adff')).toBe('#18181b')
  })

})

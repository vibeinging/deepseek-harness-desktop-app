import { createTheme, type MantineColorsTuple, type MantineThemeOverride } from '@mantine/core'

// Tsinghua-purple primary color (default theme). Specific shades are still driven by theme/*/ SCSS --el-* variables.
// This sets a matching Mantine primary color so Mantine's default blue does not conflict with the app's purple tone.
const tsinghuaPurple: MantineColorsTuple = [
  '#f3f0ff',
  '#e5dbff',
  '#c9b8ff',
  '#ac8fff',
  '#9469fe',
  '#8451fe',
  '#7c45fe',
  '#6a36e3',
  '#5e2ecb',
  '#5025b2'
]

const DEFAULT_FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif'

/**
 * 根据皮肤的主色阶（10 个颜色字符串）构建一个 Mantine theme override。
 * 主题没有提供 mantineColors 时回退到默认清透蓝。
 * 调用方（AppProviders）把结果传给 <MantineProvider theme={...}>，切换皮肤时主色即时跟随。
 */
export function buildMantineTheme(colors?: string[] | null): MantineThemeOverride {
  const tuple: MantineColorsTuple = (colors && colors.length === 10
    ? (colors as unknown as MantineColorsTuple)
    : tsinghuaPurple)
  return createTheme({
    primaryColor: 'brand',
    colors: { brand: tuple },
    fontFamily: DEFAULT_FONT_FAMILY,
    defaultRadius: 'md',
    cursorType: 'pointer'
  })
}

/** 默认 Mantine 主题（清透蓝），供未接入主题 store 的场景兜底。 */
export const mantineTheme = buildMantineTheme()

// 内置皮肤清单。
// 这些皮肤的 CSS 已在 src/theme/index.scss 中静态编译进全局 bundle，常驻 <head>。
// 切换内置皮肤靠 html.<htmlClass> 选择器命中（见 apply.ts），无需运行时加载 CSS。
//
// 当前产品只提供清透蓝。旧版本的主题类仍会在切换时清理，避免热升级后残留。
// 清单同时声明明确主色 + Mantine 色阶，运行时把安全主色直接应用到 html，
// 保证 Agent / Element / Mantine 三者一致。
import { deriveMantineColors } from './colors'
import type { SkinDefinition } from './types'

export const LIGHTING_BLUE = '#5b8def'

// 每套主题都拥有明确的暗色强调色。明暗模式只选择主题变体，不再通过切换到
// 某个名为“dark”的主题来获得暗色界面。
export const LIGHTING_BLUE_DARK = '#86b2ff'

export const LIGHTING_BLUE_COLORS: string[] = deriveMantineColors(LIGHTING_BLUE)
export const LIGHTING_BLUE_DARK_COLORS: string[] = deriveMantineColors(LIGHTING_BLUE_DARK)

export interface BuiltinAgentPalette {
  bg: string
  surface: string
  hover: string
  text: string
  textSoft: string
  muted: string
  faint: string
}

type BuiltinAgentPalettes = Record<'light' | 'dark', BuiltinAgentPalette>

/**
 * Agent 使用的完整语义色。主题决定色调，外观模式决定明暗；自定义主题继承自己的 base。
 * 这组值只由宿主内置，不进入用户或 Profile 主题输入契约。
 */
export const BUILTIN_AGENT_PALETTES: Record<string, BuiltinAgentPalettes> = {
  lighting: {
    light: { bg: '#f8fbff', surface: '#fdfefe', hover: '#f2f7fc', text: '#1d2530', textSoft: '#465366', muted: '#6e7b8e', faint: '#abb5c2' },
    dark: { bg: '#2c3440', surface: '#141a22', hover: '#1e2631', text: '#f3f6fa', textSoft: '#d9e1eb', muted: '#b9c4d1', faint: '#8c9aaa' }
  }
}

export const BUILTIN_SKIN_IDS = ['lighting'] as const

export const BUILTIN_SKINS: SkinDefinition[] = [
  {
    id: 'lighting',
    name: '清透蓝',
    description: '清爽通透的蓝色调，支持浅色与深色模式。',
    builtIn: true,
    source: 'builtin',
    htmlClass: 'lighting-theme',
    vars: { '--el-color-primary': LIGHTING_BLUE },
    mantineColors: LIGHTING_BLUE_COLORS,
    dark: {
      vars: { '--el-color-primary': LIGHTING_BLUE_DARK },
      mantineColors: LIGHTING_BLUE_DARK_COLORS
    }
  }
]

/** 默认皮肤 id（与 src/settings.ts 的 defaultTheme 对齐）。 */
export const DEFAULT_SKIN_ID = 'lighting'

/** 当前与旧版本内置皮肤的 html 类名集合（用于切换和升级时清理）。 */
export const BUILTIN_SKIN_CLASSES: string[] = [
  'tsinghua-purple',
  'china-red',
  'base-theme',
  'lighting-theme',
  'dark'
]

const BUILTIN_BY_ID = new Map(BUILTIN_SKINS.map((s) => [s.id, s]))

export function findBuiltinSkin(id: string): SkinDefinition | undefined {
  return BUILTIN_BY_ID.get(id)
}

export function isBuiltinSkinId(id: string): boolean {
  return BUILTIN_BY_ID.has(id)
}

export function builtinAgentPalette(
  id: string,
  scheme: 'light' | 'dark'
): BuiltinAgentPalette {
  return (BUILTIN_AGENT_PALETTES[id] || BUILTIN_AGENT_PALETTES[DEFAULT_SKIN_ID])[scheme]
}

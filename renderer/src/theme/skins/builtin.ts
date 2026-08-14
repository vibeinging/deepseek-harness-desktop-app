// 内置皮肤清单。
// 这些皮肤的 CSS 已在 src/theme/index.scss 中静态编译进全局 bundle，常驻 <head>。
// 切换内置皮肤靠 html.<htmlClass> 选择器命中（见 apply.ts），无需运行时加载 CSS。
//
// 宿主只保留一个不出现在主题库中的安全底座。产品主题由 DSH Profile Bundle 提供。
// 清单同时声明明确主色 + Mantine 色阶，运行时把安全主色直接应用到 html，
// 保证 Agent / Element / Mantine 三者一致。
import { deriveMantineColors } from './colors'
import type { SkinDefinition } from './types'

export const LIGHTING_BLUE = '#3f6fd8'

// 每套主题都拥有明确的暗色强调色。明暗模式只选择主题变体，不再通过切换到
// 某个名为“dark”的主题来获得暗色界面。
export const LIGHTING_BLUE_DARK = '#78a2ff'

export const LIGHTING_BLUE_COLORS: string[] = deriveMantineColors(LIGHTING_BLUE)
export const LIGHTING_BLUE_DARK_COLORS: string[] = deriveMantineColors(LIGHTING_BLUE_DARK)

/** dsh-work 随应用挂入 Web Profile 的主题 Bundle。 */
export const THEME_PACK_PACKAGE_NAME = '@deepseek-ai/dsh-theme-pack'
export const DEFAULT_PROFILE_SKIN_ID = 'profile:%40deepseek-ai%2Fdsh-theme-pack:professional-blue'
export const ANIME_PROFILE_SKIN_ID = 'profile:%40deepseek-ai%2Fdsh-theme-pack:anime-blue'

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
    light: { bg: '#f1f5fb', surface: '#fbfcfe', hover: '#e8eef7', text: '#111827', textSoft: '#334155', muted: '#475569', faint: '#5f6f85' },
    dark: { bg: '#1c2738', surface: '#121a27', hover: '#1b2636', text: '#f8fafc', textSoft: '#dbe4f0', muted: '#b8c4d4', faint: '#94a3b8' }
  }
}

export const BUILTIN_SKIN_IDS = ['lighting'] as const

export const BUILTIN_SKINS: SkinDefinition[] = [
  {
    id: 'lighting',
    name: '系统底座',
    description: '主题插件尚未就绪时使用的安全界面底座。',
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

/** Profile 主题不可用时使用的宿主安全底座 id。 */
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

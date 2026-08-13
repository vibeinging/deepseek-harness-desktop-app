// 内置底图预设。
// 用纯 CSS 渐变实现，不依赖外部图片文件，随包即用。
// 用户也可选择本地图片（复制到 userData，通过 dsh-skin-asset:// 协议访问）。
import type { BgImageSize } from './types'

export interface BgPreset {
  /** 唯一 id。 */
  id: string
  /** 显示名。 */
  name: string
  /**
   * 用于 CSS background 的值。
   * 预设用渐变（如 'linear-gradient(...)'）；'none' 表示无底图。
   * 本地图片会是 url('dsh-skin-asset://...')。
   */
  cssValue: string
  /** 建议填充方式（预设渐变一般用 cover）。 */
  size: BgImageSize
  /** 是否是"无底图"占位项。 */
  none?: boolean
}

export const BUILTIN_BG_PRESETS: BgPreset[] = [
  { id: 'none', name: '无底图', cssValue: 'none', size: 'cover', none: true },
  { id: 'aurora', name: '极光', cssValue: 'linear-gradient(135deg, #a8edea 0%, #fed6e3 100%)', size: 'cover' },
  { id: 'dawn', name: '晨曦', cssValue: 'linear-gradient(135deg, #ffeaa7 0%, #fab1a0 100%)', size: 'cover' },
  { id: 'deep-sea', name: '深海', cssValue: 'linear-gradient(135deg, #2c3e50 0%, #4ca1af 100%)', size: 'cover' },
  { id: 'forest', name: '森林', cssValue: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)', size: 'cover' },
  { id: 'twilight', name: '暮光', cssValue: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', size: 'cover' },
  { id: 'mint', name: '薄荷', cssValue: 'linear-gradient(135deg, #d4fc79 0%, #96e6a1 100%)', size: 'cover' },
  { id: 'graphite', name: '石墨', cssValue: 'linear-gradient(135deg, #232526 0%, #414345 100%)', size: 'cover' },
  { id: 'peach', name: '蜜桃', cssValue: 'linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)', size: 'cover' },
  { id: 'galaxy', name: '星河', cssValue: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)', size: 'cover' }
]

const PRESET_BY_ID = new Map(BUILTIN_BG_PRESETS.map((p) => [p.id, p]))
const LOCAL_ASSET_PATTERN = /^dsh-skin-asset:\/\/[0-9a-f]{24}\.(?:png|jpe?g|webp|gif)$/i

export function findBgPreset(id: string): BgPreset | undefined {
  return PRESET_BY_ID.get(id)
}

/** 是否是本机 IPC 复制图片后返回的稳定资源 URL。 */
export function isLocalBgImage(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_ASSET_PATTERN.test(value.trim())
}

/** 是否是安全背景引用。插件只允许预设；用户外观可额外使用本机资源。 */
export function isSafeBgImage(value: unknown, allowLocal = true): value is string {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  return PRESET_BY_ID.has(normalized) || (allowLocal && isLocalBgImage(normalized))
}

/**
 * 把 BrandAppearance.bgImage 解析为最终 CSS background 值。
 * - 内置预设 id → 预设的 cssValue（渐变）
 * - 合法 dsh-skin-asset:// 本机资源 → 包装为 url(...)
 * - 远程 URL / data URL / 裸 CSS → 拒绝并回退 none
 * - undefined/空 → 'none'
 */
export function resolveBgImageCss(bgImage: string | undefined): string {
  if (!bgImage) return 'none'
  const preset = PRESET_BY_ID.get(bgImage)
  if (preset) return preset.cssValue
  if (isLocalBgImage(bgImage)) return `url('${bgImage}')`
  return 'none'
}

/** 根据底图来源推断填充方式。 */
export function resolveBgImageSize(bgImage: string | undefined, declared?: BgImageSize): BgImageSize {
  if (declared) return declared
  const preset = bgImage ? PRESET_BY_ID.get(bgImage) : undefined
  return preset?.size ?? 'cover'
}

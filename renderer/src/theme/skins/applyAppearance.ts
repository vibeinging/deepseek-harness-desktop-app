// 品牌外观应用：纯 DOM 热应用（底图/底色/透明度），即时生效。
//
// 应用名（appName）由 store/brand.ts 单独处理（涉及 document.title、主进程、i18n）。
// 本模块只负责把 BrandAppearance 的背景相关字段写入 CSS 变量到 html[data-active-brand]。
//
// CSS 变量约定（在 agent-theme.scss 消费）：
//   --brand-bg-color      底色（回退 --dsh-bg）
//   --brand-bg-image      底图 CSS 值（回退 none）
//   --brand-bg-size       底图填充方式（回退 cover）
//   --brand-bg-opacity    底图不透明度 0-1（无底图或未启用品牌外观时回退 0）
//   --brand-panel-opacity 内容面板不透明度 0-1（回退 1）
//
// 默认（未设置任何外观）：html 上无 data-active-brand，SCSS 变量用回退值，外观与原版一致。
import { resolveBgImageCss, resolveBgImageSize } from './backgrounds'
import { normalizeHexColor } from './colors'
import type { BrandAppearance } from './types'

const ACTIVE_BRAND_ATTR = 'data-active-brand'
const ACTIVE_BRAND_IMAGE_ATTR = 'data-active-brand-image'

function getDocument(): Document | null {
  return typeof document !== 'undefined' ? document : null
}

/** 把 0-100 的百分比归一化为 0-1，夹取边界。 */
function pct(v: number | undefined, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.max(0, Math.min(1, v / 100))
}

/** 选取明/暗模式生效的外观（合并明色基础 + 可选 dark 覆盖）。 */
function effectiveAppearance(ap: BrandAppearance, scheme: 'light' | 'dark'): BrandAppearance {
  if (scheme !== 'dark' || !ap.dark) return ap
  return {
    ...ap,
    bgColor: ap.dark.bgColor ?? ap.bgColor,
    bgImage: ap.dark.bgImage ?? ap.bgImage,
    bgImageSize: ap.dark.bgImageSize ?? ap.bgImageSize,
    bgOpacity: ap.dark.bgOpacity ?? ap.bgOpacity,
    panelOpacity: ap.dark.panelOpacity ?? ap.panelOpacity
  }
}

/**
 * 应用品牌外观到当前文档（热应用，立即生效）。
 * 只处理背景相关字段；应用名由 brand store 处理。
 * @param ap       品牌外观（可为空对象=全默认）
 * @param scheme   当前明暗模式
 * @param hasBg    是否有需要应用的外观（无则清除，恢复默认）
 */
export function applyAppearance(
  ap: BrandAppearance | null | undefined,
  scheme: 'light' | 'dark' = 'light',
  hasBg = true
) {
  const doc = getDocument()
  if (!doc) return
  const html = doc.documentElement

  if (!hasBg || !ap) {
    // 清除品牌外观：移除属性，让 SCSS 变量回退到默认。
    html.removeAttribute(ACTIVE_BRAND_ATTR)
    html.removeAttribute(ACTIVE_BRAND_IMAGE_ATTR)
    html.style.removeProperty('--brand-bg-color')
    html.style.removeProperty('--brand-bg-image')
    html.style.removeProperty('--brand-bg-size')
    html.style.removeProperty('--brand-bg-opacity')
    html.style.removeProperty('--brand-panel-opacity')
    html.style.removeProperty('--dsh-surface-override')
    return
  }

  const eff = effectiveAppearance(ap, scheme)
  html.setAttribute(ACTIVE_BRAND_ATTR, 'custom')

  const safeBgColor = normalizeHexColor(eff.bgColor)
  if (safeBgColor) html.style.setProperty('--brand-bg-color', safeBgColor)
  else html.style.removeProperty('--brand-bg-color')

  const bgImageCss = resolveBgImageCss(eff.bgImage)
  if (bgImageCss && bgImageCss !== 'none') {
    html.setAttribute(ACTIVE_BRAND_IMAGE_ATTR, 'true')
    html.style.setProperty('--brand-bg-image', bgImageCss)
    html.style.setProperty('--brand-bg-size', resolveBgImageSize(eff.bgImage, eff.bgImageSize))
  } else {
    html.removeAttribute(ACTIVE_BRAND_IMAGE_ATTR)
    html.style.setProperty('--brand-bg-image', 'none')
  }

  // 底图不透明度：只有有底图时才有意义；无底图时强制 0（不绘制）。
  const hasImage = bgImageCss && bgImageCss !== 'none'
  html.style.setProperty('--brand-bg-opacity', hasImage ? String(pct(eff.bgOpacity, 1)) : '0')

  // 内容面板不透明度（0-1 空间，缺省=1 不透明）。
  const panelOp = pct(eff.panelOpacity, 1)
  html.style.setProperty('--brand-panel-opacity', String(panelOp))
  // 面板透明：panelOpacity<100 时写 --dsh-surface-override（rgba 半透明合成色）。
  // SCSS 里 --dsh-surface 是 var(--dsh-surface-override, var(--dsh-surface-raw))，override 从 html 继承
  // 到 .dsh-root 与 portal 层，所有用 var(--dsh-surface) 的容器自动半透明（无需逐个改 SCSS）。
  if (panelOp < 1) {
    const translucent = composeTranslucentSurface(doc, panelOp)
    if (translucent) html.style.setProperty('--dsh-surface-override', translucent)
  } else {
    html.style.removeProperty('--dsh-surface-override')
  }
}

/**
 * 读取当前生效的 --dsh-surface-raw 原始色（SCSS 定义的明/暗 surface），与透明度合成 rgba()。
 * 从 .dsh-root（若已挂载）或 html 的 portal 作用域读取；读不到时回退暖白。
 */
function composeTranslucentSurface(doc: Document, opacity: number): string | null {
  try {
    const root = doc.querySelector('.dsh-root') as HTMLElement | null
    const source = root || doc.documentElement
    const raw = getComputedStyle(source).getPropertyValue('--dsh-surface-raw').trim()
    const rgb = parseColorToRgb(raw)
    if (rgb) return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${opacity.toFixed(3)})`
  } catch {
    /* getComputedStyle 不可用时回退 */
  }
  return `rgba(255, 250, 250, ${opacity.toFixed(3)})`
}

/** 把 hex / rgb() / 颜色名解析为 {r,g,b}；失败返回 null。 */
function parseColorToRgb(value: string): { r: number; g: number; b: number } | null {
  const v = value.trim()
  if (!v) return null
  // rgba?()/rgb?()
  const mRgb = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i)
  if (mRgb) return { r: +mRgb[1], g: +mRgb[2], b: +mRgb[3] }
  // #hex
  const mHex = v.match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i)
  if (mHex) {
    let h = mHex[1]
    if (h.length === 3) h = h.split('').map((c) => c + c).join('')
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
  }
  return null
}

/** 是否存在任何需要应用的外观（全空对象视为无）。 */
export function hasAppearanceContent(ap: BrandAppearance | null | undefined): boolean {
  if (!ap) return false
  return Boolean(
    ap.bgColor || ap.bgImage ||
      typeof ap.bgOpacity === 'number' ||
      typeof ap.panelOpacity === 'number' ||
      ap.bgImageSize ||
      (ap.dark && hasAppearanceContent(ap.dark))
  )
}

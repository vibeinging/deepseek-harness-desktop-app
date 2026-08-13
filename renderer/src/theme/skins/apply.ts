// 皮肤应用核心：纯 DOM 热切换。
//
// 内置皮肤先命中随包 SCSS 类；自定义/插件皮肤先挂载明确的内置 base，再把经过白名单
// 校验的主色写到 html inline style。v1 不再生成或注入任意 CSS，旧数据即使绕过恢复校验
// 也无法执行 raw extraCss。
import {
  BUILTIN_SKIN_CLASSES,
  DEFAULT_SKIN_ID,
  builtinAgentPalette,
  findBuiltinSkin
} from './builtin'
import {
  SAFE_SKIN_COLOR_VARS,
  mixHexColor,
  normalizeHexColor,
  readableTextColor
} from './colors'
import type { SkinDefinition } from './types'

const ACTIVE_SKIN_ATTR = 'data-active-skin'
const HOST_SKIN_STYLE_VARS = [
  '--skin-dsh-bg',
  '--skin-dsh-surface',
  '--skin-dsh-hover',
  '--skin-dsh-text',
  '--skin-dsh-text-soft',
  '--skin-dsh-muted',
  '--skin-dsh-faint',
  '--skin-dsh-on-accent',
  '--el-color-primary-rgb',
  '--el-color-primary-dark-2',
  ...Array.from({ length: 9 }, (_, index) => `--el-color-primary-light-${index + 1}`)
] as const
let currentSkin: SkinDefinition | null = null

function getDocument(): Document | null {
  return typeof document !== 'undefined' ? document : null
}

/** 清理旧版本曾注入的皮肤 style，避免升级后继续执行 raw CSS。 */
function removeLegacyInjectedSkinStyles(doc: Document) {
  doc.querySelectorAll('style[data-active-skin-style]').forEach((element) => element.remove())
}

function clearBuiltinSkinClasses(html: HTMLElement) {
  BUILTIN_SKIN_CLASSES.forEach((className) => html.classList.remove(className))
}

function clearInlineSkinVars(html: HTMLElement) {
  SAFE_SKIN_COLOR_VARS.forEach((name) => html.style.removeProperty(name))
  HOST_SKIN_STYLE_VARS.forEach((name) => html.style.removeProperty(name))
}

function builtinBaseFor(skin: SkinDefinition): SkinDefinition {
  if (skin.builtIn) return findBuiltinSkin(skin.id) || findBuiltinSkin(DEFAULT_SKIN_ID)!
  return findBuiltinSkin(skin.base || DEFAULT_SKIN_ID) || findBuiltinSkin(DEFAULT_SKIN_ID)!
}

function effectivePrimary(skin: SkinDefinition, scheme: 'light' | 'dark'): string | null {
  const base = builtinBaseFor(skin)
  const basePrimary = normalizeHexColor(base.vars?.['--el-color-primary'])
  const ownPrimary = normalizeHexColor(skin.vars?.['--el-color-primary'])
  const mainPrimary = ownPrimary || basePrimary
  if (scheme !== 'dark') return mainPrimary
  return normalizeHexColor(skin.dark?.vars?.['--el-color-primary'])
    || ownPrimary
    || normalizeHexColor(base.dark?.vars?.['--el-color-primary'])
    || mainPrimary
}

function applyInlineSkinVars(html: HTMLElement, skin: SkinDefinition, scheme: 'light' | 'dark') {
  clearInlineSkinVars(html)
  const primary = effectivePrimary(skin, scheme)
  if (primary) {
    html.style.setProperty('--el-color-primary', primary)
    html.style.setProperty('--el-color-primary-rgb', [1, 3, 5]
      .map((offset) => Number.parseInt(primary.slice(offset, offset + 2), 16))
      .join(', '))
    for (let level = 1; level <= 9; level += 1) {
      html.style.setProperty(`--el-color-primary-light-${level}`, mixHexColor(primary, '#ffffff', level / 10))
    }
    html.style.setProperty('--el-color-primary-dark-2', mixHexColor(primary, '#000000', 0.2))
    html.style.setProperty('--skin-dsh-on-accent', readableTextColor(primary))
  }

  const base = builtinBaseFor(skin)
  const palette = builtinAgentPalette(base.id, scheme)
  html.style.setProperty('--skin-dsh-bg', palette.bg)
  html.style.setProperty('--skin-dsh-surface', palette.surface)
  html.style.setProperty('--skin-dsh-hover', palette.hover)
  html.style.setProperty('--skin-dsh-text', palette.text)
  html.style.setProperty('--skin-dsh-text-soft', palette.textSoft)
  html.style.setProperty('--skin-dsh-muted', palette.muted)
  html.style.setProperty('--skin-dsh-faint', palette.faint)
}

/** 应用皮肤；原始 CSS 与非白名单变量不会进入 DOM。 */
export function applySkin(
  skin: SkinDefinition | null | undefined,
  scheme: 'light' | 'dark' = 'light'
) {
  const doc = getDocument()
  if (!doc || !skin) return

  const html = doc.documentElement
  currentSkin = skin
  removeLegacyInjectedSkinStyles(doc)
  clearBuiltinSkinClasses(html)
  html.setAttribute(ACTIVE_SKIN_ATTR, skin.id)
  html.setAttribute('data-agent-scheme', scheme)

  const base = builtinBaseFor(skin)
  // 只挂载注册过的内置 class；即使调用方绕过 normalizer，也不能借 htmlClass 注入任意全局类。
  html.classList.add(base.htmlClass || base.id)
  applyInlineSkinVars(html, skin, scheme)
}

/** 明暗切换时同步暗色主色，不重新加载皮肤。 */
export function refreshSkinScheme(scheme: 'light' | 'dark') {
  const doc = getDocument()
  if (!doc) return
  const html = doc.documentElement
  html.setAttribute('data-agent-scheme', scheme)
  if (currentSkin) applyInlineSkinVars(html, currentSkin, scheme)
}

export function getActiveSkinId(): string | null {
  const doc = getDocument()
  if (!doc) return null
  return doc.documentElement.getAttribute(ACTIVE_SKIN_ATTR)
}

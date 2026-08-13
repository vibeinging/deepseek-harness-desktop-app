// 皮肤 JSON 导入 / 导出与 Renderer 最终安全校验。
// Renderer 不信任磁盘、导入文件或 Server catalog：三条入口最终都只保留内置基底、
// 一个受控主色变量、Mantine 色阶和受控品牌外观。原始 CSS、远程 URL 与任意 CSS 变量均禁止。
import { isLocalBgImage, isSafeBgImage } from './backgrounds'
import { DEFAULT_SKIN_ID, findBuiltinSkin, isBuiltinSkinId } from './builtin'
import { deriveMantineColors, isSafeSkinColorVar, normalizeHexColor } from './colors'
import type {
  BrandAppearance,
  SkinDefinition,
  SkinFile,
  SkinSchemeOverride,
  SkinSourceBundle
} from './types'

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/
const PROFILE_BUNDLE_ID_PATTERN = /^[A-Za-z0-9._/@-]{1,320}$/
// Profile 运行时 id 必须是 encodeURIComponent(package_name) 与 manifest_id 的精确组合。
const PROFILE_SOURCE_PART = String.raw`(?:[a-z0-9._!~*'()-]|%[0-9a-f]{2}){1,440}`
const PROFILE_RUNTIME_ID_PATTERN = new RegExp(
  String.raw`^profile:${PROFILE_SOURCE_PART}:[a-z0-9][a-z0-9_-]{0,62}$`,
  'i'
)
const MAX_EXTRA_CSS_BYTES = 64 * 1024
export const MAX_SKIN_IMPORT_BYTES = 256 * 1024

const USER_SKIN_FIELDS = new Set([
  'id',
  'name',
  'description',
  'builtIn',
  'source',
  'base',
  'vars',
  'mantineColors',
  'extraCss',
  'dark',
  'appearance',
  'updatedAt'
])
const PROFILE_THEME_FIELDS = new Set([
  'id',
  'name',
  'description',
  'builtIn',
  'source',
  'base',
  'vars',
  'mantineColors',
  'extraCss',
  'dark',
  'appearance',
  'manifest_id',
  'source_bundle'
])
const SCHEME_FIELDS = new Set(['vars', 'mantineColors', 'extraCss'])
const APPEARANCE_FIELDS = new Set([
  'appName',
  'bgColor',
  'bgImage',
  'bgImageSize',
  'bgOpacity',
  'panelOpacity',
  'dark'
])
const APPEARANCE_DARK_FIELDS = new Set(['bgColor', 'bgImage', 'bgImageSize', 'bgOpacity', 'panelOpacity'])
const BG_IMAGE_SIZE_VALUES = new Set(['cover', 'contain', 'center'])
const MAX_APP_NAME_LEN = 32

export class SkinValidationError extends Error {
  code: string

  constructor(message: string, code = 'SKIN_INVALID') {
    super(message)
    this.name = 'SkinValidationError'
    this.code = code
  }
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length
  return value.length
}

function asString(value: unknown, field: string, max = 1024): string {
  if (typeof value !== 'string') {
    throw new SkinValidationError(`${field} 必须是字符串`, 'SKIN_FIELD_TYPE')
  }
  const trimmed = value.trim()
  if (!trimmed) throw new SkinValidationError(`${field} 不能为空`, 'SKIN_FIELD_EMPTY')
  if (trimmed.length > max) {
    throw new SkinValidationError(`${field} 超过最大长度 ${max}`, 'SKIN_FIELD_TOO_LONG')
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new SkinValidationError(`${field} 含不允许的控制字符`, 'SKIN_FIELD_INVALID')
  }
  return trimmed
}

function asColor(value: unknown, field: string): string {
  const color = normalizeHexColor(value)
  if (!color) {
    throw new SkinValidationError(`${field} 必须是 #RGB 或 #RRGGBB 十六进制颜色`, 'SKIN_COLOR_INVALID')
  }
  return color
}

function asVars(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SkinValidationError(`${field} 必须是对象`, 'SKIN_FIELD_TYPE')
  }
  const out: Record<string, string> = {}
  for (const [key, rawColor] of Object.entries(value as Record<string, unknown>)) {
    if (!isSafeSkinColorVar(key)) {
      throw new SkinValidationError(
        `${field} 只允许颜色变量 --el-color-primary，不允许 "${key}"`,
        'SKIN_VAR_KEY'
      )
    }
    out[key] = asColor(rawColor, `${field}["${key}"]`)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function asExtraCss(value: unknown, field: string): undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new SkinValidationError(`${field} 必须是字符串`, 'SKIN_FIELD_TYPE')
  }
  if (byteLength(value) > MAX_EXTRA_CSS_BYTES) {
    throw new SkinValidationError(`${field} 超过最大长度 ${MAX_EXTRA_CSS_BYTES} 字节`, 'SKIN_FIELD_TOO_LONG')
  }
  if (value.trim()) {
    throw new SkinValidationError(
      `${field} 不支持原始 CSS；请使用主色、基础主题和外观字段`,
      'SKIN_RAW_CSS_FORBIDDEN'
    )
  }
  return undefined
}

function asMantineColors(value: unknown, field = 'mantineColors'): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new SkinValidationError(`${field} 必须是数组`, 'SKIN_FIELD_TYPE')
  }
  if (value.length !== 10) {
    throw new SkinValidationError(`${field} 必须是 10 个颜色值（Mantine 色阶）`, 'SKIN_COLORS_LENGTH')
  }
  return value.map((color, index) => asColor(color, `${field}[${index}]`))
}

interface ColorPair {
  vars?: Record<string, string>
  mantineColors?: string[]
}

function asColorPair(rawVars: unknown, rawColors: unknown, field: string): ColorPair {
  let vars = asVars(rawVars, `${field}.vars`)
  const mantineColors = asMantineColors(rawColors, `${field}.mantineColors`)
  const primary = vars?.['--el-color-primary']

  if (primary && !mantineColors) {
    throw new SkinValidationError(
      `${field} 修改 --el-color-primary 时必须同时提供 mantineColors`,
      'SKIN_PRIMARY_COLORS_REQUIRED'
    )
  }
  if (primary && mantineColors && primary !== mantineColors[6]) {
    throw new SkinValidationError(
      `${field}.mantineColors[6] 必须与 --el-color-primary 相同`,
      'SKIN_PRIMARY_COLOR_MISMATCH'
    )
  }
  if (!primary && mantineColors) vars = { '--el-color-primary': mantineColors[6] }
  return { vars, mantineColors }
}

function asSchemeOverride(value: unknown, field: string): SkinSchemeOverride | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SkinValidationError(`${field} 必须是对象`, 'SKIN_FIELD_TYPE')
  }
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!SCHEME_FIELDS.has(key)) {
      throw new SkinValidationError(`${field} 含非法字段 "${key}"`, 'SKIN_FIELD_UNKNOWN')
    }
  }
  asExtraCss(obj.extraCss, `${field}.extraCss`)
  const pair = asColorPair(obj.vars, obj.mantineColors, field)
  if (!pair.vars && !pair.mantineColors) return undefined
  return pair
}

function asBase(value: unknown, field: string): string {
  const base = value === undefined || value === null
    ? DEFAULT_SKIN_ID
    : asString(value, field, 64)
  if (!findBuiltinSkin(base)) {
    throw new SkinValidationError(`${field} 必须是内置主题 id`, 'SKIN_BASE_INVALID')
  }
  return base
}

function asPercentValue(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new SkinValidationError(`${field} 必须是 0-100 之间的数字`, 'SKIN_FIELD_TYPE')
  }
  return value
}

interface AppearanceOptions {
  allowAppName: boolean
  allowLocalImage: boolean
  panelOpacityMin: number
}

function asBgImage(value: unknown, field: string, allowLocal: boolean): string | undefined {
  if (value === undefined || value === null) return undefined
  const image = asString(value, field, allowLocal ? 128 : 64)
  if (!isSafeBgImage(image, allowLocal)) {
    throw new SkinValidationError(
      allowLocal
        ? `${field} 只能使用内置预设或本机主题图片`
        : `${field} 只能使用内置背景预设`,
      'SKIN_BG_IMAGE_FORBIDDEN'
    )
  }
  return image
}

function asAppearance(value: unknown, field: string, options: AppearanceOptions): BrandAppearance | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SkinValidationError(`${field} 必须是对象`, 'SKIN_FIELD_TYPE')
  }
  const obj = value as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!APPEARANCE_FIELDS.has(key)) {
      throw new SkinValidationError(`${field} 含非法字段 "${key}"`, 'SKIN_FIELD_UNKNOWN')
    }
  }
  if (!options.allowAppName && Object.prototype.hasOwnProperty.call(obj, 'appName')) {
    throw new SkinValidationError(
      `${field}.appName 不属于主题；请在品牌名称设置中单独修改`,
      'THEME_APP_NAME_FORBIDDEN'
    )
  }
  const appName = options.allowAppName && obj.appName !== undefined && obj.appName !== null
    ? asString(obj.appName, `${field}.appName`, MAX_APP_NAME_LEN)
    : undefined
  const bgColor = obj.bgColor !== undefined && obj.bgColor !== null
    ? asColor(obj.bgColor, `${field}.bgColor`)
    : undefined
  const bgImage = asBgImage(obj.bgImage, `${field}.bgImage`, options.allowLocalImage)

  let bgImageSize: BrandAppearance['bgImageSize']
  if (obj.bgImageSize !== undefined && obj.bgImageSize !== null) {
    const size = String(obj.bgImageSize)
    if (!BG_IMAGE_SIZE_VALUES.has(size)) {
      throw new SkinValidationError(`${field}.bgImageSize 必须是 cover/contain/center`, 'SKIN_FIELD_TYPE')
    }
    bgImageSize = size as BrandAppearance['bgImageSize']
  }
  const bgOpacity = asPercentValue(obj.bgOpacity, `${field}.bgOpacity`)
  const panelOpacity = asPercentValue(obj.panelOpacity, `${field}.panelOpacity`)
  if (panelOpacity !== undefined && panelOpacity < options.panelOpacityMin) {
    throw new SkinValidationError(
      `${field}.panelOpacity 必须是 ${options.panelOpacityMin}-100 之间的数字`,
      'SKIN_FIELD_TYPE'
    )
  }

  let dark: BrandAppearance['dark']
  if (obj.dark !== undefined && obj.dark !== null) {
    if (typeof obj.dark !== 'object' || Array.isArray(obj.dark)) {
      throw new SkinValidationError(`${field}.dark 必须是对象`, 'SKIN_FIELD_TYPE')
    }
    const darkObj = obj.dark as Record<string, unknown>
    for (const key of Object.keys(darkObj)) {
      if (!APPEARANCE_DARK_FIELDS.has(key)) {
        throw new SkinValidationError(`${field}.dark 含非法字段 "${key}"`, 'SKIN_FIELD_UNKNOWN')
      }
    }
    const darkOut: NonNullable<BrandAppearance['dark']> = {}
    if (darkObj.bgColor !== undefined && darkObj.bgColor !== null) {
      darkOut.bgColor = asColor(darkObj.bgColor, `${field}.dark.bgColor`)
    }
    const darkImage = asBgImage(darkObj.bgImage, `${field}.dark.bgImage`, options.allowLocalImage)
    if (darkImage) darkOut.bgImage = darkImage
    if (darkObj.bgImageSize !== undefined && darkObj.bgImageSize !== null) {
      const size = String(darkObj.bgImageSize)
      if (!BG_IMAGE_SIZE_VALUES.has(size)) {
        throw new SkinValidationError(`${field}.dark.bgImageSize 必须是 cover/contain/center`, 'SKIN_FIELD_TYPE')
      }
      darkOut.bgImageSize = size as BrandAppearance['bgImageSize']
    }
    const darkBgOpacity = asPercentValue(darkObj.bgOpacity, `${field}.dark.bgOpacity`)
    const darkPanelOpacity = asPercentValue(darkObj.panelOpacity, `${field}.dark.panelOpacity`)
    if (darkPanelOpacity !== undefined && darkPanelOpacity < options.panelOpacityMin) {
      throw new SkinValidationError(
        `${field}.dark.panelOpacity 必须是 ${options.panelOpacityMin}-100 之间的数字`,
        'SKIN_FIELD_TYPE'
      )
    }
    if (darkBgOpacity !== undefined) darkOut.bgOpacity = darkBgOpacity
    if (darkPanelOpacity !== undefined) darkOut.panelOpacity = darkPanelOpacity
    if (Object.keys(darkOut).length > 0) dark = darkOut
  }

  const out: BrandAppearance = {}
  if (appName) out.appName = appName
  if (bgColor) out.bgColor = bgColor
  if (bgImage) out.bgImage = bgImage
  if (bgImageSize) out.bgImageSize = bgImageSize
  if (bgOpacity !== undefined) out.bgOpacity = bgOpacity
  if (panelOpacity !== undefined) out.panelOpacity = panelOpacity
  if (dark) out.dark = dark
  return Object.keys(out).length > 0 ? out : undefined
}

function asSourceBundle(value: unknown): Partial<SkinSourceBundle> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SkinValidationError('source_bundle 必须是对象', 'SKIN_PROFILE_SOURCE_INVALID')
  }
  const obj = value as Record<string, unknown>
  const allowed = new Set([
    'package_name',
    'name',
    'version',
    'manifest_path'
  ])
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new SkinValidationError(`source_bundle 含非法字段 "${key}"`, 'SKIN_PROFILE_SOURCE_INVALID')
    }
  }
  const out: Partial<SkinSourceBundle> = {}
  for (const key of allowed) {
    const raw = obj[key]
    if (raw === undefined || raw === null) continue
    const max = key === 'manifest_path'
      ? 256
      : (key === 'package_name' ? 320 : 160)
    const normalized = asString(raw, `source_bundle.${key}`, max)
    if (key === 'package_name' && !PROFILE_BUNDLE_ID_PATTERN.test(normalized)) {
      throw new SkinValidationError(
        'source_bundle.package_name 只能包含字母、数字、点、下划线、/、@ 和连字符',
        'SKIN_PROFILE_SOURCE_INVALID'
      )
    }
    if (key === 'package_name') out.package_name = normalized
    else if (key === 'name') out.name = normalized
    else if (key === 'version') out.version = normalized
    else if (key === 'manifest_path') out.manifest_path = normalized
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function checkUnknownFields(obj: Record<string, unknown>, allowed: Set<string>, field: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new SkinValidationError(`${field}含非法字段 "${key}"`, 'SKIN_FIELD_UNKNOWN')
    }
  }
}

/** 校验并规范化用户主题。新建与导入都严格拒绝旧版 raw CSS。 */
export function normalizeSkinDefinition(raw: unknown): SkinDefinition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkinValidationError('主题定义必须是对象', 'SKIN_NOT_OBJECT')
  }
  const obj = raw as Record<string, unknown>
  checkUnknownFields(obj, USER_SKIN_FIELDS, '主题定义')

  const id = asString(obj.id, 'id', 64)
  if (!ID_PATTERN.test(id)) {
    throw new SkinValidationError(
      `id 只能包含小写字母、数字、_、-，且以字母数字开头: "${id}"`,
      'SKIN_ID_FORMAT'
    )
  }
  if (isBuiltinSkinId(id)) {
    throw new SkinValidationError(`id "${id}" 与内置主题冲突，请改名`, 'SKIN_ID_CONFLICT')
  }

  const name = asString(obj.name, 'name', 64)
  const description = obj.description !== undefined && obj.description !== null
    ? asString(obj.description, 'description', 512)
    : undefined
  const base = asBase(obj.base, 'base')
  asExtraCss(obj.extraCss, 'extraCss')
  const pair = asColorPair(obj.vars, obj.mantineColors, 'skin')
  const dark = asSchemeOverride(obj.dark, 'dark')
  const appearance = asAppearance(obj.appearance, 'appearance', {
    allowAppName: false,
    allowLocalImage: true,
    panelOpacityMin: 0
  })

  return {
    id,
    name,
    ...(description ? { description } : {}),
    builtIn: false,
    source: 'user',
    base,
    ...(pair.vars ? { vars: pair.vars } : {}),
    ...(pair.mantineColors ? { mantineColors: pair.mantineColors } : {}),
    ...(dark ? { dark } : {}),
    ...(appearance ? { appearance } : {}),
    updatedAt: Date.now()
  }
}

/**
 * 对 Server 下发的 DSH Profile catalog 再做一次 Renderer 信任边界校验。
 * 与用户导入相比，Profile 主题不得设置应用名或引用本机图片。
 */
export function normalizeProfileThemeDefinition(raw: unknown): SkinDefinition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SkinValidationError('Profile 主题定义必须是对象', 'SKIN_NOT_OBJECT')
  }
  const obj = raw as Record<string, unknown>
  checkUnknownFields(obj, PROFILE_THEME_FIELDS, 'Profile 主题定义')

  const id = asString(obj.id, 'id', 512)
  if (!PROFILE_RUNTIME_ID_PATTERN.test(id)) {
    throw new SkinValidationError(`Profile 主题 id 格式不合法: "${id}"`, 'SKIN_ID_FORMAT')
  }
  if (isBuiltinSkinId(id)) {
    throw new SkinValidationError(`Profile 主题 id "${id}" 与内置主题冲突`, 'SKIN_ID_CONFLICT')
  }
  const name = asString(obj.name, 'name', 64)
  const manifestId = obj.manifest_id !== undefined && obj.manifest_id !== null
    ? asString(obj.manifest_id, 'manifest_id', 64)
    : undefined
  if (manifestId && !ID_PATTERN.test(manifestId)) {
    throw new SkinValidationError(`manifest_id 格式不合法: "${manifestId}"`, 'SKIN_ID_FORMAT')
  }
  const description = obj.description !== undefined && obj.description !== null
    ? asString(obj.description, 'description', 512)
    : undefined
  const base = asBase(obj.base, 'base')
  asExtraCss(obj.extraCss, 'extraCss')
  const pair = asColorPair(obj.vars, obj.mantineColors, 'skin')
  const dark = asSchemeOverride(obj.dark, 'dark')
  const appearance = asAppearance(obj.appearance, 'appearance', {
    allowAppName: false,
    allowLocalImage: false,
    panelOpacityMin: 60
  })
  const sourceBundle = asSourceBundle(obj.source_bundle)
  const packageName = sourceBundle?.package_name
  if (!manifestId || !packageName || !sourceBundle) {
    throw new SkinValidationError(
      'Profile 主题必须提供 manifest_id 与 source_bundle.package_name',
      'SKIN_PROFILE_SOURCE_INVALID'
    )
  }
  const expectedId = `profile:${encodeURIComponent(packageName)}:${manifestId}`
  if (id !== expectedId) {
    throw new SkinValidationError(
      'Profile 主题 id 与 source_bundle / manifest_id 不一致',
      'SKIN_PROFILE_SOURCE_MISMATCH'
    )
  }
  if (!pair.vars && !pair.mantineColors && !dark && !appearance) {
    throw new SkinValidationError(
      'Profile 主题至少需要提供 vars、mantineColors、dark 或 appearance 之一',
      'SKIN_EMPTY'
    )
  }

  return {
    id,
    name,
    ...(description ? { description } : {}),
    builtIn: false,
    source: 'profile',
    manifest_id: manifestId,
    base,
    ...(pair.vars ? { vars: pair.vars } : {}),
    ...(pair.mantineColors ? { mantineColors: pair.mantineColors } : {}),
    ...(dark ? { dark } : {}),
    ...(appearance ? { appearance } : {}),
    source_bundle: { ...sourceBundle, package_name: packageName }
  }
}

/**
 * 升级旧版本地数据。旧 raw CSS 会被明确移除并告警；旧版只有主色而没有 Mantine 色阶时
 * 自动补齐，以免升级后整套皮肤消失。新导入不走此函数，仍会严格报错。
 */
export function migrateLegacySkinDefinition(
  raw: unknown,
  warn: (message: string) => void = (message) => console.warn(`[skins] ${message}`)
): SkinDefinition {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return normalizeSkinDefinition(raw)
  const next = { ...(raw as Record<string, unknown>) }

  if (typeof next.extraCss === 'string' && next.extraCss.trim()) {
    delete next.extraCss
    warn('旧皮肤的原始 CSS 已停用并移除')
  }

  const migrateColorPair = (target: Record<string, unknown>, label: string) => {
    const rawVars = target.vars
    const primary = normalizeHexColor(
      rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)
        ? (rawVars as Record<string, unknown>)['--el-color-primary']
        : undefined
    )
    const hadUnsupportedVars = Boolean(
      rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)
      && Object.keys(rawVars as Record<string, unknown>).some((key) => key !== '--el-color-primary')
    )
    if (hadUnsupportedVars) warn(`${label}中不再支持的 CSS 变量已移除`)
    if (rawVars !== undefined) target.vars = primary ? { '--el-color-primary': primary } : undefined

    let palette: string[] | undefined
    if (target.mantineColors !== undefined) {
      try {
        palette = asMantineColors(target.mantineColors, `${label}.mantineColors`)
      } catch {
        target.mantineColors = undefined
        warn(`${label}中不合法的 Mantine 色阶已移除`)
      }
    }
    if (primary && (!palette || palette[6] !== primary)) {
      target.mantineColors = deriveMantineColors(primary)
      warn(`${label}的主色已补齐一致的 Mantine 色阶`)
    } else if (palette) {
      target.mantineColors = palette
    }
  }

  migrateColorPair(next, '旧皮肤')

  if (next.dark && typeof next.dark === 'object' && !Array.isArray(next.dark)) {
    const dark = { ...(next.dark as Record<string, unknown>) }
    if (typeof dark.extraCss === 'string' && dark.extraCss.trim()) {
      delete dark.extraCss
      warn('旧皮肤的暗色原始 CSS 已停用并移除')
    }
    migrateColorPair(dark, '旧皮肤暗色覆盖')
    next.dark = dark
  }
  if (next.appearance && typeof next.appearance === 'object' && !Array.isArray(next.appearance)) {
    const appearance = { ...(next.appearance as Record<string, unknown>) }
    if (Object.prototype.hasOwnProperty.call(appearance, 'appName')) {
      delete appearance.appName
      warn('旧皮肤携带的应用名称已移除；应用名称现在由品牌设置单独管理')
    }
    if (appearance.bgColor !== undefined && !normalizeHexColor(appearance.bgColor)) {
      delete appearance.bgColor
      warn('旧皮肤的不合法底色已移除')
    }
    if (typeof appearance.bgImage === 'string' && !isSafeBgImage(appearance.bgImage, true)) {
      delete appearance.bgImage
      warn('旧皮肤的不安全背景图引用已移除')
    }
    if (appearance.dark && typeof appearance.dark === 'object' && !Array.isArray(appearance.dark)) {
      const darkAppearance = { ...(appearance.dark as Record<string, unknown>) }
      if (darkAppearance.bgColor !== undefined && !normalizeHexColor(darkAppearance.bgColor)) {
        delete darkAppearance.bgColor
        warn('旧皮肤暗色外观的不合法底色已移除')
      }
      if (typeof darkAppearance.bgImage === 'string' && !isSafeBgImage(darkAppearance.bgImage, true)) {
        delete darkAppearance.bgImage
        warn('旧皮肤暗色外观的不安全背景图引用已移除')
      }
      appearance.dark = darkAppearance
    }
    next.appearance = appearance
  }
  const normalized = normalizeSkinDefinition(next)
  const previousUpdatedAt = next.updatedAt
  if (typeof previousUpdatedAt === 'number' && Number.isFinite(previousUpdatedAt) && previousUpdatedAt >= 0) {
    normalized.updatedAt = previousUpdatedAt
  }
  return normalized
}

/** 解析 SkinFile 信封或裸 SkinDefinition；在 JSON.parse 前先限制资源大小。 */
export function parseSkinFile(text: string): SkinDefinition {
  if (typeof text !== 'string') {
    throw new SkinValidationError('主题文件必须是文本', 'SKIN_FIELD_TYPE')
  }
  const bytes = byteLength(text)
  if (bytes > MAX_SKIN_IMPORT_BYTES) {
    throw new SkinValidationError(
      `主题文件超过 ${MAX_SKIN_IMPORT_BYTES / 1024}KB 上限`,
      'SKIN_FILE_TOO_LARGE'
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new SkinValidationError(`JSON 解析失败: ${(error as Error).message}`, 'SKIN_JSON_PARSE')
  }
  if (parsed && typeof parsed === 'object'
    && ((parsed as SkinFile).kind === 'dsh-theme' || (parsed as SkinFile).kind === 'dsh-skin')) {
    const file = parsed as SkinFile
    if (file.schema_version !== 1) {
      throw new SkinValidationError(`不支持的 schema_version: ${file.schema_version}`, 'SKIN_SCHEMA_VERSION')
    }
    return normalizeSkinDefinition(file.skin)
  }
  return normalizeSkinDefinition(parsed)
}

function assertPortableAppearance(appearance: BrandAppearance | undefined) {
  if (isLocalBgImage(appearance?.bgImage) || isLocalBgImage(appearance?.dark?.bgImage)) {
    throw new SkinValidationError(
      '主题使用了本机背景图，无法导出到其它设备；请先改用内置背景预设',
      'SKIN_ASSET_NOT_PORTABLE'
    )
  }
}

/** 把一个可移植用户皮肤序列化为信封格式。 */
export function serializeSkinFile(skin: SkinDefinition): string {
  if (skin.builtIn || skin.source === 'profile') {
    throw new SkinValidationError('内置或插件主题不可直接导出，请先新建自定义主题', 'SKIN_NOT_EXPORTABLE')
  }
  if (skin.extraCss?.trim() || (skin.dark as unknown as { extraCss?: string } | undefined)?.extraCss?.trim()) {
    throw new SkinValidationError('含原始 CSS 的旧主题不可导出，请先编辑并移除', 'SKIN_RAW_CSS_FORBIDDEN')
  }
  const normalized = normalizeSkinDefinition(skin)
  if (typeof skin.updatedAt === 'number' && Number.isFinite(skin.updatedAt) && skin.updatedAt >= 0) {
    normalized.updatedAt = skin.updatedAt
  }
  assertPortableAppearance(normalized.appearance)
  const file: SkinFile = {
    kind: 'dsh-theme',
    schema_version: 1,
    skin: normalized
  }
  return JSON.stringify(file, null, 2)
}

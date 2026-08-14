// 主题数据模型。内部继续沿用 SkinDefinition 名称读取旧数据，产品界面统一称“主题”。
// 主题 = 内置基底 + 亮色/暗色受控主色 + Mantine 色阶 + 可选主题外观。
//
// 三类来源：
// - builtin: 随包编译的 SCSS 皮肤（CSS 已常驻 <head>），切换靠 html.<htmlClass>。
// - user:    用户自定义皮肤，定义持久化在 localStorage + Electron userData，运行时只写受控主色变量。
// - profile: DSH Profile Bundle 通过 dshWork.themes 显式声明；Renderer 会再次校验后再写受控变量。
//
// 主题与明暗模式（light/dark/system，见 views/agent/themeContext）正交解耦：
// 主题提供 light/dark 两套变体，模式只决定读取哪套，不选择另一个主题。
// 注：--dsh-accent 链式依赖 --el-color-primary，换品牌皮肤时 Agent 视图强调色会自动跟随。

/** 单个皮肤的明/暗变量覆盖（与明暗模式解耦，但允许皮肤自带暗色微调）。 */
export interface SkinSchemeOverride {
  /** v1 只允许 --el-color-primary，值只允许 #RGB / #RRGGBB。 */
  vars?: Record<string, string>
  /** 暗色模式专用 Mantine 主色 10 阶；第 6 阶必须与暗色主色一致。 */
  mantineColors?: string[]
}

/** Profile 主题来源。安装与卸载只由 DSH Profile 管理。 */
export interface SkinSourceBundle {
  package_name: string
  name?: string
  version?: string | null
  manifest_path?: string
}

/** 底图填充方式。 */
export type BgImageSize = 'cover' | 'contain' | 'center'

/**
 * 品牌外观（brand appearance）：应用名 + 底图 + 底色 + 透明度。
 * 与皮肤正交（皮肤管颜色变量，外观管应用名 + 背景层），可独立配置，也可随皮肤自带。
 * 应用内透明（窗口本身不透明，背景层 + 内容面板半透明让底图隐约可见）。
 */
export interface BrandAppearance {
  /** @deprecated 仅用于迁移旧皮肤；主题不能修改应用名称。 */
  appName?: string
  /** 底色（覆盖 --dsh-bg），如 '#f0f4f8'。 */
  bgColor?: string
  /** 底图来源：内置预设 id（见 backgrounds.ts）或本地图片的应用内 URL（dsh-skin-asset:// 协议）。 */
  bgImage?: string
  /** 底图填充方式，默认 cover。 */
  bgImageSize?: BgImageSize
  /** 底图不透明度 0-100（底图在该透明度下显示；0=完全透明不显示底图）。 */
  bgOpacity?: number
  /** 内容面板不透明度 0-100（越低越透明，能看见底图；默认 100=不透）。 */
  panelOpacity?: number
  /** 暗色模式下的覆盖（仅 bg/panel 相关，appName 不分明暗）。 */
  dark?: Partial<Omit<BrandAppearance, 'appName' | 'dark'>>
}

export interface SkinDefinition {
  /** 唯一 id，如 'lighting' / 'my-ocean'。 */
  id: string
  /** 显示名。 */
  name: string
  /** 可选描述。 */
  description?: string
  /** true=随包内置（走 SCSS）；false=用户/Profile 主题（内置 base + 受控 inline 主色）。 */
  builtIn: boolean
  /** 来源标记。 */
  source?: 'builtin' | 'user' | 'profile'
  /**
   * 仅内置皮肤使用：对应 SCSS 中 html.<htmlClass> 的选择器类名。
   * 当前宿主底座 lighting 对应 'lighting-theme'。
   * 自定义/Profile 主题忽略此字段，只能通过 base 选取已注册的内置类。
   */
  htmlClass?: string
  /** 自定义/Profile 主题的宿主底座；缺省输入会规范化为 lighting。 */
  base?: string
  /** 明色/默认变量覆盖；v1 只允许 --el-color-primary 十六进制颜色。 */
  vars?: Record<string, string>
  /** Mantine 主色 10 阶色板，存在时同步更新 MantineProvider 主色。 */
  mantineColors?: string[]
  /** @deprecated v1 安全契约禁止原始 CSS；仅为迁移旧数据保留类型兼容。 */
  extraCss?: string
  /** 可选暗色覆盖（明暗切到 dark 时叠加）。 */
  dark?: SkinSchemeOverride
  /** 可选品牌外观（应用名/底图/底色/透明度），随皮肤自带。 */
  appearance?: BrandAppearance
  /** DSH Profile Bundle 来源。用户导入不可声明。 */
  source_bundle?: SkinSourceBundle
  /** Bundle 主题描述中的原始 id；运行时复合 id 不用于界面展示。 */
  manifest_id?: string
  /** 可选创建/更新时间戳（用户皮肤导入导出用）。 */
  updatedAt?: number
}

export interface SkinCatalog {
  skins: SkinDefinition[]
  activeSkinId: string
}

/** 皮肤 JSON 导入/导出文件的信封格式。 */
export interface SkinFile {
  /** 新文件使用 theme；skin 仅用于读取旧版导出。 */
  kind: 'dsh-theme' | 'dsh-skin'
  /** 信封版本，当前为 1。 */
  schema_version: 1
  /** 皮肤定义（单个）。 */
  skin: SkinDefinition
}

/** 从 SkinDefinition 解析出应用时实际生效的 html 类名。 */
export function skinHtmlClass(skin: SkinDefinition): string {
  if (skin.builtIn) return skin.htmlClass || skin.id
  return ''
}

// 皮肤可使用的受控颜色变量与颜色工具。
//
// 自定义皮肤不允许写任意 CSS 变量。这里的白名单只包含颜色 token；所有值统一为
// 十六进制颜色，既能避免 `; }` 等声明逃逸，也让 Renderer / Server 校验结果稳定一致。

export const SAFE_SKIN_COLOR_VARS = Object.freeze([
  '--el-color-primary'
] as const)

const SAFE_SKIN_COLOR_VAR_SET = new Set<string>(SAFE_SKIN_COLOR_VARS)
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** 是否是允许由皮肤覆盖的颜色变量。 */
export function isSafeSkinColorVar(name: string): boolean {
  return SAFE_SKIN_COLOR_VAR_SET.has(name)
}

/** 是否是合法且不会逃逸 CSS 声明的十六进制颜色。 */
export function isSafeHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value.trim())
}

/**
 * 规范化十六进制颜色。Mantine 主色要求不透明色，因此 requireOpaque=true 时只接受
 * #RGB / #RRGGBB，并统一返回小写 #rrggbb。
 */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!HEX_COLOR_PATTERN.test(trimmed)) return null
  const body = trimmed.slice(1).toLowerCase()
  if (body.length === 3) {
    return `#${body.split('').map((part) => part + part).join('')}`
  }
  return `#${body}`
}

/**
 * 从一个不透明主色生成 Mantine 10 阶色板（浅→深）。第 6 阶固定为输入主色，
 * 因为 Mantine 默认使用 shade 6；这样 Element、Agent 与 Mantine 的主色完全一致。
 */
export function deriveMantineColors(value: string): string[] {
  const base = normalizeHexColor(value)
  if (!base) throw new Error('主色必须是 #RGB 或 #RRGGBB 十六进制颜色')

  const red = Number.parseInt(base.slice(1, 3), 16)
  const green = Number.parseInt(base.slice(3, 5), 16)
  const blue = Number.parseInt(base.slice(5, 7), 16)
  // 正数与白色混合；负数与黑色混合；第 6 项（索引 6）保留原色。
  const mixes = [0.92, 0.82, 0.68, 0.5, 0.32, 0.16, 0, -0.12, -0.24, -0.36]

  return mixes.map((ratio) => {
    const target = ratio >= 0 ? 255 : 0
    const weight = Math.abs(ratio)
    const channel = (part: number) => Math.round(part + (target - part) * weight)
    return `#${toHex(channel(red))}${toHex(channel(green))}${toHex(channel(blue))}`
  })
}

/** 把主色按比例混向另一个颜色；ratio=0 保留主色，ratio=1 完全使用 target。 */
export function mixHexColor(value: string, targetValue: string, ratio: number): string {
  const base = normalizeHexColor(value)
  const target = normalizeHexColor(targetValue)
  if (!base || !target) throw new Error('混色只接受十六进制颜色')
  const weight = Math.max(0, Math.min(1, ratio))
  const channel = (hex: string, offset: number) => Number.parseInt(hex.slice(offset, offset + 2), 16)
  const mixed = [1, 3, 5].map((offset) => Math.round(
    channel(base, offset) + (channel(target, offset) - channel(base, offset)) * weight
  ))
  return `#${mixed.map(toHex).join('')}`
}

/** 为小字号按钮选择对比度更高的前景色。 */
export function readableTextColor(background: string): string {
  const normalized = normalizeHexColor(background)
  if (!normalized) return '#fffefa'
  const luminance = (value: string) => {
    const channels = [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
      .map((part) => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4)
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
  }
  const bg = luminance(normalized)
  const light = '#fffefa'
  const dark = '#18181b'
  const contrast = (candidate: string) => {
    const fg = luminance(candidate)
    return (Math.max(bg, fg) + 0.05) / (Math.min(bg, fg) + 0.05)
  }
  return contrast(light) >= contrast(dark) ? light : dark
}

function toHex(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0')
}

import { DEFAULT_SKIN_ID, findBuiltinSkin } from './builtin'
import type { SkinDefinition } from './types'

/**
 * 解析当前实际 Mantine 色阶：暗色色阶 > 皮肤默认色阶 > 内置 base 色阶。
 * appearance-only 皮肤也必须继承 base，否则 Element 与 Mantine 会出现两套主色。
 */
export function mantineColorsForScheme(
  skin: SkinDefinition | null | undefined,
  scheme: 'light' | 'dark'
): string[] | undefined {
  if (scheme === 'dark' && skin?.dark?.mantineColors?.length === 10) {
    return skin.dark.mantineColors
  }
  if (skin?.mantineColors?.length === 10) return skin.mantineColors
  if (!skin || skin.builtIn) return undefined
  const base = findBuiltinSkin(skin.base || DEFAULT_SKIN_ID)
  if (scheme === 'dark' && base?.dark?.mantineColors?.length === 10) return base.dark.mantineColors
  return base?.mantineColors
}

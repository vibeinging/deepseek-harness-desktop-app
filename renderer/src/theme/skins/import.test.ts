import { describe, expect, it, vi } from 'vitest'

import { deriveMantineColors } from './colors'
import {
  MAX_SKIN_IMPORT_BYTES,
  migrateLegacySkinDefinition,
  normalizeProfileThemeDefinition,
  normalizeSkinDefinition,
  parseSkinFile,
  serializeSkinFile,
  SkinValidationError
} from './import'

const PRIMARY = '#1e6fff'
const VALID_COLORS = deriveMantineColors(PRIMARY)

function baseSkin(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'my-ocean',
    name: '我的海蓝',
    vars: { '--el-color-primary': PRIMARY },
    mantineColors: VALID_COLORS,
    ...overrides
  }
}

function profileTheme(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseSkin({
    id: 'profile:bundle.example:my-ocean',
    manifest_id: 'my-ocean',
    source_bundle: { package_name: 'bundle.example', name: '示例 Bundle', version: '1.0.0' },
    ...overrides
  })
}

describe('normalizeSkinDefinition', () => {
  it('规范化合法皮肤并补默认 base', () => {
    const skin = normalizeSkinDefinition(baseSkin())
    expect(skin.id).toBe('my-ocean')
    expect(skin.builtIn).toBe(false)
    expect(skin.source).toBe('user')
    expect(skin.base).toBe('lighting')
    expect(skin.mantineColors).toEqual(VALID_COLORS)
  })

  it('拒绝与内置皮肤冲突或格式非法的 id', () => {
    expect(() => normalizeSkinDefinition(baseSkin({ id: 'lighting' }))).toThrow(SkinValidationError)
    expect(() => normalizeSkinDefinition(baseSkin({ id: 'My Ocean' }))).toThrow(/id/)
  })

  it('base 只能引用内置皮肤', () => {
    expect(normalizeSkinDefinition(baseSkin({ base: 'lighting' })).base).toBe('lighting')
    expect(() => normalizeSkinDefinition(baseSkin({ base: 'dark' }))).toThrow(/内置主题 id/)
    expect(() => normalizeSkinDefinition(baseSkin({ base: 'does-not-exist' }))).toThrow(/内置主题 id/)
  })

  it('只允许主色变量，且颜色仅接受 #RGB/#RRGGBB', () => {
    expect(() => normalizeSkinDefinition(baseSkin({ vars: { '--dsh-accent': '#fff' } }))).toThrow(/只允许/)
    expect(() => normalizeSkinDefinition(baseSkin({ vars: { '--el-color-primary': 'red' } }))).toThrow(/十六进制/)
    expect(() => normalizeSkinDefinition(baseSkin({ vars: { '--el-color-primary': 'red; } body {' } }))).toThrow(/十六进制/)
  })

  it('主色必须带 10 阶色板，且第 6 阶一致', () => {
    expect(() => normalizeSkinDefinition(baseSkin({ mantineColors: undefined }))).toThrow(/必须同时提供/)
    expect(() => normalizeSkinDefinition(baseSkin({ mantineColors: ['#fff', '#000'] }))).toThrow(/10/)
    const mismatch = [...VALID_COLORS]
    mismatch[6] = '#ffffff'
    expect(() => normalizeSkinDefinition(baseSkin({ mantineColors: mismatch }))).toThrow(/必须与/)
  })

  it('只有 Mantine 色阶时从第 6 阶派生主色', () => {
    const skin = normalizeSkinDefinition(baseSkin({ vars: undefined }))
    expect(skin.vars?.['--el-color-primary']).toBe(PRIMARY)
  })

  it('dark 主色使用独立且一致的 Mantine 色阶', () => {
    const darkColors = deriveMantineColors('#9aa0aa')
    const skin = normalizeSkinDefinition(baseSkin({
      dark: { vars: { '--el-color-primary': '#9aa0aa' }, mantineColors: darkColors }
    }))
    expect(skin.dark?.vars?.['--el-color-primary']).toBe('#9aa0aa')
    expect(skin.dark?.mantineColors?.[6]).toBe('#9aa0aa')
    expect(() => normalizeSkinDefinition(baseSkin({
      dark: { vars: { '--el-color-primary': '#9aa0aa' } }
    }))).toThrow(/必须同时提供/)
  })

  it('拒绝非空原始 CSS 和未知字段', () => {
    expect(() => normalizeSkinDefinition(baseSkin({ extraCss: 'body { display: none }' }))).toThrow(/不支持原始 CSS/)
    expect(() => normalizeSkinDefinition(baseSkin({ dark: { extraCss: 'body{}' } }))).toThrow(/不支持原始 CSS/)
    expect(() => normalizeSkinDefinition(baseSkin({ evil: true }))).toThrow(/非法字段/)
  })
})

describe('parseSkinFile / serializeSkinFile', () => {
  it('解析信封和裸定义', () => {
    const legacyEnvelope = JSON.stringify({ kind: 'dsh-skin', schema_version: 1, skin: baseSkin() })
    const themeEnvelope = JSON.stringify({ kind: 'dsh-theme', schema_version: 1, skin: baseSkin() })
    expect(parseSkinFile(legacyEnvelope).id).toBe('my-ocean')
    expect(parseSkinFile(themeEnvelope).id).toBe('my-ocean')
    expect(parseSkinFile(JSON.stringify(baseSkin())).id).toBe('my-ocean')
  })

  it('在 JSON.parse 前拒绝超大文本', () => {
    const text = `{"pad":"${'x'.repeat(MAX_SKIN_IMPORT_BYTES)}"}`
    expect(() => parseSkinFile(text)).toThrow(/256KB/)
    try {
      parseSkinFile(text)
    } catch (error) {
      expect((error as SkinValidationError).code).toBe('SKIN_FILE_TOO_LARGE')
    }
  })

  it('拒绝错误 JSON 和 schema_version', () => {
    expect(() => parseSkinFile('{ not json')).toThrow(SkinValidationError)
    expect(() => parseSkinFile(JSON.stringify({
      kind: 'dsh-skin', schema_version: 2, skin: baseSkin()
    }))).toThrow(/schema_version/)
  })

  it('可移植用户皮肤可以往返', () => {
    const original = normalizeSkinDefinition(baseSkin({
      description: '测试描述',
      appearance: { bgImage: 'dawn', panelOpacity: 85 }
    }))
    const parsed = parseSkinFile(serializeSkinFile(original))
    expect(JSON.parse(serializeSkinFile(original)).kind).toBe('dsh-theme')
    expect(parsed.description).toBe('测试描述')
    expect(parsed.base).toBe('lighting')
    expect(parsed.appearance?.bgImage).toBe('dawn')
  })

  it('本机图片、内置皮肤和 Profile 主题不可导出', () => {
    const local = normalizeSkinDefinition(baseSkin({
      appearance: { bgImage: 'dsh-skin-asset://0123456789abcdef01234567.png' }
    }))
    expect(() => serializeSkinFile(local)).toThrow(/无法导出到其它设备/)
    try {
      serializeSkinFile(local)
    } catch (error) {
      expect((error as SkinValidationError).code).toBe('SKIN_ASSET_NOT_PORTABLE')
    }
    expect(() => serializeSkinFile({ ...local, builtIn: true, source: 'builtin' })).toThrow(/不可.*导出/)
    expect(() => serializeSkinFile({ ...local, source: 'profile' })).toThrow(/不可.*导出/)
  })
})

describe('appearance 安全校验', () => {
  it('用户主题允许预设与本机 IPC 资源，但不能修改应用名称', () => {
    const skin = normalizeSkinDefinition(baseSkin({
      appearance: {
        bgColor: '#abc',
        bgImage: 'dsh-skin-asset://0123456789abcdef01234567.webp',
        bgOpacity: 40,
        panelOpacity: 90
      }
    }))
    expect(skin.appearance?.bgColor).toBe('#aabbcc')
    expect(() => normalizeSkinDefinition(baseSkin({
      appearance: { appName: '我的应用' }
    }))).toThrow(/不属于主题/)
  })

  it('拒绝远程 URL、裸 CSS、非法颜色与越界透明度', () => {
    expect(() => normalizeSkinDefinition(baseSkin({ appearance: { bgImage: 'https://example.com/a.png' } }))).toThrow(/本机主题图片/)
    expect(() => normalizeSkinDefinition(baseSkin({ appearance: { bgImage: 'linear-gradient(red, blue)' } }))).toThrow(/本机主题图片/)
    expect(() => normalizeSkinDefinition(baseSkin({ appearance: { bgColor: 'rgb(1,2,3)' } }))).toThrow(/十六进制/)
    expect(() => normalizeSkinDefinition(baseSkin({ appearance: { bgOpacity: 150 } }))).toThrow(/0-100/)
  })
})

describe('Profile Renderer 二次校验', () => {
  it('保留 Bundle 来源但强制 source=profile', () => {
    const skin = normalizeProfileThemeDefinition(profileTheme({ builtIn: true, source: 'builtin' }))
    expect(skin.id).toBe('profile:bundle.example:my-ocean')
    expect(skin.builtIn).toBe(false)
    expect(skin.source).toBe('profile')
    expect(skin.source_bundle?.name).toBe('示例 Bundle')
  })

  it('接受精确复合 id，包括 encodeURIComponent 的 %40 来源', () => {
    expect(normalizeProfileThemeDefinition(profileTheme({
      id: 'profile:%40scope%2Fexample:ocean',
      manifest_id: 'ocean',
      source_bundle: { package_name: '@scope/example', name: '示例 Bundle' }
    })).id).toBe('profile:%40scope%2Fexample:ocean')
    expect(() => normalizeProfileThemeDefinition(profileTheme({
      id: 'profile:%ZZ:ocean',
      manifest_id: 'ocean'
    }))).toThrow(/id 格式/)
  })

  it('拒绝运行时 id 与来源身份不一致', () => {
    expect(() => normalizeProfileThemeDefinition(profileTheme({
      id: 'profile:other.example:my-ocean'
    }))).toThrow(/不一致/)
    expect(() => normalizeProfileThemeDefinition(baseSkin({
      id: 'profile:bundle.example:my-ocean'
    }))).toThrow(/必须提供/)
  })

  it('package_name 支持 161-320 字符并保持来源绑定', () => {
    const canonical = `bundle.${'a'.repeat(193)}`
    const id = `profile:${encodeURIComponent(canonical)}:ocean`
    const skin = normalizeProfileThemeDefinition(profileTheme({
      id,
      manifest_id: 'ocean',
      source_bundle: { package_name: canonical, name: '长来源 Bundle' }
    }))
    expect(skin.source_bundle?.package_name).toBe(canonical)
  })

  it('拒绝不符合 Server 标识语法的 Bundle 来源，即使复合 id 与其编码结果一致', () => {
    const canonical = 'bundle name'
    expect(() => normalizeProfileThemeDefinition(profileTheme({
      id: `profile:${encodeURIComponent(canonical)}:ocean`,
      manifest_id: 'ocean',
      source_bundle: { package_name: canonical, name: '伪造来源' }
    }))).toThrow(/只能包含/)
  })

  it('拒绝只有 base、没有任何主题内容的 Profile 主题', () => {
    expect(() => normalizeProfileThemeDefinition(profileTheme({
      vars: undefined,
      mantineColors: undefined
    }))).toThrow(/至少需要/)
  })

  it('Profile 主题不能设置应用名、本机图片或原始 CSS', () => {
    expect(() => normalizeProfileThemeDefinition(profileTheme({
      appearance: { appName: '冒充宿主' }
    }))).toThrow(/不属于主题/)
    expect(() => normalizeProfileThemeDefinition(profileTheme({
      appearance: { appName: null, bgColor: '#fff' }
    }))).toThrow(/不属于主题/)
    expect(() => normalizeProfileThemeDefinition(profileTheme({
      appearance: { bgImage: 'dsh-skin-asset://0123456789abcdef01234567.png' }
    }))).toThrow(/内置背景预设/)
    expect(() => normalizeProfileThemeDefinition(profileTheme({ extraCss: 'body{}' }))).toThrow(/不支持原始 CSS/)
    expect(() => normalizeProfileThemeDefinition(profileTheme({
      appearance: { panelOpacity: 59 }
    }))).toThrow(/60-100/)
  })
})

describe('旧皮肤迁移', () => {
  it('移除 raw CSS、补 base/色阶并产生 warning', () => {
    const warn = vi.fn()
    const skin = migrateLegacySkinDefinition({
      id: 'legacy',
      name: '旧皮肤',
      vars: { '--el-color-primary': '#1e6fff' },
      extraCss: 'body { display: none }',
      dark: { vars: { '--el-color-primary': '#9aa0aa' }, extraCss: 'html{}' }
    }, warn)
    expect(skin.base).toBe('lighting')
    expect(skin.extraCss).toBeUndefined()
    expect(skin.mantineColors?.[6]).toBe('#1e6fff')
    expect(skin.dark?.mantineColors?.[6]).toBe('#9aa0aa')
    expect(warn).toHaveBeenCalledTimes(4)
  })

  it('迁移时只移除不安全旧字段，不丢整套皮肤', () => {
    const warn = vi.fn()
    const skin = migrateLegacySkinDefinition({
      id: 'legacy-vars',
      name: '旧变量皮肤',
      vars: { '--el-color-primary': '#abc', '--side-bar-width': '9999px' },
      appearance: { bgColor: 'url(https://example.com)', bgImage: 'https://example.com/a.png' }
    }, warn)
    expect(skin.vars).toEqual({ '--el-color-primary': '#aabbcc' })
    expect(skin.mantineColors?.[6]).toBe('#aabbcc')
    expect(skin.appearance).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('迁移旧主题时移除应用名称并保留其它外观', () => {
    const warn = vi.fn()
    const skin = migrateLegacySkinDefinition({
      ...baseSkin(),
      appearance: { appName: '旧主题名称', bgImage: 'aurora' }
    }, warn)
    expect(skin.appearance).toEqual({ bgImage: 'aurora' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('应用名称'))
  })

  it('同一份已迁移数据重复迁移保持稳定 updatedAt', () => {
    const first = migrateLegacySkinDefinition({
      id: 'stable',
      name: '稳定皮肤',
      vars: { '--el-color-primary': '#1e6fff' },
      mantineColors: VALID_COLORS,
      updatedAt: 1234
    })
    const second = migrateLegacySkinDefinition(first)
    expect(second.updatedAt).toBe(1234)
    expect(second).toEqual(first)
  })
})

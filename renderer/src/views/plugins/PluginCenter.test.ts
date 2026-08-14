import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('./PluginCenter.tsx', import.meta.url)), 'utf8')
const api = readFileSync(fileURLToPath(new URL('../../api/plugins.ts', import.meta.url)), 'utf8')

describe('DSH Profile Bundle community plugin flow', () => {
  it('preflights a fixed source before enabling installation', () => {
    expect(api).toContain("url: '/api/agent/profile-bundles/preflight'")
    expect(source).toContain('preflightProfileBundleReq(source)')
    expect(source).toContain('检查兼容性')
    expect(source).toContain("disabled={!preflight?.installable")
    expect(source).toContain('data-profile-preflight={preflight.status}')
  })

  it('explains Profile, SDK and product-surface boundaries without exposing a second UI', () => {
    expect(source).toContain('需要补齐 dsh.bundle.patch、当前 dsh.client / ./client 清单和正式 SDK 版本后再安装')
    expect(source).toContain('dsh-work 不会改为链接 DSH 源码')
    expect(source).toContain('这个 Bundle 会进入当前主窗口的 DSH Client 图')
    expect(source).toContain('设置页、全局浮层和侧栏底部加法位置使用标准 Slot')
    expect(source).toContain('data-dsh-client-surface-status')
    expect(source).toContain("detail.ui_runtime.isolation === 'quarantined'")
    expect(source).toContain('data-profile-bundle-blocked')
    expect(source).toContain('主窗口已支持')
    expect(source).toContain('不代表这个插件实际注册了这些位置')
    expect(source).not.toContain('adopted_slots')
    expect(source).not.toContain('dsh-work 尚未承载该图')
    expect(source).not.toContain('按这里显示的顺序进入 DSH Web')
  })
})

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
    expect(source).toContain('需要补齐 dsh.bundle.patch、当前 dshClient 清单和正式 SDK 版本后再安装')
    expect(source).toContain('dsh-work 不会绕过 registry 改为链接 DSH 源码')
    expect(source).toContain('不会自动出现在 dsh-work 工作台')
    expect(source).not.toContain('按这里显示的顺序进入 DSH Web')
  })
})

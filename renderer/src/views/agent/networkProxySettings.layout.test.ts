import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = readFileSync(fileURLToPath(new URL('./AgentSettings.tsx', import.meta.url)), 'utf8')

describe('proxy credential persistence boundary', () => {
  it('drops old authenticated proxy values before settings return to localStorage', () => {
    expect(source).toContain("httpProxy: proxyContainsCredentials(merged.httpProxy) ? ''")
  })

  it('rejects authenticated proxy input before updating renderer state or saving IPC settings', () => {
    const setter = source.slice(source.indexOf('const setNetwork ='), source.indexOf('const setWebSearchSetting ='))
    expect(setter).toContain("key === 'httpProxy' && proxyContainsCredentials(value)")
    expect(setter.indexOf('proxyContainsCredentials')).toBeLessThan(setter.indexOf('setData(next)'))
    expect(setter.indexOf('proxyContainsCredentials')).toBeLessThan(setter.indexOf('saveDesktopNetworkSettings'))
  })
})

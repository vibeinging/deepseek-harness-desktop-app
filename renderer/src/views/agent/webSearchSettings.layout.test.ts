import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const settingsSource = readFileSync(fileURLToPath(new URL('./AgentSettings.tsx', import.meta.url)), 'utf8')
const mainSource = readFileSync(fileURLToPath(new URL('../../../../electron/main.js', import.meta.url)), 'utf8')
const packageSource = readFileSync(fileURLToPath(new URL('../../../../electron/package.json', import.meta.url)), 'utf8')

describe('global web search settings', () => {
  it('shows only one generic API URL and key in runtime and network settings', () => {
    expect(settingsSource).toContain('title="联网搜索"')
    expect(settingsSource).toContain('label="搜索 API URL"')
    expect(settingsSource).toContain('label="API Key"')
    expect(settingsSource).toContain('webSearchApiUrl')
    expect(settingsSource).toContain('webSearchApiKey')
    expect(settingsSource).not.toContain('webSearchProvider')
    expect(settingsSource).not.toContain('SerpApi API')
    expect(settingsSource).not.toContain('Tavily API')
    expect(settingsSource).toContain("secret")
  })

  it('persists search settings in the desktop host and packages the environment adapter', () => {
    expect(mainSource).toContain('normalizeWebSearchSettings')
    expect(mainSource).toContain('applyWebSearchEnv(env, settings)')
    expect(mainSource).toContain('mode: 0o600')
    expect(packageSource).toContain('web-search-settings.js')
  })
})

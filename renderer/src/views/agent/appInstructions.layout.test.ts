import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8')

describe('App global instructions', () => {
  it('has a first-class settings entry and a real saved editor', () => {
    const settings = read('./AgentSettings.tsx')
    const editor = read('./AppInstructions.tsx')
    const api = read('../../api/app-settings.ts')

    expect(settings).toMatch(/key:\s*'instructions', label:\s*'全局指令'/)
    expect(settings).toMatch(/active === 'instructions'[\s\S]*<AppInstructions \/>/)
    expect(editor).toMatch(/getAppInstructionsReq\(\)/)
    expect(editor).toMatch(/updateAppInstructionsReq\(instructions\)/)
    expect(editor).toMatch(/maxLength=\{maxLength\}/)
    expect(api).toMatch(/\/api\/agent\/settings\/instructions/)
  })
})

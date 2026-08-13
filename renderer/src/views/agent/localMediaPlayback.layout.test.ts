import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('inline local media result contract', () => {
  it('renders resolved workspace videos with native controls and a safe fallback', () => {
    const conversation = read('./conversation/AssistantContent.tsx')
    const styles = read('./agent.module.scss')

    expect(conversation).toContain('data-inline-media={kind}')
    expect(conversation).toContain('controls')
    expect(conversation).toContain('playsInline')
    expect(conversation).toContain('preload="metadata"')
    expect(conversation).toContain('无法在页面内播放这个')
    expect(styles).toContain('.localMediaCard video')
    expect(styles).toContain('aspect-ratio: 16 / 9')
  })
})

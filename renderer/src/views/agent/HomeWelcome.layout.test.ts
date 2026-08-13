import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HOME_BLINK_MAX_DELAY_MS, HOME_BLINK_MIN_DELAY_MS, randomHomeBlinkDelay, shouldDoubleHomeBlink } from './homeBlink'
import { resolveHomeGreeting } from './homeGreeting'

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')

describe('homepage character', () => {
  it('appears only on the new-conversation home and stays decorative', () => {
    const conversation = read('./AgentConversation.tsx')
    const welcome = read('./HomeWelcome.tsx')

    expect(conversation).toContain('showCharacter={!selectedId && !temporary}')
    expect(welcome).toContain('aria-hidden="true"')
    expect(welcome).toContain('draggable={false}')
    expect(welcome).toContain("@/assets/dsh-home-character.png")
    expect(welcome).toContain("@/assets/dsh-home-character-loop.webm")
    expect(welcome).toContain('muted')
    expect(welcome).toContain('playsInline')
    expect(welcome).not.toContain('autoPlay')
    expect(welcome).not.toMatch(/\sloop(?:\s|=)/)
    expect(welcome).toContain('randomHomeBlinkDelay()')
  })

  it('varies blink waits and keeps occasional double blinks deterministic at the boundaries', () => {
    expect(randomHomeBlinkDelay(() => 0)).toBe(HOME_BLINK_MIN_DELAY_MS)
    expect(randomHomeBlinkDelay(() => 0.5)).toBe(6_000)
    expect(randomHomeBlinkDelay(() => 1)).toBe(HOME_BLINK_MAX_DELAY_MS)
    expect(shouldDoubleHomeBlink(() => 0.1)).toBe(true)
    expect(shouldDoubleHomeBlink(() => 0.5)).toBe(false)
  })

  it('places the transparent cutout above the composer with its hands over the top edge', () => {
    const welcome = read('./HomeWelcome.tsx')
    const styles = read('./HomeWelcome.module.scss')

    expect(welcome).toContain("data-has-character={showCharacter ? 'true' : 'false'}")
    expect(welcome).toContain('data-greeting-period={greeting.period}')
    expect(welcome).toContain('dsh-work')
    expect(welcome).toMatch(/className=\{styles\.character\}[\s\S]*className=\{styles\.composer\}/)
    expect(styles).toContain(".interaction[data-has-character='true']")
    expect(styles).toContain('padding-top: var(--home-character-rise)')
    expect(styles).toContain('z-index: 3')
    expect(styles).toContain('z-index: 2')
    expect(styles).toContain('color: var(--dsh-muted)')
    expect(styles).toContain('color: var(--dsh-faint)')
    expect(styles).toContain('object-fit: contain')
    expect(styles).not.toContain('@keyframes home-character-breathe')
    expect(styles).not.toContain('animation: home-character')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(styles).toContain('@container (max-width: 760px)')
  })

  it.each([
    [2, 'late', '这么晚了还要工作呀？'],
    [9, 'morning', '上午好，今天做点什么？'],
    [15, 'afternoon', '下午好，接下来做点什么？'],
    [20, 'evening', '晚上好，还要继续吗？'],
    [23, 'late', '这么晚了还要工作呀？']
  ] as const)('uses the local hour %i for the %s line', (hour, period, title) => {
    const greeting = resolveHomeGreeting(new Date(2026, 0, 1, hour))
    expect(greeting).toMatchObject({ period, title })
  })
})

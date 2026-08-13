import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import TurnLocator, { type TurnLocatorMarker } from './TurnLocator'

function markers(count: number): TurnLocatorMarker[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `question-${index}`,
    title: `第 ${index + 1} 问`,
    excerpt: `问题 ${index + 1}`,
  }))
}

describe('TurnLocator rendering mode', () => {
  it('renders only MAX ticks inside a scrollable virtual rail for a long conversation', () => {
    const html = renderToStaticMarkup(
      <TurnLocator
        markers={markers(1_000)}
        activeId="question-617"
        ariaLabel="对话轮次导航"
        onSelect={vi.fn()}
      />
    )

    expect(html).toContain('data-turn-locator-mode="scroll"')
    expect(html).toContain('data-turn-locator-rendered="20"')
    expect(html).toContain('role="region"')
    expect(html.match(/<button/g)).toHaveLength(20)
    expect(html).not.toContain('role="slider"')
  })

  it('keeps direct question buttons for a short conversation', () => {
    const html = renderToStaticMarkup(
      <TurnLocator
        markers={markers(12)}
        activeId="question-4"
        ariaLabel="对话轮次导航"
        onSelect={vi.fn()}
      />
    )

    expect(html).toContain('data-turn-locator-mode="ticks"')
    expect(html).toContain('data-turn-locator-rendered="12"')
    expect(html.match(/<button/g)).toHaveLength(12)
    expect(html).not.toContain('role="slider"')
  })
})

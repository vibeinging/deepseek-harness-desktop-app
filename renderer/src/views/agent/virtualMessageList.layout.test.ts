import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

describe('conversation virtual message list contract', () => {
  it('renders only virtual rows and measures their dynamic height', () => {
    const conversation = read('./AgentConversation.tsx')
    const styles = read('./agent.module.scss')
    const packageJson = read('../../../package.json')

    expect(packageJson).toContain('"@tanstack/react-virtual"')
    expect(conversation).toContain('useVirtualizer<HTMLDivElement, HTMLDivElement>')
    expect(conversation).toContain('count: messages.length')
    expect(conversation).toContain('ref={messageVirtualizer.measureElement}')
    expect(conversation).toContain('messageVirtualizer.getTotalSize()')
    expect(conversation).toContain("anchorTo: 'end'")
    expect(conversation).toContain("followOnAppend: 'auto'")
    expect(conversation).toContain('useFlushSync: false')
    expect(conversation).not.toContain('historyRenderWindow(')
    expect(styles).toContain('.virtualMessageRow')
    expect(styles).toContain('position: absolute')
  })

  it('keeps message images lazy while video and audio load metadata only', () => {
    const content = read('./conversation/AssistantContent.tsx')
    const markdown = read('../../utils/markdownConfig.ts')

    expect(content).toContain('loading="lazy"')
    expect(content).toContain('decoding="async"')
    expect(content).toContain('preload="metadata"')
    expect(markdown).toContain('renderLazyMarkdownImage')
    expect(markdown).toContain('loading="lazy" decoding="async"')
  })
})

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const source = [
  './AgentConversation.tsx',
  './conversation/AssistantContent.tsx'
].map((file) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')).join('\n')
const styles = readFileSync(fileURLToPath(new URL('./agent.module.scss', import.meta.url)), 'utf8')

describe('chat web search surface', () => {
  it('provides per-turn auto, required and off modes', () => {
    expect(source).toContain("type SearchMode = 'auto' | 'required' | 'off'")
    expect(source).toContain('data-search-mode={searchMode}')
    expect(source).toContain('searchMode,')
    expect(styles).toContain(".searchModeButton[data-search-mode='required']")
  })

  it('renders structured source cards and passes sources into inline citation rendering', () => {
    expect(source).toContain("b.type === 'web_sources'")
    expect(source).toContain('annotateWebCitations')
    expect(source).toContain('#dsh-web-source-')
    expect(source).toContain('id={`dsh-web-source-${source.source_id}`}')
    expect(source).toContain('data-web-sources')
    expect(styles).toContain('.webSourcesList')
  })
})

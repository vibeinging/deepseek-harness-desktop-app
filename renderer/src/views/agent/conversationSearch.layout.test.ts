import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const searchPalette = readFileSync(new URL('./SearchPalette.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('./AgentShell.tsx', import.meta.url), 'utf8')
const files = readFileSync(new URL('./WorkspaceFilesSection.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../../api/agent.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./agent.module.scss', import.meta.url), 'utf8')

describe('workspace search contract', () => {
  it('queries conversations, native file search and saved web sources after one short debounce', () => {
    expect(searchPalette).toContain('searchAgentConversations(keyword, 60, filters)')
    expect(searchPalette).toContain('searchAgentFiles(keyword, 60, filters)')
    expect(searchPalette).toContain('searchAgentWebSources(keyword, 50, filters)')
    expect(searchPalette).toContain('Promise.allSettled')
    expect(searchPalette).toContain('}, 180)')
    expect(api).toContain("url: '/api/agent/search/conversations'")
    expect(api).toContain("url: '/api/agent/search/files'")
    expect(api).toContain("url: '/api/agent/search/web-sources'")
  })

  it('shows type, project and time filters while keeping keyboard navigation', () => {
    expect(searchPalette).toContain('搜索项目、对话、文件、产物或网页来源…')
    expect(searchPalette).toContain('value={resultKind}')
    expect(searchPalette).toContain('value={projectFilter}')
    expect(searchPalette).toContain('value={timeRange}')
    expect(searchPalette).toContain('styles.searchItemSnippet')
    expect(searchPalette).toContain("' · 已归档'")
    expect(searchPalette).toContain("kind: 'file'")
    expect(searchPalette).toContain('<IconFile')
    expect(searchPalette).toContain('<IconWorldSearch')
    expect(searchPalette).toContain("e.key === 'ArrowDown'")
    expect(styles).toContain('.searchItemSnippet')
    expect(styles).toContain('-webkit-line-clamp: 2')
  })

  it('opens a file result in the matching project, conversation and files panel', () => {
    expect(shell).toContain('onSelectFile={(file: AgentFileSearchResult) =>')
    expect(shell).toContain("openWorkbenchTab('files')")
    expect(shell).toContain('setFileOpenTarget({')
    expect(files).toContain('openRequest?: WorkspaceFileOpenRequest | null')
    expect(files).toContain('handledOpenRequest.current = openRequest.nonce')
    expect(files).toContain('pickFile({')
  })
})

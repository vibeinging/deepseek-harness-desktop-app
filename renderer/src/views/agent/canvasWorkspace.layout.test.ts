import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const canvas = readFileSync(new URL('./CanvasWorkspace.tsx', import.meta.url), 'utf8')
const artifacts = readFileSync(new URL('./WorkspaceArtifactsSection.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('./AgentShell.tsx', import.meta.url), 'utf8')
const streamTypes = readFileSync(new URL('./stream/types.ts', import.meta.url), 'utf8')
const api = readFileSync(new URL('../../api/agent.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./agent.module.scss', import.meta.url), 'utf8')

describe('Canvas workspace UI contract', () => {
  it('uses the existing artifact workbench for both global and project conversations', () => {
    expect(artifacts).toContain('<CanvasWorkspace')
    expect(artifacts).toContain('if (canvasMode)')
    expect(artifacts).toContain('sessionId?: string | null')
    expect(artifacts).toContain('data-artifact-action="open-canvas"')
    expect(artifacts).toContain('openRequestNonce={canvasOpenRequest?.sessionId === sessionId ? (canvasOpenRequest?.nonce ?? null) : null}')
    expect(shell).toContain("openWorkbenchTab('artifacts')")
    expect(shell).toContain("'canvas_opened', 'canvas_updated', 'canvas_suggestion_created'")
    expect(shell).not.toContain("'canvas' | null")
    expect(streamTypes).toContain('canvas_id?: string | null')
  })

  it('creates and directly edits document or code Canvas with optimistic version checks', () => {
    expect(canvas).toContain("{ value: 'document', label: '文档' }")
    expect(canvas).toContain("{ value: 'code', label: '代码' }")
    expect(canvas).toContain('data-canvas-create-action="confirm"')
    expect(canvas).toContain('data-canvas-action="save"')
    expect(canvas).toContain('baseVersionId: detail.current_version_id')
    expect(canvas).toContain("draft !== String(detail.content || '')")
    expect(canvas).toContain('data-canvas-conflict=')
    expect(canvas).toContain('data-canvas-conflict-action="latest"')
    expect(canvas).toContain('data-canvas-conflict-action="local"')
    expect(canvas).toContain('你的本地稿仍保留')
    expect(api).toContain('/canvases/${pe(canvasId)}/edits`')
    expect(api).toContain('base_version_id: input.baseVersionId')
  })

  it('sends an exact UTF-16 selection only for inline suggestions', () => {
    expect(canvas).toContain('node.selectionStart')
    expect(canvas).toContain('node.selectionEnd')
    expect(canvas).toContain('data-canvas-selection=')
    expect(canvas).toContain('suggestWithDsh')
    expect(canvas).not.toContain('data-canvas-action="ask"')
    expect(canvas).not.toContain('让 DSH 处理全文')
    expect(canvas).not.toContain('让 DSH 改写选区')
    expect(shell).toContain('canvas_inspect')
    expect(shell).toContain('canvas_suggest')
    expect(shell).toContain('使用 inspect 实际返回的 current_version_id 作为 base_version_id，不覆盖历史')
  })

  it('reviews inline suggestions and preserves version preview, diff and restore', () => {
    expect(canvas).toContain('data-canvas-suggestion=')
    expect(canvas).toContain("decideSuggestion(suggestion, 'accept')")
    expect(canvas).toContain("decideSuggestion(suggestion, 'reject')")
    expect(canvas).toContain('data-canvas-version-preview=')
    expect(canvas).toContain('textDiff(versionPreview.content')
    expect(canvas).toContain('data-canvas-action="restore"')
    expect(canvas).toContain('恢复会创建一个新的当前版本，现有历史不会被覆盖。')
    expect(api).toContain('/suggestions/${pe(suggestionId)}/decision`')
    expect(api).toContain('/canvases/${pe(canvasId)}/restore`')
  })

  it('has compact, keyboard-visible and narrow-workbench styles', () => {
    expect(styles).toContain('.canvasWorkspace')
    expect(styles).toContain('container-type: inline-size')
    expect(styles).toContain('.canvasTextEditor')
    expect(styles).toContain('.canvasSuggestions')
    expect(styles).toContain('.canvasConflict')
    expect(styles).toContain('.canvasVersions')
    expect(styles).toContain('@container (max-width: 420px)')
    expect(styles).toContain('.canvasCard:focus-visible')
  })
})

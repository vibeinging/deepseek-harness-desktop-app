import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { artifactBelongsToSession } from './WorkspaceArtifactsSection'

const artifacts = readFileSync(new URL('./WorkspaceArtifactsSection.tsx', import.meta.url), 'utf8')
const files = readFileSync(new URL('./WorkspaceFilesSection.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('./AgentShell.tsx', import.meta.url), 'utf8')
const conversation = [
  readFileSync(new URL('./AgentConversation.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./conversation/messageState.ts', import.meta.url), 'utf8')
].join('\n')
const draft = readFileSync(new URL('./conversationDraft.ts', import.meta.url), 'utf8')
const search = readFileSync(new URL('./SearchPalette.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../../api/agent.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./agent.module.scss', import.meta.url), 'utf8')
const assistantContent = readFileSync(new URL('./conversation/AssistantContent.tsx', import.meta.url), 'utf8')
const artifactActions = readFileSync(new URL('./conversation/ArtifactActions.tsx', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../../../../electron/preload.js', import.meta.url), 'utf8')
const electronMain = readFileSync(new URL('../../../../electron/main.js', import.meta.url), 'utf8')
const artifactContextMenu = readFileSync(new URL('../../../../electron/artifact-context-menu.js', import.meta.url), 'utf8')

describe('project artifact library layout contract', () => {
  it('adds a durable artifact tab and keeps session Canvas available from the same surface', () => {
    expect(shell).toContain("'artifacts'")
    expect(shell).toContain('data-workbench-empty-action={tool.id}')
    expect(shell).toContain('data-workbench-add')
    expect(shell).toContain('data-workbench-add-option={tool.id}')
    expect(shell).toContain('data-workbench-tab={tool.id}')
    expect(shell).toContain("case 'dsh-work/artifacts':")
    expect(shell).toContain('workbenchTabs.opened.map((tab) =>')
    expect(shell).toContain('<WorkspaceArtifactsSection')
    expect(artifacts).toContain('sessionId?: string | null')
    expect(artifacts).toContain('<CanvasWorkspace')
    expect(artifacts).toContain('data-artifact-action="open-canvas"')
  })

  it('supports list, search, detail, preview, source Turn, versions, diff and non-destructive restore', () => {
    expect(artifacts).toContain('listProjectArtifacts')
    expect(artifacts).toContain('previewProjectArtifactVersion')
    expect(artifacts).toContain('compareProjectArtifactVersions')
    expect(artifacts).toContain('restoreProjectArtifactVersion')
    expect(artifacts).toContain('data-artifact-version=')
    expect(artifacts).toContain('data-artifact-diff=')
    expect(artifacts).toContain('data-artifact-action="reference"')
    expect(artifacts).toContain('disabled={!selectedVersion || previewLoading || !preview}')
    expect(artifacts).toContain('Turn ${shortId(version.source_turn_id)}')
    expect(artifacts).toContain('恢复会创建一个新的当前版本，已有历史不会被覆盖。')
  })

  it('lets users publish a project file and reference an exact managed version back into the composer', () => {
    expect(files).toContain('data-file-action="publish-artifact"')
    expect(files).toContain('createProjectArtifact(projectId')
    expect(shell).toContain('referenceProjectArtifact')
    expect(shell).toContain('artifactVersionId: version.id')
    expect(conversation).toContain('requestedArtifactReference')
    expect(conversation).toContain('artifact_version_id')
    expect(conversation).toContain('artifact_version_number')
    expect(conversation).toContain('data-artifact-version-id=')
    expect(draft).toContain('artifactVersionId:')
    expect(draft).toContain('artifactVersionNumber:')
  })

  it('includes authorized project artifacts in global search and exposes the full local API contract', () => {
    expect(search).toContain("value: 'artifact'")
    expect(search).toContain('searchAgentArtifacts')
    expect(search).toContain('onSelectArtifact')
    expect(search).toContain('data-search-result-kind={it.kind}')
    expect(api).toContain("url: '/api/agent/search/artifacts'")
    expect(api).toContain('/artifacts/${pe(artifactId)}/diff')
    expect(api).toContain('/artifacts/${pe(artifactId)}/restore')
  })

  it('keeps the shared Library scoped to the active conversation in the workbench', () => {
    expect(artifacts).toContain('const visibleItems = useMemo')
    expect(artifacts).toContain('artifactBelongsToSession(artifact, sessionId)')
    expect(artifacts).toContain('}, [items, sessionId])')
    expect(artifacts).toContain('}, [projectId, sessionId])')
    expect(artifacts).toContain("openRequest.sessionId !== sessionId")
    expect(artifacts).toContain('当前会话还没有产物')
    expect(shell).toContain('artifactOpenTarget.sessionId !== activeId')
    expect(shell).toContain('targetSessionId === activeId')
  })

  it('does not treat an artifact from an older conversation as a current conversation artifact', () => {
    const oldArtifact = {
      source_session_id: 'old-session',
      current_version: { source_session_id: 'old-session' }
    } as any
    const currentArtifact = {
      source_session_id: 'current-session',
      current_version: { source_session_id: 'current-session' }
    } as any
    const updatedInCurrentConversation = {
      source_session_id: 'old-session',
      current_version: { source_session_id: 'current-session' }
    } as any

    expect(artifactBelongsToSession(oldArtifact, 'current-session')).toBe(false)
    expect(artifactBelongsToSession(currentArtifact, 'current-session')).toBe(true)
    expect(artifactBelongsToSession(updatedInCurrentConversation, 'current-session')).toBe(true)
    expect(artifactBelongsToSession(currentArtifact, null)).toBe(false)
  })

  it('has dedicated compact styles instead of borrowing the file tree layout', () => {
    expect(styles).toContain('.artifactLibrary')
    expect(styles).toContain('.artifactCard')
    expect(styles).toContain('.artifactPreview')
    expect(styles).toContain('.artifactVersions')
    expect(styles).toContain('.artifactSourceLink')
    expect(styles).toContain('.workbenchTabList')
    expect(styles).toContain('.workbenchTabItem')
    expect(styles).toMatch(/\.workbenchTab\s*\{[^}]*flex: 0 1 auto/s)
  })

  it('keeps Plugin PDF output visible and downloadable', () => {
    expect(assistantContent).toContain("outputArtifact?.materialization === 'client-download'")
    expect(assistantContent).toContain("outputArtifact?.format === 'application/pdf'")
    expect(assistantContent).not.toMatch(/^import html2pdf from 'html2pdf\.js'/m)
    expect(assistantContent).toContain("await import('html2pdf.js')")
    expect(assistantContent).toContain("from(body).save()")
    expect(assistantContent).toContain('下载 PDF')
  })

  it('gives every delivered artifact one shared action surface and one safe native channel', () => {
    expect(assistantContent).toContain('<ArtifactActionSurface')
    expect(assistantContent).toContain("kind: 'image'")
    expect(assistantContent).toContain("kind: 'audio'")
    expect(assistantContent).toContain("kind: 'chart'")
    expect(artifactActions).toContain('onContextMenu=')
    expect(artifactActions).toContain("reveal: '在 Finder 中显示'")
    expect(artifactActions).toContain("return '复制图片'")
    expect(artifactActions).toContain('output_delivery')
    expect(artifactActions).toContain('runArtifactAction')
    expect(assistantContent).toContain("/^(?:生成的图片|.+\\s生成的图片)$/")
    expect(preload).toContain("ipcRenderer.invoke('artifact-native-action'")
    expect(electronMain).toContain("ipcMain.handle('artifact-native-action'")
    expect(electronMain).toContain("['open', 'reveal', 'copy'].includes(action)")
    expect(electronMain).toContain("path.join(DATA_ROOT, 'runs')")
    expect(electronMain).toContain('resolveArtifactActionPath')
    expect(electronMain).not.toContain("ipcMain.handle('artifact-image-copy'")
  })

  it('uses a native OS file menu for artifacts and resolved markdown file references', () => {
    expect(assistantContent).toContain('showArtifactContextMenu')
    expect(artifactActions).toContain('showArtifactContextMenu')
    expect(preload).toContain("ipcRenderer.invoke('artifact-context-menu'")
    expect(electronMain).toContain("ipcMain.handle('artifact-context-menu'")
    expect(electronMain).toContain('resolveArtifactActionPath(payload.path)')
    expect(electronMain).toContain('createArtifactContextMenu')
    expect(artifactContextMenu).toContain('$.NSWorkspace.sharedWorkspace')
    expect(artifactContextMenu).toContain('URLsForApplicationsToOpenURL')
    expect(artifactContextMenu).toContain("label: '打开方式'")
    expect(artifactContextMenu).toContain("label: '复制路径'")
    expect(artifactContextMenu).toContain("label: '复制文件内容'")
    expect(artifactContextMenu).toContain("label: platform === 'darwin' ? '在 Finder 中显示'")
  })
})

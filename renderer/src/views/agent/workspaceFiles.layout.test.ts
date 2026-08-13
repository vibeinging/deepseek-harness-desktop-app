import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const view = readFileSync(new URL('./WorkspaceFilesSection.tsx', import.meta.url), 'utf8')
const conversation = [
  readFileSync(new URL('./AgentConversation.tsx', import.meta.url), 'utf8'),
  readFileSync(new URL('./conversation/AssistantContent.tsx', import.meta.url), 'utf8')
].join('\n')
const shell = readFileSync(new URL('./AgentShell.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./agent.module.scss', import.meta.url), 'utf8')
const preload = readFileSync(new URL('../../../../electron/preload.js', import.meta.url), 'utf8')
const main = readFileSync(new URL('../../../../electron/main.js', import.meta.url), 'utf8')
const server = readFileSync(new URL('../../../../server/src/app/chat/agent_misc.js', import.meta.url), 'utf8')

describe('workspace file preview contract', () => {
  it('shows extracted text, truncation reasons and unsupported-file guidance', () => {
    expect(view).toContain("preview.previewMode === 'extracted_text'")
    expect(view).toContain('preview.canPreview === false')
    expect(view).toContain("preview.reason || '暂不支持内置预览")
    expect(view).toContain('styles.wsFilePreviewNotice')
    expect(styles).toContain('.wsFilePreviewNotice')
  })

  it('keeps PPTX text extraction in the common local preview contract', () => {
    expect(view).toContain("preview.previewMode === 'extracted_text'")
    expect(view).toContain('{preview.reason && <div className={styles.wsFilePreviewNotice}>{preview.reason}</div>}')
    expect(server).toContain('".pptx"')
    expect(server).toContain('`# Slide ${index + 1}\\n${paragraphs.join("\\n")}`')
  })

  it('opens or reveals only desktop-authorized roots', () => {
    expect(view).toContain('authorizePreviewRoot(preview.rootPath)')
    expect(view).toContain("runNativeFileAction('open')")
    expect(view).toContain("runNativeFileAction('reveal')")
    expect(preload).toContain("ipcRenderer.invoke('authorize-preview-root', p)")
    expect(main).toContain("ipcMain.handle('authorize-preview-root'")
    expect(main).toContain("path.join(DATA_ROOT, 'projects')")
  })

  it('loads directories on demand and searches file names and bodies through the backend', () => {
    expect(view).toContain('listAgentDirectory(projectId, rootId, node.path, sessionId)')
    expect(view).toContain('searchAgentFiles(keyword, 100')
    expect(view).toContain('aria-expanded={expanded}')
    expect(view).toContain("placeholder=\"搜索文件名或正文\"")
    expect(view).not.toContain('visibleFiles.slice(0, 12)')
  })

  it('opens an assistant file reference in the right file panel', () => {
    expect(conversation).toContain('await onOpenFileReference({')
    expect(conversation).toContain('onOpenFileReference={onOpenFileReference}')
    expect(shell).toContain("openWorkbenchTab('files')")
    expect(shell).toContain('onOpenFileReference={openFileReference}')
    expect(view).toContain('relativePathFromRoot(item.path, openRequest.absolutePath!)')
    expect(view).toContain('root_id: root.id')
  })

  it('shows a privacy-safe breadcrumb for project and external files', () => {
    expect(shell).toContain('projectName={allWorkspaces.find((workspace) => workspace.id === activeWs)?.name}')
    expect(view).toContain('buildWorkspaceFileBreadcrumb({')
    expect(view).toContain("scope: 'external'")
    expect(view).toContain('data-file-scope={preview.scope}')
    expect(view).toContain("preview.scope !== 'external'")
    expect(view).toContain('<div className={styles.wsFilesRoot} title={root.name}>')
    expect(styles).toContain('.wsFileBreadcrumbTrail')
    expect(styles).toContain(".wsFileScopeBadge[data-file-scope='external']")
  })
})

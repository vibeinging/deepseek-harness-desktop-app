import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const editor = readFileSync(new URL('./OfficeArtifactEditor.tsx', import.meta.url), 'utf8')
const powerPointEditor = readFileSync(new URL('./PowerPointArtifactEditor.tsx', import.meta.url), 'utf8')
const powerPointStyles = readFileSync(new URL('./PowerPointArtifactEditor.module.scss', import.meta.url), 'utf8')
const artifacts = readFileSync(new URL('./WorkspaceArtifactsSection.tsx', import.meta.url), 'utf8')
const conversation = readFileSync(new URL('./AgentConversation.tsx', import.meta.url), 'utf8')
const shell = readFileSync(new URL('./AgentShell.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../../api/agent.ts', import.meta.url), 'utf8')

describe('DSH office artifact UI contract', () => {
  it('keeps all five managed artifact formats available', () => {
    expect(artifacts).toContain("{ value: 'markdown', label: 'Markdown 文档' }")
    expect(artifacts).toContain("{ value: 'docx', label: 'Word 文档' }")
    expect(artifacts).toContain("{ value: 'xlsx', label: 'Excel 表格' }")
    expect(artifacts).toContain("{ value: 'pptx', label: 'PowerPoint 演示' }")
    expect(artifacts).toContain("{ value: 'pdf', label: 'PDF 文档' }")
    expect(api).toContain('/artifacts/office`')
  })

  it('uses a task-specific PowerPoint selector with sanitized preview SVG', () => {
    expect(editor).toContain('<PowerPointArtifactEditor')
    expect(powerPointEditor).toContain('data-powerpoint-workbench')
    expect(powerPointEditor).toContain('data-powerpoint-thumbnail={slide.number}')
    expect(powerPointEditor).toContain('data-powerpoint-stage')
    expect(powerPointEditor).toContain('data-powerpoint-object={object.kind}')
    expect(powerPointEditor).toContain('DOMPurify.sanitize')
    expect(powerPointStyles).toContain('.slideRail')
    expect(powerPointStyles).toContain('.objectHitActive')
  })

  it('sends exact selections through attachment metadata into the main DSH conversation', () => {
    expect(editor).toContain('onReferenceSelection?.(inspection, referencedSelections)')
    expect(artifacts).toContain('officeSelections: selections')
    expect(shell).toContain('artifactSelections: officeSelections')
    expect(conversation).toContain('attachmentArtifactSelections(attachment)')
    expect(conversation).toContain('data-artifact-selection-count={selectionCount || undefined}')
    expect(conversation).not.toContain('请按我接下来的要求修改项目产物')
  })

  it('supports additive and marquee selection without an independent write path', () => {
    expect(powerPointEditor).toContain('data-powerpoint-hit-layer')
    expect(powerPointEditor).toContain('data-powerpoint-marquee')
    expect(powerPointEditor).toContain('event.metaKey || event.ctrlKey || event.shiftKey')
    expect(editor).not.toContain('editProjectOfficeArtifact')
    expect(editor).not.toContain('保存为新版本')
    expect(editor).toContain('引用后，直接在主输入框说明怎么改')
  })
})

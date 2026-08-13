import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconInfoCircle,
  IconLink,
  IconLoader2,
} from '@tabler/icons-react'
import {
  inspectProjectOfficeArtifact,
  type OfficeArtifactSection,
  type ProjectArtifact,
  type ProjectOfficeArtifactInspection
} from '@/api/agent'
import AppSelect from '@/components/AppSelect'
import PowerPointArtifactEditor, { type PowerPointSelection } from './PowerPointArtifactEditor'
import styles from './agent.module.scss'

export interface OfficeArtifactSelection {
  format: string
  anchor: string
  label: string
  text?: string
  page?: number
  sheet?: string
  address?: string
  rect?: { x: number; y: number; width: number; height: number }
  objectId?: string
  kind?: string
  canReplaceText?: boolean
}
type TextTarget = OfficeArtifactSelection & { kind: string; canReplaceText?: boolean }

function columnName(index: number) {
  let value = index + 1
  let result = ''
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

function textTargets(inspection: ProjectOfficeArtifactInspection | null): TextTarget[] {
  if (!inspection) return []
  const result: TextTarget[] = []
  for (const section of inspection.document.sections || []) {
    if (inspection.document.format === 'markdown' && typeof section.text === 'string') {
      result.push({ format: 'markdown', anchor: section.anchor, label: section.kind === 'heading' ? '标题' : `内容块 ${result.length + 1}`, text: section.text, kind: section.kind })
    }
    if (inspection.document.format === 'docx') {
      if (section.kind === 'paragraph') result.push({ format: 'docx', anchor: section.anchor, label: section.style || `段落 ${section.index || result.length + 1}`, text: section.text || '', kind: 'paragraph' })
      for (const row of section.rows || []) {
        for (const cell of row.cells || []) result.push({ format: 'docx', anchor: cell.anchor, label: `表格 ${section.index || ''} · R${cell.row}C${cell.column}`, text: cell.text, kind: 'cell' })
      }
    }
    if (inspection.document.format === 'pptx') {
      for (const object of section.objects || []) result.push({
        format: 'pptx',
        anchor: object.anchor,
        label: `第 ${section.number} 页 · ${object.name || object.kind}`,
        text: object.text,
        page: section.number,
        objectId: object.object_id,
        kind: object.kind,
        canReplaceText: object.can_replace_range === true
      })
      if (section.notes) result.push({ format: 'pptx', anchor: section.notes.anchor, label: `第 ${section.number} 页 · 备注`, text: section.notes.text, page: section.number, kind: 'notes', canReplaceText: true })
    }
  }
  return result
}

function formatValue(value: unknown) {
  if (value === null || value === undefined) return ''
  return String(value)
}

export default function OfficeArtifactEditor({
  projectId,
  artifact,
  onClose,
  onReferenceSelection
}: {
  projectId: string
  artifact: ProjectArtifact
  onClose: () => void
  onReferenceSelection?: (inspection: ProjectOfficeArtifactInspection, selections: OfficeArtifactSelection[]) => void
}) {
  const [inspection, setInspection] = useState<ProjectOfficeArtifactInspection | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [selectedAnchor, setSelectedAnchor] = useState('')
  const [powerPointSelections, setPowerPointSelections] = useState<PowerPointSelection[]>([])
  const [selectedSheet, setSelectedSheet] = useState('')
  const [pdfRect, setPdfRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const [pdfPage, setPdfPage] = useState(1)
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const response: any = await inspectProjectOfficeArtifact(projectId, artifact.id)
      const next: ProjectOfficeArtifactInspection | null = response?.data || response || null
      if (!next) throw new Error('服务端没有返回编辑结构')
      setInspection(next)
      setSelectedAnchor('')
      setPowerPointSelections([])
      setPdfRect(null)
      const firstSheet = next.document.format === 'xlsx' ? next.document.sections[0]?.name || '' : ''
      setSelectedSheet(firstSheet)
      setPdfPage(1)
    } catch (error: any) {
      setLoadError(error?.msg || error?.message || '无法读取办公产物')
      setInspection(null)
    } finally {
      setLoading(false)
    }
  }, [artifact.current_version_id, artifact.id, projectId])

  useEffect(() => { void load() }, [load])

  const targets = useMemo(() => textTargets(inspection), [inspection])
  const selectedTextTarget = useMemo(
    () => targets.find((target) => target.anchor === selectedAnchor) || null,
    [selectedAnchor, targets]
  )
  const sheet = useMemo(
    () => inspection?.document.format === 'xlsx'
      ? inspection.document.sections.find((section) => section.name === selectedSheet) || inspection.document.sections[0] || null
      : null,
    [inspection, selectedSheet]
  )
  const pdfSection = useMemo(
    () => inspection?.document.format === 'pdf'
      ? inspection.document.sections.find((section) => section.page === pdfPage) || inspection.document.sections[0] || null
      : null,
    [inspection, pdfPage]
  )
  const selectTextTarget = (target: TextTarget) => {
    setSelectedAnchor(target.anchor)
  }

  const selectCell = (section: OfficeArtifactSection, address: string) => {
    const cell = section.cells?.find((item) => item.address === address)
    const anchor = cell?.anchor || `xlsx:cell:${encodeURIComponent(section.name || '')}:${address}`
    setSelectedAnchor(anchor)
  }

  const selectedCell = useMemo(() => {
    if (!sheet || inspection?.document.format !== 'xlsx') return null
    const found = sheet.cells?.find((cell) => cell.anchor === selectedAnchor)
    if (found) return found
    const address = selectedAnchor.split(':').at(-1) || ''
    return address ? { anchor: selectedAnchor, address, value: null, display: '', formula: null } : null
  }, [inspection, selectedAnchor, sheet])

  const selectionsForReference = (): OfficeArtifactSelection[] => {
    if (!inspection) return []
    if (inspection.document.format === 'pptx') return powerPointSelections
    if (inspection.document.format === 'xlsx' && selectedCell && sheet?.name) return [{
      format: 'xlsx', anchor: selectedCell.anchor, label: `${sheet.name}!${selectedCell.address}`,
      text: selectedCell.formula || formatValue(selectedCell.value), sheet: sheet.name, address: selectedCell.address
    }]
    if (inspection.document.format === 'pdf' && pdfSection && pdfRect) return [{
      format: 'pdf', anchor: pdfSection.anchor, label: `第 ${pdfSection.page} 页区域`, page: pdfSection.page, rect: pdfRect
    }]
    return selectedTextTarget ? [selectedTextTarget] : []
  }

  const beginPdfDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    dragStart.current = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const updatePdfDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    const end = {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    }
    const start = dragStart.current
    setPdfRect({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) })
  }

  const endPdfDrag = () => { dragStart.current = null }

  if (loading) return <div className={styles.officeEditorState}><IconLoader2 size={16} className={styles.wsFileSpinner} /> 正在打开编辑器…</div>
  if (!inspection || loadError) return (
    <div className={styles.officeEditorState}>
      <strong>无法编辑这个产物</strong>
      <span>{loadError || '格式不受支持'}</span>
      <button type="button" onClick={onClose}>返回产物</button>
    </div>
  )

  const referencedSelections = selectionsForReference()
  const primarySelection = referencedSelections.at(-1) || null
  return (
    <div className={styles.officeEditor} data-office-editor={inspection.document.format} data-office-base-version={inspection.version.id}>
      <div className={styles.officeEditorHead}>
        <button
          type="button"
          aria-label="查看详情与版本"
          title="详情与版本"
          data-office-action="close"
          onClick={onClose}
        >
          <IconInfoCircle size={15} />
        </button>
        <div><strong>{artifact.name}</strong><span>{inspection.document.format.toUpperCase()} · 基于 v{inspection.version.version_number}</span></div>
      </div>
      {inspection.document.warnings?.length > 0 && <div className={styles.officeEditorWarning}>{inspection.document.warnings[0]}</div>}

      {inspection.document.format === 'xlsx' ? (
        <div className={styles.officeWorkbook}>
          <AppSelect
            aria-label="工作表"
            value={selectedSheet}
            onChange={(value) => { setSelectedSheet(value); setSelectedAnchor('') }}
            options={inspection.document.sections.map((section) => ({ value: section.name || '', label: section.name || '工作表' }))}
            size="xs"
          />
          {sheet && (
            <div className={styles.officeSheetGrid} data-office-sheet={sheet.name}>
              <table>
                <thead><tr><th />{Array.from({ length: Math.min(12, Math.max(6, (sheet.column_count || 0) + 1)) }, (_, column) => <th key={column}>{columnName(column)}</th>)}</tr></thead>
                <tbody>
                  {Array.from({ length: Math.min(40, Math.max(12, (sheet.row_count || 0) + 1)) }, (_, row) => (
                    <tr key={row}>
                      <th>{row + 1}</th>
                      {Array.from({ length: Math.min(12, Math.max(6, (sheet.column_count || 0) + 1)) }, (__, column) => {
                        const address = `${columnName(column)}${row + 1}`
                        const cell = sheet.cells?.find((item) => item.address === address)
                        const active = selectedCell?.address === address
                        return <td key={address}><button type="button" data-office-cell={address} data-active={active || undefined} onClick={() => selectCell(sheet, address)}>{cell?.formula || cell?.display || ''}</button></td>
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : inspection.document.format === 'pptx' ? (
        <PowerPointArtifactEditor
          inspection={inspection}
          selections={powerPointSelections}
          onSelectionChange={setPowerPointSelections}
        />
      ) : inspection.document.format === 'pdf' ? (
        <div className={styles.officePdf}>
          <AppSelect
            aria-label="PDF 页面"
            value={String(pdfPage)}
            onChange={(value) => { setPdfPage(Number(value)); setPdfRect(null) }}
            options={inspection.document.sections.map((section) => ({ value: String(section.page), label: `第 ${section.page} 页` }))}
            size="xs"
          />
          {pdfSection && (
            <div
              className={styles.officePdfPage}
              data-office-pdf-page={pdfSection.page}
              style={{ aspectRatio: `${pdfSection.width || 595} / ${pdfSection.height || 842}` }}
              onPointerDown={beginPdfDrag}
              onPointerMove={updatePdfDrag}
              onPointerUp={endPdfDrag}
              onPointerCancel={endPdfDrag}
            >
              <pre>{pdfSection.text || '这一页没有提取到文字。拖动鼠标选择要标注的区域。'}</pre>
              {(pdfSection.annotations || []).filter((item) => item.rect).map((annotation) => <span key={annotation.id} title={annotation.text} style={{ left: `${annotation.rect!.x * 100}%`, top: `${annotation.rect!.y * 100}%`, width: `${annotation.rect!.width * 100}%`, height: `${annotation.rect!.height * 100}%` }} />)}
              {pdfRect && <span className={styles.officePdfSelection} style={{ left: `${pdfRect.x * 100}%`, top: `${pdfRect.y * 100}%`, width: `${pdfRect.width * 100}%`, height: `${pdfRect.height * 100}%` }} />}
            </div>
          )}
        </div>
      ) : (
        <div className={styles.officeBlocks}>
          {targets.map((target) => (
            <button type="button" key={target.anchor} data-office-anchor={target.anchor} data-active={selectedAnchor === target.anchor || undefined} onClick={() => selectTextTarget(target)}>
              <small>{target.label}</small><span>{target.text || '空内容'}</span>
            </button>
          ))}
        </div>
      )}

      <section
        className={styles.officeSelectionPanel}
        data-office-selection-context={primarySelection?.anchor || undefined}
        data-office-selection-count={referencedSelections.length || undefined}
      >
        <div>
          <strong>{referencedSelections.length > 1 ? `已选择 ${referencedSelections.length} 个选区` : primarySelection?.label || '选择要调整的内容'}</strong>
          <span>{primarySelection ? '引用后，直接在主输入框说明怎么改' : '可点击选择，也可按住 ⌘/Ctrl 多选或拖动框选'}</span>
        </div>
        <button
          type="button"
          data-office-action="reference-selection"
          disabled={referencedSelections.length === 0 || !onReferenceSelection}
          onClick={() => referencedSelections.length > 0 && onReferenceSelection?.(inspection, referencedSelections)}
        >
          <IconLink size={14} /> {referencedSelections.length > 1 ? `引用 ${referencedSelections.length} 个选区` : '引用选区'}
        </button>
      </section>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import clsx from 'clsx'
import type { OfficeArtifactSection, ProjectOfficeArtifactInspection } from '@/api/agent'
import styles from './PowerPointArtifactEditor.module.scss'

type PowerPointObject = NonNullable<OfficeArtifactSection['objects']>[number]

export interface PowerPointSelection {
  format: 'pptx'
  anchor: string
  label: string
  text?: string
  page?: number
  objectId?: string
  kind: string
  canReplaceText?: boolean
}

interface MarqueeSelection {
  startX: number
  startY: number
  endX: number
  endY: number
  additive: boolean
  previous: PowerPointSelection[]
}

function safeSvg(svg?: string | null) {
  if (!svg) return ''
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'foreignObject'],
    FORBID_ATTR: ['onload', 'onerror', 'onclick']
  })
}

function objectLabel(kind = '') {
  const labels: Record<string, string> = {
    text: '文字', shape: '形状', connector: '连接线', image: '图片', picture: '图片',
    table: '表格', chart: '图表', smartArt: 'SmartArt', group: '组合', media: '媒体',
    ole: '嵌入对象', model3d: '3D 对象', zoom: '缩放对象', unknown: '其他对象'
  }
  return labels[kind] || kind || '对象'
}

function objectGlyph(kind = '') {
  if (kind === 'text') return 'T'
  if (kind === 'table') return '▦'
  if (kind === 'chart') return '▥'
  if (kind === 'image' || kind === 'picture') return '▧'
  if (kind === 'connector') return '╱'
  if (kind === 'group') return '◫'
  return '◇'
}

function objectSelection(slide: OfficeArtifactSection, object: PowerPointObject): PowerPointSelection {
  return {
    format: 'pptx',
    anchor: object.anchor,
    label: `第 ${slide.number} 页 · ${object.name || objectLabel(object.kind)}`,
    text: object.text,
    page: slide.number,
    objectId: object.object_id,
    kind: object.kind,
    canReplaceText: object.can_replace_range === true
  }
}

function SvgLayer({ svg }: { svg?: string | null }) {
  const markup = useMemo(() => safeSvg(svg), [svg])
  if (!markup) return <div className={styles.previewUnavailable}>这一页没有生成预览</div>
  return <div className={styles.svgLayer} aria-hidden="true" dangerouslySetInnerHTML={{ __html: markup }} />
}

function ObjectSummary({ object }: { object: PowerPointObject }) {
  if (object.kind === 'table' && object.table_data) {
    return <span>{object.table_data.row_count} 行 × {object.table_data.column_count} 列</span>
  }
  if (object.kind === 'chart' && object.chart_data) {
    return <span>{object.chart_data.series.length} 个系列 · {object.chart_data.categories.length} 个分类</span>
  }
  return <span>{object.text?.trim() || objectLabel(object.kind)}</span>
}

export default function PowerPointArtifactEditor({
  inspection,
  selections,
  onSelectionChange
}: {
  inspection: ProjectOfficeArtifactInspection
  selections: PowerPointSelection[]
  onSelectionChange: (selections: PowerPointSelection[]) => void
}) {
  const slides = inspection.document.sections || []
  const [page, setPage] = useState(slides[0]?.number || 1)
  const [marquee, setMarquee] = useState<MarqueeSelection | null>(null)
  const marqueeRef = useRef<MarqueeSelection | null>(null)
  const current = slides.find((slide) => slide.number === page) || slides[0] || null
  const selectedAnchors = useMemo(() => new Set(selections.map((selection) => selection.anchor)), [selections])
  const primarySelection = selections.at(-1) || null
  const selected = useMemo(() => {
    if (!primarySelection) return null
    for (const slide of slides) {
      const object = (slide.objects || []).find((item) => item.anchor === primarySelection.anchor)
      if (object) return { slide, object }
      if (slide.notes?.anchor === primarySelection.anchor) return { slide, object: null }
    }
    return null
  }, [primarySelection, slides])

  useEffect(() => {
    if (!selected?.slide.number) return
    setPage((currentPage) => currentPage === selected.slide.number ? currentPage : selected.slide.number || currentPage)
  }, [selected])

  useEffect(() => {
    if (current || !slides[0]?.number) return
    setPage(slides[0].number)
  }, [current, slides])

  if (!current) return <div className={styles.empty}>这份演示文稿没有可显示的页面。</div>

  const isAdditive = (event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => (
    event.metaKey || event.ctrlKey || event.shiftKey
  )
  const chooseSelection = (
    selection: PowerPointSelection,
    event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>
  ) => {
    if (!isAdditive(event)) {
      onSelectionChange([selection])
      return
    }
    onSelectionChange(selectedAnchors.has(selection.anchor)
      ? selections.filter((item) => item.anchor !== selection.anchor)
      : [...selections, selection])
  }
  const selectObject = (
    object: PowerPointObject,
    event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>
  ) => chooseSelection(objectSelection(current, object), event)
  const selectNotes = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!current.notes) return
    chooseSelection({
      format: 'pptx',
      anchor: current.notes.anchor,
      label: `第 ${current.number} 页 · 备注`,
      text: current.notes.text,
      page: current.number,
      kind: 'notes',
      canReplaceText: true
    }, event)
  }

  const normalizedPoint = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)))
    }
  }

  const beginMarquee = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.button !== 0) return
    const point = normalizedPoint(event)
    event.currentTarget.setPointerCapture(event.pointerId)
    const nextMarquee = {
      startX: point.x,
      startY: point.y,
      endX: point.x,
      endY: point.y,
      additive: event.metaKey || event.ctrlKey || event.shiftKey,
      previous: selections
    }
    // Pointer events can finish before React commits the first state update
    // (for example, a quick trackpad gesture). Keep the live gesture in a ref
    // so pointerup always sees the selection that actually started.
    marqueeRef.current = nextMarquee
    setMarquee(nextMarquee)
  }

  const updateMarquee = (event: React.PointerEvent<HTMLDivElement>) => {
    const activeMarquee = marqueeRef.current
    if (!activeMarquee) return
    const point = normalizedPoint(event)
    const nextMarquee = { ...activeMarquee, endX: point.x, endY: point.y }
    marqueeRef.current = nextMarquee
    setMarquee(nextMarquee)
  }

  const finishMarquee = (event: React.PointerEvent<HTMLDivElement>) => {
    const activeMarquee = marqueeRef.current
    if (!activeMarquee) return
    const point = normalizedPoint(event)
    const x = Math.min(activeMarquee.startX, point.x)
    const y = Math.min(activeMarquee.startY, point.y)
    const width = Math.abs(point.x - activeMarquee.startX)
    const height = Math.abs(point.y - activeMarquee.startY)
    const previous = activeMarquee.additive ? activeMarquee.previous : []
    const size = current.size || { width: 1, height: 1 }
    const matches = width < 0.006 && height < 0.006
      ? []
      : (current.objects || []).filter((object) => {
          const position = object.position
          if (!position || position.width <= 0 || position.height <= 0) return false
          const objectX = position.x / Math.max(1, size.width)
          const objectY = position.y / Math.max(1, size.height)
          const objectWidth = position.width / Math.max(1, size.width)
          const objectHeight = position.height / Math.max(1, size.height)
          return objectX < x + width && objectX + objectWidth > x
            && objectY < y + height && objectY + objectHeight > y
        }).map((object) => objectSelection(current, object))
    const merged = new Map(previous.map((selection) => [selection.anchor, selection]))
    for (const selection of matches) merged.set(selection.anchor, selection)
    onSelectionChange([...merged.values()])
    marqueeRef.current = null
    setMarquee(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const cancelMarquee = () => {
    marqueeRef.current = null
    setMarquee(null)
  }

  return (
    <div className={styles.workbench} data-powerpoint-workbench data-powerpoint-page={current.number}>
      <nav className={styles.slideRail} aria-label="幻灯片页面">
        {slides.map((slide) => {
          const slideAnchors = new Set([
            ...(slide.objects || []).map((object) => object.anchor),
            ...(slide.notes ? [slide.notes.anchor] : [])
          ])
          const selectedCount = selections.filter((selection) => slideAnchors.has(selection.anchor)).length
          return <button
            type="button"
            key={slide.anchor}
            className={clsx(styles.thumbnail, slide.number === current.number && styles.thumbnailActive)}
            data-powerpoint-thumbnail={slide.number}
            aria-current={slide.number === current.number ? 'page' : undefined}
            onClick={() => setPage(slide.number || 1)}
          >
            <span className={styles.thumbnailNumber}>{slide.number}</span>
            <span className={styles.thumbnailCanvas} style={{ aspectRatio: `${slide.size?.width || 16} / ${slide.size?.height || 9}` }}>
              <SvgLayer svg={slide.preview_svg} />
            </span>
            {slide.hidden && <span className={styles.hiddenBadge}>隐藏</span>}
            {selectedCount > 0 && <span className={styles.thumbnailSelection}>{selectedCount} 个已选</span>}
          </button>
        })}
      </nav>

      <section className={styles.stagePanel}>
        <header className={styles.stageHeader}>
          <div>
            <strong>第 {current.number} 页</strong>
            <span>{current.layout_name || '演示文稿页面'} · {(current.objects || []).length} 个元素</span>
          </div>
          <span className={styles.stageHint}>点击选择 · ⌘/Ctrl 多选 · 空白处拖动框选</span>
        </header>
        <div
          className={styles.stage}
          style={{
            aspectRatio: `${current.size?.width || 16} / ${current.size?.height || 9}`,
            background: current.background?.color || '#fff'
          }}
          data-powerpoint-stage
        >
          <SvgLayer svg={current.preview_svg} />
          <div
            className={styles.hitLayer}
            data-powerpoint-hit-layer
            onPointerDown={beginMarquee}
            onPointerMove={updateMarquee}
            onPointerUp={finishMarquee}
            onPointerCancel={cancelMarquee}
          >
            {(current.objects || []).map((object) => {
              const size = current.size || { width: 1, height: 1 }
              const position = object.position || { x: 0, y: 0, width: 0, height: 0 }
              if (position.width <= 0 || position.height <= 0) return null
              const active = selectedAnchors.has(object.anchor)
              return (
                <button
                  type="button"
                  key={object.anchor}
                  className={clsx(styles.objectHit, active && styles.objectHitActive)}
                  data-powerpoint-object={object.kind}
                  data-office-anchor={object.anchor}
                  aria-label={`${object.name || objectLabel(object.kind)}，${objectLabel(object.kind)}`}
                  aria-pressed={active}
                  style={{
                    left: `${position.x / size.width * 100}%`,
                    top: `${position.y / size.height * 100}%`,
                    width: `${position.width / size.width * 100}%`,
                    height: `${position.height / size.height * 100}%`,
                    transform: object.rotation ? `rotate(${object.rotation}deg)` : undefined
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    selectObject(object, event)
                  }}
                >
                  {active && <span className={styles.selectionTag}>{selections.length > 1 ? '已选' : objectLabel(object.kind)}</span>}
                </button>
              )
            })}
            {marquee && (
              <span
                className={styles.marquee}
                data-powerpoint-marquee
                aria-hidden="true"
                style={{
                  left: `${Math.min(marquee.startX, marquee.endX) * 100}%`,
                  top: `${Math.min(marquee.startY, marquee.endY) * 100}%`,
                  width: `${Math.abs(marquee.endX - marquee.startX) * 100}%`,
                  height: `${Math.abs(marquee.endY - marquee.startY) * 100}%`
                }}
              />
            )}
          </div>
        </div>
      </section>

      <aside className={styles.elementPanel} aria-label="当前页面元素">
        <div className={styles.elementHead}>
          <strong>{selections.length > 0 ? `已选 ${selections.length} 个` : '页面元素'}</strong>
          {selections.length > 0
            ? <button type="button" onClick={() => onSelectionChange([])}>清除</button>
            : <span>{(current.objects || []).length}</span>}
        </div>
        <div className={styles.elementList}>
          {(current.objects || []).length === 0 ? (
            <div className={styles.elementEmpty}>这一页没有可选择的元素。</div>
          ) : (current.objects || []).map((object) => (
            <button
              type="button"
              key={object.anchor}
              className={clsx(styles.elementItem, selectedAnchors.has(object.anchor) && styles.elementItemActive)}
              data-office-anchor={object.anchor}
              data-active={selectedAnchors.has(object.anchor) || undefined}
              aria-pressed={selectedAnchors.has(object.anchor)}
              onClick={(event) => selectObject(object, event)}
            >
              <span className={styles.elementGlyph}>{objectGlyph(object.kind)}</span>
              <span className={styles.elementCopy}>
                <strong>{object.name || objectLabel(object.kind)}</strong>
                <ObjectSummary object={object} />
              </span>
              <small>{objectLabel(object.kind)}</small>
            </button>
          ))}
          {current.notes && (
            <button
              type="button"
              className={clsx(styles.elementItem, selectedAnchors.has(current.notes.anchor) && styles.elementItemActive)}
              data-office-anchor={current.notes.anchor}
              data-active={selectedAnchors.has(current.notes.anchor) || undefined}
              aria-pressed={selectedAnchors.has(current.notes.anchor)}
              onClick={selectNotes}
            >
              <span className={styles.elementGlyph}>N</span>
              <span className={styles.elementCopy}><strong>演讲者备注</strong><span>{current.notes.text || '空备注'}</span></span>
              <small>备注</small>
            </button>
          )}
        </div>
        {selected?.object && selections.length === 1 && (
          <div className={styles.selectionInfo} data-powerpoint-selection={selected.object.kind}>
            <div><strong>{selected.object.name || objectLabel(selected.object.kind)}</strong><span>{objectLabel(selected.object.kind)}</span></div>
            <dl>
              <div><dt>位置</dt><dd>{Math.round(selected.object.position?.x || 0)}, {Math.round(selected.object.position?.y || 0)}</dd></div>
              <div><dt>尺寸</dt><dd>{Math.round(selected.object.position?.width || 0)} × {Math.round(selected.object.position?.height || 0)}</dd></div>
              {selected.object.style?.font_size && <div><dt>字号</dt><dd>{selected.object.style.font_size}</dd></div>}
              {selected.object.style?.fill_color && <div><dt>填充</dt><dd><i style={{ background: selected.object.style.fill_color }} />{selected.object.style.fill_color}</dd></div>}
            </dl>
          </div>
        )}
        {selections.length > 1 && (
          <div className={styles.selectionInfo} data-powerpoint-selection="multiple">
            <div><strong>{selections.length} 个选区</strong><span>可跨页引用</span></div>
            <p>{selections.slice(0, 3).map((selection) => selection.label).join('、')}{selections.length > 3 ? ` 等 ${selections.length} 项` : ''}</p>
          </div>
        )}
      </aside>
    </div>
  )
}

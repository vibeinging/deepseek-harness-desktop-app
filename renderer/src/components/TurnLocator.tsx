import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type UIEvent
} from 'react'
import styles from './TurnLocator.module.scss'

export type TurnLocatorVariant = 'overlay' | 'inline'

export interface TurnLocatorMarker {
  id: string
  title: string
  excerpt: string
  meta?: string
}

export const MAX_TURN_LOCATOR_TICKS = 20
export const TURN_LOCATOR_TICK_PITCH = 10
export const LONG_TURN_LOCATOR_HEIGHT = MAX_TURN_LOCATOR_TICKS * TURN_LOCATOR_TICK_PITCH

export function turnLocatorMode(total: number) {
  return total > MAX_TURN_LOCATOR_TICKS ? 'scroll' : 'ticks'
}

export function turnLocatorTop(index: number, total: number) {
  if (total <= 1) return 50
  const halfSpan = Math.min(38, Math.max(20, (total - 1) * 3.2))
  const start = 50 - halfSpan
  const end = 50 + halfSpan
  return start + ((end - start) * index) / (total - 1)
}

export function turnLocatorIndexAtPosition(position: number, height: number, total: number) {
  if (total <= 1 || height <= 0) return 0
  const halfSpan = Math.min(38, Math.max(20, (total - 1) * 3.2))
  const start = 50 - halfSpan
  const end = 50 + halfSpan
  const percent = (position / height) * 100
  const ratio = Math.min(1, Math.max(0, (percent - start) / (end - start)))
  return Math.round(ratio * (total - 1))
}

export function turnLocatorVisibleRange(
  scrollTop: number,
  total: number,
  limit = MAX_TURN_LOCATOR_TICKS,
  pitch = TURN_LOCATOR_TICK_PITCH,
) {
  const safeTotal = Math.max(0, Math.floor(total))
  const safeLimit = Math.max(1, Math.floor(limit))
  if (safeTotal <= safeLimit) return { start: 0, end: safeTotal }
  const maxStart = safeTotal - safeLimit
  const start = Math.min(maxStart, Math.max(0, Math.floor(Math.max(0, scrollTop) / Math.max(1, pitch))))
  return { start, end: start + safeLimit }
}

export function turnLocatorScrollTopForIndex(
  index: number,
  total: number,
  viewportHeight = LONG_TURN_LOCATOR_HEIGHT,
  pitch = TURN_LOCATOR_TICK_PITCH,
) {
  const safeTotal = Math.max(0, Math.floor(total))
  if (safeTotal <= 0) return 0
  const safePitch = Math.max(1, pitch)
  const maxScrollTop = Math.max(0, safeTotal * safePitch - Math.max(1, viewportHeight))
  const centered = (Math.min(safeTotal - 1, Math.max(0, index)) + 0.5) * safePitch - viewportHeight / 2
  return Math.min(maxScrollTop, Math.max(0, centered))
}

export function sameTurnLocatorMarkers(a: TurnLocatorMarker[], b: TurnLocatorMarker[]) {
  if (a.length !== b.length) return false
  return a.every((marker, index) => {
    const next = b[index]
    return marker.id === next.id && marker.title === next.title && marker.excerpt === next.excerpt && marker.meta === next.meta
  })
}

function cx(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(' ')
}

export default function TurnLocator({
  markers,
  activeId,
  ariaLabel,
  variant = 'overlay',
  showPreview = false,
  onSelect
}: {
  markers: TurnLocatorMarker[]
  activeId?: string
  ariaLabel: string
  variant?: TurnLocatorVariant
  showPreview?: boolean
  onSelect: (id: string) => void
}) {
  const hoverClearTimerRef = useRef<number | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [hoverId, setHoverId] = useState<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const mode = turnLocatorMode(markers.length)
  const scrollMode = mode === 'scroll'
  const activeMarkerIndex = markers.findIndex((marker) => marker.id === activeId)
  const activeIndex = activeMarkerIndex >= 0 ? activeMarkerIndex : Math.max(0, markers.length - 1)
  const hoverIndex = hoverId ? markers.findIndex((marker) => marker.id === hoverId) : -1
  const hoverMarker = hoverIndex >= 0 ? markers[hoverIndex] : null
  const rootClassName = cx(styles.locator, variant === 'inline' ? styles.inline : styles.overlay)
  const railHeight = scrollMode
    ? LONG_TURN_LOCATOR_HEIGHT
    : Math.max(72, Math.min(LONG_TURN_LOCATOR_HEIGHT, markers.length * 10 + 40))
  const rootStyle = { '--turn-locator-height': `${railHeight}px` } as CSSProperties
  const visibleRange = useMemo(
    () => turnLocatorVisibleRange(scrollMode ? scrollTop : 0, markers.length),
    [markers.length, scrollMode, scrollTop]
  )
  const markerPositions = useMemo(
    () => markers.slice(visibleRange.start, visibleRange.end).map((marker, offset) => {
      const index = visibleRange.start + offset
      return {
        marker,
        index,
        top: scrollMode
          ? `${(index + 0.5) * TURN_LOCATOR_TICK_PITCH}px`
          : `${turnLocatorTop(index, markers.length)}%`,
      }
    }),
    [markers, scrollMode, visibleRange.end, visibleRange.start]
  )
  const hoverViewportTop = hoverIndex < 0
    ? railHeight / 2
    : scrollMode
      ? (hoverIndex + 0.5) * TURN_LOCATOR_TICK_PITCH - scrollTop
      : (turnLocatorTop(hoverIndex, markers.length) / 100) * railHeight
  const previewTop = Math.min(railHeight - 18, Math.max(18, hoverViewportTop))

  const showHover = useCallback((id: string) => {
    if (hoverClearTimerRef.current) window.clearTimeout(hoverClearTimerRef.current)
    hoverClearTimerRef.current = null
    setHoverId(id)
  }, [])

  const hideHover = useCallback(() => {
    if (hoverClearTimerRef.current) window.clearTimeout(hoverClearTimerRef.current)
    hoverClearTimerRef.current = window.setTimeout(() => setHoverId(null), 180)
  }, [])

  const updateHoverFromPointer = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      if (!markers.length || rect.height <= 0) return
      const position = event.clientY - rect.top
      const index = scrollMode
        ? Math.min(markers.length - 1, Math.max(0, Math.floor(
            (position + event.currentTarget.scrollTop) / TURN_LOCATOR_TICK_PITCH
          )))
        : turnLocatorIndexAtPosition(position, rect.height, markers.length)
      const closest = markers[index]
      if (closest) showHover(closest.id)
    },
    [markers, scrollMode, showHover]
  )

  const updateVirtualWindow = useCallback((event: UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  useEffect(() => {
    if (!scrollMode) {
      setScrollTop(0)
      return
    }
    const viewport = viewportRef.current
    if (!viewport || activeIndex < 0) return
    const markerTop = activeIndex * TURN_LOCATOR_TICK_PITCH
    const markerBottom = markerTop + TURN_LOCATOR_TICK_PITCH
    const visibleTop = viewport.scrollTop
    const visibleBottom = visibleTop + viewport.clientHeight
    if (markerTop >= visibleTop && markerBottom <= visibleBottom) return
    const nextScrollTop = turnLocatorScrollTopForIndex(
      activeIndex,
      markers.length,
      viewport.clientHeight || LONG_TURN_LOCATOR_HEIGHT
    )
    viewport.scrollTop = nextScrollTop
    setScrollTop(nextScrollTop)
  }, [activeIndex, markers.length, scrollMode])

  useEffect(
    () => () => {
      if (hoverClearTimerRef.current) window.clearTimeout(hoverClearTimerRef.current)
    },
    []
  )

  if (!markers.length) return null

  return (
    <nav
      className={rootClassName}
      style={rootStyle}
      aria-label={ariaLabel}
      data-turn-locator-mode={mode}
      data-turn-locator-total={markers.length}
      data-turn-locator-rendered={markerPositions.length}
    >
      <div
        className={styles.rail}
        data-hovering={hoverMarker ? 'true' : undefined}
      >
        <div
          ref={viewportRef}
          className={cx(styles.tickViewport, scrollMode && styles.scrollViewport)}
          role={scrollMode ? 'region' : undefined}
          tabIndex={scrollMode ? 0 : undefined}
          aria-label={scrollMode ? `${ariaLabel}，滚动查看更多轮次` : undefined}
          onScroll={scrollMode ? updateVirtualWindow : undefined}
          onMouseEnter={updateHoverFromPointer}
          onMouseMove={updateHoverFromPointer}
          onMouseLeave={hideHover}
        >
          <div
            className={cx(styles.tickCanvas, scrollMode && styles.scrollCanvas)}
            style={scrollMode ? { height: `${markers.length * TURN_LOCATOR_TICK_PITCH}px` } : undefined}
          >
            {markerPositions.map(({ marker, top, index }) => {
              const hoverDistance = hoverIndex >= 0 ? Math.abs(index - hoverIndex) : -1
              return (
                <button
                  key={marker.id}
                  type="button"
                  className={styles.tick}
                  data-active={marker.id === activeId ? 'true' : undefined}
                  data-marker-index={index}
                  data-hover-distance={hoverDistance >= 0 && hoverDistance <= 3 ? String(hoverDistance) : undefined}
                  style={{ top }}
                  onFocus={() => showHover(marker.id)}
                  onBlur={hideHover}
                  onClick={() => onSelect(marker.id)}
                  aria-current={marker.id === activeId ? 'location' : undefined}
                  aria-label={`${marker.title}: ${marker.excerpt}`}
                />
              )
            })}
          </div>
        </div>
        {showPreview && hoverMarker && (
          <button
            type="button"
            className={styles.preview}
            style={{ top: `${previewTop}px` }}
            onMouseEnter={() => showHover(hoverMarker.id)}
            onMouseLeave={hideHover}
            onFocus={() => showHover(hoverMarker.id)}
            onBlur={hideHover}
            onClick={() => onSelect(hoverMarker.id)}
          >
            <span className={styles.previewTitle}>{hoverMarker.title}</span>
            <span className={styles.previewText}>{hoverMarker.excerpt}</span>
            {hoverMarker.meta && <span className={styles.previewMeta}>{hoverMarker.meta}</span>}
          </button>
        )}
      </div>
    </nav>
  )
}

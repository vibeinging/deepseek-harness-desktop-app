// Generic context menu. Rendered through .dsh-root (theme scope and not scaled by .dsh-zoom).
// Use position:fixed in viewport coordinates; click outside / press Esc to close; flip direction near screen edges.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './agent.module.scss'

export interface MenuItem {
  key: string
  icon?: ReactNode
  label: string
  ariaLabel?: string
  onClick?: () => void
  disabled?: boolean
  danger?: boolean
  dividerBefore?: boolean
}

export default function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let left = x
    let top = y
    if (x + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8
    if (y + r.height > window.innerHeight - 8) top = Math.max(8, y - r.height)
    setPos({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [x, y])

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDoc, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // 挂到 <body>：与 Mantine 浮层（withinPortal）一致，确保 position:fixed 相对视口定位，
  // 彻底避开 .dsh-root 内任何可能为 fixed 后代建立包含块的祖先（transform/contain 等）。
  // 主题变量通过 :root[data-mantine-color-scheme] 已铺到 <html>，body 下同样可用。
  const host = typeof document !== 'undefined' ? document.body : null
  if (!host) return null

  return createPortal(
    <div
      ref={ref}
      className={styles.ctxMenu}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-label="快捷操作"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) => (
        <div key={it.key}>
          {it.dividerBefore && <div className={styles.ctxDivider} />}
          <button
            type="button"
            role="menuitem"
            aria-label={it.ariaLabel || it.label}
            className={`${styles.ctxItem} ${it.danger ? styles.ctxItemDanger : ''}`}
            disabled={it.disabled}
            onClick={() => {
              if (it.disabled) return
              it.onClick?.()
              onClose()
            }}
          >
            <span className={styles.ctxIcon}>{it.icon}</span>
            <span className={styles.ctxLabel}>{it.label}</span>
          </button>
        </div>
      ))}
    </div>,
    host
  )
}

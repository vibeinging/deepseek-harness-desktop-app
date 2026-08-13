// Shared shell layout for settings pages: App Settings and full-window Project Settings share the same two-column layout.
// The shell only provides the visual frame (back button, left nav slot, right content card); navigation items and body are passed in.
// This keeps back button position, sidebar width, and content card style consistent for reuse.
import { type ReactNode } from 'react'
import { IconArrowLeft, IconChevronDown } from '@tabler/icons-react'
import styles from './settingsShell.module.scss'

export function SettingsShell({
  onBack,
  backLabel = '返回项目',
  nav,
  children
}: {
  onBack?: () => void
  backLabel?: string
  nav: ReactNode
  children: ReactNode
}) {
  // Theme is controlled by ancestor .dsh-root[data-theme] (--dsh-* tokens), shell itself does not read scheme.
  return (
    <div className={styles.wrap}>
      <aside className={styles.side}>
        {onBack && (
          <button type="button" className={styles.back} onClick={onBack}>
            <IconArrowLeft size={16} stroke={1.8} />
            {backLabel}
          </button>
        )}
        <nav className={styles.nav}>{nav}</nav>
      </aside>
      <main className={styles.main}>{children}</main>
    </div>
  )
}

// Single nav item (button). Icon is optional (App settings have it, project settings do not).
export function SettingsNavItem({
  active = false,
  onClick,
  icon,
  id,
  pluginName,
  nested = false,
  children
}: {
  active?: boolean
  onClick?: () => void
  icon?: ReactNode
  id?: string
  pluginName?: string
  nested?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      id={id}
      className={`${styles.navItem} ${nested ? styles.navItemNested : ''} ${active ? styles.navItemActive : ''}`}
      onClick={onClick}
      {...(pluginName ? { 'data-plugin-name': pluginName } : {})}
    >
      {icon && <span className={styles.navIcon}>{icon}</span>}
      <span>{children}</span>
    </button>
  )
}

// Collapsible groups: title is clickable to expand/collapse + nested items. If no label, only children are rendered.
export function SettingsNavGroup({
  label,
  sourceLabel,
  pluginName,
  nested = false,
  collapsed = false,
  onToggle,
  id,
  children
}: {
  label?: string
  sourceLabel?: string
  pluginName?: string
  nested?: boolean
  collapsed?: boolean
  onToggle?: () => void
  id?: string
  children: ReactNode
}) {
  return (
    <>
      {label && (
        <button
          type="button"
          className={`${styles.groupHeader} ${nested ? styles.groupHeaderNested : ''}`}
          onClick={onToggle}
          title={pluginName ? (sourceLabel || `Plugin · ${pluginName}`) : undefined}
          {...(id ? { id } : {})}
          {...(pluginName ? { 'data-plugin-name': pluginName } : {})}
        >
          <IconChevronDown
            size={13}
            stroke={2.2}
            className={`${styles.groupChev} ${collapsed ? styles.groupChevCollapsed : ''}`}
          />
          <span className={styles.groupLabel}>{label}</span>
          {sourceLabel && <span className={styles.groupSource}>{sourceLabel}</span>}
        </button>
      )}
      {!collapsed && children}
    </>
  )
}

export function SettingsNavSep() {
  return <div className={styles.navSep} />
}

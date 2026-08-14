import { createContext, useContext, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { LocaleSnapshot } from '@deepseek-ai/dsh-client-locale/client'
import type { ThemePreference, ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import {
  resolveSlotLabel,
  type PropsRenderSlots,
  type StoredEntry
} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { WORKBENCH_SLOT } from '@/views/agent/workbenchContributions'
import type { DshConversationBridge } from './DshConversationBridge'
import styles from './DshClientHost.module.scss'

type DshWorkSlot = typeof WORKBENCH_SLOT | 'settings.section' | 'shell.overlay'
export type DshWorkRenderSlot = PropsRenderSlots<DshWorkSlot>['renderSlot']

export const DSH_WORK_LAYOUT_EVENT = 'dsh-work:layout'
export type DshWorkLayoutAction = 'toggle-sidebar' | 'open-details' | 'close-details'

const APP_OWNED_SETTINGS_SECTION_IDS = new Set(['general', 'models', 'plugins'])
const NOOP_SUBSCRIBE = () => () => {}

export interface DshSettingsSectionInfo {
  id: string
  label: string
  order: number
  registrant?: string
}

export interface DshClientHostValue {
  slots: ClientContext['slots']
  renderSlot: DshWorkRenderSlot
  conversation: DshConversationBridge
  localeSnapshot: LocaleSnapshot
  themeSnapshot: ThemeSnapshot
  setLocale: (id: string) => void
  setTheme: (preference: ThemePreference) => void
}

export interface DshClientRuntimeBridge {
  conversation: DshConversationBridge
  locale: {
    getSnapshot: () => LocaleSnapshot
    subscribe: (listener: () => void) => () => void
    setLocale: (id: string) => void
  }
  theme: {
    getSnapshot: () => ThemeSnapshot
    subscribe: (listener: () => void) => () => void
    setTheme: (preference: ThemePreference) => void
  }
}

const DshClientHostContext = createContext<DshClientHostValue | null>(null)

/** Bridge the active DSH Client fiber into the existing React product tree. */
export function DshClientHostProvider({
  children,
  slots,
  renderSlot,
  runtime
}: Pick<DshClientHostValue, 'slots' | 'renderSlot'> & {
  children: ReactNode
  runtime: DshClientRuntimeBridge
}) {
  const localeSnapshot = useSyncExternalStore(
    runtime.locale.subscribe,
    runtime.locale.getSnapshot,
    runtime.locale.getSnapshot
  )
  const themeSnapshot = useSyncExternalStore(
    runtime.theme.subscribe,
    runtime.theme.getSnapshot,
    runtime.theme.getSnapshot
  )
  const value = useMemo(() => ({
    slots,
    renderSlot,
    conversation: runtime.conversation,
    localeSnapshot,
    themeSnapshot,
    setLocale: runtime.locale.setLocale,
    setTheme: runtime.theme.setTheme
  }), [localeSnapshot, renderSlot, runtime, slots, themeSnapshot])
  return <DshClientHostContext.Provider value={value}>{children}</DshClientHostContext.Provider>
}

/** Return the active DSH Client host, or null on the explicit standalone dev page. */
export function useDshClientHost(): DshClientHostValue | null {
  return useContext(DshClientHostContext)
}

/** Project standard settings entries that are not already implemented by dsh-work pages. */
export function projectDshSettingsSections(entries: readonly StoredEntry[]): DshSettingsSectionInfo[] {
  const seen = new Set<string>()
  const sections: DshSettingsSectionInfo[] = []
  for (const entry of entries) {
    const id = String(entry.options.id || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    if (APP_OWNED_SETTINGS_SECTION_IDS.has(id)) continue
    sections.push({
      id,
      label: resolveSlotLabel(entry.options.label)?.trim() || id,
      order: entry.options.order ?? 0,
      ...(entry.registrant ? { registrant: entry.registrant } : {})
    })
  }
  return sections.sort((left, right) => left.order - right.order || left.label.localeCompare(right.label))
}

/** Follow the active DSH settings.section ledger without creating App-owned plugin state. */
export function useDshSettingsSections(): DshSettingsSectionInfo[] {
  const host = useDshClientHost()
  const version = useSyncExternalStore(
    host ? (listener) => host.slots.subscribe('settings.section', listener) : NOOP_SUBSCRIBE,
    host ? () => host.slots.getVersion('settings.section') : () => 0,
    () => 0
  )
  return useMemo(() => (
    host ? projectDshSettingsSections(host.slots.entriesOfSlot('settings.section')) : []
  ), [host, version])
}

/** Report whether the active Client graph currently provides one settings section. */
export function useHasDshSettingsSection(id: string): boolean {
  const host = useDshClientHost()
  const version = useSyncExternalStore(
    host ? (listener) => host.slots.subscribe('settings.section', listener) : NOOP_SUBSCRIBE,
    host ? () => host.slots.getVersion('settings.section') : () => 0,
    () => 0
  )
  return useMemo(() => (
    host?.slots.entriesOfSlot('settings.section').some((entry) => entry.options.id === id) === true
  ), [host, id, version])
}

/** Render one standard settings section through the root-owned Slot authorization. */
export function DshSettingsSection({ id, onClose }: { id: string; onClose: () => void }) {
  const host = useDshClientHost()
  if (!host) return null
  return (
    <div className={styles.settingsSection} data-dsh-standard-settings-section={id}>
      {host.renderSlot('settings.section', { close: onClose }, { only: id })}
    </div>
  )
}

/** Mount the standard frame overlay inside the product token scope. */
export function DshStandardShellOverlay() {
  const host = useDshClientHost()
  const [target, setTarget] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    setTarget(document.querySelector<HTMLElement>('.dsh-root'))
  }, [])

  if (!host || !target) return null
  return createPortal(
    <div className={styles.shellOverlay} data-dsh-standard-shell-overlay>
      {host.renderSlot('shell.overlay', {})}
    </div>,
    target
  )
}

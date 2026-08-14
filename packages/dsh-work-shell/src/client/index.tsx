import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import {
  type PropsRenderSlots,
  type PropsRuntime
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ThemePreference, ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { useLayoutEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import DshWorkApp from '../../../../renderer/src/DshWorkApp'
import {
  DSH_WORK_LAYOUT_EVENT,
  DshClientHostProvider,
  useDshClientHost,
  type DshClientRuntimeBridge,
  type DshWorkLayoutAction
} from '../../../../renderer/src/dsh-client/DshClientHost'
import { DshConversationBridge } from '../../../../renderer/src/dsh-client/DshConversationBridge'
import { createDshThemePresenter } from '../../../../renderer/src/theme/dshRuntimeTheme'
import { WORKBENCH_SLOT } from '../../../../renderer/src/views/agent/workbenchContributions'
import '../../../../renderer/src/views/agent/workbenchSlotRuntime'
import styles from './DshWorkSettings.module.css'

const STANDARD_ROOT_SLOTS = [
  'sidebar',
  'conversation',
  'details',
  'settings.section',
  'shell.overlay'
] as const
type DshWorkRootSlot = typeof WORKBENCH_SLOT | (typeof STANDARD_ROOT_SLOTS)[number]
type DshWorkRootProps = PropsRuntime<'root'> & PropsRenderSlots<DshWorkRootSlot>
type DshWorkSidebarProps = PropsRuntime<'sidebar'> & PropsRenderSlots<'sidebar.footer.action'>
type DshWorkGeneralProps = PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.general.item'>
type DshWorkConversationProps = PropsRuntime<'conversation'> & PropsRenderSlots<'conversation.composer.dock'>

export const inject = ['slots', 'sessions', 'theme', 'locale']

const APP_MAPPED_GENERAL_ITEMS = new Set(['appearance', 'composer-enter', 'language', 'permission'])

class DshWorkLayoutAdapter implements ILayout {
  #dispatch(action: DshWorkLayoutAction) {
    window.dispatchEvent(new CustomEvent(DSH_WORK_LAYOUT_EVENT, { detail: { action } }))
  }

  toggleSidebar() {
    this.#dispatch('toggle-sidebar')
  }

  openDetails() {
    this.#dispatch('open-details')
  }

  closeDetails() {
    this.#dispatch('close-details')
  }
}

/** Register the dsh-work product shell into the shared DSH root Slot. */
export function apply(ctx: ClientContext) {
  const layout = new DshWorkLayoutAdapter()
  const conversation = new DshConversationBridge(ctx.sessions)
  const runtime: DshClientRuntimeBridge = {
    conversation,
    locale: {
      getSnapshot: () => ctx.locale.getLocale(),
      subscribe: (listener) => ctx.locale.subscribe(listener),
      setLocale: (id) => ctx.locale.setLocale(id)
    },
    theme: {
      getSnapshot: () => ctx.theme.getTheme(),
      subscribe: (listener) => ctx.on('theme/change', () => listener()),
      setTheme: (preference: ThemePreference) => ctx.theme.setTheme(preference)
    }
  }

  function DshWorkRoot({ renderSlot }: DshWorkRootProps) {
    return (
      <DshClientHostProvider slots={ctx.slots} renderSlot={renderSlot} runtime={runtime}>
        <DshWorkApp />
        {renderSlot('sidebar', { collapsed: false, width: 263 }, { only: 'dsh-work-sidebar' })}
        {renderSlot('conversation', {}, { only: 'dsh-work-conversation' })}
      </DshClientHostProvider>
    )
  }

  function DshWorkSidebar({ renderSlot }: DshWorkSidebarProps) {
    const [target, setTarget] = useState<Element | null>(null)
    useLayoutEffect(() => {
      const syncTarget = () => setTarget(document.querySelector('[data-dsh-sidebar-footer-actions]'))
      syncTarget()
      const observer = new MutationObserver(syncTarget)
      observer.observe(document.body, { childList: true, subtree: true })
      return () => observer.disconnect()
    }, [])
    if (!target) return null
    return createPortal(renderSlot('sidebar.footer.action', { wide: true }), target)
  }

  function DshWorkGeneralSettings({ renderSlot }: DshWorkGeneralProps) {
    const version = useSyncExternalStore(
      (listener) => ctx.slots.subscribe('settings.general.item', listener),
      () => ctx.slots.getVersion('settings.general.item'),
      () => 0
    )
    const ids = useMemo(() => {
      const seen = new Set<string>()
      return ctx.slots.entriesOfSlot('settings.general.item').flatMap((entry) => {
        const id = String(entry.options.id || '').trim()
        if (!id || seen.has(id) || APP_MAPPED_GENERAL_ITEMS.has(id)) return []
        seen.add(id)
        return [id]
      })
    }, [version])
    if (!ids.length) return null
    return (
      <section className={styles.generalRows} data-dsh-work-general-plugin-settings>
        {ids.map((id) => <div key={id}>{renderSlot('settings.general.item', {}, { only: id })}</div>)}
      </section>
    )
  }

  function DshWorkConversation({ sessionId, useSession, renderSlot }: DshWorkConversationProps) {
    const host = useDshClientHost()
    const session = useSession((snapshot) => snapshot)
    const input = useSyncExternalStore(
      conversation.subscribeInput,
      conversation.getInputSnapshot,
      conversation.getInputSnapshot
    )
    const version = useSyncExternalStore(
      (listener) => ctx.slots.subscribe('conversation.composer.dock', listener),
      () => ctx.slots.getVersion('conversation.composer.dock'),
      () => 0
    )
    const [target, setTarget] = useState<Element | null>(null)
    useLayoutEffect(() => {
      const syncTarget = () => setTarget(document.querySelector('[data-dsh-conversation-composer-dock]'))
      syncTarget()
      const observer = new MutationObserver(syncTarget)
      observer.observe(document.body, { childList: true, subtree: true })
      return () => observer.disconnect()
    }, [])
    const hasEntries = useMemo(
      () => ctx.slots.entriesOfSlot('conversation.composer.dock').length > 0,
      [version]
    )
    if (!host || !target || !hasEntries || !sessionId || !session) return null
    if (host.conversation.getSessionId() !== sessionId) return null
    return createPortal(
      <div data-dsh-standard-conversation-composer-dock>
        {renderSlot('conversation.composer.dock', {
          session,
          input: { ...input, queue: session.queue }
        })}
      </div>,
      target
    )
  }

  ctx.effect(() => conversation.dispose, 'dsh-work conversation bridge')
  ctx.effect(() => ctx.reflect.provide('layout', layout), 'dsh-work shell layout adapter')

  ctx.effect(() => ctx.slots.register({
    name: 'root',
    priority: -100,
    children: {
      [WORKBENCH_SLOT]: { kind: 'list', scope: 'root' },
      'sidebar': { kind: 'single', scope: 'root' },
      'conversation': { kind: 'single', scope: 'session-maybe' },
      'details': { kind: 'single', scope: 'session' },
      'settings.section': { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' }
    }
  }, DshWorkRoot), 'dsh-work shell root registration')

  ctx.effect(() => ctx.slots.register({
    name: 'sidebar',
    id: 'dsh-work-sidebar',
    priority: 100,
    children: {
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'sidebar.settings': { kind: 'single', scope: 'root' },
      'sidebar.footer.action': { kind: 'list', scope: 'root' }
    }
  }, DshWorkSidebar), 'dsh-work sidebar adapter')

  ctx.effect(() => ctx.slots.register({
    name: 'conversation',
    id: 'dsh-work-conversation',
    priority: -100,
    children: {
      'conversation.composer.dock': { kind: 'list', scope: 'session' }
    }
  }, DshWorkConversation), 'dsh-work conversation adapter')

  ctx.effect(() => ctx.slots.register({
    name: 'settings.section',
    id: 'general',
    order: 0,
    priority: -100,
    label: '常规',
    children: { 'settings.general.item': { kind: 'list', scope: 'root' } }
  }, DshWorkGeneralSettings), 'dsh-work general settings section')

  ctx.effect(() => {
    const presenter = createDshThemePresenter(document)
    const themeColorMeta = document.createElement('meta')
    themeColorMeta.name = 'theme-color'
    const present = (snapshot: ThemeSnapshot) => {
      presenter.present(snapshot)
      themeColorMeta.content = getComputedStyle(document.body).backgroundColor
      if (!themeColorMeta.isConnected) document.head.append(themeColorMeta)
    }
    present(ctx.theme.getTheme())
    const off = ctx.on('theme/change', present)
    return () => {
      off()
      presenter.dispose()
      themeColorMeta.remove()
    }
  }, 'dsh-work shell theme presenter')
}

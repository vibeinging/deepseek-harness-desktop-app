import { type ReactNode, useEffect, useMemo } from 'react'
import { MantineProvider } from '@mantine/core'
import { Notifications } from '@mantine/notifications'
import { ModalsProvider } from '@mantine/modals'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/lang'
import { buildMantineTheme } from '@/theme/mantineTheme'
import { mantineColorsForScheme } from '@/theme/skins/palette'
import { useSkinsStore } from '@/store/skins'
import { subscribePluginCatalogEvents } from '@/api/plugins'
import {
  dispatchProfileCatalogChanged,
  subscribeProfileCatalogChanged,
  type ProfileCatalogChangeReason
} from '@/store/profileCatalogEvents'
import { refreshProfileThemes } from '@/store/profileThemes'

// Mantine style entry point (global, imported once)
import '@mantine/core/styles.css'
import '@mantine/notifications/styles.css'
import '@mantine/dates/styles.css'
import '@mantine/dropzone/styles.css'

const NOTIFICATION_Z_INDEX = 400
const MODAL_Z_INDEX = 500
const PLUGIN_CATALOG_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000] as const

/**
 * Global provider aggregation (aligned with app.use(...) registrations in original main.js):
 * - MantineProvider   ← element-plus + ElConfigProvider
 * - Notifications     ← ElMessage / ElNotification
 * - ModalsProvider    ← ElMessageBox
 * - I18nextProvider   ← vue-i18n
 *
 * Mantine 主色随激活皮肤热跟随：皮肤提供 mantineColors 时重建 theme，传入 MantineProvider。
 * Mantine 通过 context 透传，theme 变化只触发消费子树重渲染，不会 unmount。
 */
export default function AppProviders({ children }: { children: ReactNode }) {
  const scheme = useSkinsStore((s) => s.scheme)
  const skin = useSkinsStore((s) => s.previewSkin || s.getSkin(s.appliedSkinId))
  const colors = mantineColorsForScheme(skin, scheme)
  // 主色阶或明暗模式变化时重建 theme；dark 有独立色阶时同步切换。
  const theme = useMemo(() => buildMantineTheme(colors), [colors])

  useEffect(() => {
    void refreshProfileThemes().catch(() => undefined)
    return subscribeProfileCatalogChanged(() => {
      void refreshProfileThemes(true).catch(() => undefined)
    })
  }, [])

  useEffect(() => {
    let disposed = false
    let reconnectIndex = 0
    let reconnectTimer: number | null = null
    let controller: AbortController | null = null

    const connect = () => {
      if (disposed) return
      controller?.abort()
      controller = new AbortController()
      let readyAt = 0
      void subscribePluginCatalogEvents((event) => {
        if (disposed) return
        if (event.type === 'plugin_catalog.ready') {
          readyAt = Date.now()
          dispatchProfileCatalogChanged({
            reason: 'upgrade',
            canonical_plugin_id: 'profile:web'
          }, event.payload.event_id)
          return
        }
        if (event.type !== 'plugin_catalog.changed'
          || !event.payload.reason || !event.payload.canonical_plugin_id) return
        dispatchProfileCatalogChanged({
          reason: event.payload.reason as ProfileCatalogChangeReason,
          canonical_plugin_id: event.payload.canonical_plugin_id
        }, event.payload.event_id)
      }, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          if (disposed) return
          controller = null
          if (readyAt && Date.now() - readyAt >= 20_000) reconnectIndex = 0
          const delay = PLUGIN_CATALOG_RECONNECT_DELAYS_MS[
            Math.min(reconnectIndex, PLUGIN_CATALOG_RECONNECT_DELAYS_MS.length - 1)
          ]
          reconnectIndex = Math.min(reconnectIndex + 1, PLUGIN_CATALOG_RECONNECT_DELAYS_MS.length - 1)
          reconnectTimer = window.setTimeout(connect, delay)
        })
    }

    connect()
    return () => {
      disposed = true
      controller?.abort()
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer)
    }
  }, [])

  return (
    <I18nextProvider i18n={i18n}>
      <MantineProvider theme={theme} defaultColorScheme="light">
        <Notifications position="top-center" zIndex={NOTIFICATION_Z_INDEX} />
        <ModalsProvider modalProps={{ zIndex: MODAL_Z_INDEX }}>{children}</ModalsProvider>
      </MantineProvider>
    </I18nextProvider>
  )
}

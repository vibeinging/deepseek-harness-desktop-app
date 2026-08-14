import { useEffect, useRef } from 'react'
import { RouterProvider } from 'react-router-dom'
import { notifications } from '@mantine/notifications'
import AppProviders from '@/providers/AppProviders'
import { router } from '@/router'
import { initApp } from '@/app-init'
import { DshStandardShellOverlay, useDshClientHost } from '@/dsh-client/DshClientHost'

// Product styles belong to the dsh-work shell Client Plugin. The plugin build
// embeds them in its ModuleLoader factory; the standalone Vite path loads the
// same imports through the ordinary app bundle.
import '@/theme/index.scss'
import '@/styles/index.scss'
import '@xyflow/react/dist/style.css'
import 'katex/dist/katex.min.css'
import 'nprogress/nprogress.css'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

/** The existing dsh-work product tree, independent of who owns the React root. */
export default function DshWorkApp() {
  const dshClientHost = useDshClientHost()
  const runtimeMode = dshClientHost ? 'dsh-client' : 'standalone'
  const bootOptions = useRef(dshClientHost ? {
    scheme: dshClientHost.themeSnapshot.active.colorScheme,
    language: dshClientHost.localeSnapshot.active
  } : {}).current

  useEffect(() => {
    void initApp(bootOptions)
    document.documentElement.dataset.appReady = 'true'
    document.documentElement.dataset.dshWorkRuntime = runtimeMode
    return () => {
      delete document.documentElement.dataset.appReady
      delete document.documentElement.dataset.dshWorkRuntime
    }
  }, [bootOptions, runtimeMode])

  useEffect(() => {
    const backendApi = (window as any).electronAPI
    if (typeof backendApi?.onBackendState !== 'function') return
    return backendApi.onBackendState((payload: any) => {
      if (payload?.state === 'restarting') {
        notifications.show({ color: 'yellow', message: '本地服务已中断，正在自动恢复…' })
      } else if (payload?.state === 'ready') {
        notifications.show({ color: 'green', message: '本地服务已恢复' })
      } else if (payload?.state === 'failed') {
        notifications.show({ color: 'red', message: payload?.error || '本地服务不可用，请重启应用' })
      }
    })
  }, [])

  return (
    <AppProviders>
      <RouterProvider router={router} />
      <DshStandardShellOverlay />
    </AppProviders>
  )
}

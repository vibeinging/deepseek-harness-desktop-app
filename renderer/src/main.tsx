import ReactDOM from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { notifications } from '@mantine/notifications'
import AppProviders from '@/providers/AppProviders'
import { router } from '@/router'
import { initApp } from '@/app-init'

// Global styles + side effects (aligned with import sequence in original main.js)
import '@/theme/index.scss'
import '@/styles/index.scss'
import '@xyflow/react/dist/style.css'
import 'katex/dist/katex.min.css'
import 'nprogress/nprogress.css'
import 'react-grid-layout/css/styles.css'
import 'react-resizable/css/styles.css'

initApp()

ReactDOM.createRoot(document.getElementById('app') as HTMLElement).render(
  <AppProviders>
    <RouterProvider router={router} />
  </AppProviders>
)

document.documentElement.dataset.appReady = 'true'

const backendApi = (window as any).electronAPI
if (typeof backendApi?.onBackendState === 'function') {
  const dispose = backendApi.onBackendState((payload: any) => {
    if (payload?.state === 'restarting') {
      notifications.show({ color: 'yellow', message: '本地服务已中断，正在自动恢复…' })
    } else if (payload?.state === 'ready') {
      notifications.show({ color: 'green', message: '本地服务已恢复' })
    } else if (payload?.state === 'failed') {
      notifications.show({ color: 'red', message: payload?.error || '本地服务不可用，请重启应用' })
    }
  })
  window.addEventListener('beforeunload', dispose, { once: true })
}

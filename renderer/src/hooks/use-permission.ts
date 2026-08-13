import NProgress from 'nprogress'
import settings from '@/settings'

NProgress.configure({ showSpinner: false })

export const progressStart = () => {
  if (settings.isNeedNprogress) NProgress.start()
}

export const progressClose = () => {
  if (settings.isNeedNprogress) NProgress.done()
}

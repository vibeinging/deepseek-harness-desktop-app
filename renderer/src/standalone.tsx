import ReactDOM from 'react-dom/client'
import DshWorkApp from '@/DshWorkApp'

/** Mount the explicit browser-only fallback used by the Vite development URL. */
export function mountStandaloneDshWorkApp(element: HTMLElement) {
  element.dataset.dshWorkRuntime = 'standalone'
  ReactDOM.createRoot(element).render(<DshWorkApp />)
}

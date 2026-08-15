import { type RouteObject, redirect } from 'react-router-dom'
import RouteGuard from './RouteGuard'

/**
 * Electron app route configuration.
 * Only app-native pages are exposed. Unmatched paths fall back to the main workspace.
 */
const viewModules: Record<string, () => Promise<any>> = {
  'views/error-page/404': () => import('@/views/error-page/404'),
  'views/share/index': () => import('@/views/share/index'),
  'views/agent/index': () => import('@/views/agent/index'),
  'views/agent/AgentWorkspaceRoute': () => import('@/views/agent/AgentWorkspaceRoute')
}

const lazyOf = (key: string) => {
  const loader = viewModules[key]
  if (!loader) throw new Error(`[router] 找不到视图模块: ${key}`)
  return async () => {
    const m: any = await loader()
    return { Component: m.default }
  }
}

export interface RouteMeta {
  title?: string
  requireProject?: boolean
  elSvgIcon?: string
  cachePage?: boolean
  hidden?: boolean
  affix?: boolean
  tooltip?: string
  public?: boolean
  [k: string]: any
}

export interface AppRoute {
  path?: string
  index?: boolean
  name?: string
  /** glob key: 'views/xxx/index' */
  view?: string
  hidden?: boolean
  meta?: RouteMeta
  redirectTo?: string | ((params: Record<string, string | undefined>, url: URL) => string)
  children?: AppRoute[]
}

export const constantRoutes: AppRoute[] = [
  { path: '/404', view: 'views/error-page/404', hidden: true, meta: { requireProject: false } },
  { path: '/share/:shareToken', name: 'SharedSession', view: 'views/share/index', hidden: true, meta: { title: 'router.sharedSession', public: true, requireProject: false } },

  // The pathless desktop shell keeps theme, zoom, navigation resizing and
  // product slots consistent across application routes.
  {
    view: 'views/agent/index',
    children: [
      {
        path: '/agent',
        name: 'AgentWorkspace',
        view: 'views/agent/AgentWorkspaceRoute',
        hidden: true,
        meta: { title: 'DeepSeek Harness Desktop App', requireProject: false }
      }
    ]
  },
  // Default redirect to the main product workspace.
  { index: true, redirectTo: '/agent', hidden: true, meta: { requireProject: false } }
]

const allDescriptors: AppRoute[] = constantRoutes

// ── descriptor → React Router RouteObject ──
const toRouteObject = (r: AppRoute): RouteObject => {
  const handle = { meta: r.meta || {}, name: r.name }
  if (r.redirectTo) {
    const dest = r.redirectTo
    return {
      ...(r.index ? { index: true } : { path: r.path }),
      loader: ({ params, request }) =>
        redirect(typeof dest === 'function' ? dest(params as any, new URL(request.url)) : dest),
      handle
    } as RouteObject
  }
  const base: any = r.index ? { index: true } : { path: r.path }
  if (r.view) base.lazy = lazyOf(r.view)
  if (r.children) base.children = r.children.map(toRouteObject)
  base.handle = handle
  return base as RouteObject
}

const buildTree = (descriptors: AppRoute[]): RouteObject[] =>
  descriptors.map(toRouteObject)

export const routeObjects: RouteObject[] = [
  {
    element: <RouteGuard />,
    children: [
      ...buildTree(allDescriptors),
      // /agent owns the application shell.
      { path: '*', loader: () => redirect('/agent') }
    ]
  }
]

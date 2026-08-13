import { useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useMatches, useNavigate } from 'react-router-dom'
import { progressClose, progressStart } from '@/hooks/use-permission'
import { useProjectStore } from '@/store/project'
import { getMyProjectsReq, getProjectDetailReq } from '@/api/project'
import type { RouteMeta } from './routes'

interface NavTarget {
  path: string
  meta: RouteMeta
  params: Record<string, string | undefined>
}

/**
 * Local app route guard. The app has no login/account flow and loads
 * project context only when required.
 */
async function resolveGuard(to: NavTarget): Promise<string | null> {
  if (to.meta?.public || to.path.startsWith('/share/')) return null

  const needProject = to.meta?.requireProject !== false
  if (needProject) {
    let project = useProjectStore.getState()
    if (project.projects.length === 0) {
      try {
        const res: any = await getMyProjectsReq()
        useProjectStore.getState().setProjects(res.data?.items || res.data || [])
      } catch {
        return '/agent'
      }
    }

    project = useProjectStore.getState()
    const urlProjectId = to.params?.projectId
    if (urlProjectId && urlProjectId !== (project.currentProject?.id || null)) {
      const target = project.projects.find((p) => p.id === urlProjectId)
      if (target) {
        useProjectStore.getState().setCurrentProject(target)
      } else {
        try {
          const res: any = await getProjectDetailReq(urlProjectId)
          if (res.data) useProjectStore.getState().setCurrentProject(res.data)
          else return '/agent'
        } catch {
          return '/agent'
        }
      }
    }

    project = useProjectStore.getState()
    const lastProject = project.currentProject
    if (lastProject) {
      const validProject = project.projects.find((p) => p.id === lastProject.id)
      if (!validProject) {
        if (Date.now() - project.lastDetailFetchedAt < 5000) {
          const deduped = project.projects.filter((p) => p.id !== lastProject.id)
          useProjectStore.getState().setProjects([lastProject, ...deduped])
        } else {
          try {
            const res: any = await getMyProjectsReq()
            const freshProjects = res.data?.items || res.data || []
            useProjectStore.getState().setProjects(freshProjects)
            if (!freshProjects.find((p: any) => p.id === lastProject.id)) {
              useProjectStore.getState().clearProject()
              return '/agent'
            }
          } catch {
            useProjectStore.getState().clearProject()
            return '/agent'
          }
        }
      }
    } else {
      return '/agent'
    }
  }

  return null
}

export default function RouteGuard() {
  const location = useLocation()
  const navigate = useNavigate()
  const matches = useMatches()
  // Keep `ready=true` after the first successful check: later navigations still
  // run validation (redirect on failure) but do not unmount `<Outlet/>`.
  // Without this, every navigation remounts Layout and stateful children
  // like sidebar and onboarding.
  const [ready, setReady] = useState(false)
  const runIdRef = useRef(0)

  const navKey = location.pathname + location.search

  useEffect(() => {
    const runId = ++runIdRef.current
    progressStart()

    // Read meta + params from the deepest matched route.
    const deepest = matches[matches.length - 1] as any
    const meta: RouteMeta = (deepest?.handle?.meta as RouteMeta) || {}
    const params: Record<string, string | undefined> = deepest?.params || {}
    const to: NavTarget = { path: location.pathname, meta, params }

    resolveGuard(to)
      .then((redirectTo) => {
        if (runId !== runIdRef.current) return
        if (redirectTo && redirectTo !== location.pathname) {
          navigate(redirectTo, { replace: true })
        } else {
          setReady(true)
        }
      })
      .finally(() => {
        if (runId === runIdRef.current) progressClose()
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navKey])

  return ready ? <Outlet /> : null
}

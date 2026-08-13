import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import settings from '@/settings'

interface SidebarState {
  opened: boolean
  collapsed: boolean
  hidden: boolean
}

interface AxiosPromiseItem {
  url?: string
  cancel: (msg?: string) => void
}

export interface BasicState {
  cachedViews: string[]
  cachedViewsDeep: string[]
  sessionStates: Record<string, any>
  sidebar: SidebarState
  axiosPromiseArr: AxiosPromiseItem[]
  settings: typeof settings

  remotePromiseArrByReqUrl: (reqUrl?: string) => void
  clearPromiseArr: () => void
  resetState: () => void
  setSidebarOpen: (v: boolean) => void
  setSidebarCollapsed: (v: boolean) => void
  setSidebarHidden: (v: boolean) => void
  toggleSidebar: () => void
  toggleSidebarHidden: () => void
  setToggleSideBar: () => void
  addCachedView: (view: string) => void
  delCachedView: (view: string) => void
  addCachedViewDeep: (view: string) => void
  delCacheViewDeep: (view: string) => void
  saveSessionState: (sessionId: string, sessionState: any) => void
  getSessionState: (sessionId: string) => any
  getAllSessionStates: () => Record<string, any>
  clearSessionState: (sessionId: string) => void
  clearAllSessionStates: () => void
}

export const useBasicStore = create<BasicState>()(
  persist(
    (set, get) => ({
      cachedViews: [],
      cachedViewsDeep: [],
      sessionStates: {},
      sidebar: { opened: true, collapsed: false, hidden: false },
      axiosPromiseArr: [],
      settings,

      remotePromiseArrByReqUrl: (reqUrl) =>
        set((s) => ({ axiosPromiseArr: s.axiosPromiseArr.filter((f) => f.url !== reqUrl) })),
      clearPromiseArr: () => set({ axiosPromiseArr: [] }),
      resetState: () =>
        set({
          cachedViews: [],
          cachedViewsDeep: [],
          axiosPromiseArr: []
        }),
      setSidebarOpen: (v) => set((s) => ({ sidebar: { ...s.sidebar, opened: v } })),
      setSidebarCollapsed: (v) => set((s) => ({ sidebar: { ...s.sidebar, collapsed: v } })),
      setSidebarHidden: (v) => set((s) => ({ sidebar: { ...s.sidebar, hidden: v } })),
      toggleSidebar: () => set((s) => ({ sidebar: { ...s.sidebar, collapsed: !s.sidebar.collapsed } })),
      toggleSidebarHidden: () => set((s) => ({ sidebar: { ...s.sidebar, hidden: !s.sidebar.hidden } })),
      setToggleSideBar: () => set((s) => ({ sidebar: { ...s.sidebar, opened: !s.sidebar.opened } })),
      addCachedView: (view) =>
        set((s) => (s.cachedViews.includes(view) ? s : { cachedViews: [...s.cachedViews, view] })),
      delCachedView: (view) => set((s) => ({ cachedViews: s.cachedViews.filter((v) => v !== view) })),
      addCachedViewDeep: (view) =>
        set((s) => (s.cachedViewsDeep.includes(view) ? s : { cachedViewsDeep: [...s.cachedViewsDeep, view] })),
      delCacheViewDeep: (view) => set((s) => ({ cachedViewsDeep: s.cachedViewsDeep.filter((v) => v !== view) })),
      saveSessionState: (sessionId, sessionState) =>
        set((s) => ({
          sessionStates: {
            ...s.sessionStates,
            [sessionId]: { ...s.sessionStates[sessionId], ...sessionState, lastUpdated: Date.now() }
          }
        })),
      getSessionState: (sessionId) => get().sessionStates[sessionId] || null,
      getAllSessionStates: () => get().sessionStates,
      clearSessionState: (sessionId) =>
        set((s) => {
          const next = { ...s.sessionStates }
          delete next[sessionId]
          return { sessionStates: next }
        }),
      clearAllSessionStates: () => set({ sessionStates: {} })
    }),
    {
      name: 'basic',
      version: 2,
      migrate: (persisted: any) => {
        const { token, userInfo, getUserInfo, isAdminMode, ...localState } = persisted || {}
        void token
        void userInfo
        void getUserInfo
        void isAdminMode
        return localState
      },
      partialize: (s) => ({
        sidebar: s.sidebar,
        sessionStates: s.sessionStates
      })
    }
  )
)

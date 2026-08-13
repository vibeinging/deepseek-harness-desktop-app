import { create } from 'zustand'
import { persist } from 'zustand/middleware'
export interface Project {
  id: string
  name?: string
  [k: string]: any
}

export interface ProjectState {
  currentProject: Project | null
  projects: Project[]
  loading: boolean
  lastDetailFetchedAt: number

  setProjects: (projects: Project[]) => void
  setCurrentProject: (project: Project | null) => void
  clearProject: () => void
  resetState: () => void
  setLoading: (loading: boolean) => void
}

export const useProjectStore = create<ProjectState>()(
  persist(
    (set, get) => ({
      currentProject: null,
      projects: [],
      loading: false,
      lastDetailFetchedAt: 0,

      setProjects: (projects) => set({ projects: projects || [] }),
      setCurrentProject: (project) => {
        if (project) {
          const projects = [...get().projects]
          const index = projects.findIndex((p) => p.id === project.id)
          if (index !== -1) projects[index] = { ...projects[index], ...project }
          set({
            currentProject: project,
            projects,
            lastDetailFetchedAt: Date.now()
          })
        } else {
          set({
            currentProject: null,
            lastDetailFetchedAt: Date.now()
          })
        }
      },
      clearProject: () => set({ currentProject: null }),
      resetState: () =>
        set({ currentProject: null, projects: [], loading: false }),
      setLoading: (loading) => set({ loading })
    }),
    {
      name: 'project',
      version: 2,
      migrate: (persisted: any) => {
        const { currentPermissions, currentRole, ...projectState } = persisted || {}
        void currentPermissions
        void currentRole
        return projectState
      },
      partialize: (s) => ({
        currentProject: s.currentProject
      })
    }
  )
)

/** Derived getters, aligned with Pinia-style getters, for selector usage. */
export const projectGetters = {
  hasProject: (s: ProjectState) => !!s.currentProject,
  currentProjectId: (s: ProjectState) => s.currentProject?.id || null,
  currentProjectName: (s: ProjectState) => s.currentProject?.name || ''
}

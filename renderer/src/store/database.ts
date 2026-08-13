import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface DatabaseConfig {
  id: string
  db_type?: string
  [k: string]: any
}

interface UIState {
  showSchemaConfig: boolean
  showAttachConfig: boolean
  activeDatabaseTab: string
}

export interface DatabaseState {
  databases: DatabaseConfig[]
  currentDatabase: DatabaseConfig | null
  schemaConfigs: Record<string, any>
  sqliteAttachConfigs: Record<string, any>
  schemaDiscoveryCache: Record<string, any>
  connectionTestResults: Record<string, any>
  loading: boolean
  schemaLoading: boolean
  errors: Record<string, any>
  ui: UIState

  setDatabases: (databases: DatabaseConfig[]) => void
  setCurrentDatabase: (database: DatabaseConfig | null) => void
  updateSchemaConfig: (databaseId: string, config: any) => void
  updateAttachConfig: (databaseId: string, config: any) => void
  cacheSchemaDiscovery: (connectionKey: string, discoveryData: any) => void
  getCachedSchemaDiscovery: (connectionKey: string) => any
  clearSchemaCache: (connectionKey?: string | null) => void
  saveConnectionTestResult: (connectionKey: string, result: any) => void
  clearConnectionTestResult: (connectionKey?: string | null) => void
  setLoading: (loading: boolean) => void
  setSchemaLoading: (loading: boolean) => void
  setError: (key: string, error: any) => void
  clearError: (key?: string | null) => void
  updateUIState: (uiState: Partial<UIState>) => void
  resetDatabaseState: () => void
  prepareSchemaFormData: (databaseConfig: DatabaseConfig | null) => any
  handleSchemaDiscoveryResponse: (connectionKey: string, response: any) => any
  handleConnectionTestResponse: (connectionKey: string, response: any) => any
  // getters
  currentSchemaConfig: () => any
  currentAttachConfig: () => any
  supportsMultipleSchemas: () => boolean
  getConnectionTestResult: (connectionKey: string) => any
  getConnectionKey: (dbConfig: any) => string
}

const defaultUI = (): UIState => ({
  showSchemaConfig: false,
  showAttachConfig: false,
  activeDatabaseTab: 'basic'
})

export const useDatabaseStore = create<DatabaseState>()(
  persist(
    (set, get) => ({
      databases: [],
      currentDatabase: null,
      schemaConfigs: {},
      sqliteAttachConfigs: {},
      schemaDiscoveryCache: {},
      connectionTestResults: {},
      loading: false,
      schemaLoading: false,
      errors: {},
      ui: defaultUI(),

      setDatabases: (databases) => set({ databases }),
      setCurrentDatabase: (database) => set({ currentDatabase: database }),
      updateSchemaConfig: (databaseId, config) =>
        set((s) => ({ schemaConfigs: { ...s.schemaConfigs, [databaseId]: { ...s.schemaConfigs[databaseId], ...config } } })),
      updateAttachConfig: (databaseId, config) =>
        set((s) => ({ sqliteAttachConfigs: { ...s.sqliteAttachConfigs, [databaseId]: { ...s.sqliteAttachConfigs[databaseId], ...config } } })),
      cacheSchemaDiscovery: (connectionKey, discoveryData) =>
        set((s) => ({ schemaDiscoveryCache: { ...s.schemaDiscoveryCache, [connectionKey]: { ...discoveryData, timestamp: Date.now() } } })),
      getCachedSchemaDiscovery: (connectionKey) => {
        const cached = get().schemaDiscoveryCache[connectionKey]
        if (!cached) return null
        if (Date.now() - cached.timestamp > 5 * 60 * 1000) {
          set((s) => {
            const next = { ...s.schemaDiscoveryCache }
            delete next[connectionKey]
            return { schemaDiscoveryCache: next }
          })
          return null
        }
        return cached
      },
      clearSchemaCache: (connectionKey = null) =>
        set((s) => {
          if (connectionKey) {
            const next = { ...s.schemaDiscoveryCache }
            delete next[connectionKey]
            return { schemaDiscoveryCache: next }
          }
          return { schemaDiscoveryCache: {} }
        }),
      saveConnectionTestResult: (connectionKey, result) =>
        set((s) => ({ connectionTestResults: { ...s.connectionTestResults, [connectionKey]: { ...result, timestamp: Date.now() } } })),
      clearConnectionTestResult: (connectionKey = null) =>
        set((s) => {
          if (connectionKey) {
            const next = { ...s.connectionTestResults }
            delete next[connectionKey]
            return { connectionTestResults: next }
          }
          return { connectionTestResults: {} }
        }),
      setLoading: (loading) => set({ loading }),
      setSchemaLoading: (loading) => set({ schemaLoading: loading }),
      setError: (key, error) => set((s) => ({ errors: { ...s.errors, [key]: error } })),
      clearError: (key = null) =>
        set((s) => {
          if (key) {
            const next = { ...s.errors }
            delete next[key]
            return { errors: next }
          }
          return { errors: {} }
        }),
      updateUIState: (uiState) => set((s) => ({ ui: { ...s.ui, ...uiState } })),
      resetDatabaseState: () =>
        set({
          currentDatabase: null,
          schemaConfigs: {},
          sqliteAttachConfigs: {},
          connectionTestResults: {},
          errors: {},
          ui: defaultUI()
        }),
      prepareSchemaFormData: (databaseConfig) => {
        if (!databaseConfig) return {}
        const schemaConfig = get().schemaConfigs[databaseConfig.id] || {}
        const attachConfig = get().sqliteAttachConfigs[databaseConfig.id] || {}
        return {
          id: databaseConfig.id,
          name: databaseConfig.name,
          host: databaseConfig.host,
          port: databaseConfig.port,
          database: databaseConfig.database,
          username: databaseConfig.username,
          password: databaseConfig.password,
          db_type: databaseConfig.db_type,
          description: databaseConfig.description || '',
          default_schema: schemaConfig.defaultSchema || databaseConfig.default_schema,
          available_schemas: schemaConfig.availableSchemas || databaseConfig.available_schemas || [],
          schema_filter_enabled:
            schemaConfig.schemaFilterEnabled !== undefined ? schemaConfig.schemaFilterEnabled : databaseConfig.schema_filter_enabled,
          sqlite_attached_dbs: attachConfig.attachedDbs || databaseConfig.sqlite_attached_dbs || []
        }
      },
      handleSchemaDiscoveryResponse: (connectionKey, response) => {
        if (!response || !response.data) return
        const { schemas, default_schema, supports_multiple_schemas, warnings, errors } = response.data
        get().cacheSchemaDiscovery(connectionKey, {
          schemas,
          defaultSchema: default_schema,
          supportsMultipleSchemas: supports_multiple_schemas,
          warnings: warnings || [],
          errors: errors || []
        })
        const currentDatabase = get().currentDatabase
        if (currentDatabase) {
          get().updateSchemaConfig(currentDatabase.id, {
            availableSchemas: schemas || [],
            defaultSchema: default_schema,
            supportsMultipleSchemas: supports_multiple_schemas || false
          })
          if (currentDatabase.db_type === 'SQLite') {
            const attachedDbs = (schemas || [])
              .map((schemaName: string) => ({
                schema_name: schemaName,
                file_path: currentDatabase.database === schemaName ? currentDatabase.host : ''
              }))
              .filter((db: any) => db.schema_name && db.file_path)
            get().updateAttachConfig(currentDatabase.id, {
              attachedDbs,
              securityValidated: !(errors && errors.length > 0)
            })
          }
        }
        return response.data
      },
      handleConnectionTestResponse: (connectionKey, response) => {
        if (!response || !response.data) return
        const result = response.data
        get().saveConnectionTestResult(connectionKey, {
          success: result.success,
          message: result.message || '',
          schemas: result.schemas || [],
          accessible_schemas: result.accessible_schemas || [],
          inaccessible_schemas: result.inaccessible_schemas || [],
          schema_access_warning: result.schema_access_warning,
          sqlite_attached_supported: result.sqlite_attached_supported,
          attached_dbs_test: result.attached_dbs_test || [],
          attach_security_summary: result.attach_security_summary,
          attach_db_warning: result.attach_db_warning,
          warnings: result.warnings || [],
          errors: result.errors || []
        })
        const currentDatabase = get().currentDatabase
        if (result.success && currentDatabase) {
          if (result.schemas && result.schemas.length > 0) {
            get().updateSchemaConfig(currentDatabase.id, { availableSchemas: result.schemas, supportsMultipleSchemas: true })
          }
          if (result.sqlite_attached_supported && result.attached_dbs_test) {
            const validAttachedDbs = result.attached_dbs_test
              .filter((db: any) => db.accessible && db.security_passed !== false)
              .map((db: any) => ({ schema_name: db.alias, file_path: db.path }))
            get().updateAttachConfig(currentDatabase.id, { attachedDbs: validAttachedDbs, securityValidated: true })
          }
        }
        return result
      },

      currentSchemaConfig: () => {
        const cur = get().currentDatabase
        if (!cur) return null
        return get().schemaConfigs[cur.id] || { availableSchemas: [], defaultSchema: null, schemaFilterEnabled: false }
      },
      currentAttachConfig: () => {
        const cur = get().currentDatabase
        if (!cur) return null
        return get().sqliteAttachConfigs[cur.id] || { attachedDbs: [], securityValidated: false }
      },
      supportsMultipleSchemas: () => {
        const cur = get().currentDatabase
        if (!cur) return false
        return ['PostgreSQL', 'Oracle', 'SQLServer', 'SQLite', 'OpenGauss'].includes(cur.db_type || '')
      },
      getConnectionTestResult: (connectionKey) => get().connectionTestResults[connectionKey] || null,
      getConnectionKey: (dbConfig) =>
        dbConfig ? `${dbConfig.host}:${dbConfig.port}:${dbConfig.database}:${dbConfig.username}:${dbConfig.db_type}` : ''
    }),
    {
      name: 'database',
      partialize: (s) => ({
        schemaConfigs: s.schemaConfigs,
        sqliteAttachConfigs: s.sqliteAttachConfigs,
        ui: { activeDatabaseTab: s.ui.activeDatabaseTab } as UIState
      })
    }
  )
)

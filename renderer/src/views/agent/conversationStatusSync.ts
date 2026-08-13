export const CONVERSATION_STATUS_BATCH_WINDOW_MS = 100
export const CONVERSATION_STATUS_REFRESH_RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000] as const

type RefreshState = {
  timer: ReturnType<typeof setTimeout> | null
  timerKind: 'batch' | 'retry' | null
  running: boolean
  dirty: boolean
  retryAttempt: number
}

export interface ConversationStatusRefreshOptions {
  immediate?: boolean
}

/**
 * Coalesces invalidations per workspace and keeps at most one snapshot request
 * running for each workspace. An invalidation received during a request is
 * remembered and reconciled once more after that request settles.
 */
export class ConversationStatusRefreshCoordinator {
  private readonly states = new Map<string, RefreshState>()
  private disposed = false

  constructor(
    private readonly refreshWorkspace: (workspaceId: string) => Promise<unknown>,
    private readonly batchWindowMs = CONVERSATION_STATUS_BATCH_WINDOW_MS,
    private readonly retryDelaysMs: readonly number[] = CONVERSATION_STATUS_REFRESH_RETRY_DELAYS_MS
  ) {}

  schedule(workspaceId: string, options: ConversationStatusRefreshOptions = {}) {
    const id = String(workspaceId || '').trim()
    if (!id || this.disposed) return
    const state = this.state(id)
    state.retryAttempt = 0
    if (state.running) {
      state.dirty = true
      return
    }
    if (state.timer !== null) {
      if (!options.immediate && state.timerKind !== 'retry') return
      clearTimeout(state.timer)
      state.timer = null
      state.timerKind = null
    }
    this.armTimer(id, state, options.immediate ? 0 : this.batchWindowMs, 'batch')
  }

  scheduleMany(workspaceIds: Iterable<string>, options: ConversationStatusRefreshOptions = {}) {
    for (const workspaceId of new Set(workspaceIds)) this.schedule(workspaceId, options)
  }

  dispose() {
    this.disposed = true
    for (const state of this.states.values()) {
      if (state.timer !== null) clearTimeout(state.timer)
    }
    this.states.clear()
  }

  private state(workspaceId: string) {
    let state = this.states.get(workspaceId)
    if (!state) {
      state = { timer: null, timerKind: null, running: false, dirty: false, retryAttempt: 0 }
      this.states.set(workspaceId, state)
    }
    return state
  }

  private armTimer(
    workspaceId: string,
    state: RefreshState,
    delayMs: number,
    kind: 'batch' | 'retry'
  ) {
    state.timerKind = kind
    state.timer = setTimeout(() => {
      state.timer = null
      state.timerKind = null
      this.run(workspaceId, state)
    }, Math.max(0, delayMs))
  }

  private run(workspaceId: string, state: RefreshState) {
    if (this.disposed) return
    if (state.running) {
      state.dirty = true
      return
    }
    state.running = true
    void Promise.resolve()
      .then(() => this.refreshWorkspace(workspaceId))
      .then(() => {
        state.running = false
        if (this.disposed) return
        state.retryAttempt = 0
        if (state.dirty) {
          state.dirty = false
          this.armTimer(workspaceId, state, 0, 'batch')
          return
        }
        if (state.timer === null) this.states.delete(workspaceId)
      }, () => {
        state.running = false
        if (this.disposed) return
        if (state.dirty) {
          state.dirty = false
          state.retryAttempt = 0
          this.armTimer(workspaceId, state, 0, 'batch')
          return
        }
        const retryDelay = this.retryDelaysMs[state.retryAttempt]
        if (retryDelay !== undefined) {
          state.retryAttempt += 1
          this.armTimer(workspaceId, state, retryDelay, 'retry')
          return
        }
        this.states.delete(workspaceId)
      })
  }
}

/** Prevents automatic retries from looping while allowing a later explicit row click to retry. */
export class ConversationViewedRequestTracker {
  private readonly inFlight = new Set<string>()
  private readonly failed = new Set<string>()

  claim(runId: string, options: { retryFailed?: boolean } = {}) {
    const id = String(runId || '').trim()
    if (!id) return false
    if (this.inFlight.has(id)) return false
    if (this.failed.has(id) && !options.retryFailed) return false
    this.failed.delete(id)
    this.inFlight.add(id)
    return true
  }

  markFailed(runId: string) {
    const id = String(runId || '').trim()
    if (!id) return
    this.inFlight.delete(id)
    this.failed.add(id)
  }

  markSucceeded(runId: string) {
    const id = String(runId || '').trim()
    this.inFlight.delete(id)
    this.failed.delete(id)
  }
}

/** Invalidates sidebar snapshots that started before a local authoritative mutation. */
export class ConversationSnapshotVersionTracker {
  private readonly versions = new Map<string, number>()

  get(workspaceId: string) {
    return this.versions.get(String(workspaceId || '').trim())
  }

  set(workspaceId: string, version: number) {
    const id = String(workspaceId || '').trim()
    if (id) this.versions.set(id, version)
  }

  begin(workspaceId: string) {
    const id = String(workspaceId || '').trim()
    if (!id) return 0
    const version = (this.get(id) || 0) + 1
    this.set(id, version)
    return version
  }

  invalidate(workspaceId: string) {
    return this.begin(workspaceId)
  }

  isCurrent(workspaceId: string, version: number) {
    const id = String(workspaceId || '').trim()
    return Boolean(id) && version > 0 && this.versions.get(id) === version
  }
}

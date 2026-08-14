import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { OwnerOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

type ComposerDockOwner = OwnerOf<'conversation.composer.dock'>
export type DshWorkComposerInputSnapshot = Omit<ComposerDockOwner['input'], 'queue'>
type DshSessions = Pick<ClientContext['sessions'], 'list' | 'open' | 'clear'>

const EMPTY_INPUT: DshWorkComposerInputSnapshot = Object.freeze({
  draft: '',
  imageIds: Object.freeze([]),
  draftRev: 0,
  phase: 'plain',
  occurrences: Object.freeze([])
})

/**
 * Keep the product-selected App conversation bound to the matching DSH Client
 * Session without creating another session or queue store.
 */
export class DshConversationBridge {
  readonly #sessions: DshSessions
  readonly #listeners = new Set<() => void>()
  readonly #unsubscribeSessions: () => void
  #desiredSessionId: SessionId | null | undefined
  #input = EMPTY_INPUT
  #disposed = false

  constructor(sessions: DshSessions) {
    this.#sessions = sessions
    this.#unsubscribeSessions = sessions.list.subscribe(() => this.#reconcileSession())
  }

  /** Select the exact DSH Session bound to the current App conversation. */
  syncSession(sessionId: string | null) {
    if (this.#disposed) return
    const next = sessionId ? sessionId as SessionId : null
    if (this.#desiredSessionId === next) {
      this.#reconcileSession()
      return
    }
    this.#desiredSessionId = next
    this.#input = { ...EMPTY_INPUT, draftRev: this.#input.draftRev + 1 }
    this.#emit()
    this.#reconcileSession()
  }

  /** Publish the App composer's current draft into the read-only Slot owner share. */
  updateDraft(draft: string) {
    if (this.#disposed || this.#input.draft === draft) return
    this.#input = {
      ...this.#input,
      draft,
      draftRev: this.#input.draftRev + 1
    }
    this.#emit()
  }

  /** Return the Session identity the product currently expects the Client to stage. */
  getSessionId() {
    return this.#desiredSessionId
  }

  /** Return the stable input snapshot consumed by useSyncExternalStore. */
  getInputSnapshot = () => this.#input

  /** Subscribe to product composer draft changes. */
  subscribeInput = (listener: () => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Release the list listener and all product subscribers. */
  dispose = () => {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribeSessions()
    this.#listeners.clear()
  }

  #emit() {
    for (const listener of this.#listeners) listener()
  }

  #reconcileSession() {
    if (this.#disposed || this.#desiredSessionId === undefined) return
    const list = this.#sessions.list.getSnapshot()
    if (this.#desiredSessionId === null) {
      if (list.current !== undefined) this.#sessions.clear()
      return
    }
    if (list.current === this.#desiredSessionId) return
    if (list.byId[this.#desiredSessionId]) this.#sessions.open(this.#desiredSessionId)
  }
}

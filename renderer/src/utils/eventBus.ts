// Simple event bus for cross-component communication (aligned with original utils/eventBus.js).
type Callback = (...args: any[]) => void

class EventBus {
  private events: Record<string, Callback[]> = {}

  on(event: string, callback: Callback) {
    if (!this.events[event]) this.events[event] = []
    this.events[event].push(callback)
  }

  off(event: string, callback: Callback) {
    if (!this.events[event]) return
    const index = this.events[event].indexOf(callback)
    if (index > -1) this.events[event].splice(index, 1)
  }

  emit(event: string, ...args: any[]) {
    if (!this.events[event]) return
    this.events[event].forEach((callback) => callback(...args))
  }

  clear() {
    this.events = {}
  }
}

export const eventBus = new EventBus()

export const EVENT_TYPES = {
  REFRESH_HISTORY: 'refresh_history',
  NEW_session_CREATED: 'new_session_created',
  QUERY_COMPLETED: 'query_completed',
  LOCATE_AGENT_QUESTION: 'locate_agent_question',
  OPEN_AGENT_REVIEW: 'open_agent_review'
} as const

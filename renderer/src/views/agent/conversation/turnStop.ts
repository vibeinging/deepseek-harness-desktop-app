export interface TurnStopResult {
  settled: boolean
  settlement?: unknown
}

type InterruptTurn = (threadId: string, turnId: string) => Promise<unknown>

/**
 * Ask the server to stop and durably settle the turn before closing its SSE.
 * Aborting immediately loses the authoritative terminal frame and can leave
 * the live UI in a different state from the persisted conversation.
 */
export async function stopTurnAfterSettlement({
  threadId,
  turnId,
  interrupt,
  abort
}: {
  threadId: string | null | undefined
  turnId: string | null | undefined
  interrupt: InterruptTurn
  abort: () => void
}): Promise<TurnStopResult> {
  if (!threadId || !turnId) {
    abort()
    return { settled: false }
  }
  try {
    const response: any = await interrupt(threadId, turnId)
    const data = response?.data ?? response
    if (data?.settled !== true) abort()
    return {
      settled: data?.settled === true,
      settlement: data?.settlement ?? null
    }
  } catch {
    abort()
    return { settled: false }
  }
}

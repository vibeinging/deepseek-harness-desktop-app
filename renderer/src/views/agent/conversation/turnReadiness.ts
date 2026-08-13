export interface ActiveTurnTarget {
  threadId: string
  turnId: string
}

/**
 * A new conversation becomes visibly busy before the runtime publishes its
 * turn id. Give that short startup window a chance to finish so an input sent
 * from the "补充到当前任务" composer is not silently moved to the next turn.
 */
export async function waitForActiveTurnTarget(
  read: () => ActiveTurnTarget | null,
  {
    timeoutMs = 3_000,
    pollMs = 25
  }: {
    timeoutMs?: number
    pollMs?: number
  } = {}
): Promise<ActiveTurnTarget | null> {
  const initial = read()
  if (initial) return initial
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, Math.max(1, pollMs)))
    const current = read()
    if (current) return current
  }
  return read()
}

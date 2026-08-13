import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const shellSource = readFileSync(new URL('./AgentShell.tsx', import.meta.url), 'utf8')
const conversationSource = readFileSync(new URL('./AgentConversation.tsx', import.meta.url), 'utf8')

describe('conversation status shell wiring', () => {
  it('retries failed status snapshots without replacing the last good sidebar state', () => {
    expect(shellSource).toContain("loadConvs([workspaceId], { throwOnError: true, silent: true })")
    expect(shellSource).toContain('if (Object.keys(map).length > 0) setConvByWs')
    expect(shellSource).toContain('if (options.throwOnError && failedIds.size > 0)')
  })

  it('does not mark a terminal result viewed merely because its snapshot is active', () => {
    expect(shellSource).not.toContain('canAutomaticallyMarkConversationViewed')
    expect(shellSource).not.toContain('markConversationViewedIfNeeded(activeWs, activeId)')
  })

  it('invalidates older snapshots and retries from every explicit conversation selection path', () => {
    expect(shellSource.match(/conversationSnapshotVersionRef\.current\.invalidate\(workspaceId\)/g)?.length)
      .toBeGreaterThanOrEqual(3)
    expect(shellSource.match(/markConversationViewedIfNeeded\([^\n]+\{ retryFailed: true \}\)/g))
      .toHaveLength(4)
  })

  it('restores running and stop controls from the selected conversation run after a remount', () => {
    expect(shellSource).toContain('latestRunId={activeConversation?.latest_run_id}')
    expect(shellSource).toContain('latestRunStatus={activeConversation?.latest_run_status}')
    expect(shellSource).toContain('liveInteractionStatus={activeConversation?.live_interaction_status}')
    expect(conversationSource).toContain('const effectiveBusy = runtimeState.busy')
    expect(conversationSource).toContain('busy && busySessionId === selectedId')
    expect(conversationSource).toContain('stopAgentRun(runId)')
    expect(conversationSource).toContain("title={effectiveBusy ? '停止当前任务' : '发送'}")
  })
})

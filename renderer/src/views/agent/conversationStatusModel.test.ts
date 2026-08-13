import { describe, expect, it } from 'vitest'
import {
  conversationRuntimeState,
  conversationStatusBadge,
  isActiveConversationRunStatus,
  isReviewableConversationRunStatus
} from './conversationStatusModel'

describe('conversation sidebar status model', () => {
  it('shows running work and gives a live interaction higher priority', () => {
    expect(conversationStatusBadge({ latestRunStatus: 'queued' })?.label).toBe('正在运行')
    expect(conversationStatusBadge({ latestRunStatus: 'recovering' })?.label).toBe('正在运行')
    expect(conversationStatusBadge({ latestRunStatus: 'completed', locallyRunning: true })?.kind).toBe('running')
    expect(conversationStatusBadge({
      latestRunStatus: 'running',
      locallyRunning: true,
      liveInteractionStatus: 'waiting_user_input'
    })?.label).toBe('需要回复')
    expect(conversationStatusBadge({
      latestRunStatus: 'running',
      liveInteractionStatus: 'waiting_approval'
    })?.label).toBe('需要确认')
    expect(conversationStatusBadge({
      latestRunStatus: 'running',
      latestRunViewedAt: '2026-08-09T12:00:00.000Z',
      liveInteractionStatus: 'waiting_user_input'
    })?.label).toBe('需要回复')
  })

  it('keeps unseen terminal outcomes visible and hides them after viewing', () => {
    expect(conversationStatusBadge({ latestRunStatus: 'completed' })?.label).toBe('完成待查看')
    expect(conversationStatusBadge({ latestRunStatus: 'failed' })?.label).toBe('运行失败')
    expect(conversationStatusBadge({ latestRunStatus: 'interrupted' })?.label).toBe('已停止')
    expect(conversationStatusBadge({ latestRunStatus: 'expired' })?.label).toBe('已过期')
    expect(conversationStatusBadge({
      latestRunStatus: 'completed',
      latestRunViewedAt: '2026-08-09T12:00:00.000Z'
    })).toBeNull()
  })

  it('recognizes reviewable outcomes and safely ignores unknown states', () => {
    expect(conversationStatusBadge({ latestRunStatus: 'future_state' })).toBeNull()
    expect(conversationStatusBadge({})).toBeNull()
    expect(isReviewableConversationRunStatus('failed')).toBe(true)
    expect(isReviewableConversationRunStatus('running')).toBe(false)
  })

  it('restores the active runtime controls from the durable run snapshot after a remount', () => {
    expect(conversationRuntimeState({
      localBusy: false,
      conversationId: 'conversation-1',
      latestRunId: 'run-1',
      latestRunStatus: 'running'
    })).toEqual({
      busy: true,
      recovered: true,
      authoritativeActive: true,
      stopRunId: 'run-1'
    })
    expect(isActiveConversationRunStatus('waiting_user_input')).toBe(true)
  })

  it('lets a durable terminal state clear stale shell-local running state', () => {
    expect(conversationRuntimeState({
      localBusy: false,
      conversationId: 'conversation-1',
      latestRunId: 'run-1',
      latestRunStatus: 'interrupted',
      locallyRunning: true
    })).toEqual({
      busy: false,
      recovered: false,
      authoritativeActive: false,
      stopRunId: null
    })
  })
})

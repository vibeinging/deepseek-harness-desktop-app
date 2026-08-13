import { describe, expect, it } from 'vitest'
import {
  activityState,
  activityStateLabel,
  approvalInteractionState,
  userInputInteractionState
} from './activityState'

describe('activityState', () => {
  it('only keeps a running item active while its Turn is running', () => {
    expect(activityState('inProgress', true)).toBe('running')
    expect(activityState('running', false)).toBe('stopped')
  })

  it('keeps rejected, stopped, failed, and completed states distinct', () => {
    expect(activityState('declined', false)).toBe('rejected')
    expect(activityState('interrupted', false)).toBe('stopped')
    expect(activityState('failed', false)).toBe('error')
    expect(activityState('completed', false)).toBe('done')
    expect(activityStateLabel('rejected')).toBe('已拒绝')
    expect(activityStateLabel('stopped')).toBe('已停止')
  })

  it('closes approval and user-input interactions after terminal Turn states', () => {
    expect(approvalInteractionState('MCP 工具确认', undefined)).toBe('requested')
    expect(approvalInteractionState('MCP 工具确认', undefined, undefined, 'suspended')).toBe('requested')
    expect(approvalInteractionState('MCP 工具确认', undefined, undefined, 'interrupted')).toBe('stopped')
    expect(approvalInteractionState('stopped', 'interrupted')).toBe('stopped')
    expect(approvalInteractionState('error', 'failed')).toBe('error')
    expect(approvalInteractionState('MCP 工具确认', undefined, 'approved')).toBe('approved')

    expect(userInputInteractionState('requested', 'requested')).toBe('requested')
    expect(userInputInteractionState('requested', 'requested', 'suspended')).toBe('requested')
    expect(userInputInteractionState('requested', 'requested', 'interrupted')).toBe('stopped')
    expect(userInputInteractionState('stopped', 'interrupted')).toBe('stopped')
    expect(userInputInteractionState('error', 'failed')).toBe('error')
    expect(userInputInteractionState('resolved', 'resolved')).toBe('resolved')
  })
})

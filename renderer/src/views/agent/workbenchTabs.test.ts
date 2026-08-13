import { describe, expect, it } from 'vitest'
import {
  activateWorkbenchTabState,
  closeWorkbenchTabState,
  EMPTY_WORKBENCH_TABS,
  openWorkbenchTabState,
  reconcileWorkbenchTabsState
} from './workbenchTabs'

describe('right workbench tab state', () => {
  it('adds tools without replacing tabs that are already open', () => {
    const review = openWorkbenchTabState(EMPTY_WORKBENCH_TABS, 'review')
    const browser = openWorkbenchTabState(review, 'browser')

    expect(browser).toEqual({ opened: ['review', 'browser'], active: 'browser' })
    expect(openWorkbenchTabState(browser, 'review')).toEqual({
      opened: ['review', 'browser'],
      active: 'review'
    })
  })

  it('switches only to a tab that is already open', () => {
    const state = { opened: ['review', 'files'] as const, active: 'review' as const }

    expect(activateWorkbenchTabState({ opened: [...state.opened], active: state.active }, 'files')).toEqual({
      opened: ['review', 'files'],
      active: 'files'
    })
    expect(activateWorkbenchTabState({ opened: [...state.opened], active: state.active }, 'sites')).toEqual({
      opened: ['review', 'files'],
      active: 'review'
    })
  })

  it('keeps the active tab when an inactive tab is closed', () => {
    expect(closeWorkbenchTabState({ opened: ['review', 'browser', 'files'], active: 'files' }, 'browser')).toEqual({
      opened: ['review', 'files'],
      active: 'files'
    })
  })

  it('activates the adjacent tab and only becomes empty after the last close', () => {
    const afterMiddle = closeWorkbenchTabState({
      opened: ['review', 'browser', 'files'],
      active: 'browser'
    }, 'browser')
    expect(afterMiddle).toEqual({ opened: ['review', 'files'], active: 'files' })

    const afterLastPosition = closeWorkbenchTabState(afterMiddle, 'files')
    expect(afterLastPosition).toEqual({ opened: ['review'], active: 'review' })
    expect(closeWorkbenchTabState(afterLastPosition, 'review')).toEqual(EMPTY_WORKBENCH_TABS)
  })

  it('removes tabs after their Profile contribution disappears', () => {
    expect(reconcileWorkbenchTabsState({
      opened: ['review', 'browser', 'files'],
      active: 'browser'
    }, ['review', 'files'])).toEqual({
      opened: ['review', 'files'],
      active: 'files'
    })
  })
})

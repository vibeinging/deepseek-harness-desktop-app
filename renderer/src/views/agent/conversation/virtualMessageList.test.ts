import { describe, expect, it, vi } from 'vitest'
import {
  activeVirtualMarkerId,
  estimateVirtualMessageSize,
  type VirtualMarkerRow,
} from './virtualMessageList'

describe('virtual message list model', () => {
  it('uses smaller estimates for user messages and scales assistant estimates by block count', () => {
    const user = { role: 'user', blocks: [{ id: 'u', type: 'text', content: 'hello' }] } as any
    const assistant = {
      role: 'assistant',
      blocks: Array.from({ length: 5 }, (_, index) => ({ id: `a${index}`, type: 'text', content: 'result' })),
    } as any

    expect(estimateVirtualMessageSize(user)).toBeLessThan(estimateVirtualMessageSize(assistant))
  })

  it('finds the active question with logarithmic offset lookups', () => {
    const markers: VirtualMarkerRow[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `question-${index}`,
      rowIndex: index * 2,
    }))
    const offsetForRow = vi.fn((rowIndex: number) => rowIndex * 100)

    expect(activeVirtualMarkerId(markers, 123_450, offsetForRow)).toBe('question-617')
    expect(offsetForRow.mock.calls.length).toBeLessThanOrEqual(11)
  })

  it('returns the first marker before its measured start and handles empty input', () => {
    const markers = [{ id: 'first', rowIndex: 4 }]
    expect(activeVirtualMarkerId(markers, 0, () => 400)).toBe('first')
    expect(activeVirtualMarkerId([], 0, () => 0)).toBe('')
  })
})

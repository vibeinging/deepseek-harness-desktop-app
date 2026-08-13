import type { AgentMessage as Msg } from '../stream/types'

export const VIRTUAL_MESSAGE_OVERSCAN = 6
export const VIRTUAL_MESSAGE_PADDING_START = 30
export const VIRTUAL_MESSAGE_PADDING_END = 40

export interface VirtualMarkerRow {
  id: string
  rowIndex: number
}

export function estimateVirtualMessageSize(message: Msg | undefined) {
  if (!message) return 160
  const blockCount = Math.max(1, message.blocks.length)
  if (message.role === 'user') return Math.min(360, 72 + blockCount * 24)
  return Math.min(720, 132 + blockCount * 44)
}

export function activeVirtualMarkerId(
  markers: VirtualMarkerRow[],
  probeOffset: number,
  offsetForRow: (rowIndex: number) => number | null,
) {
  if (markers.length === 0) return ''

  let low = 0
  let high = markers.length - 1
  let activeIndex = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const offset = offsetForRow(markers[middle].rowIndex)
    if (offset === null || offset > probeOffset) {
      high = middle - 1
    } else {
      activeIndex = middle
      low = middle + 1
    }
  }
  return markers[activeIndex].id
}

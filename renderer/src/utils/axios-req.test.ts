import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const show = vi.fn()
const apiRequest = vi.fn()

vi.mock('@mantine/notifications', () => ({ notifications: { show } }))
vi.mock('@/store/basic', () => ({
  useBasicStore: {
    getState: () => ({
      axiosPromiseArr: [],
      remotePromiseArrByReqUrl: vi.fn()
    })
  }
}))
vi.mock('@/store/config', () => ({
  useConfigStore: { getState: () => ({ language: 'zh' }) }
}))
vi.mock('@/lang', () => ({ default: { t: (key: string) => key } }))

describe('Electron request error handling', () => {
  beforeEach(() => {
    show.mockClear()
    apiRequest.mockReset()
    vi.stubGlobal('window', {
      electronAPI: { apiRequest },
      location: { origin: 'http://localhost' }
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('keeps ignoreMsg requests silent when Electron IPC rejects', async () => {
    apiRequest.mockRejectedValueOnce(new Error('本地请求超时(4000ms)'))
    const { default: axiosReq } = await import('./axios-req')

    await expect(axiosReq({
      url: '/api/projects/project-one/plugins',
      method: 'get',
      timeout: 4_000,
      ignoreMsg: true
    })).rejects.toMatchObject({
      message: '本地请求超时(4000ms)',
      config: expect.objectContaining({ ignoreMsg: true, timeout: 4_000 })
    })
    expect(show).not.toHaveBeenCalled()
  })

  it('still reports ordinary Electron IPC failures', async () => {
    apiRequest.mockRejectedValueOnce(new Error('本地服务不可用'))
    const { default: axiosReq } = await import('./axios-req')

    await expect(axiosReq({ url: '/api/health', method: 'get' })).rejects.toThrow('本地服务不可用')
    expect(show).toHaveBeenCalledTimes(1)
  })
})

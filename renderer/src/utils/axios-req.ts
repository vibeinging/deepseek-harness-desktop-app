import axios, { AxiosError, type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { notifications } from '@mantine/notifications'
import { useBasicStore } from '@/store/basic'
import { useConfigStore } from '@/store/config'
import i18n from '@/lang'

/** Show a uniform business error toast (replaces Element Plus ElMessage.error). */
const errorToast = (message: string) => {
  notifications.show({ color: 'red', message, autoClose: 2000 })
}

// Extended config: keep original semantics of ignoreCode / ignoreMsg / isNotTipErrorMsg.
export interface ReqConfig extends AxiosRequestConfig {
  ignoreCode?: number | number[]
  ignoreMsg?: boolean
  isNotTipErrorMsg?: boolean
  /** Business flag: skip global loading overlay (kept for compatibility). */
  ignoreLoading?: boolean
}

const service = axios.create()
let tempReqUrlSave = ''

// ── Electron: route requests through ipc (main process forwards to local backend), so renderer does not call HTTP directly.──
// JSON / FormData uploads and blob downloads all go through ipc; SSE uses subscribeStream(api-stream.ts). Browser without electronAPI falls back to xhr.
const _xhrAdapter = (config: any) => (axios as any).getAdapter('xhr')(config)
function _ipcPath(config: any): string {
  let url = config.url || ''
  try { if (/^https?:\/\//i.test(url)) { const u = new URL(url); url = u.pathname + u.search } } catch { /* keep */ }
  const p = config.params
  if (p && typeof p === 'object') {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(p)) if (v !== undefined && v !== null) qs.append(k, String(v))
    const s = qs.toString()
    if (s) url += (url.includes('?') ? '&' : '?') + s
  }
  return url
}
function _flatHeaders(h: any): Record<string, string> {
  const out: Record<string, string> = {}
  const src = h && typeof h.toJSON === 'function' ? h.toJSON() : h || {}
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null || typeof v === 'object') continue
    out[k] = String(v)
  }
  return out
}
// Bytes <-> base64 conversion (chunking avoids String.fromCharCode stack overflow; optimized for ipc transport).
function _b64FromBytes(bytes: Uint8Array): string {
  let bin = ''
  const CH = 0x8000
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH) as unknown as number[])
  return btoa(bin)
}
function _bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
function _arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  return ab
}
const ipcAdapter = async (config: any) => {
  const ea = (window as any).electronAPI
  if (!ea?.apiRequest) return _xhrAdapter(config) // Browser: native xhr.
  const isForm = typeof FormData !== 'undefined' && config.data instanceof FormData
  const wantBlob = config.responseType === 'blob'
  const wantArrayBuffer = config.responseType === 'arraybuffer'

  let body: string | null = null
  let bodyEncoding: string | undefined
  const headers = _flatHeaders(config.headers)
  if (isForm) {
    // FormData -> real multipart bytes via browser Request encoding, preserving boundary content-type in base64 transfer.
    const enc = new Request('http://x', { method: 'POST', body: config.data })
    const ab = await enc.arrayBuffer()
    body = _b64FromBytes(new Uint8Array(ab))
    bodyEncoding = 'base64'
    delete headers['Content-Type']
    delete headers['content-type']
    const ct = enc.headers.get('content-type')
    if (ct) headers['Content-Type'] = ct
  } else {
    body = config.data == null ? null : typeof config.data === 'string' ? config.data : JSON.stringify(config.data)
    if (body != null && !headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json'
  }

  let r: any
  try {
    r = await ea.apiRequest({
      method: (config.method || 'get').toUpperCase(),
      url: _ipcPath(config),
      headers,
      body,
      bodyEncoding,
      timeoutMs: Number.isFinite(Number(config.timeout)) && Number(config.timeout) > 0
        ? Number(config.timeout)
        : undefined
    })
  } catch (error: any) {
    const cause = error instanceof Error ? error : new Error(String(error || '本地请求失败'))
    throw AxiosError.from(cause, error?.code || AxiosError.ERR_NETWORK, config)
  }

  let data: any
  if (r.bodyB64 !== undefined) {
    const bytes = _bytesFromB64(r.bodyB64)
    const ab = _arrayBufferFromBytes(bytes)
    data = wantBlob ? new Blob([ab], { type: String((r.headers && r.headers['content-type']) || '') })
      : wantArrayBuffer ? ab : bytes
  } else {
    data = r.json !== undefined ? r.json : r.body
  }
  const response: any = {
    data,
    status: r.status,
    statusText: r.statusText || '',
    headers: r.headers || {},
    config,
    request: {},
  }
  if (!config.validateStatus || config.validateStatus(r.status)) return response
  throw new AxiosError(
    `Request failed with status code ${r.status}`,
    r.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
    config,
    {},
    response,
  )
}
// Axios reads defaults.adapter (not instance.adapter), so it must be set on defaults to take effect.
service.defaults.adapter = ipcAdapter
// Global fallback: bare axios direct calls (axios.get/post bypassing service) also go through ipc for download/upload.
axios.defaults.adapter = ipcAdapter

service.interceptors.request.use(
  (req) => {
    const basicStore = useBasicStore.getState()
    req.cancelToken = new axios.CancelToken((cancel) => {
      tempReqUrlSave = req.url || ''
      basicStore.axiosPromiseArr.push({ url: req.url, cancel })
    })

    const configStore = useConfigStore.getState()
    const langMap: Record<string, string> = { zh: 'zh-CN', en: 'en-US' }
    req.headers['Accept-Language'] = langMap[configStore.language] || 'zh-CN'

    if ('get'.includes((req.method || '').toLowerCase()) && !req.params) req.params = req.data
    return req
  },
  (err) => Promise.reject(err)
)

service.interceptors.response.use(
  (res: AxiosResponse) => {
    useBasicStore.getState().remotePromiseArrByReqUrl(tempReqUrlSave)
    if (res.config.responseType === 'blob' || res.config.responseType === 'arraybuffer') {
      return res.data as any
    }
    const { success, message, msg } = res.data || {}
    const config = res.config as ReqConfig

    if (success === true) return res.data as any

    if (
      config.ignoreCode &&
      ((Array.isArray(config.ignoreCode) && config.ignoreCode.includes(res.data.code)) || config.ignoreCode === res.data.code)
    ) {
      return res.data as any
    }

    if (!config.ignoreMsg && !config.isNotTipErrorMsg) {
      errorToast(message || msg || i18n.t('common.http.requestFailed'))
    }
    return Promise.reject(res.data)
  },
  (err) => {
    useBasicStore.getState().remotePromiseArrByReqUrl(tempReqUrlSave)
    const status = err.response?.status
    const errorMessage = err.response?.data?.message || err.response?.data?.msg || err.message
    const config = (err.config || {}) as ReqConfig

    const tip = (key: string) => {
      if (!config.ignoreMsg && !config.isNotTipErrorMsg) errorToast(errorMessage || i18n.t(key))
      return Promise.reject(err)
    }

    if (status === 401) return tip('common.http.clientError')
    if (status === 403) return tip('common.http.forbidden')
    if (status === 404) return tip('common.http.notFound')
    if (status === 422) return tip('common.http.serverError')
    if (status === 400) return tip('common.http.badRequest')
    if (status >= 400 && status < 500) return tip('common.http.clientError')
    if (status >= 500) return tip('common.http.internalError')

    if (!err.response) {
      if (!config.ignoreMsg && !config.isNotTipErrorMsg) {
        errorToast(i18n.t('common.http.networkError'))
      }
      return Promise.reject(err)
    }

    if (!config.ignoreMsg) {
      errorToast(errorMessage || i18n.t('common.http.requestFailed'))
    }
    return Promise.reject(err.message || err)
  }
)

// Return Promise<any>: the response interceptor has already unwrapped AxiosResponse to business envelope ({success,data,message,...}),
// callers read res.success/res.data directly, so exported type is any to avoid widespread `as any` casts.
export default function axiosReq(config: ReqConfig): Promise<any> {
  return service({
    baseURL: import.meta.env.VITE_APP_BASE_URL || window.location.origin || '',
    timeout: 0,
    ...config
  }) as unknown as Promise<any>
}

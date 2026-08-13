// Electron: route SSE streaming through ipc (main process pulls from local backend and streams chunks back),
// returning a Response shape same as fetch.
// Browser (without electronAPI) falls back to native fetch. The Response body is backed by
// a ReadableStream fed by ipc chunks, so resp.ok / resp.status / resp.body.getReader() / resp.json() all work unchanged.

function ipcPath(u: string): string {
  try {
    if (/^https?:\/\//i.test(u)) {
      const x = new URL(u)
      return x.pathname + x.search
    }
  } catch {
    /* keep raw */
  }
  return u
}

function flatHeaders(h: any): Record<string, string> {
  const out: Record<string, string> = {}
  if (!h) return out
  if (typeof h.forEach === 'function' && typeof h.get === 'function') {
    // Headers object instance
    h.forEach((v: string, k: string) => {
      out[k] = v
    })
    return out
  }
  for (const [k, v] of Object.entries(h)) if (v !== null && v !== undefined && typeof v !== 'object') out[k] = String(v)
  return out
}

export function apiStreamFetch(url: string, opts: any = {}): Promise<Response> {
  const ea = (window as any).electronAPI
  if (!ea?.streamStart) return fetch(url, opts)
  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array>
    let headSeen = false
    let dispose: (() => void) | null = null
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
      cancel() {
        dispose?.()
      },
    })
    dispose = ea.streamStart(
      {
        url: ipcPath(url),
        method: (opts.method || 'GET').toUpperCase(),
        headers: flatHeaders(opts.headers),
        body: opts.body ?? null,
      },
      (msg: any) => {
        if (msg.type === 'head') {
          headSeen = true
          const headers = new Headers()
          for (const [k, v] of Object.entries(msg.headers || {})) {
            try {
              headers.set(k, String(v))
            } catch {
      /* Skip invalid header. */
            }
          }
          const noBody = msg.status === 204 || msg.status === 304
          resolve(new Response(noBody ? null : stream, { status: msg.status || 200, statusText: msg.statusText || '', headers }))
        } else if (msg.type === 'data') {
          try {
            // Binary chunks are sent as base64 for blob download and decoded to bytes;
            // text chunks (SSE/JSON/CSV) are utf-8 decoded.
            const bytes = msg.b64 ? Uint8Array.from(atob(msg.chunk), (c) => c.charCodeAt(0)) : enc.encode(msg.chunk)
            controller.enqueue(bytes)
          } catch {
              /* Stream already closed. */
          }
        } else if (msg.type === 'end') {
          try {
            controller.close()
          } catch {
            /* Stream already closed. */
          }
        } else if (msg.type === 'error') {
          if (!headSeen) reject(new Error(msg.error || 'stream error'))
          else {
            try {
              controller.error(new Error(msg.error || 'stream error'))
            } catch {
            /* Stream already closed. */
            }
          }
        }
      }
    )
    const sig: AbortSignal | undefined = opts.signal
    if (sig) {
      const onAbort = () => {
        dispose?.()
        try {
          controller.error(new DOMException('Aborted', 'AbortError'))
        } catch {
          /* Stream already closed. */
        }
      }
      if (sig.aborted) onAbort()
      else sig.addEventListener('abort', onAbort, { once: true })
    }
  })
}

// ── subscribeStream: line-based stream subscription (replaces per-consumer fetch + getReader boilerplate)──
// Centralize transport (Electron→ipc direct / browser→fetch), decoding, buffering, and line splitting by \n.
// ipc stream no longer round-trips through Response/ReadableStream/codec conversion (removes duplicate layer).
// Each consumer keeps custom SSE protocol parsing (data:/id:/: / [DONE]) in onLine.
// resolve on stream end; reject on non-2xx head, transport error, or abort via req.signal.

export interface StreamReq {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: any
  signal?: AbortSignal
}

function httpErr(status: number): Error {
  return Object.assign(new Error(`请求失败 (${status})`), { status })
}
function abortErr(): Error {
  try {
    return new DOMException('Aborted', 'AbortError')
  } catch {
    return Object.assign(new Error('Aborted'), { name: 'AbortError' })
  }
}
function makeFeeder(onLine: (line: string) => void) {
  let buf = ''
  return {
    feed(chunk: string) {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const ln of lines) onLine(ln)
    },
    flush() {
      if (buf) {
        onLine(buf)
        buf = ''
      }
    },
  }
}

export function subscribeStream(req: StreamReq, onLine: (line: string) => void): Promise<void> {
  const ea = (window as any).electronAPI
  return ea?.streamStart ? ipcSubscribe(req, onLine, ea) : fetchSubscribe(req, onLine)
}

function ipcSubscribe(req: StreamReq, onLine: (line: string) => void, ea: any): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { feed, flush } = makeFeeder(onLine)
    let dispose: (() => void) | null = null
    let settled = false
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true
        fn()
      }
    }
    dispose = ea.streamStart(
      { url: ipcPath(req.url), method: (req.method || 'GET').toUpperCase(), headers: req.headers || {}, body: req.body ?? null },
      (msg: any) => {
        if (msg.type === 'head') {
          if (msg.status < 200 || msg.status >= 300) {
            dispose?.()
            settle(() => reject(httpErr(msg.status)))
          }
        } else if (msg.type === 'data') feed(msg.chunk)
        else if (msg.type === 'end') {
          flush()
          settle(resolve)
        } else if (msg.type === 'error') settle(() => reject(new Error(msg.error || 'stream error')))
      }
    )
    const sig = req.signal
    if (sig) {
      const onAbort = () => {
        dispose?.()
        settle(() => reject(abortErr()))
      }
      if (sig.aborted) onAbort()
      else sig.addEventListener('abort', onAbort, { once: true })
    }
  })
}

async function fetchSubscribe(req: StreamReq, onLine: (line: string) => void): Promise<void> {
  const resp = await fetch(req.url, { method: req.method || 'GET', headers: req.headers, body: req.body, signal: req.signal })
  if (!resp.ok) throw httpErr(resp.status)
  if (!resp.body) return
  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  const { feed, flush } = makeFeeder(onLine)
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    feed(decoder.decode(value, { stream: true }))
  }
  flush()
}

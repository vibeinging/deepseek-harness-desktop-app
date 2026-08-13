import axiosReq from '@/utils/axios-req'
import { subscribeStream } from '@/utils/api-stream'
import { createAPIURL } from '@/utils/url-helper'

export interface DshModelEntry {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>
    defaultEffort?: string
  }
  contextWindow?: number
  maxTokens?: number
}

export interface DshModelGroup {
  id: string
  name: string
  models: DshModelEntry[]
}

export interface DshProviderEntry {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
  active: boolean
}

export interface DshSettingsNamespace {
  ns: string
  schema: unknown
  value: unknown
  base?: unknown
  user?: unknown
  applies: 'live' | 'restart'
  secrets: Array<{ path: string[]; set: boolean }>
  revision: number
}

export interface DshCredentialState {
  configured: boolean
  source?: string
  writable: boolean
}

export interface DshModelSettingsSnapshot {
  providers: DshProviderEntry[]
  groups: DshModelGroup[]
  failures: Array<{ id: string; name: string; message: string }>
  writable: boolean
  has_document: boolean
  namespaces: DshSettingsNamespace[]
  credentials: Record<string, DshCredentialState>
  credential_error?: string | null
}

export type DshModelSettingsEventType =
  | 'dsh_models.ready'
  | 'dsh_models.changed'
  | 'dsh_models.heartbeat'

export interface DshModelSettingsEvent {
  type: DshModelSettingsEventType
  payload: {
    event_id: string | null
    server_instance_id: string | null
    seq: number | null
    reason: string | null
    ns: string | null
    ref: string | null
    at: string | null
  }
}

const DSH_MODEL_SETTINGS_EVENT_TYPES = new Set<DshModelSettingsEventType>([
  'dsh_models.ready',
  'dsh_models.changed',
  'dsh_models.heartbeat'
])

const optionalText = (value: unknown) => {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || null
}

export function parseDshModelSettingsEvent(line: string): DshModelSettingsEvent | null {
  if (!line.startsWith('data:')) return null
  const data = line.slice(5).trim()
  if (!data || data === '[DONE]') return null
  try {
    const parsed = JSON.parse(data)
    const type = String(parsed?.type || '') as DshModelSettingsEventType
    if (!DSH_MODEL_SETTINGS_EVENT_TYPES.has(type)) return null
    const payload = parsed?.payload && typeof parsed.payload === 'object' ? parsed.payload : {}
    const rawSeq = payload.seq
    return {
      type,
      payload: {
        event_id: optionalText(payload.event_id),
        server_instance_id: optionalText(payload.server_instance_id),
        seq: rawSeq == null || !Number.isFinite(Number(rawSeq)) ? null : Number(rawSeq),
        reason: optionalText(payload.reason),
        ns: optionalText(payload.ns),
        ref: optionalText(payload.ref),
        at: optionalText(payload.at)
      }
    }
  } catch {
    return null
  }
}

export function subscribeDshModelSettingsEvents(
  onEvent: (event: DshModelSettingsEvent) => void,
  signal?: AbortSignal
) {
  return subscribeStream({
    url: createAPIURL('/api/dsh/models/events'),
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
    signal
  }, (line) => {
    const event = parseDshModelSettingsEvent(line)
    if (event) onEvent(event)
  })
}

export type DshSettingsOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

export const getDshModelSettingsReq = () => axiosReq({
  url: '/api/dsh/models',
  method: 'get'
})

export const mutateDshModelSettingsReq = (
  ns: string,
  ops: DshSettingsOp[],
  expectedRevision?: number
) => axiosReq({
  url: '/api/dsh/models/settings/mutate',
  method: 'post',
  data: { ns, ops, expected_revision: expectedRevision }
})

export const setDshModelCredentialReq = (ref: string, value: string) => axiosReq({
  url: '/api/dsh/models/credentials',
  method: 'post',
  data: { ref, value }
})

export const unsetDshModelCredentialReq = (ref: string) => axiosReq({
  url: `/api/dsh/models/credentials/${encodeURIComponent(ref)}`,
  method: 'delete'
})

export const discoverDshModelsReq = (input: {
  settingsNs: string
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
}) => axiosReq({
  url: '/api/dsh/models/discover',
  method: 'post',
  data: {
    settings_ns: input.settingsNs,
    provider: input.provider,
    base_url: input.baseURL,
    api: input.api,
    api_key: input.apiKey
  }
})

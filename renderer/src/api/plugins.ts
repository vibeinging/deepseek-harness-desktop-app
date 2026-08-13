import axiosReq from '@/utils/axios-req'
import { subscribeStream } from '@/utils/api-stream'
import { createAPIURL } from '@/utils/url-helper'

export type PluginCatalogEventType =
  | 'plugin_catalog.ready'
  | 'plugin_catalog.changed'
  | 'plugin_catalog.heartbeat'

export interface PluginCatalogEvent {
  type: PluginCatalogEventType
  payload: {
    event_id: string | null
    server_instance_id: string | null
    seq: number | null
    reason: string | null
    canonical_plugin_id: string | null
    project_ids: string[] | null
    at: string | null
  }
}

const PLUGIN_CATALOG_EVENT_TYPES = new Set<PluginCatalogEventType>([
  'plugin_catalog.ready',
  'plugin_catalog.changed',
  'plugin_catalog.heartbeat'
])

const optionalText = (value: unknown) => {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return normalized || null
}

export function parsePluginCatalogEvent(line: string): PluginCatalogEvent | null {
  if (!line.startsWith('data:')) return null
  const data = line.slice(5).trim()
  if (!data || data === '[DONE]') return null
  try {
    const parsed = JSON.parse(data)
    const type = String(parsed?.type || '') as PluginCatalogEventType
    if (!PLUGIN_CATALOG_EVENT_TYPES.has(type)) return null
    const payload = parsed?.payload && typeof parsed.payload === 'object' ? parsed.payload : {}
    const rawSeq = payload.seq
    const projectIds: string[] | null = payload.project_ids == null
      ? null
      : Array.isArray(payload.project_ids)
        ? [...new Set<string>((payload.project_ids as unknown[])
          .map(optionalText)
          .filter((item): item is string => Boolean(item)))]
        : null
    return {
      type,
      payload: {
        event_id: optionalText(payload.event_id),
        server_instance_id: optionalText(payload.server_instance_id),
        seq: rawSeq == null || !Number.isFinite(Number(rawSeq)) ? null : Number(rawSeq),
        reason: optionalText(payload.reason),
        canonical_plugin_id: optionalText(payload.canonical_plugin_id),
        project_ids: projectIds,
        at: optionalText(payload.at)
      }
    }
  } catch {
    return null
  }
}

export function subscribePluginCatalogEvents(
  onEvent: (event: PluginCatalogEvent) => void,
  signal?: AbortSignal
) {
  return subscribeStream({
    url: createAPIURL('/api/agent/plugin-catalog/events'),
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
    signal
  }, (line) => {
    const event = parsePluginCatalogEvent(line)
    if (event) onEvent(event)
  })
}

export function listPluginCatalogReq(refresh = false) {
  return axiosReq({
    url: '/api/agent/plugins',
    method: 'get',
    params: refresh ? { refresh: 1 } : undefined
  })
}

export function getPluginDetailReq(pluginId: string) {
  return axiosReq({
    url: `/api/agent/plugins/${encodeURIComponent(pluginId)}`,
    method: 'get'
  })
}

export function uninstallProfileBundleReq(pluginId: string) {
  return axiosReq({
    url: `/api/agent/profile-bundles/${encodeURIComponent(pluginId)}`,
    method: 'delete'
  })
}

export function installProfileBundleReq(source: string) {
  return axiosReq({
    url: '/api/agent/profile-bundles',
    method: 'post',
    data: { source }
  })
}

export function preflightProfileBundleReq(source: string) {
  return axiosReq({
    url: '/api/agent/profile-bundles/preflight',
    method: 'post',
    data: { source },
    ignoreMsg: true
  })
}

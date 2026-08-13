export const EVIDENCE_STATUS_COPY: Record<string, { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  verified: { label: '已验证', tone: 'ok' },
  evidence_available: { label: '有执行依据', tone: 'neutral' },
  needs_attention: { label: '有待确认项', tone: 'warn' },
  unverified: { label: '未验证', tone: 'warn' }
}

export function evidenceStatusCopy(status?: string | null) {
  return EVIDENCE_STATUS_COPY[String(status || '')] || EVIDENCE_STATUS_COPY.evidence_available
}

function signed(value: number) {
  return value > 0 ? `+${value}` : String(value)
}

export function evidenceRerunCopy(comparison?: any) {
  if (!comparison?.summary) return null
  if (comparison.summary.identical) {
    return { tone: 'ok' as const, title: '复跑一致', detail: '数据、Schema 和检查均未变化' }
  }
  const details: string[] = []
  const rowDelta = (comparison.queries || []).reduce(
    (total: number, query: any) => total + Number(query?.row_count?.delta || 0),
    0
  )
  if (rowDelta) details.push(`行数 ${signed(rowDelta)}`)
  const changedNumeric = (comparison.queries || []).flatMap((query: any) =>
    Object.entries(query?.numeric_summary || {})
      .filter(([, item]: any) => item?.changed && item?.sum_delta != null)
      .slice(0, 2)
      .map(([column, item]: any) => `${column} 合计 ${signed(Number(item.sum_delta))}`)
  )
  details.push(...changedNumeric.slice(0, 2))
  if (comparison.summary.schema_changed) details.push('Schema 已变化')
  if (comparison.summary.changed_validation_count) details.push('检查结果已变化')
  if (!details.length && comparison.summary.data_changed) details.push('数据内容已变化')
  return { tone: 'warn' as const, title: '发现变化', detail: details.join(' · ') || '证据快照与上次不同' }
}

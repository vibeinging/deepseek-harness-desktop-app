/**
 * Chart type registry.
 *
 * Add one entry in CHART_TYPES to register a new chart type.
 * PanelCard / useContentBlock / PanelEditor will auto-recognize it.
 *
 * Each entry contains:
 *  - id:           Unique id (maps to display_type)
 *  - label:        Display name
 *  - group:        Group (basic / extended / other)
 *  - needsAxis:    Whether XY axis config is needed
 *  - buildOption:  (ctx) => function that builds ECharts option
 */

// ============ Palette and helper functions ============

export const iosColors = [
  '#007AFF', '#34C759', '#FF9500', '#FF2D55', '#5856D6',
  '#00C7BE', '#FF3B30', '#FFCC00', '#AF52DE', '#30D158',
  '#5AC8FA', '#4CD964', '#FF6B6B', '#C644FC', '#2ED573',
  '#FFA502', '#FF4757', '#7BED9F', '#70A1FF', '#ECCC68',
  '#A29BFE', '#FD79A8', '#00CEC9', '#E17055', '#6C5CE7'
]

export const getColorOffset = (panelId?: string) => {
  if (!panelId) return Math.floor(Math.random() * iosColors.length)
  let hash = 5381
  for (let i = 0; i < panelId.length; i++) {
    hash = ((hash << 5) + hash) ^ panelId.charCodeAt(i)
  }
  return Math.abs(hash) % iosColors.length
}

export const getColors = (panelId?: string) => {
  const offset = getColorOffset(panelId)
  return iosColors.slice(offset).concat(iosColors.slice(0, offset))
}

const adjustColorBrightness = (hex: string, percent: number) => {
  const num = parseInt(hex.replace('#', ''), 16)
  const amt = Math.round(2.55 * percent)
  const R = Math.min(255, (num >> 16) + amt)
  const G = Math.min(255, ((num >> 8) & 0x00ff) + amt)
  const B = Math.min(255, (num & 0x0000ff) + amt)
  return `#${(1 << 24 | R << 16 | G << 8 | B).toString(16).slice(1)}`
}

export const createGradient = (color: string, direction = 'vertical') => {
  const lighterColor = adjustColorBrightness(color, 30)
  if (direction === 'vertical') {
    return {
      type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
      colorStops: [{ offset: 0, color: lighterColor }, { offset: 1, color }]
    }
  }
  return {
    type: 'linear', x: 0, y: 0, x2: 1, y2: 0,
    colorStops: [{ offset: 0, color }, { offset: 1, color: lighterColor }]
  }
}

// iOS-style base option
export const iosBaseOption: any = {
  backgroundColor: 'transparent',
  textStyle: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", Arial, sans-serif',
    color: '#1D1D1F'
  },
  tooltip: {
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    borderColor: 'rgba(0, 0, 0, 0.08)',
    borderWidth: 1,
    borderRadius: 12,
    shadowBlur: 20,
    shadowColor: 'rgba(0, 0, 0, 0.15)',
    shadowOffsetY: 8,
    padding: [12, 16],
    textStyle: {
      color: '#1D1D1F',
      fontSize: 13,
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
    },
    extraCssText: 'backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);'
  },
  legend: {
    icon: 'circle',
    itemWidth: 8,
    itemHeight: 8,
    itemGap: 16,
    textStyle: {
      color: '#86868B',
      fontSize: 12,
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
    }
  },
  xAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: {
      color: '#86868B',
      fontSize: 11,
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
    },
    splitLine: { show: false }
  },
  yAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: {
      color: '#86868B',
      fontSize: 11,
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
    },
    splitLine: {
      lineStyle: { color: 'rgba(0, 0, 0, 0.06)', type: 'dashed' }
    }
  }
}

// ============ buildOption context ============
// ctx = { data, x_axis_field, y_axis_fields, title, colors, group_field? }

const makeTitleOption = (title?: string) =>
  title
    ? { text: title, left: 'center', top: 10, textStyle: { fontSize: 14, fontWeight: 500, color: '#1D1D1F' } }
    : undefined

/**
 * Pivot flat data into multiple series by group_field.
 */
const pivotByGroup = (data: any[], xField: string, yField: string, groupField: string) => {
  const xValues = [...new Set(data.map((r) => r[xField]))]
  const seriesNames = [...new Set(data.map((r) => r[groupField]))]
  const lookup = new Map<any, Map<any, any>>()
  for (const row of data) {
    const xKey = row[xField]
    if (!lookup.has(xKey)) lookup.set(xKey, new Map())
    lookup.get(xKey)!.set(row[groupField], row[yField] ?? 0)
  }
  const seriesMap: Record<string, any[]> = {}
  for (const name of seriesNames) {
    seriesMap[name] = xValues.map((x) => lookup.get(x)?.get(name) ?? 0)
  }
  return { xValues, seriesNames, seriesMap }
}

const _isIdLike = (col: string) => {
  const lower = col.toLowerCase().trim()
  return lower === 'id' || lower === 'pk' || lower === 'index' || lower.endsWith('_id')
}

/**
 * Auto-detect group_field on frontend as fallback when backend does not set it.
 */
const autoDetectGroupField = (data: any[], xField: string, yFields: string[]) => {
  if (!data.length || yFields.length !== 1) return null
  const xUnique = new Set(data.map((r) => r[xField])).size
  if (data.length <= xUnique) return null
  const row = data[0]
  return (
    Object.keys(row).find(
      (k) => k !== xField && !yFields.includes(k) && typeof row[k] !== 'number' && !_isIdLike(k)
    ) || null
  )
}

// ============ Shared XY axis chart builder ============

const buildAxisChart = (
  ctx: any,
  { baseType, isHorizontal = false, isStacked = false, showArea = false }: any
) => {
  const { data, x_axis_field, y_axis_fields, title, colors, group_field } = ctx

  const effectiveGroup = isStacked
    ? group_field || autoDetectGroupField(data, x_axis_field, y_axis_fields)
    : null

  let xAxisData: any[], series: any[], legendNames: any[]

  if (effectiveGroup && y_axis_fields.length === 1) {
    const yField = y_axis_fields[0]
    const pivoted = pivotByGroup(data, x_axis_field, yField, effectiveGroup)
    xAxisData = pivoted.xValues
    legendNames = pivoted.seriesNames
    series = pivoted.seriesNames.map((name: any, index: number) => ({
      name,
      type: baseType,
      data: pivoted.seriesMap[name],
      stack: isStacked ? 'total' : undefined,
      itemStyle: {
        color: createGradient(colors[index % colors.length], isHorizontal ? 'horizontal' : 'vertical'),
        borderRadius: baseType === 'bar' ? (isHorizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0
      },
      smooth: baseType === 'line',
      symbol: baseType === 'line' ? 'circle' : 'none',
      symbolSize: 6,
      lineStyle: baseType === 'line' ? { width: 2 } : undefined,
      areaStyle: showArea
        ? {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: colors[index % colors.length] + '40' },
                { offset: 1, color: colors[index % colors.length] + '05' }
              ]
            }
          }
        : undefined
    }))
  } else {
    xAxisData = data.map((item: any) => item[x_axis_field] || '')
    legendNames = y_axis_fields
    series = (y_axis_fields || []).map((field: any, index: number) => ({
      name: field,
      type: baseType,
      data: data.map((item: any) => item[field] ?? 0),
      stack: isStacked ? 'total' : undefined,
      itemStyle: {
        color: createGradient(colors[index % colors.length], isHorizontal ? 'horizontal' : 'vertical'),
        borderRadius: baseType === 'bar' ? (isHorizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]) : 0
      },
      smooth: baseType === 'line',
      symbol: baseType === 'line' ? 'circle' : 'none',
      symbolSize: 6,
      lineStyle: baseType === 'line' ? { width: 2 } : undefined,
      areaStyle: showArea
        ? {
            color: {
              type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: colors[index % colors.length] + '40' },
                { offset: 1, color: colors[index % colors.length] + '05' }
              ]
            }
          }
        : undefined
    }))
  }

  const categoryAxis = {
    ...iosBaseOption.xAxis,
    type: 'category',
    data: xAxisData,
    axisLabel: {
      ...iosBaseOption.xAxis.axisLabel,
      rotate: !isHorizontal && xAxisData.length > 5 ? 30 : 0,
      interval: 0
    }
  }
  const valueAxis = { ...iosBaseOption.yAxis, type: 'value' }
  const hasLegend = legendNames && legendNames.length > 1

  return {
    ...iosBaseOption,
    title: makeTitleOption(title),
    tooltip: { ...iosBaseOption.tooltip, trigger: 'axis' },
    legend: hasLegend ? { ...iosBaseOption.legend, bottom: 10, data: legendNames } : undefined,
    grid: { left: isHorizontal ? 100 : 60, right: 20, top: title ? 50 : 30, bottom: hasLegend ? 50 : 30 },
    xAxis: isHorizontal ? valueAxis : categoryAxis,
    yAxis: isHorizontal ? categoryAxis : valueAxis,
    series
  }
}

// ============ Chart type definitions ============

const CHART_TYPES: any[] = [
  // ---- Basic charts ----
  { id: 'bar', label: '柱状图', group: 'basic', needsAxis: true, buildOption: (ctx: any) => buildAxisChart(ctx, { baseType: 'bar' }) },
  { id: 'line', label: '折线图', group: 'basic', needsAxis: true, buildOption: (ctx: any) => buildAxisChart(ctx, { baseType: 'line' }) },
  {
    id: 'pie', label: '饼图', group: 'basic', needsAxis: false,
    buildOption: (ctx: any) => {
      const { data, x_axis_field, y_axis_fields, title, colors } = ctx
      const field = y_axis_fields[0]
      return {
        ...iosBaseOption,
        title: makeTitleOption(title),
        tooltip: { ...iosBaseOption.tooltip, trigger: 'item' },
        series: [{
          type: 'pie', radius: ['40%', '70%'], center: ['50%', '55%'],
          itemStyle: { borderRadius: 8, borderColor: '#fff', borderWidth: 2 },
          label: { show: true, formatter: '{b}: {d}%' },
          data: data.map((item: any, i: number) => ({
            name: item[x_axis_field] || `项目${i + 1}`,
            value: item[field] ?? 0,
            itemStyle: { color: colors[i % colors.length] }
          }))
        }]
      }
    }
  },

  // ---- Extended charts ----
  { id: 'stacked_bar', label: '堆叠柱状图', group: 'extended', needsAxis: true, buildOption: (ctx: any) => buildAxisChart(ctx, { baseType: 'bar', isStacked: true }) },
  { id: 'horizontal_bar', label: '横向柱状图', group: 'extended', needsAxis: true, buildOption: (ctx: any) => buildAxisChart(ctx, { baseType: 'bar', isHorizontal: true }) },
  { id: 'area', label: '面积图', group: 'extended', needsAxis: true, buildOption: (ctx: any) => buildAxisChart(ctx, { baseType: 'line', showArea: true }) },
  { id: 'stacked_line', label: '堆叠面积图', group: 'extended', needsAxis: true, buildOption: (ctx: any) => buildAxisChart(ctx, { baseType: 'line', isStacked: true, showArea: true }) },
  {
    id: 'rose', label: '玫瑰图', group: 'extended', needsAxis: false,
    buildOption: (ctx: any) => {
      const { data, x_axis_field, y_axis_fields, title, colors } = ctx
      const field = y_axis_fields[0]
      return {
        ...iosBaseOption,
        title: makeTitleOption(title),
        tooltip: { ...iosBaseOption.tooltip, trigger: 'item' },
        series: [{
          type: 'pie', radius: ['20%', '70%'], center: ['50%', '55%'], roseType: 'area',
          itemStyle: { borderRadius: 8, borderColor: '#fff', borderWidth: 2 },
          label: { show: true, formatter: '{b}: {d}%' },
          data: data.map((item: any, i: number) => ({
            name: item[x_axis_field] || `项目${i + 1}`,
            value: item[field] ?? 0,
            itemStyle: { color: colors[i % colors.length] }
          }))
        }]
      }
    }
  },
  {
    id: 'scatter', label: '散点图', group: 'extended', needsAxis: true,
    buildOption: (ctx: any) => {
      const { data, x_axis_field, y_axis_fields, title, colors } = ctx
      const series = (y_axis_fields || []).map((field: any, index: number) => ({
        name: field, type: 'scatter',
        data: data.map((item: any) => [item[x_axis_field], item[field] ?? 0]),
        symbolSize: 10, itemStyle: { color: colors[index % colors.length] }
      }))
      const hasLegend = y_axis_fields && y_axis_fields.length > 1
      return {
        ...iosBaseOption,
        title: makeTitleOption(title),
        tooltip: { ...iosBaseOption.tooltip, trigger: 'item' },
        legend: hasLegend ? { ...iosBaseOption.legend, bottom: 10, data: y_axis_fields } : undefined,
        grid: { left: 60, right: 20, top: title ? 50 : 30, bottom: hasLegend ? 50 : 30 },
        xAxis: { ...iosBaseOption.xAxis, type: 'value', name: x_axis_field },
        yAxis: { ...iosBaseOption.yAxis, type: 'value', name: y_axis_fields[0] || '' },
        series
      }
    }
  },
  {
    id: 'radar', label: '雷达图', group: 'extended', needsAxis: false,
    buildOption: (ctx: any) => {
      const { data, x_axis_field, y_axis_fields, title, colors } = ctx
      const xAxisData = data.map((item: any) => item[x_axis_field] || '')
      let indicator: any, seriesData: any
      if (xAxisData.length > 0 && y_axis_fields.length === 1) {
        const field = y_axis_fields[0]
        const maxVal = Math.max(...data.map((item: any) => item[field] ?? 0)) * 1.2 || 100
        indicator = xAxisData.map((name: any) => ({ name, max: maxVal }))
        seriesData = [{ value: data.map((item: any) => item[field] ?? 0), name: field }]
      } else {
        const maxVals = y_axis_fields.map((f: any) => Math.max(...data.map((item: any) => item[f] ?? 0)) * 1.2 || 100)
        indicator = y_axis_fields.map((f: any, i: number) => ({ name: f, max: maxVals[i] }))
        seriesData = data.map((item: any, i: number) => ({
          value: y_axis_fields.map((f: any) => item[f] ?? 0),
          name: item[x_axis_field] || `系列${i + 1}`,
          lineStyle: { color: colors[i % colors.length] },
          areaStyle: { color: colors[i % colors.length] + '30' }
        }))
      }
      return {
        ...iosBaseOption,
        title: makeTitleOption(title),
        tooltip: { ...iosBaseOption.tooltip, trigger: 'item' },
        legend: seriesData.length > 1 ? { ...iosBaseOption.legend, bottom: 10, data: seriesData.map((s: any) => s.name) } : undefined,
        radar: { indicator, shape: 'polygon' },
        series: [{ type: 'radar', data: seriesData }]
      }
    }
  },
  {
    id: 'funnel', label: '漏斗图', group: 'extended', needsAxis: false,
    buildOption: (ctx: any) => {
      const { data, x_axis_field, y_axis_fields, title, colors } = ctx
      const field = y_axis_fields[0]
      const xAxisData = data.map((item: any) => item[x_axis_field] || '')
      return {
        ...iosBaseOption,
        title: makeTitleOption(title),
        tooltip: { ...iosBaseOption.tooltip, trigger: 'item', formatter: '{b}: {c}' },
        legend: { ...iosBaseOption.legend, bottom: 10, data: xAxisData },
        series: [{
          type: 'funnel', left: '10%', top: title ? 50 : 30, bottom: 40, width: '80%',
          sort: 'descending', gap: 2,
          label: { show: true, position: 'inside', formatter: '{b}: {c}' },
          itemStyle: { borderColor: '#fff', borderWidth: 1 },
          data: data.map((item: any, i: number) => ({
            name: item[x_axis_field] || `步骤${i + 1}`,
            value: item[field] ?? 0,
            itemStyle: { color: colors[i % colors.length] }
          }))
        }]
      }
    }
  },
  {
    id: 'gauge', label: '仪表盘', group: 'extended', needsAxis: false,
    buildOption: (ctx: any) => {
      const { data, x_axis_field, y_axis_fields, title, colors } = ctx
      const field = y_axis_fields[0]
      const value = data[0]?.[field] ?? 0
      const allValues = data.map((item: any) => item[field] ?? 0)
      const maxVal = Math.max(...allValues) * 1.5 || 100
      return {
        ...iosBaseOption,
        title: makeTitleOption(title),
        tooltip: { ...iosBaseOption.tooltip, trigger: 'item' },
        series: [{
          type: 'gauge', radius: '85%', center: ['50%', '60%'], min: 0, max: maxVal,
          progress: { show: true, width: 14, itemStyle: { color: colors[0] } },
          axisLine: { lineStyle: { width: 14, color: [[1, '#E0E0E0']] } },
          axisTick: { show: false },
          splitLine: { length: 10, lineStyle: { width: 2, color: '#999' } },
          axisLabel: { distance: 20, color: '#86868B', fontSize: 11 },
          pointer: { itemStyle: { color: colors[0] } },
          detail: { valueAnimation: true, fontSize: 24, fontWeight: 600, color: '#1D1D1F', offsetCenter: [0, '70%'] },
          data: [{ value, name: data[0]?.[x_axis_field] || field }]
        }]
      }
    }
  },
  {
    id: 'waterfall', label: '瀑布图', group: 'extended', needsAxis: true,
    buildOption: (ctx: any) => {
      const { data, x_axis_field, y_axis_fields, title, colors } = ctx
      const xAxisData = data.map((item: any) => item[x_axis_field] || '')
      const field = y_axis_fields[0]
      const values = data.map((item: any) => item[field] ?? 0)
      const placeholders: any[] = []
      const increases: any[] = []
      const decreases: any[] = []
      let running = 0
      for (let i = 0; i < values.length; i++) {
        const val = values[i]
        if (val >= 0) {
          placeholders.push(running)
          increases.push(val)
          decreases.push(0)
        } else {
          placeholders.push(running + val)
          increases.push(0)
          decreases.push(Math.abs(val))
        }
        running += val
      }
      return {
        ...iosBaseOption,
        title: makeTitleOption(title),
        tooltip: { ...iosBaseOption.tooltip, trigger: 'axis' },
        legend: { ...iosBaseOption.legend, bottom: 10, data: ['增加', '减少'] },
        grid: { left: 60, right: 20, top: title ? 50 : 30, bottom: 50 },
        xAxis: {
          ...iosBaseOption.xAxis, type: 'category', data: xAxisData,
          axisLabel: { ...iosBaseOption.xAxis.axisLabel, rotate: xAxisData.length > 5 ? 30 : 0, interval: 0 }
        },
        yAxis: { ...iosBaseOption.yAxis, type: 'value' },
        series: [
          { name: 'placeholder', type: 'bar', stack: 'waterfall', itemStyle: { color: 'transparent' }, emphasis: { itemStyle: { color: 'transparent' } }, data: placeholders },
          { name: '增加', type: 'bar', stack: 'waterfall', itemStyle: { color: colors[1], borderRadius: [4, 4, 0, 0] }, data: increases },
          { name: '减少', type: 'bar', stack: 'waterfall', itemStyle: { color: colors[6], borderRadius: [4, 4, 0, 0] }, data: decreases }
        ]
      }
    }
  }
]

// ============ Registry API ============

const _registry = new Map<string, any>()
for (const chartType of CHART_TYPES) {
  _registry.set(chartType.id, chartType)
}

const _axisIds = new Set(CHART_TYPES.filter((t) => t.needsAxis).map((t) => t.id))
const _nonAxisIds = new Set(CHART_TYPES.filter((t) => !t.needsAxis).map((t) => t.id))

const GROUP_ORDER = ['basic', 'extended']
const _chartTypesByGroup = (() => {
  const map: Record<string, any[]> = {}
  for (const ct of CHART_TYPES) {
    if (!map[ct.group]) map[ct.group] = []
    map[ct.group].push({ id: ct.id, label: ct.label })
  }
  return GROUP_ORDER.filter((g) => map[g]).map((g) => ({
    group: g,
    label: g === 'basic' ? '基础图表' : '扩展图表',
    types: map[g]
  }))
})()

/** Check whether display_type is a chart type. */
export const isChartDisplayType = (displayType: string) => _registry.has(displayType)

/** Return chart types grouped by category. */
export const getChartTypesByGroup = () => _chartTypesByGroup

/** Get chart type configuration by id. */
export const getChartType = (id: string) => _registry.get(id) || null

/** Chart type IDs that need axis configuration (Set). */
export const getAxisChartTypeIds = () => _axisIds

/** Chart type IDs that do not need axis configuration (Set). */
export const getNonAxisChartTypeIds = () => _nonAxisIds

/** Get display label for chart type. */
export const getChartLabel = (id: string) => _registry.get(id)?.label || id

/**
 * Build ECharts option.
 */
export const buildChartOption = (displayType: string, chartData: any, panelId?: string) => {
  const chartType = _registry.get(displayType)
  if (!chartType) return null
  const { data, x_axis_field, y_axis_fields, title, group_field } = chartData
  if (!data || !Array.isArray(data) || data.length === 0) return null
  const colors = getColors(panelId)
  return chartType.buildOption({ data, x_axis_field, y_axis_fields, title, colors, group_field })
}

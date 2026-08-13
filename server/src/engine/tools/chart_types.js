// 迁移自 dsh_kernel/data_analyze/planner/dbagents/chart_types.py

/**
 * 图表类型注册表
 *
 * 新增图表类型只需在 CHART_TYPES 数组中添加一条配置即可，
 * format_agent 中的关键词映射、展示选项、类型名称会自动更新。
 *
 * 每条配置包含：
 *   id          - 唯一标识（对应 display_type）
 *   labelKey    - 中文名
 *   group       - 分组 (basic / extended)
 *   needsAxis   - 是否需要 XY 坐标轴
 *   keywords    - 关键词列表（用于用户意图快速匹配）
 *   descriptionKey - 描述文案
 */

export class ChartTypeDef {
  /**
   * @param {object} opts
   * @param {string}   opts.id
   * @param {string}   opts.labelKey
   * @param {string}   opts.group
   * @param {boolean}  opts.needsAxis
   * @param {string[]} opts.keywords
   * @param {string}   opts.descriptionKey
   */
  constructor({ id, labelKey, group, needsAxis, keywords, descriptionKey }) {
    this.id = id;
    this.labelKey = labelKey;
    this.group = group;
    this.needsAxis = needsAxis;
    this.keywords = keywords;
    this.descriptionKey = descriptionKey;
  }
}

// ============ 图表类型定义 ============

/** @type {ChartTypeDef[]} */
export const CHART_TYPES = [
  // ---- 基础 ----
  new ChartTypeDef({
    id: 'table', labelKey: '表格', group: 'basic', needsAxis: true,
    keywords: ['表格', '列表形式', 'table'],
    descriptionKey: '以表格形式展示数据',
  }),
  new ChartTypeDef({
    id: 'bar', labelKey: '柱状图', group: 'basic', needsAxis: true,
    keywords: ['柱状图', '柱形图', '条形图', 'bar'],
    descriptionKey: '适合对比不同类别的数值',
  }),
  new ChartTypeDef({
    id: 'line', labelKey: '折线图', group: 'basic', needsAxis: true,
    keywords: ['折线图', '趋势图', 'line', '走势图', '曲线图'],
    descriptionKey: '适合展示趋势变化',
  }),
  new ChartTypeDef({
    id: 'pie', labelKey: '饼图', group: 'basic', needsAxis: false,
    keywords: ['饼图', 'pie', '占比图', '比例图', '环形图'],
    descriptionKey: '适合展示占比分布',
  }),
  new ChartTypeDef({
    id: 'text', labelKey: '文本总结', group: 'basic', needsAxis: false,
    keywords: ['文字总结', '文本总结', '用文字', 'text'],
    descriptionKey: '以自然语言描述数据结果',
  }),

  // ---- 扩展（更具体的类型，关键词匹配优先级高于基础类型） ----
  new ChartTypeDef({
    id: 'stacked_bar', labelKey: '堆叠柱状图', group: 'extended', needsAxis: true,
    keywords: ['堆叠柱状图', '堆叠柱形图', '堆叠条形图', 'stacked bar', 'stacked_bar'],
    descriptionKey: '适合展示各类别的组成部分',
  }),
  new ChartTypeDef({
    id: 'horizontal_bar', labelKey: '横向柱状图', group: 'extended', needsAxis: true,
    keywords: ['横向柱状图', '横向柱形图', '水平柱状图', '水平条形图', 'horizontal bar', 'horizontal_bar'],
    descriptionKey: '适合类别名称较长时的对比',
  }),
  new ChartTypeDef({
    id: 'area', labelKey: '面积图', group: 'extended', needsAxis: true,
    keywords: ['面积图', 'area chart', 'area'],
    descriptionKey: '适合展示趋势变化及面积大小',
  }),
  new ChartTypeDef({
    id: 'stacked_line', labelKey: '堆叠面积图', group: 'extended', needsAxis: true,
    keywords: ['堆叠面积图', '堆叠折线图', 'stacked line', 'stacked area', 'stacked_line'],
    descriptionKey: '适合展示多个系列的趋势及总量',
  }),
  new ChartTypeDef({
    id: 'rose', labelKey: '玫瑰图', group: 'extended', needsAxis: false,
    keywords: ['玫瑰图', '南丁格尔', 'nightingale', 'rose'],
    descriptionKey: '南丁格尔玫瑰图，适合展示占比差异',
  }),
  new ChartTypeDef({
    id: 'scatter', labelKey: '散点图', group: 'extended', needsAxis: true,
    keywords: ['散点图', 'scatter', '气泡图', '相关性图'],
    descriptionKey: '适合展示两个变量的相关性',
  }),
  new ChartTypeDef({
    id: 'radar', labelKey: '雷达图', group: 'extended', needsAxis: false,
    keywords: ['雷达图', 'radar', '蜘蛛图', 'spider'],
    descriptionKey: '适合多维度对比分析',
  }),
  new ChartTypeDef({
    id: 'funnel', labelKey: '漏斗图', group: 'extended', needsAxis: false,
    keywords: ['漏斗图', 'funnel', '转化率图', '转化漏斗'],
    descriptionKey: '适合展示流程转化率',
  }),
  new ChartTypeDef({
    id: 'gauge', labelKey: '仪表盘', group: 'extended', needsAxis: false,
    keywords: ['仪表盘', 'gauge', '仪表图', '刻度盘'],
    descriptionKey: '适合展示单个指标的完成度',
  }),
  new ChartTypeDef({
    id: 'waterfall', labelKey: '瀑布图', group: 'extended', needsAxis: true,
    keywords: ['瀑布图', 'waterfall', '阶梯图'],
    descriptionKey: '适合展示数值的增减变化过程',
  }),
];

// ============ 注册表（急初始化） ============

/** @type {Map<string, ChartTypeDef>} */
const _registry = new Map(CHART_TYPES.map(ct => [ct.id, ct]));

// 扩展类型排在前面，确保关键词匹配优先级
const _keywordOrder = [
  ...CHART_TYPES.filter(ct => ct.group === 'extended'),
  ...CHART_TYPES.filter(ct => ct.group === 'basic'),
];

// 预缓存常用集合，避免每次调用重建
const _allIds = CHART_TYPES.map(ct => ct.id);
const _visualIds = new Set(CHART_TYPES.filter(ct => ct.id !== 'text' && ct.id !== 'table').map(ct => ct.id));
const _axisIds = new Set(CHART_TYPES.filter(ct => ct.needsAxis).map(ct => ct.id));


/**
 * @param {string} typeId
 * @returns {ChartTypeDef|undefined}
 */
export function getChartType(typeId) {
  return _registry.get(typeId);
}

/**
 * @returns {string[]}
 */
export function getAllChartTypeIds() {
  return _allIds;
}

/**
 * @param {string} typeId
 * @returns {string}
 */
export function getChartLabel(typeId) {
  const ct = _registry.get(typeId);
  return ct ? ct.labelKey : typeId;
}

/**
 * 构建 {typeId: [keywords]} 映射，扩展类型在前。
 * @returns {Object<string, string[]>}
 */
export function buildKeywordMap() {
  const map = {};
  for (const ct of _keywordOrder) {
    map[ct.id] = ct.keywords;
  }
  return map;
}

/**
 * 构建展示选项列表（用于 ask_user）。
 * tFunc 是翻译函数 t(key) => string；桌面版直接传 key => key 即可。
 * @param {(key: string) => string} tFunc
 * @returns {Array<{value: string, label: string, meta: {description: string}}>}
 */
export function buildDisplayOptions(tFunc) {
  const options = [
    {
      value: 'auto',
      label: tFunc('自动选择（推荐）'),
      meta: { description: tFunc('根据数据特点自动选择最佳展示方式') },
    },
  ];
  for (const ct of CHART_TYPES) {
    options.push({
      value: ct.id,
      label: tFunc(ct.labelKey),
      meta: { description: tFunc(ct.descriptionKey) },
    });
  }
  return options;
}

/**
 * @returns {Set<string>}
 */
export function getAxisChartTypeIds() {
  return _axisIds;
}

/**
 * @returns {Set<string>}
 */
export function getVisualChartTypeIds() {
  return _visualIds;
}

// 查询结果展示服务。只做确定性的数据形态判断和前端展示，不调用模型。

import {
  buildKeywordMap,
  buildDisplayOptions,
  getVisualChartTypeIds,
  getChartLabel,
  getAllChartTypeIds,
} from '../tools/chart_types.js';
import { AgentContext } from '../core/agent_context.js'; // eslint-disable-line no-unused-vars
import { t } from '../utils/i18n.js';
import { pushInPlaceStatus } from '../agents/agent_helpers.js';

/** 轻量 logger（对应 Python logging.getLogger(__name__)，保留 emoji 日志行） */
const logger = {
  error: (...args) => console.error('[format_agent]', ...args),
  warn: (...args) => console.warn('[format_agent]', ...args),
  warning: (...args) => console.warn('[format_agent]', ...args),
  info: (...args) => console.info('[format_agent]', ...args),
  debug: (...args) => console.debug('[format_agent]', ...args),
};

// Markdown 块级前缀（标题/引用/列表/代码围栏/表格）正则：单行纯文本加粗时用于规避破坏 md。
const MARKDOWN_BLOCK_PREFIX_RE = /^\s*(?:#{1,6}\s|>\s|[-*+]\s|\d+[.)]\s|```|~~~|\|)/;

/**
 * 判断列名是否为 ID 类字段（不适合作为图表轴）。
 * @param {string} col_name
 * @returns {boolean}
 */
function _is_id_like(col_name) {
  const lower = String(col_name).toLowerCase().trim();
  return ['id', 'pk', 'index', 'row_number'].includes(lower) || lower.endsWith('_id');
}

// ============== 数据模型 ==============

/**
 * FormatBlock - 单个展示块（对应 Python pydantic FormatBlock）。
 */
export class FormatBlock {
  /**
   * @param {object} opts
   * @param {string} opts.display_type        展示类型: line/bar/pie/table/text/...
   * @param {string} opts.title               标题
   * @param {string} [opts.content='']        文本内容（display_type=text 时必填）
   * @param {string|null} [opts.x_axis_field=null]    X 轴字段（类别轴）
   * @param {string[]|null} [opts.y_axis_fields=null] Y 轴字段（数值轴，可多个）
   * @param {string|null} [opts.group_field=null]     分组字段（堆叠图/分组图）
   * @param {string} [opts.data_source='sub_task_0']  数据来源索引
   */
  constructor({
    display_type,
    title,
    content = '',
    x_axis_field = null,
    y_axis_fields = null,
    group_field = null,
    data_source = 'sub_task_0',
  } = {}) {
    this.display_type = display_type;
    this.title = title;
    this.content = content ?? '';
    this.x_axis_field = x_axis_field ?? null;
    this.y_axis_fields = y_axis_fields ?? null;
    this.group_field = group_field ?? null;
    this.data_source = data_source ?? 'sub_task_0';
  }

  /**
   * 从普通对象构造 FormatBlock（容忍缺省字段，对齐 pydantic 默认值）。
   * @param {object} [obj={}]
   * @returns {FormatBlock}
   */
  static fromJSON(obj = {}) {
    if (obj instanceof FormatBlock) return obj;
    const o = obj || {};
    return new FormatBlock({
      display_type: o.display_type,
      title: o.title,
      content: o.content ?? '',
      x_axis_field: o.x_axis_field ?? null,
      y_axis_fields: o.y_axis_fields ?? null,
      group_field: o.group_field ?? null,
      data_source: o.data_source ?? 'sub_task_0',
    });
  }

  /**
   * 序列化为普通对象（对应 pydantic model_dump）。
   * @returns {object}
   */
  model_dump() {
    return {
      display_type: this.display_type,
      title: this.title,
      content: this.content,
      x_axis_field: this.x_axis_field,
      y_axis_fields: this.y_axis_fields,
      group_field: this.group_field,
      data_source: this.data_source,
    };
  }
}

/**
 * CompoundResponse - ResultPresenter 统一输出模型（对应 Python pydantic CompoundResponse）。
 */
export class CompoundResponse {
  /**
   * @param {object} opts
   * @param {Array<FormatBlock|object>} [opts.blocks=[]] 展示块列表，按展示顺序排列
   */
  constructor({ blocks = [] } = {}) {
    this.blocks = (blocks || []).map((b) => FormatBlock.fromJSON(b));
  }

  /** llm.js response_model 约定：类名（用于 schema hint）。 */
  static get name() {
    return 'CompoundResponse';
  }

  /** llm.js response_model 约定：JSON Schema 提示。 */
  static get schema() {
    return {
      properties: {
        blocks: {
          type: 'array',
          description: '展示块列表，按展示顺序排列',
        },
      },
      required: ['blocks'],
    };
  }

  /**
   * 从普通对象构造（llm.js typed chat 用此把 JSON → 模型实例）。
   * @param {object} [parsed={}]
   * @returns {CompoundResponse}
   */
  static fromJSON(parsed = {}) {
    if (parsed instanceof CompoundResponse) return parsed;
    const p = parsed || {};
    return new CompoundResponse({ blocks: Array.isArray(p.blocks) ? p.blocks : [] });
  }
}

/**
 * 格式化 Agent - 统一上下文 + 复合输出
 *
 * 逻辑：
 * 1. 用户明确要求某种格式 → 关键词匹配，直接构建单块 CompoundResponse
 * 2. 用户没明确要求 → 根据行数、字段类型确定展示方式
 * 3. 图表轴由确定性代码绑定，不再启动第二个模型
 */
export class ResultPresenter {
  static _FORMAT_PROGRESS_CID_KEY = '_format_display_progress_content_id';

  constructor() {
  }

  // 展示类型选项（ask_user 时使用）
  // 注意：不能在类级别调用 t()，因为此时请求语言上下文 ContextVar 尚未设置
  // 改为 getter，在请求处理时动态生成，确保翻译正确
  get DISPLAY_TYPE_OPTIONS() {
    return buildDisplayOptions(t);
  }

  // 展示类型关键词映射（从 chart_types 注册表生成，扩展类型优先匹配）
  get DISPLAY_TYPE_KEYWORDS() {
    return ResultPresenter._DISPLAY_TYPE_KEYWORDS;
  }

  /**
   * @param {AgentContext} agent_context
   * @param {Function|null} stream_callback
   * @param {string} body
   * @param {string} title
   * @returns {Promise<void>}
   */
  async _push_format_progress_status(agent_context, stream_callback, body, title) {
    await pushInPlaceStatus(agent_context, stream_callback, {
      cid_key: ResultPresenter._FORMAT_PROGRESS_CID_KEY,
      content: body,
      title,
    });
  }

  /**
   * 收尾：把同一个 cid 的最后状态改成完成态，并清理上下文键（释放 cid 槽位，
   * 下一轮 ask_user 不会复用旧块）。
   *
   * @param {AgentContext} agent_context
   * @param {Function|null} stream_callback
   * @param {string|null} [done_message=null]
   * @returns {Promise<void>}
   */
  async _finalize_format_progress_status(agent_context, stream_callback, done_message = null) {
    if (!stream_callback || !(ResultPresenter._FORMAT_PROGRESS_CID_KEY in agent_context.data)) {
      return;
    }
    await pushInPlaceStatus(agent_context, stream_callback, {
      cid_key: ResultPresenter._FORMAT_PROGRESS_CID_KEY,
      content: done_message || t('展示方式已确定'),
      title: t('格式化展示'),
    });
    delete agent_context.data[ResultPresenter._FORMAT_PROGRESS_CID_KEY];
  }

  /**
   * 判断采样行里是否存在数值列（int/float，排除 bool）。
   * @param {object} sample_row
   * @returns {boolean}
   */
  static _has_numeric_column(sample_row) {
    if (!sample_row || typeof sample_row !== 'object' || Array.isArray(sample_row)) {
      return false;
    }
    for (const v of Object.values(sample_row)) {
      if (typeof v === 'boolean') continue;
      if (typeof v === 'number') return true;
    }
    return false;
  }

  /**
   * 规则判断：是否应该直接走 table/text，直接选择 决策。
   *
   * 命中以下条件之一 → 不画图（"data + 意图"明确不适合可视化）：
   * - 用户消息含"列出/给我/有哪些/名单/明细"等列表意图关键词 → table
   * - 数据是单值/单行单列 → text
   * - 数据全文本无数值列 → table（图没东西可画）
   * - 数据 > 50 行 → table（chart 太挤反而看不清）
   *
   * 否则返回 null，由默认展示规则继续判断。
   *
   * @param {string} user_message
   * @param {Array<object>} sub_tasks
   * @returns {string|null}
   */
  _select_rule_display_type(user_message, sub_tasks) {
    if (!sub_tasks || !sub_tasks.length) {
      return null;
    }

    // (1) 用户意图：明确要"列出/明细" → 直接 table
    const msg_lower = (user_message || '').toLowerCase();
    if (ResultPresenter._LIST_INTENT_KEYWORDS.some((kw) => msg_lower.includes(kw))) {
      logger.info('[Format] 规则命中：用户明确要列表/明细 → table（直接选择）');
      return 'table';
    }

    // (2) 看主数据集（最后一个 sub_task，跟现有路径一致）形态
    const main_task = sub_tasks[sub_tasks.length - 1];
    const rows = main_task.row_count || 0;
    const columns = main_task.columns || [];
    const sample = main_task.sample || main_task.data || [];

    // 单值答案（如"banks 多少张表" → 11）
    if (rows <= 1 && columns.length <= 1) {
      logger.info(`[Format] 规则命中：单值答案 rows=${rows} cols=${columns.length} → text（直接选择）`);
      return 'text';
    }

    // 数据采样：判断是否存在数值列
    if (sample && Array.isArray(sample) && sample[0] && typeof sample[0] === 'object' && !Array.isArray(sample[0])) {
      if (!ResultPresenter._has_numeric_column(sample[0])) {
        logger.info('[Format] 规则命中：无数值列，无法构图 → table（直接选择）');
        return 'table';
      }
    }

    // 数据量大：图太挤，不如直接表格分页查看
    if (rows > 50) {
      logger.info(`[Format] 规则命中：行数 ${rows} > 50 → table（直接选择）`);
      return 'table';
    }

    // 模糊场景由默认展示规则继续判断。
    return null;
  }

  /**
   * 通过关键词快速检测一个或多个展示类型，按在问题中的出现顺序返回。
   * @param {string} question
   * @returns {string[]}
   */
  _detect_display_types_by_keyword(question) {
    if (!question) {
      return [];
    }

    const question_lower = question.toLowerCase();
    const matched_positions = [];
    for (const [display_type, keywords] of Object.entries(this.DISPLAY_TYPE_KEYWORDS)) {
      let first_pos = null;
      for (const keyword of keywords) {
        const pos = question_lower.indexOf(keyword.toLowerCase());
        if (pos >= 0 && (first_pos === null || pos < first_pos)) {
          first_pos = pos;
        }
      }
      if (first_pos !== null) {
        matched_positions.push([first_pos, display_type]);
      }
    }

    matched_positions.sort((a, b) => a[0] - b[0]);
    const detected_types = matched_positions.map(([, display_type]) => display_type);
    if (detected_types.length) {
      logger.info(`[Format] 关键词匹配到展示类型: ${JSON.stringify(detected_types)}`);
      if (detected_types.length > 1) {
        logger.info(`[Format] 检测到多个展示类型，按问题出现顺序生成多个 block: ${JSON.stringify(detected_types)}`);
      }
    }
    return detected_types;
  }

  // ============== 核心方法 ==============

  /**
   * 统一处理 format_context，输出 CompoundResponse（原 reasoning，改为纯函数返回）。
   *
   * 决策分三层（依次命中即短路）：
   *   Step 1  关键词匹配 — 用户明确说了图类型（折线图/柱状图…）→ 直接用
   *   Step 2  跳过规则   — 单值/全文本/列表意图/50+行 → table/text
   *   Step 3  默认规则   — 时间字段用折线图，其他数值数据用柱状图，其余用表格
   *
   * @param {AgentContext} agent_context
   * @param {Function|null} stream_callback
   * @returns {Promise<{blocks: Array<object>, metadata: object}>}
   * @throws {Error} 缺少 format_context 或无 sub_tasks
   */
  async run(agent_context, stream_callback) {
    logger.info('[Format] 开始生成可视化展示');

    const format_context = agent_context.input_data.format_context;
    const user_message = agent_context.input_data.user_message ?? '';

    if (!format_context) {
      throw new Error('缺少 format_context');
    }

    const sub_tasks = format_context.sub_tasks ?? [];
    if (!sub_tasks.length) {
      throw new Error('format_context 中没有 sub_tasks');
    }

    const metric_view_summary = ResultPresenter._summarize_metric_view_usage(format_context);

    // 展示只是 Agent 的确定性工具，不得在工具内部再次启动模型。
    if (stream_callback && !ResultPresenter._isNonEmpty(metric_view_summary)) {
      const total_rows = sub_tasks.reduce((acc, task) => acc + task.row_count, 0);
      await this._push_format_progress_status(
        agent_context,
        stream_callback,
        t('查询到 {} 条数据，正在分析展示方式...', total_rows),
        t('结果展示'),
      );
    }

    const requested = this._detect_display_types_by_keyword(user_message);
    let displayTypes = requested;
    if (!displayTypes.length) {
      const ruleType = this._select_rule_display_type(user_message, sub_tasks);
      if (ruleType && ruleType !== 'text') {
        displayTypes = [ruleType];
      } else {
        const mainTask = sub_tasks[sub_tasks.length - 1] || {};
        const sample = Array.isArray(mainTask.sample) && mainTask.sample.length
          ? mainTask.sample
          : Array.isArray(mainTask.data) ? mainTask.data : [];
        const row = sample[0] && typeof sample[0] === 'object' ? sample[0] : {};
        const hasTime = Object.keys(row).some((column) =>
          ResultPresenter._is_time_column(column, sample.slice(0, 5).map((item) => item?.[column])),
        );
        const hasNumeric = Object.entries(row).some(([column, value]) =>
          typeof value === 'number' && !_is_id_like(column),
        );
        displayTypes = [hasNumeric && Number(mainTask.row_count || sample.length) > 1
          ? (hasTime ? 'line' : 'bar')
          : 'table'];
      }
    }
    const response = this._build_detected_response(displayTypes, user_message, sub_tasks);

    // 检测「用户明确要求的图类型」是否被系统替换（如要饼图但数据是时间序列→折线图）。
    // 若替换，给对应展示块附黄色提示（前端 content-hint 用 fallback_hint 字段渲染黄色警示）。
    const [substitution_hint, substituted_block] = this._detect_chart_substitution(user_message, response);

    // 统一推送路径（所有决策分支共用）
    const metric_view_metadata = ResultPresenter._build_metric_view_metadata(metric_view_summary);

    if (stream_callback && !ResultPresenter._isNonEmpty(metric_view_summary)) {
      await this._finalize_format_progress_status(agent_context, stream_callback);
    }

    await this._push_question_header(user_message, metric_view_metadata, stream_callback);
    for (const block of response.blocks) {
      const block_data = this._resolve_block_data(block, format_context);
      const hint = block === substituted_block ? substitution_hint : null;
      await this._push_block_to_frontend(block, block_data, metric_view_metadata, stream_callback, {
        substitution_hint: hint,
      });
    }

    return this._build_compound_action(response, format_context, user_message, metric_view_summary);
  }

  /**
   * 检测用户明确要求的图类型是否被系统替换为其它形态。
   *
   * 返回 [提示文案, 被替换的展示块]；未发生替换则 [null, null]。
   * 仅在用户问题里明确指定了某一图类型（关键词命中）、且实际展示块的类型
   * 与之不同时触发——这是"系统没完全听用户的"的可解释场景，前端渲染黄色警示。
   *
   * @param {string} user_message
   * @param {CompoundResponse} response
   * @returns {[string|null, FormatBlock|null]}
   */
  _detect_chart_substitution(user_message, response) {
    if (!response || !response.blocks || !response.blocks.length) {
      return [null, null];
    }
    const requested = this._detect_display_types_by_keyword(user_message);
    if (!requested.length) {
      return [null, null];
    }
    const req_type = requested[0];
    // 取第一个非文本展示块（chart / table）作为对比对象
    const target = response.blocks.find((b) => b.display_type !== 'text') ?? null;
    if (!target || target.display_type === req_type) {
      return [null, null];
    }
    const hint = t(
      '您要求的「{}」不适合当前数据形态，已自动改用「{}」展示。',
      t(getChartLabel(req_type)),
      t(getChartLabel(target.display_type)),
    );
    return [hint, target];
  }

  /**
   * 用户明确指定展示类型时，不启动模型，直接构建 CompoundResponse。
   *
   * @param {string|string[]} detected_type
   * @param {string} user_message
   * @param {Array<object>} sub_tasks
   * @returns {CompoundResponse}
   */
  _build_detected_response(detected_type, user_message, sub_tasks) {
    const title = user_message.length > 50 ? `${user_message.slice(0, 50)}...` : user_message;
    const detected_types = Array.isArray(detected_type) ? detected_type : [detected_type];
    const title_map = {
      line: t('趋势图'),
      bar: t('柱状图'),
      pie: t('占比图'),
      table: t('详细数据表'),
      text: t('分析总结'),
    };
    const blocks = detected_types.map(
      (item) =>
        new FormatBlock({
          display_type: item,
          title: detected_types.length === 1 ? title : title_map[item] ?? title,
          data_source: `sub_task_${sub_tasks.length - 1}`,
        }),
    );
    return new CompoundResponse({ blocks });
  }

  // ============== 数据解析与推送 ==============

  /**
   * 根据 block.data_source 获取对应的数据（最多 500 行）。
   *
   * @param {FormatBlock} block
   * @param {object} format_context
   * @returns {object}
   */
  _resolve_block_data(block, format_context) {
    const sub_tasks = format_context.sub_tasks;
    if (block.data_source.startsWith('sub_task_')) {
      let idx;
      const last_sep = block.data_source.lastIndexOf('_');
      const parsed = parseInt(block.data_source.slice(last_sep + 1), 10);
      idx = Number.isNaN(parsed) ? -1 : parsed;
      if (idx >= 0 && idx < sub_tasks.length) {
        const task = sub_tasks[idx];
        return {
          data: task.data,
          columns: task.columns,
          row_count: task.row_count,
          truncated: task.truncated ?? false,
          source_type: task.source_type ?? 'database_connection',
        };
      }
    }
    // 默认返回最后一个子任务
    const last = sub_tasks[sub_tasks.length - 1];
    return {
      data: last.data,
      columns: last.columns,
      row_count: last.row_count,
      truncated: last.truncated ?? false,
      source_type: last.source_type ?? 'database_connection',
    };
  }

  /**
   * 推送问题作为答案的上下文头。
   *
   * @param {string} user_message
   * @param {object} metric_view_metadata
   * @param {Function|null} stream_callback
   * @returns {Promise<void>}
   */
  async _push_question_header(user_message, metric_view_metadata, stream_callback) {
    if (!stream_callback || !user_message) {
      return;
    }
    await stream_callback(`**${user_message}**`, {
      content_type: 'markdown',
      title: t('问题'),
      savable_to_panel: false,
      recall: false,
      ...metric_view_metadata,
    });
  }

  /**
   * @param {object} format_context
   * @returns {object}
   */
  static _summarize_metric_view_usage(format_context) {
    const sub_tasks =
      format_context && typeof format_context === 'object' && !Array.isArray(format_context)
        ? format_context.sub_tasks ?? []
        : [];
    const hits = [];
    const fallbacks = [];

    for (const task of sub_tasks) {
      const query_mode = task.query_mode ?? '';
      const status = task.metric_view_status ?? '';
      const metric_view = task.metric_view || {};
      const decision = task.metric_view_decision || {};
      const fallback_to = task.fallback_to;

      if (
        query_mode === 'metric_view' &&
        ['confirmed_hit', 'need_param_clarification'].includes(status) &&
        ResultPresenter._isNonEmpty(metric_view)
      ) {
        hits.push({
          query_mode,
          metric_view_status: status,
          metric_view,
          metric_view_decision: decision,
          fallback_to,
        });
      } else if (status === 'fallback' && ResultPresenter._isNonEmpty(metric_view)) {
        fallbacks.push({
          query_mode: query_mode || 'nl2sql',
          metric_view_status: status,
          metric_view,
          metric_view_decision: decision,
          fallback_to: fallback_to || 'nl2sql',
        });
      }
    }

    if (hits.length) {
      const first = hits[0];
      return {
        query_mode: 'metric_view',
        metric_view_status: first.metric_view_status ?? 'confirmed_hit',
        metric_view: first.metric_view,
        metric_view_decision: first.metric_view_decision,
        fallback_to: null,
      };
    }

    if (fallbacks.length) {
      const first = fallbacks[0];
      return {
        query_mode: first.query_mode ?? 'nl2sql',
        metric_view_status: 'fallback',
        metric_view: first.metric_view,
        metric_view_decision: first.metric_view_decision,
        fallback_to: first.fallback_to ?? 'nl2sql',
      };
    }

    return {};
  }

  /**
   * @param {object} summary
   * @returns {object}
   */
  static _build_metric_view_metadata(summary) {
    if (!ResultPresenter._isNonEmpty(summary)) {
      return {};
    }

    const metadata = {};
    for (const key of ['query_mode', 'metric_view_status', 'metric_view', 'metric_view_decision', 'fallback_to']) {
      if (key in summary && summary[key] !== null && summary[key] !== undefined) {
        metadata[key] = summary[key];
      }
    }
    return metadata;
  }

  /**
   * 按值识别时间列：date/datetime 类型，或日期格式（含纯数字 20241201）。
   *
   * 比列名关键词可靠——能认出 ds / stat_dt 等不含时间词、值却是日期的列；更重要的是
   * 能把"被当成数值的数字日期（20241201 是 int）"从 y 轴度量里摘出来、改做 x 轴。
   * 列名 token 仅作值不明确时的辅助信号。
   *
   * @param {string} col_name
   * @param {Array<any>} sample_values
   * @returns {boolean}
   */
  static _is_time_column(col_name, sample_values) {
    const vals = sample_values.filter((v) => v !== null && v !== undefined).slice(0, 5);
    if (vals.length) {
      if (vals.every((v) => v instanceof Date)) {
        return true;
      }
      if (vals.every((v) => ResultPresenter._DATE_VALUE_RE.test(String(v)))) {
        return true;
      }
    }
    return ResultPresenter._TIME_AXIS_TOKENS.some((tok) => String(col_name).toLowerCase().includes(tok));
  }

  /**
   * 把图表块的「数据形态」对齐成可直接渲染的配置（纯确定性，不调模型）。
   *
   * 集中处理所有"图配置 vs 数据形态匹配"逻辑，让 _push_block_to_frontend 回归纯渲染：
   *   1. 校验传入的轴字段是否真实存在，不存在时丢弃
   *   2. 缺轴时按列类型推断（时间/类别列→x，数值列→y）
   *   3. 单行宽表 melt 成长表（指标名→类别, 值→数值），避免宽表画出空图
   *   4. stacked 图推断 group_field
   *   5. 无数值列→降级 table；饼图含负值→降级 bar（占比语义不接受负值）
   *
   * 图表选择和数据形态变换全部由确定性代码完成。
   * 返回 {display_type, data, fields(null=沿用默认), x_axis_field, y_axis_fields, group_field, fallback_hint}。
   *
   * @param {FormatBlock} block
   * @param {Array<object>} serialized
   * @param {Array<any>} columns
   * @returns {object}
   */
  static _resolve_chart_fields(block, serialized, columns) {
    let display_type = block.display_type;
    let x_field = block.x_axis_field || '';
    let y_fields = [...(block.y_axis_fields || [])];
    let group_field = block.group_field || '';
    let fields = null;
    let fallback_hint = null;
    const row0 = serialized.length ? serialized[0] : {};

    // 1. 校验轴字段真实存在，不在数据列里的字段直接丢弃。
    if (x_field && !(x_field in row0)) {
      x_field = '';
    }
    if (y_fields.length) {
      y_fields = y_fields.filter((yf) => yf in row0);
    }

    // 2. 缺轴时按列类型推断。时间列按"值"识别——数字日期 20241201 也是 int，
    //    必须先认出来、从数值度量里排除，否则会被当 y 轴画歪。
    if (serialized.length && (!x_field || !y_fields.length)) {
      const time_cols = Object.keys(row0).filter((k) =>
        ResultPresenter._is_time_column(
          k,
          serialized.slice(0, 5).map((r) => r[k]),
        ),
      );
      if (!y_fields.length) {
        y_fields = Object.keys(row0).filter(
          (k) => typeof row0[k] === 'number' && !_is_id_like(k) && !time_cols.includes(k),
        );
      }
      if (!x_field) {
        if (time_cols.length) {
          x_field = time_cols[0];
        } else {
          x_field =
            Object.keys(row0).find((k) => typeof row0[k] !== 'number' && !_is_id_like(k)) ?? '';
        }
      }
    }

    // 3. 单行宽表透视成长表（每个数值列 melt 成一行）
    if (serialized.length && serialized.length === 1 && y_fields.length >= 2 && !x_field) {
      const r0 = serialized[0];
      const metric_key = t('指标');
      const value_key = t('数值');
      serialized = y_fields.map((yf) => ({ [metric_key]: yf, [value_key]: r0[yf] }));
      fields = [
        { expression: metric_key, alias: metric_key },
        { expression: value_key, alias: value_key },
      ];
      x_field = metric_key;
      y_fields = [value_key];
    }

    // 4. stacked 图推断 group_field（1 个 y + 多 string 列 + 行数 > x 去重数）
    if (
      !group_field &&
      ['stacked_bar', 'stacked_line'].includes(display_type) &&
      serialized.length &&
      y_fields.length === 1 &&
      x_field
    ) {
      const str_cols = Object.keys(serialized[0]).filter(
        (k) =>
          k !== x_field &&
          !y_fields.includes(k) &&
          typeof serialized[0][k] !== 'number' &&
          !_is_id_like(k),
      );
      const x_unique = new Set(serialized.map((r) => r[x_field])).size;
      if (str_cols.length && serialized.length > x_unique) {
        group_field = str_cols[0];
      }
    }

    // 5. 降级判断
    if (!y_fields.length) {
      display_type = 'table';
      fallback_hint =
        `当前数据中没有数值类型的列（现有列：${columns.map((c) => String(c)).join(', ')}），` +
        `无法生成${getChartLabel(block.display_type)}，已自动切换为表格展示。`;
    } else if (['pie', 'rose'].includes(display_type)) {
      const has_negative = serialized.some((r) =>
        y_fields.some((yf) => typeof r[yf] === 'number' && r[yf] < 0),
      );
      if (has_negative) {
        display_type = 'bar';
        fallback_hint = t('数据包含负值，饼图无法完整展示全部数据，已自动改用柱状图。');
      }
    }

    return {
      display_type,
      data: serialized,
      fields,
      x_axis_field: x_field,
      y_axis_fields: y_fields,
      group_field,
      fallback_hint,
    };
  }

  /**
   * 推送单个展示块到前端。
   *
   * content_id / replace_content 用于流式打字机更新（同一 block 多次推送，
   * 前端用 content_id 合并、replace_content 覆盖）。返回实际使用的 content_id。
   *
   * substitution_hint：用户要求的图类型被系统替换时的说明，写入 content.fallback_hint，
   * 前端 content-hint 渲染为黄色警示条。
   *
   * @param {FormatBlock} block
   * @param {object} block_data
   * @param {object} metric_view_metadata
   * @param {Function|null} stream_callback
   * @param {object} [opts]
   * @param {string|null} [opts.content_id=null]
   * @param {boolean} [opts.replace_content=false]
   * @param {boolean} [opts.is_partial=false]
   * @param {string|null} [opts.substitution_hint=null]
   * @returns {Promise<string|null>}
   */
  async _push_block_to_frontend(
    block,
    block_data,
    metric_view_metadata,
    stream_callback,
    { content_id = null, replace_content = false, is_partial = false, substitution_hint = null } = {},
  ) {
    if (!stream_callback) {
      return null;
    }

    const truncated = block_data.truncated ?? false;
    const total_rows = block_data.row_count ?? 0;
    const source_type = block_data.source_type ?? 'database_connection';

    if (block.display_type === 'text') {
      let content_text = block.content || '';
      // 仅对单行纯文本数据库答案做轻量加粗，避免破坏多行 markdown/list 格式。
      // 流式中间态不做加粗（避免半截字符串触发误判）
      if (source_type !== 'unstructured_data_source' && !is_partial) {
        content_text = ResultPresenter._format_database_text_for_markdown(content_text);
      }
      // 截断提示追加到文本末尾（小字提示），仅最终态附加
      if (truncated && !is_partial) {
        content_text += `\n\n<small>${t('数据量较大（共 {} 行），当前仅展示前 500 行。如需查看更多数据，请缩小查询范围或添加筛选条件。', total_rows)}</small>`;
      }
      return await stream_callback(content_text, {
        content_id,
        content_type: 'markdown',
        title: block.title,
        savable_to_panel: false,
        recall: true,
        result_role: 'deliverable',
        replace_content,
        ...metric_view_metadata,
      });
    }

    const serialized = this._serialize_data_list(block_data.data);
    const fields = this._get_fields(block_data.columns, serialized.length ? serialized[0] : null);
    const content = {
      display_type: block.display_type,
      title: block.title,
      data: serialized,
      fields,
      total_row_count: total_rows,
      truncated,
    };
    if (getVisualChartTypeIds().has(block.display_type)) {
      // 图配置与数据形态的对齐（轴绑定/透视/降级）统一交确定性代码处理，
      // 轴绑定和降级统一由 _resolve_chart_fields 处理。
      const resolved = ResultPresenter._resolve_chart_fields(block, serialized, block_data.columns ?? []);
      content.display_type = resolved.display_type;
      content.data = resolved.data;
      if (resolved.fields !== null) {
        content.fields = resolved.fields;
      }
      if (resolved.fallback_hint) {
        content.fallback_hint = resolved.fallback_hint;
      }
      // 仍是图（未降级 table）且有数值轴时才写轴字段
      if (getVisualChartTypeIds().has(resolved.display_type) && resolved.y_axis_fields.length) {
        content.x_axis_field = resolved.x_axis_field;
        content.y_axis_fields = resolved.y_axis_fields;
        if (resolved.group_field) {
          content.group_field = resolved.group_field;
        }
      }
    }
    if (block.content) {
      content.content = block.content;
    }
    // 图类型替换提示（用户要求 X 但系统改用 Y）→ 写入 fallback_hint，前端黄色警示。
    // 不覆盖已有 fallback_hint（"无数值列降级表格"提示优先级更高）。
    if (substitution_hint && !content.fallback_hint) {
      content.fallback_hint = substitution_hint;
    }
    // 截断提示嵌入 JSON 内容（前端用小字渲染）
    if (truncated) {
      content.truncate_hint = t('数据量较大（共 {} 行），当前仅展示前 500 行。如需查看更多数据，请缩小查询范围或添加筛选条件。', total_rows);
    }
    return await stream_callback(JSON.stringify(content), {
      content_id,
      content_type: 'json',
      title: block.title,
      savable_to_panel: true,
      recall: true,
      result_role: 'deliverable',
      replace_content,
      ...metric_view_metadata,
    });
  }

  /**
   * @param {string} content_text
   * @returns {string}
   */
  static _format_database_text_for_markdown(content_text) {
    if (!content_text) {
      return content_text;
    }

    const stripped = content_text.trim();
    if (!stripped) {
      return content_text;
    }

    if (!ResultPresenter._should_wrap_database_text_as_strong(stripped)) {
      return content_text;
    }

    return `**${stripped}**`;
  }

  /**
   * @param {string} content_text
   * @returns {boolean}
   */
  static _should_wrap_database_text_as_strong(content_text) {
    if (content_text.includes('\n') || content_text.includes('\r')) {
      return false;
    }
    if (MARKDOWN_BLOCK_PREFIX_RE.test(content_text)) {
      return false;
    }
    if (['**', '__', '`', '<small>', '</small>'].some((token) => content_text.includes(token))) {
      return false;
    }
    return true;
  }

  // ============== 返回构建 ==============

  /**
   * 构建返回给调用方的 params dict（run() 直接返回）。
   *
   * @param {CompoundResponse} response
   * @param {object} format_context
   * @param {string} user_message
   * @param {object|null} [metric_view_summary=null]
   * @returns {object} 可直接展示的 {blocks, metadata}。
   */
  _build_compound_action(response, format_context, user_message, metric_view_summary = null) {
    return this._serialize_response({
      blocks: response.blocks.map((b) => b.model_dump()),
      metadata: {
        sub_task_count: format_context.sub_tasks.length,
        block_count: response.blocks.length,
        question: user_message,
        generated_at: new Date().toISOString(),
        ...(metric_view_summary || {}),
      },
    });
  }

  // ============ 工具方法 ============

  /**
   * 转换特殊类型为 JSON 可序列化的类型。
   * @param {any} val
   * @returns {any}
   */
  _serialize_value(val) {
    if (val instanceof Date) {
      return val.toISOString();
    }
    if (val instanceof Uint8Array) {
      return Buffer.from(val).toString('utf-8');
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(val)) {
      return val.toString('utf-8');
    }
    return val;
  }

  /**
   * 深度序列化响应对象。
   * @param {any} obj
   * @returns {any}
   */
  _serialize_response(obj) {
    if (obj instanceof Date) {
      return obj.toISOString();
    }
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(obj)) {
      return obj.toString('utf-8');
    }
    if (obj instanceof Uint8Array) {
      return Buffer.from(obj).toString('utf-8');
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this._serialize_response(item));
    }
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = this._serialize_response(v);
      }
      return out;
    }
    return obj;
  }

  /**
   * 序列化数据列表。
   * @param {Array<object>} data
   * @returns {Array<object>}
   */
  _serialize_data_list(data) {
    return (data || []).map((row) => {
      const out = {};
      for (const [k, v] of Object.entries(row)) {
        out[k] = this._serialize_value(v);
      }
      return out;
    });
  }

  /**
   * 获取字段列表。
   * @param {Array<any>} columns
   * @param {object|null} [sample_row=null]
   * @returns {Array<{expression: string, alias: string}>}
   */
  _get_fields(columns, sample_row = null) {
    let fields = (columns || []).map((col) => {
      const name =
        col && typeof col === 'object' && !Array.isArray(col) ? col.column_name : String(col);
      return { expression: name, alias: name };
    });
    if (!fields.length && sample_row) {
      fields = Object.keys(sample_row).map((key) => ({ expression: key, alias: key }));
    }
    return fields.length ? fields : [];
  }

  /**
   * 判断 dict 非空（对应 Python `if some_dict:`，空对象/null 为 falsy）。
   * @param {any} obj
   * @returns {boolean}
   */
  static _isNonEmpty(obj) {
    return Boolean(obj && typeof obj === 'object' && Object.keys(obj).length > 0);
  }
}

// 用户问题里的"列出/给我"类强信号关键词——意图明确是要看数据本身，不要图。
ResultPresenter._LIST_INTENT_KEYWORDS = [
  '列出',
  '给我',
  '有哪些',
  '名单',
  '明细',
  'list ',
  'show me',
  'give me', // 英文前后留空格避免误匹配
];

// 时间列名辅助词（仅在"按值"判断不明确时辅助；主判据是值的日期格式）。
ResultPresenter._TIME_AXIS_TOKENS = [
  '日期',
  '月份',
  '时间',
  '年份',
  '季度',
  '周',
  'date',
  'month',
  'time',
  'year',
  'quarter',
  'week',
  'period',
];

// 日期值格式：2024-12-01 / 2024/12/1 / 2024-12 / 20241201
ResultPresenter._DATE_VALUE_RE = /^(\d{4}[-/]\d{1,2}([-/]\d{1,2})?|\d{8})$/;

// 展示类型关键词映射（从 chart_types 注册表生成，扩展类型优先匹配）。
ResultPresenter._DISPLAY_TYPE_KEYWORDS = buildKeywordMap();

export default ResultPresenter;

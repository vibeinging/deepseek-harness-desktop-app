// 迁移自 backend/dsh_kernel/data_science/dsagents/tools/format_result_tool.py
//
// FormatResultTool - Agent 的 format_result 工具：生成可视化展示块。
//
// 迁移说明：
// - class FormatResultTool extends AgenticTool（本波同产 agentic_tools.js）；
//   内部委托 ResultPresenter（本波同产 result_presenter.js）。
// - 工具 name='format_result'、inputs / output_type / run / execute 与 Python 1:1。
// - Python 类属性 name/description/inputs/output_type → JS 构造函数内 this.*（BaseTool
//   读 this.name）；同时保留 static name 供下游按类引用。
// - super().__init__(name=self.name, description=self.description, **kwargs) →
//   super(NAME, DESCRIPTION, kwargs)。
// - Result.create_error → Result.createError；result.to_dict 已是 toDict（此处用不到）。
// - dict.pop 无；str.rsplit(".",1)[-1] → split('.').pop()。
// - 重建 format_context 走注入的 intermediate_ds（context.input_data.data_sources_info），
//   不直连库，符合桌面版无 ORM/AsyncSession 的约束。

import { ResultPresenter } from '../presentation/result_presenter.js';
import { AgenticTool } from './agentic_tools.js';
import { AgentContext } from '../core/agent_context.js';
import { Result } from '../core/base_tool.js';

/** 轻量 logger（对应 Python logging.getLogger(__name__)） */
const logger = {
  error: (...args) => console.error('[format_result_tool]', ...args),
  warn: (...args) => console.warn('[format_result_tool]', ...args),
  warning: (...args) => console.warn('[format_result_tool]', ...args),
  info: (...args) => console.info('[format_result_tool]', ...args),
  debug: (...args) => console.debug('[format_result_tool]', ...args),
};

const NAME = 'format_result';

const DESCRIPTION = `生成可视化展示块（图表 / 大数据表）。**非终结工具**：调用后继续 reasoning，任务结束时直接输出结论。

### 调用格式
\`\`\`json
{"tool": "format_result", "params": {"question": "用户原始问题"}}
{"tool": "format_result", "params": {"question": "用户原始问题", "intermediate_tables": ["r_628f"]}}
\`\`\`

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| question | 是 | 用户原始问题，用于选择可视化样式 |
| intermediate_tables | 否 | 要展示的中间结果表名列表（如 \`["r_628f"]\`）。**追问展示上一轮/已有结果时必须传**：从「## 中间结果」概览里挑出与当前问题真正对应的表填入，避免把无关的历史中间表也展示出来（如本轮问浙商指标，却展示了上一轮的基金排名）。不传则用最近一次查询产出的数据。 |

### 说明
- 默认数据从最近的查询结果获取（format_context）
- **追问纯展示**（本轮没有新查询、要展示中间库里已有的表）→ **务必用 \`intermediate_tables\` 指定目标表**，否则会把中间库里所有历史表都拿来、展示模型可能挑错数据集
- 工具内部按"用户意图 + 数据形态"自动决策：
  - 默认输出图表（chart：pie / bar / line / scatter / 等）
  - 数据明确不适合可视化（列表意图 / 单值 / 全文本 / 50+ 行）时退回 table
- 可在同一 turn 多次调用，绘制多个相关图表
- **非终结**：调用后请继续推理，任务结束时直接输出结论

### 何时不应该调用
- 单值/简单文本回答 → 直接自然语言回答
- 小列表（≤ 20 行）→ 直接写 markdown table
- 闲聊 / 澄清 → 直接自然语言回答`;

/**
 * FormatResultTool —— Agent 的 format_result 工具，委托 ResultPresenter 生成展示块。
 * 对外接口名与 Python 保持一致，下游 import { FormatResultTool } 不变。
 */
export class FormatResultTool extends AgenticTool {
  static name = NAME;
  static description = DESCRIPTION;
  static output_type = 'string';

  /**
   * @param {object} [kwargs={}]
   */
  constructor(kwargs = {}) {
    super(NAME, DESCRIPTION, kwargs);

    // 对外暴露 inputs / output_type（对应 Python 类属性）
    this.inputs = {
      question: {
        type: 'string',
        description: 'Original user request or question to help choose visualization style.',
      },
      intermediate_tables: {
        type: 'array',
        description:
          'Intermediate result table names to visualize (e.g. ["r_628f"]). REQUIRED when showing existing/previous-round results — pick the tables matching the current question from the intermediate-result overview, to avoid visualizing unrelated historical tables.',
        nullable: true,
      },
    };
    this.output_type = 'string';
  }

  /**
   * @param {AgentContext} context
   * @param {object} [kwargs={}]
   * @returns {string}
   */
  create_prompt(context, kwargs = {}) {
    // Python 版返回 None（pass）
    return undefined;
  }

  /**
   * @param {AgentContext} context
   * @param {object} [kwargs={}]
   * @returns {ResultPresenter}
   */
  create_presenter(context, kwargs = {}) {
    return new ResultPresenter();
  }

  /**
   * 格式化已有查询结果。
   *
   * 输入约定（按优先级取，向后兼容父 context 状态读法）：
   * - kwargs.question：必填，用户原始问题
   * - kwargs.format_context / context.data.format_context：父 agent 维护的
   *   格式化上下文（sql 工具产出时由父写入）
   * - kwargs.has_prior_intermediate / context.data._has_prior_intermediate：
   *   追问场景标志，当 format_context 为空时允许从 intermediate_ds 重建
   *
   * 输出契约：
   * - 不写父 context（重建出的 format_context 通过 Result.data.rebuilt_format_context
   *   回传，由父 agent 的 observation 决定是否合并/缓存）
   * - 成功：Result.create(data=<ResultPresenter 产出>, ...)
   * - 失败：Result.createError(...)
   *
   * @param {AgentContext} context
   * @param {object} [kwargs={}]
   * @returns {Promise<Result>}
   */
  async execute(context, kwargs = {}) {
    // 优先使用当前轮真实用户消息，保证追问改图表样式时读取到最新指令。
    const question =
      context.input_data.enhanced_user_query ||
      context.input_data.user_message ||
      kwargs.question;
    const stream_callback = kwargs.stream_callback;

    if (!question) {
      return Result.createError('question is required');
    }

    // 显式 params 优先；fallback 到父 context 状态（向后兼容旧调用方）
    let format_context = kwargs.format_context || context.data.format_context;
    const has_prior_intermediate = Boolean(
      kwargs.has_prior_intermediate || context.data._has_prior_intermediate,
    );

    // 追问场景：format_context 不存在但有中间结果可用，按需重建。
    // Agent 指定 intermediate_tables 时只重建这些表，避免混入无关历史结果。
    const intermediate_tables = kwargs.intermediate_tables;
    /** @type {object|null} */
    let rebuilt_format_context = null;
    if ((!format_context || !format_context.sub_tasks) && has_prior_intermediate) {
      format_context = await FormatResultTool._rebuild_format_context(context, intermediate_tables);
      rebuilt_format_context = format_context; // 标记本次确实重建过，回传给父 observation
    }

    if (!format_context || !format_context.sub_tasks) {
      return Result.createError(
        'No format_context found. ' +
          'format_result 需要先执行查询获取数据。' +
          '如果问题不需要查询数据，请直接回答。',
      );
    }

    // 只传 format_context，不复制父级 data（避免带入不可序列化对象如 BusinessDataSources）
    const child_context = new AgentContext({
      task_id: context.task_id,
      user_id: context.user_id,
      project_id: context.project_id,
      session_id: context.session_id,
      input_data: {
        user_message: question,
        format_context,
        business_id: context.input_data.business_id,
      },
      data: {},
    });

    const result_presenter = this.create_presenter(context);
    let params_out;
    try {
      params_out = await result_presenter.run(child_context, stream_callback);
    } catch (e) {
      return Result.createError(e?.message || 'Formatting failed');
    }

    const result_data = { ...(params_out || {}) };
    // 仅当本次工具内部实际重建了 format_context 时才回传；用于父 observation
    // 决定是否缓存到 ctx.data.format_context 复用（替代旧的副作用写回）
    if (rebuilt_format_context) {
      result_data.rebuilt_format_context = rebuilt_format_context;
    }
    return Result.create(result_data, 'Format result completed');
  }

  /**
   * 取裸表名（去掉可能的 datasource 前缀），用于匹配 Agent 传入的目标表名。
   * @param {string} name
   * @returns {string}
   */
  static _bare_table_name(name) {
    return String(name || '')
      .split('.')
      .pop()
      .trim();
  }

  /**
   * 从中间结果表按需重建 format_context（追问场景懒加载）。
   *
   * target_tables：Agent 指定的目标中间表名（可带/不带 ds 前缀）。指定时只重建这些表，
   * 避免把中间库里所有历史表都拿来、展示模型挑错数据集。指定的表都不存在时回退全量（保守）。
   *
   * 纯函数：只读 context，不写 context。重建结果由 execute() 通过 Result.data
   * 回传给父 agent 决定是否缓存到 ctx.data.format_context。
   *
   * @param {AgentContext} context
   * @param {Array<string>|null} [target_tables=null]
   * @returns {Promise<object|null>}
   */
  static async _rebuild_format_context(context, target_tables = null) {
    const MAX_DISPLAY_ROWS = 500;
    try {
      const ds_info = context.input_data.data_sources_info || {};
      const intermediate_ds = ds_info.intermediate_ds;
      if (!intermediate_ds) {
        return null;
      }
      let profiles = await intermediate_ds.profile();
      if (!profiles) {
        return null;
      }
      // Agent 指定了目标表 → 只保留这些表（裸表名匹配，容忍带 ds 前缀）。
      // 全部匹配不到时回退全量，避免因表名写错导致空展示。
      if (target_tables) {
        const wanted = new Set(
          target_tables.filter((tn) => tn).map((tn) => FormatResultTool._bare_table_name(tn)),
        );
        const filtered = profiles.filter((p) =>
          wanted.has(FormatResultTool._bare_table_name(p.name)),
        );
        if (filtered.length) {
          profiles = filtered;
        } else {
          logger.warning(
            `[FormatResultTool] 指定的 intermediate_tables=${JSON.stringify(target_tables)} 均未在中间库找到，回退全量重建`,
          );
        }
      }
      const format_ctx = {
        original_question: context.input_data.enhanced_user_query || '',
        sub_tasks: [],
      };
      for (const p of profiles) {
        const table_name = p.name;
        const [row_count] = p.size ? p.size : [0, 0];
        const sql = `SELECT * FROM "${table_name}" LIMIT ${MAX_DISPLAY_ROWS}`;
        const result = await intermediate_ds.query(sql);
        const records = result && result.data ? result.data : [];
        const columns = p.columns ? p.columns.map((c) => c.name) : [];
        format_ctx.sub_tasks.push({
          sub_question: p.description || table_name,
          columns,
          row_count,
          truncated: row_count > MAX_DISPLAY_ROWS,
          sample: records.slice(0, 10),
          data: records,
          source_type: 'database_connection',
          datasource_name: intermediate_ds.datasource_name,
          intermediate_table: `${intermediate_ds.datasource_name}.${table_name}`,
        });
      }
      logger.info(
        `[FormatResultTool] 从中间结果重建 format_context: ${format_ctx.sub_tasks.length} 个子任务`,
      );
      return format_ctx;
    } catch (e) {
      logger.warning(`[FormatResultTool] 重建 format_context 失败: ${e?.message ?? e}`);
      return null;
    }
  }
}

export default FormatResultTool;

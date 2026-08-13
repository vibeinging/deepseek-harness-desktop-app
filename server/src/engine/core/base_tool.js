// 迁移自 core/agentic_flow/tools/base_tool.py

import { currentTraceSpan, traceToolCall } from '../trace/trace_context.js';

/**
 * BaseTool - 通用工具基类
 *
 * 设计原则：
 * - 单一职责：每个工具只做一件事
 * - 接口统一：输入输出格式标准化
 * - 简单明了：删除过度设计
 */

// 轻量 i18n：桌面版只需中文，直接返回原文
// 若将来需要多语言，在此替换实现即可
function t(key, ...args) {
  let result = key;
  for (const arg of args) {
    result = result.replace('{}', String(arg));
  }
  return result;
}

// 轻量 logger（对应 Python logging.getLogger）
const logger = {
  error: (...args) => console.error('[base_tool]', ...args),
  warn:  (...args) => console.warn('[base_tool]', ...args),
  info:  (...args) => console.info('[base_tool]', ...args),
  debug: (...args) => console.debug('[base_tool]', ...args),
};

function compactToolInput(context = {}, kwargs = {}) {
  return {
    kwargs,
    project_id: context?.project_id || context?.input_data?.project_id || '',
    session_id: context?.session_id || context?.input_data?.session_id || '',
    task_id: context?.task_id || '',
  };
}

function resultText(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  const body = result instanceof Result
    ? {
        success: result.success,
        message: result.message,
        error: result.error,
        data: result.data,
        metadata: result.metadata,
      }
    : result;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function resultStatus(result) {
  return result && typeof result === 'object' && result.success === false ? 1 : 0;
}

// ============================================================
// Result — 统一执行结果（对应 Python @dataclass Result）
// ============================================================

export class Result {
  /**
   * @param {object} opts
   * @param {boolean} opts.success
   * @param {object}  [opts.data={}]
   * @param {string|null} [opts.error=null]
   * @param {string}  [opts.message='']
   * @param {number}  [opts.execution_time=0.0]
   * @param {string}  [opts.tool_name='']
   * @param {string}  [opts.task_id='']
   * @param {string}  [opts.user_id='']
   * @param {object}  [opts.metadata={}]
   * @param {Date}    [opts.timestamp]
   */
  constructor({
    success,
    data = {},
    error = null,
    message = '',
    execution_time = 0.0,
    tool_name = '',
    task_id = '',
    user_id = '',
    metadata = {},
    timestamp = new Date(),
  } = {}) {
    this.success        = success;
    this.data           = data ?? {};
    this.error          = error;
    this.message        = message;
    this.execution_time = execution_time;
    this.tool_name      = tool_name;
    this.task_id        = task_id;
    this.user_id        = user_id;
    this.metadata       = metadata ?? {};
    this.timestamp      = timestamp instanceof Date ? timestamp : new Date(timestamp);
  }

  /** 转换为普通对象 */
  toDict() {
    return {
      success:        this.success,
      data:           this.data || {},
      error:          this.error,
      message:        this.message,
      execution_time: this.execution_time,
      tool_name:      this.tool_name,
      task_id:        this.task_id,
      user_id:        this.user_id,
      metadata:       this.metadata || {},
      timestamp:      this.timestamp ? this.timestamp.toISOString() : null,
    };
  }

  /** 创建成功结果（对应 classmethod Result.create） */
  static create(data = {}, message = '', kwargs = {}) {
    if (kwargs.metadata === null || kwargs.metadata === undefined) {
      kwargs.metadata = {};
    }
    return new Result({
      success: true,
      data:    data || {},
      message: message || t('执行成功'),
      ...kwargs,
    });
  }

  /** 创建错误结果（对应 classmethod Result.create_error） */
  static createError(error, message = '', kwargs = {}) {
    if (kwargs.metadata === null || kwargs.metadata === undefined) {
      kwargs.metadata = {};
    }
    return new Result({
      success: false,
      error,
      message: message || t('执行失败'),
      ...kwargs,
    });
  }

  /** 是否成功（对应 @property is_success） */
  get is_success() {
    return this.success;
  }

  /** 是否有错误（对应 @property has_error） */
  get has_error() {
    return this.error !== null && this.error !== undefined;
  }
}

// ============================================================
// BaseTool — 通用工具基类（对应 Python ABC BaseTool）
// ============================================================

export class BaseTool {
  /**
   * @param {string} [name='']
   * @param {string} [description='']
   * @param {object} [kwargs={}]
   * @param {string} [kwargs.version='1.0.0']
   * @param {boolean} [kwargs.enabled=true]
   * @param {object}  [kwargs.config={}]
   */
  constructor(name = '', description = '', kwargs = {}) {
    this.name        = name || this.constructor.name;
    this.description = description || `${this.name} Tool`;
    this.version     = kwargs.version ?? '1.0.0';
    this.enabled     = kwargs.enabled ?? true;
    this.config      = kwargs.config ?? {};

    // 子类沿用 Python 迁移形态重写 execute()；这里在实例化时捕获原始实现，
    // 并把公开 execute() 收口为模板入口，避免调用方直接 execute() 绕过 hook/校验。
    const rawExecute = this.execute;
    if (rawExecute && rawExecute !== BaseTool.prototype.execute && !this.__baseToolTemplateWrapped) {
      Object.defineProperty(this, '_executeImpl', {
        value: rawExecute.bind(this),
        configurable: false,
        enumerable: false,
        writable: false,
      });
      Object.defineProperty(this, '__baseToolTemplateWrapped', {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
      });
      this.execute = (context, kwargs = {}) => this.executeWithHooks(context, kwargs);
    }
  }

  /**
   * 执行工具逻辑（子类必须实现，对应 @abstractmethod execute）
   *
   * @param {object} context - AgentContext
   * @param {object} [kwargs]
   * @returns {Promise<Result>}
   */
  async execute(context, kwargs = {}) {
    throw new Error(`${this.constructor.name}.execute() 未实现`);
  }

  /**
   * 获取工具参数模式（JSON Schema 格式）
   * @returns {object}
   */
  getSchema() {
    return {
      type:       'object',
      properties: {},
      required:   [],
    };
  }

  /**
   * 验证参数（默认通过，子类可覆盖）
   * @param {object} [kwargs]
   * @returns {boolean}
   */
  validateParams(kwargs = {}) {
    return true;
  }

  /**
   * 执行前钩子
   * @param {object} context
   * @param {object} [kwargs]
   * @returns {Promise<boolean>} false 则中止执行
   */
  async preExecute(context, kwargs = {}) {
    return true;
  }

  /**
   * 执行后钩子
   * @param {object} context
   * @param {Result} result
   * @param {object} [kwargs]
   * @returns {Promise<Result>}
   */
  async postExecute(context, result, kwargs = {}) {
    return result;
  }

  /**
   * 带钩子的完整执行流程（对应 execute_with_hooks）
   *
   * @param {object} context
   * @param {object} [kwargs]
   * @returns {Promise<Result>}
   */
  async executeWithHooks(context, kwargs = {}) {
    const activeSpan = currentTraceSpan();
    const agentToolName = kwargs && typeof kwargs === 'object' ? kwargs.__agenticAgentToolName : '';
    if (activeSpan?.kind === 'tool' && (activeSpan?.name === this.name || activeSpan?.name === agentToolName)) {
      return this._executeWithHooksBody(context, kwargs);
    }
    return traceToolCall(
      {
        name: this.name,
        input: compactToolInput(context, kwargs),
        attrs: {
          trace_source: 'base_tool',
          tool_class: this.constructor.name,
        },
        resultToText: resultText,
        statusFromResult: resultStatus,
      },
      () => this._executeWithHooksBody(context, kwargs),
    );
  }

  async _executeWithHooksBody(context, kwargs = {}) {
    const startTime = Date.now();
    const finalize = (result) => {
      if (result && typeof result === 'object') {
        result.execution_time = (Date.now() - startTime) / 1000;
        result.tool_name      = this.name;
      }
      return result;
    };

    try {
      // 执行前钩子
      if (!(await this.preExecute(context, kwargs))) {
        return finalize(Result.createError('执行前检查失败'));
      }

      // 验证参数
      if (!this.validateParams(kwargs)) {
        return finalize(Result.createError('参数验证失败'));
      }

      // 执行主要逻辑
      const executeImpl = this._executeImpl || BaseTool.prototype.execute.bind(this);
      let result = await executeImpl(context, kwargs);

      // 执行后钩子
      result = await this.postExecute(context, result, kwargs);

      // 设置执行时间和工具名
      return finalize(result);

    } catch (e) {
      const execution_time = (Date.now() - startTime) / 1000;
      logger.error(`工具 ${this.name} 执行失败:`, e);

      return Result.createError(
        String(e?.message ?? e),
        t('工具 {} 执行异常', this.name),
        { execution_time, tool_name: this.name },
      );
    }
  }

  /**
   * 获取工具信息（对应 get_tool_info）
   * @returns {object}
   */
  getToolInfo() {
    return {
      name:        this.name,
      description: this.description,
      version:     this.version,
      enabled:     this.enabled,
      config:      this.config,
      schema:      this.getSchema(),
    };
  }

  // ---- Python snake_case 别名（保持与 Python 调用方一致） ----

  /** @alias getSchema */
  get_schema() { return this.getSchema(); }

  /** @alias validateParams */
  validate_params(kwargs = {}) { return this.validateParams(kwargs); }

  /** @alias preExecute */
  async pre_execute(context, kwargs = {}) { return this.preExecute(context, kwargs); }

  /** @alias postExecute */
  async post_execute(context, result, kwargs = {}) { return this.postExecute(context, result, kwargs); }

  /** @alias executeWithHooks */
  async execute_with_hooks(context, kwargs = {}) { return this.executeWithHooks(context, kwargs); }

  /** @alias getToolInfo */
  get_tool_info() { return this.getToolInfo(); }
}

export async function runTool(tool, context, kwargs = {}) {
  if (!tool || (typeof tool.execute !== 'function' && typeof tool.executeWithHooks !== 'function')) {
    throw new Error('runTool 需要传入带 execute() 的工具实例');
  }
  if (typeof tool.executeWithHooks === 'function') return tool.executeWithHooks(context, kwargs);
  return tool.execute(context, kwargs);
}

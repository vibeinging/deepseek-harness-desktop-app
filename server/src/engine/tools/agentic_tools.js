// 迁移自 backend/dsh_kernel/data_science/dsagents/tools/agentic_tools.py
//
// AgenticTool - 把"自治 agent"包装成可复用工具的基类。
//
// 迁移说明：
// - 1:1 迁移，对外接口名（class / method）与 Python 版 100% 一致，供下游
//   1:1 继承（如 FormatResultTool extends AgenticTool）。
// - Python ABCMeta + @abstractmethod → JS 在基类方法里 throw（子类必须覆盖）。
// - super().__init__(name, description, **kwargs) → super(name, description, kwargs)
//   （base_tool.js 的 BaseTool 构造签名为 (name, description, kwargs)）。

import { AgentContext } from '../core/agent_context.js'; // eslint-disable-line no-unused-vars
import { BaseTool, Result } from '../core/base_tool.js';

/** 轻量 logger（对应 Python logging.getLogger(__name__)） */
const logger = {
  error: (...args) => console.error('[agentic_tools]', ...args),
  warn: (...args) => console.warn('[agentic_tools]', ...args),
  info: (...args) => console.info('[agentic_tools]', ...args),
  debug: (...args) => console.debug('[agentic_tools]', ...args),
};

/**
 * AgenticTool - 把自治 agent 包装成可复用工具的基类。
 *
 * 抽象方法（子类必须实现）：create_agent / create_prompt。
 * execute 默认抛 NotImplementedError，子类按需覆盖（如 FormatResultTool）。
 */
export class AgenticTool extends BaseTool {
  /**
   * @param {string} [name='']
   * @param {string} [description='']
   * @param {object} [kwargs={}]
   */
  constructor(name = '', description = '', kwargs = {}) {
    super(name, description, kwargs);
  }

  /**
   * 默认执行流程：创建 agent、运行、后处理。
   *
   * @param {AgentContext} context
   * @param {object} [kwargs={}]
   * @returns {Promise<Result>}
   */
  async execute(context, kwargs = {}) {
    throw new Error('NotImplementedError: AgenticTool.execute() 未实现');
  }

  /**
   * 实例化底层的专用 agent（抽象方法，子类必须实现）。
   *
   * @param {AgentContext} context
   * @param {object} [kwargs={}]
   * @returns {any}
   */
  create_agent(context, kwargs = {}) {
    throw new Error(`${this.constructor.name}.create_agent() 未实现（abstractmethod）`);
  }

  /**
   * 构建专用 agent 的初始 prompt（抽象方法，子类必须实现）。
   *
   * @param {AgentContext} context
   * @param {object} [kwargs={}]
   * @returns {string}
   */
  create_prompt(context, kwargs = {}) {
    throw new Error(`${this.constructor.name}.create_prompt() 未实现（abstractmethod）`);
  }
}

export default AgenticTool;

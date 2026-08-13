import { randomUUID } from "node:crypto";

/**
 * 当前 Turn 共享的产品上下文。
 *
 * Codex App Server 负责 Thread、Turn、工具循环和子智能体状态；这里仅保存宿主工具
 * 需要的项目身份、输入和本轮产品数据，不再实现另一套 Agent 生命周期或恢复协议。
 */
export class AgentContext {
  constructor({
    task_id,
    user_id = "",
    project_id = "",
    session_id = "",
    input_data = {},
    data = {},
  } = {}) {
    this.task_id = task_id || randomUUID();
    this.user_id = user_id;
    this.project_id = project_id;
    this.session_id = session_id;
    this.input_data = input_data;
    this.data = data;
  }
}

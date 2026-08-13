// 展示进度的共享辅助函数。

/**
 * 同一 cid_key 多次推送会原地刷新(replace_content=true),避免堆叠出新块。
 *
 * "思考中" / "任务进展" / "格式化进度" 等需要在前端原地更新，避免堆叠重复状态块。
 *
 * @param {object} agent_context
 * @param {Function} stream_callback
 * @param {object} opts
 * @param {string} opts.cid_key - 写入 agent_context.data 的 content_id 槽位,首次推送后回写复用。
 * @param {string} opts.content
 * @param {string|null} [opts.title=null]
 * @param {string} [opts.content_type='text']
 * @param {boolean} [opts.use_current_task_group=true] - true 时自动挂当前 _current_task_id;全局提示传 false。
 * @param {boolean} [opts.display=true]
 * @param {boolean} [opts.recall=false]
 * @param {boolean} [opts.replace_content=true]
 * @param {object} [opts.extra={}] - 透传到 stream_callback 的剩余 kwarg(如 task_plan / tool_name);
 *   不要再放 content_type / display / recall / replace_content,
 *   那些与上面显式参数冲突会出错。
 * @returns {Promise<string|null>}
 */
export async function pushInPlaceStatus(
  agent_context,
  stream_callback,
  {
    cid_key,
    content,
    title = null,
    content_type = 'text',
    use_current_task_group = true,
    display = true,
    recall = false,
    replace_content = true,
    extra = {},
  } = {},
) {
  if (!stream_callback) {
    return null;
  }
  const cid = agent_context.data[cid_key];
  // use_current_task_group=true 时让 StreamCallback 走 streaming_context 自动注入;
  // false 时显式传 task_group=null 阻断("全部任务完成"等全局提示不该挂任何 task)。
  const extra_kwargs = { ...extra };
  if (!use_current_task_group) {
    extra_kwargs.task_group = null;
  }
  const used_cid = await stream_callback(content, {
    content_id: cid,
    content_type,
    title,
    recall,
    display,
    replace_content,
    ...extra_kwargs,
  });
  if (used_cid && !cid) {
    agent_context.data[cid_key] = used_cid;
  }
  return used_cid;
}

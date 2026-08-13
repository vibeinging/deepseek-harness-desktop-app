import { runTool } from './base_tool.js';

export function textAgentToolResult(text, details = undefined, extra = {}) {
  const result = {
    content: [{ type: 'text', text: String(text ?? '') }],
    ...extra,
  };
  if (details !== undefined) result.details = details;
  return result;
}

function defaultResultText(result) {
  if (!result) return '';
  if (result.success === false) return result.error || result.message || '执行失败';
  if (result.message) return result.message;
  try {
    return JSON.stringify(result.data || {});
  } catch {
    return String(result.data ?? '');
  }
}

function markAgentToolKwargs(kwargs, agentToolName) {
  const out = kwargs && typeof kwargs === 'object' ? kwargs : {};
  Object.defineProperty(out, '__agenticAgentToolName', {
    value: agentToolName,
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return out;
}

export function createAgentToolFromBaseTool({
  name,
  label = '',
  description = '',
  parameters,
  tool,
  agentContext,
  buildKwargs = null,
  mapResult = null,
  mapError = null,
  prepareArguments = undefined,
  executionMode = undefined,
  details = undefined,
} = {}) {
  if (!name) throw new Error('createAgentToolFromBaseTool 需要 name');
  if (!tool) throw new Error(`createAgentToolFromBaseTool(${name}) 需要 BaseTool 实例`);

  return {
    name,
    label: label || name,
    description: description || tool.description || '',
    parameters,
    prepareArguments,
    executionMode,
    async execute(toolCallId, params = {}, signal, onUpdate) {
      const safeParams = params && typeof params === 'object' ? params : {};
      const builtKwargs = buildKwargs
        ? await buildKwargs({ toolCallId, params: safeParams, signal, onUpdate, tool, agentContext })
        : { ...safeParams, signal };
      const kwargs = markAgentToolKwargs(builtKwargs, name);
      let result;
      try {
        result = await runTool(tool, agentContext, kwargs);
      } catch (error) {
        if (mapError) {
          return await mapError({ error, params: safeParams, toolCallId, signal, onUpdate, tool, agentContext });
        }
        throw error;
      }
      if (mapResult) {
        return await mapResult({ result, params: safeParams, toolCallId, signal, onUpdate, tool, agentContext });
      }
      return textAgentToolResult(defaultResultText(result), details);
    },
  };
}

// 迁移自 backend/core/llm/__init__.py + backend/core/llm/chat.py
// 合并导出：LLM 客户端核心（chat / stream / tool-calling），OpenAI 兼容协议，node fetch。

import { AsyncLocalStorage } from 'async_hooks';
import { t } from '../utils/i18n.js';
import { recordTraceLlmCall } from '../trace/trace_context.js';

// ============================================================
// 工具：延迟 / sleep
// ============================================================
/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// JSONExtractionError
// ============================================================

/**
 * 无法从 LLM 响应中提取有效 JSON
 */
export class JSONExtractionError extends Error {
  /**
   * @param {string} message
   * @param {string} rawResponse
   */
  constructor(message, rawResponse) {
    super(message);
    this.name = 'JSONExtractionError';
    this.raw_response = rawResponse;
  }
}

// ============================================================
// ModelNotFoundError
// ============================================================

export class ModelNotFoundError extends Error {
  constructor(message = '未找到可用的模型') {
    super(message);
    this.name = 'ModelNotFoundError';
  }
}

// ============================================================
// TokenUsage
// ============================================================

/**
 * 单次或累计的 token 用量
 */
export class TokenUsage {
  constructor({ prompt_tokens = 0, completion_tokens = 0, total_tokens = 0, cached_tokens = 0 } = {}) {
    this.prompt_tokens = prompt_tokens;
    this.completion_tokens = completion_tokens;
    this.total_tokens = total_tokens;
    this.cached_tokens = cached_tokens;
  }

  /** @param {TokenUsage} other */
  add(other) {
    this.prompt_tokens += other.prompt_tokens || 0;
    this.completion_tokens += other.completion_tokens || 0;
    this.total_tokens += other.total_tokens || 0;
    this.cached_tokens += other.cached_tokens || 0;
  }

  get isEmpty() {
    return this.total_tokens === 0;
  }

  to_dict() {
    return {
      prompt_tokens: this.prompt_tokens,
      completion_tokens: this.completion_tokens,
      total_tokens: this.total_tokens,
      cached_tokens: this.cached_tokens,
    };
  }

  toString() {
    return `TokenUsage(prompt=${this.prompt_tokens}, completion=${this.completion_tokens}, total=${this.total_tokens}, cached=${this.cached_tokens})`;
  }
}

// ============================================================
// ContextVar 模拟（AsyncLocalStorage）
// ============================================================

const _trackerStorage = new AsyncLocalStorage();

/** @type {string|null} */
let _current_call_site_val = null;
/** @type {{ model_id?: string, model_category?: string, requested_role?: string }|null} */
let _current_model_meta_val = null;
/** @type {string|null} */
let _current_requested_role_val = null;

export function set_current_call_site(callSite) {
  _current_call_site_val = callSite ?? null;
}

export function set_current_model_meta(meta) {
  _current_model_meta_val = meta ?? null;
}

export function set_current_requested_role(role) {
  _current_requested_role_val = role ?? null;
}

// ============================================================
// Token 跟踪器
// ============================================================

/**
 * 从 API 响应中提取 token 用量，兼容多种格式
 * @param {object} responseData
 * @returns {TokenUsage|null}
 */
export function extractUsageFromResponse(responseData) {
  if (!responseData || typeof responseData !== 'object') return null;

  let usage = null;
  if (typeof responseData.usage === 'object' && responseData.usage) {
    usage = responseData.usage;
  } else if (typeof responseData.output === 'object' && responseData.output) {
    usage = responseData.output.usage;
    if (typeof usage !== 'object' || !usage) usage = null;
  }

  if (!usage) return null;

  // prompt cache 命中量：兼容多种返回格式
  let cached = 0;
  if (typeof usage.prompt_tokens_details === 'object' && usage.prompt_tokens_details) {
    cached = usage.prompt_tokens_details.cached_tokens || 0;
  }
  if (!cached) {
    cached = usage.cache_input_tokens || usage.cached_tokens || 0;
  }

  return new TokenUsage({
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || 0,
    cached_tokens: cached,
  });
}

/**
 * 记录一次 token 用量：打日志 + 累加到当前 tracker
 * @param {TokenUsage} usage
 * @param {string} [modelName]
 * @param {string} [callSite]
 */
export function recordUsage(usage, modelName = '', callSite = null) {
  const cs = callSite || _current_call_site_val || 'unknown';
  console.info(
    `[TOKEN] model=${modelName} call_site=${cs} | ` +
    `prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} ` +
    `total=${usage.total_tokens} cached=${usage.cached_tokens}`
  );
  const tracker = _trackerStorage.getStore();
  if (tracker) {
    tracker.usage.add(usage);
    tracker.call_count += 1;
    if (!tracker.by_call_site[cs]) tracker.by_call_site[cs] = new TokenUsage();
    tracker.by_call_site[cs].add(usage);
    tracker.calls_by_call_site[cs] = (tracker.calls_by_call_site[cs] || 0) + 1;
  }
}

/**
 * 请求级 token 用量跟踪器，作为异步上下文使用
 *
 * 用法：
 *   const tracker = new TokenTracker();
 *   await tracker.run(async () => {
 *     await chat(...);  // 内部自动累加
 *     console.log(tracker.usage);
 *   });
 */
export class TokenTracker {
  constructor() {
    this.usage = new TokenUsage();
    this.call_count = 0;
    /** @type {Record<string, TokenUsage>} */
    this.by_call_site = {};
    /** @type {Record<string, number>} */
    this.calls_by_call_site = {};
  }

  /**
   * 在此 tracker 的作用域内执行 fn（自动累加 token 用量）
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    return _trackerStorage.run(this, fn);
  }

  /**
   * 打印汇总日志
   */
  summary() {
    if (!this.usage.isEmpty) {
      console.info(
        `[TOKEN_SUMMARY] calls=${this.call_count} | ` +
        `total_prompt=${this.usage.prompt_tokens} ` +
        `total_completion=${this.usage.completion_tokens} ` +
        `total=${this.usage.total_tokens}`
      );
      const sites = Object.entries(this.by_call_site)
        .sort((a, b) => b[1].total_tokens - a[1].total_tokens);
      for (const [cs, u] of sites) {
        console.info(
          `[TOKEN_BY_SITE] ${cs} | calls=${this.calls_by_call_site[cs] || 0} ` +
          `prompt=${u.prompt_tokens} completion=${u.completion_tokens} total=${u.total_tokens}`
        );
      }
    }
  }
}

// ============================================================
// ResponseExtractor（内联迁移自 response_extractor.py）
// ============================================================

const _RE_THINKING_TAGS = /<(thinking|think|思考|思考过程)[^>]*>[\s\S]*?<\/\1[^>]*>/gi;
const _RE_CODE_BLOCK = /```\w*\s*\n([\s\S]*?)\n\s*```/;
const _CONTENT_KEYS = ['content', 'text', 'answer', 'result', 'response', 'reasoning_content', 'reasoning'];

export class ResponseExtractor {
  // ==================== 内部工具 ====================

  static _cleanThinkingTags(content) {
    if (!content || typeof content !== 'string') return content;
    return content.replace(_RE_THINKING_TAGS, '');
  }

  static _maybeClean(content, cleanThinkingTags) {
    if (cleanThinkingTags) return ResponseExtractor._cleanThinkingTags(content);
    return content;
  }

  static _extractFunctionArguments(obj) {
    if (!obj || typeof obj !== 'object') return null;
    // 直接 function 字段
    if (typeof obj.function === 'object' && obj.function) {
      const args = obj.function.arguments;
      if (typeof args === 'string' && args.trim()) return args;
    }
    // tool_calls 列表
    if (Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0) {
      const func = obj.tool_calls[0].function || {};
      const args = func.arguments || '';
      if (typeof args === 'string' && args.trim()) return args;
    }
    return null;
  }

  // ==================== JSON 清理 ====================

  static _unescapeJsonString(s) {
    return s.replace(/\\(.)/g, (_, ch) => {
      const map = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' };
      return map[ch] !== undefined ? map[ch] : '\\' + ch;
    });
  }

  /**
   * 清理 LLM 响应为纯 JSON 格式
   * @param {string} response
   * @param {boolean} [strict=false]
   * @returns {string}
   */
  static clean_llm_json_response(response, strict = false) {
    if (!response || typeof response !== 'string') {
      if (strict) throw new JSONExtractionError('LLM 响应为空', response || '');
      return '{}';
    }

    // Step 1: 移除 thinking 标签
    let cleaned = response.replace(_RE_THINKING_TAGS, '');

    // Step 2: 移除 markdown 代码块
    const codeMatch = _RE_CODE_BLOCK.exec(cleaned);
    if (codeMatch) {
      cleaned = codeMatch[1].trim();
    }

    // Step 3: 找到第一个 JSON 对象起始
    const startIdx = cleaned.indexOf('{');
    if (startIdx === -1) {
      const preview = response.length > 200 ? response.slice(0, 200) : response;
      console.warn(`LLM 响应中未找到 JSON 对象，响应片段: ${JSON.stringify(preview)}`);
      if (strict) {
        throw new JSONExtractionError(
          `LLM 响应中未找到 JSON 对象，响应片段: ${JSON.stringify(preview)}`,
          response
        );
      }
      return '{}';
    }

    // Step 3.1: 检测双重转义
    const remaining = cleaned.slice(startIdx);
    if (remaining.length > 2 && remaining[1] === '\\' && remaining[2] === '"') {
      try {
        const unescaped = ResponseExtractor._unescapeJsonString(remaining);
        JSON.parse(unescaped);
        return unescaped;
      } catch (_) {
        // fall through
      }
    }

    // Step 3.2: 括号匹配提取完整 JSON
    let bracketCount = 0;
    let endIdx = -1;
    let inString = false;
    let escapeNext = false;

    for (let i = startIdx; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (escapeNext) { escapeNext = false; continue; }
      if (ch === '"' && !inString) { inString = true; continue; }
      if (ch === '"' && inString) { inString = false; continue; }
      if (ch === '\\' && inString) { escapeNext = true; continue; }
      if (!inString) {
        if (ch === '{') bracketCount++;
        else if (ch === '}') {
          bracketCount--;
          if (bracketCount === 0) { endIdx = i + 1; break; }
        }
      }
    }

    if (endIdx > startIdx) {
      const jsonStr = cleaned.slice(startIdx, endIdx);
      // Step 4: 检测 API 响应信封并自动解包
      try {
        const obj = JSON.parse(jsonStr);
        if (obj && typeof obj === 'object') {
          const msg = obj.delta || obj.message;
          if (msg && typeof msg === 'object') {
            const inner = msg.content || msg.reasoning_content || msg.reasoning;
            if (typeof inner === 'string' && inner.trim()) {
              return ResponseExtractor.clean_llm_json_response(inner, strict);
            }
            const args = ResponseExtractor._extractFunctionArguments(msg);
            if (args) return ResponseExtractor.clean_llm_json_response(args, strict);
          }
          const args = ResponseExtractor._extractFunctionArguments(obj);
          if (args) return ResponseExtractor.clean_llm_json_response(args, strict);
        }
      } catch (_) {
        // not valid JSON as-is, return raw slice
      }
      return jsonStr;
    }

    return cleaned.slice(startIdx);
  }

  // ==================== Chat 内容提取 ====================

  /**
   * 从各种模型响应中提取 chat 内容（兼容 OpenAI / 阿里云 / 腾讯云 / 百度等格式）
   * @param {any} responseData
   * @param {boolean} [cleanThinkingTags=true]
   * @returns {string}
   */
  static extract_chat_content(responseData, cleanThinkingTags = true) {
    if (!responseData) throw new Error(t('响应数据为空'));
    const mc = (c) => ResponseExtractor._maybeClean(c, cleanThinkingTags);

    // ---------- 列表格式 ----------
    if (Array.isArray(responseData) && responseData.length > 0) {
      const first = responseData[0];
      if (first && typeof first === 'object') {
        const msg = first.delta || first.message || {};
        const content = msg.content || msg.reasoning_content || msg.reasoning;
        if (content) return mc(content);
        const args = ResponseExtractor._extractFunctionArguments(first);
        if (args) return args;
      }
    }

    // ---------- 字符串格式（双重序列化） ----------
    if (typeof responseData === 'string') {
      try {
        const parsed = JSON.parse(responseData);
        if (parsed && typeof parsed === 'object') {
          return ResponseExtractor.extract_chat_content(parsed, cleanThinkingTags);
        }
      } catch (_) { }
      return mc(responseData);
    }

    // ---------- Anthropic Messages 格式（content 是 block 数组） ----------
    if (Array.isArray(responseData.content) && (responseData.type === 'message' || responseData.role === 'assistant')) {
      const text = responseData.content
        .filter((b) => b && b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('');
      if (text) return mc(text);
    }

    // ---------- OpenAI Responses 格式（output_text / output[].content[].text） ----------
    if (typeof responseData.output_text === 'string' && responseData.output_text) {
      return mc(responseData.output_text);
    }
    if (Array.isArray(responseData.output)) {
      const parts = [];
      for (const item of responseData.output) {
        if (item && Array.isArray(item.content)) {
          for (const c of item.content) {
            if (c && (c.type === 'output_text' || c.type === 'text') && c.text) parts.push(c.text);
          }
        }
      }
      if (parts.length) return mc(parts.join(''));
    }

    // ---------- OpenAI 格式 ----------
    if (Array.isArray(responseData.choices) && responseData.choices.length > 0) {
      const message = responseData.choices[0].message || {};
      const content = message.content || message.reasoning_content || message.reasoning;
      if (content) return mc(content);
      const args = ResponseExtractor._extractFunctionArguments(message);
      if (args) return args;
    }

    // ---------- 阿里云通义千问格式 ----------
    if (responseData.output) {
      const output = responseData.output;
      if (output.text) return mc(output.text);
      if (Array.isArray(output.choices) && output.choices.length > 0) {
        const choice = output.choices[0];
        if (choice.message) {
          const content = choice.message.content || choice.message.reasoning_content || choice.message.reasoning;
          if (content) return mc(content);
          const args = ResponseExtractor._extractFunctionArguments(choice.message);
          if (args) return args;
        }
        if (choice.text) return mc(choice.text);
      }
    }

    // ---------- 腾讯云混元格式 ----------
    if (responseData.Response) {
      const resp = responseData.Response;
      if (resp.Content) return mc(resp.Content);
      if (resp.Answer) return mc(resp.Answer);
    }

    // ---------- 百度文心一言格式 ----------
    if (responseData.result) return mc(responseData.result);

    // ---------- 直接字段匹配 ----------
    for (const key of ['content', 'text', 'answer']) {
      if (responseData[key]) return mc(responseData[key]);
    }

    // ---------- 递归搜索 ----------
    function findTextContent(data) {
      if (data && typeof data === 'object') {
        if (Array.isArray(data)) {
          for (const item of data) {
            const found = findTextContent(item);
            if (found) return found;
          }
        } else {
          for (const key of _CONTENT_KEYS) {
            if (typeof data[key] === 'string') return data[key];
          }
          for (const val of Object.values(data)) {
            if (val && typeof val === 'object') {
              const found = findTextContent(val);
              if (found) return found;
            }
          }
        }
      }
      return null;
    }

    const content = findTextContent(responseData);
    if (content) return mc(content);

    throw new Error(t('无法从响应中提取chat内容: {}', JSON.stringify(responseData)));
  }

  // ==================== 流式内容提取 ====================

  /**
   * 从 SSE 流式响应行中提取 delta 内容
   * @param {string} line
   * @param {boolean} [cleanThinkingTags=true]
   * @returns {string|null}
   */
  static extract_stream_chunk(line, cleanThinkingTags = true) {
    if (!line.startsWith('data: ')) return null;
    const dataStr = line.slice(6);
    if (dataStr === '[DONE]') return null;

    const mc = (c) => ResponseExtractor._maybeClean(c, cleanThinkingTags);

    try {
      const chunkData = JSON.parse(dataStr);

      // Anthropic 流式：content_block_delta → delta.text
      if (chunkData.type === 'content_block_delta' && chunkData.delta) {
        const tx = chunkData.delta.text;
        if (tx) return mc(tx);
      }

      // OpenAI Responses 流式：response.output_text.delta → delta(字符串)
      if (chunkData.type === 'response.output_text.delta' && typeof chunkData.delta === 'string') {
        return mc(chunkData.delta);
      }

      // OpenAI 格式（choices 非空时才取 delta，空 list 是 usage-only chunk）
      if (Array.isArray(chunkData.choices) && chunkData.choices.length > 0) {
        const choice = chunkData.choices[0];
        if (choice.delta && typeof choice.delta === 'object') {
          const content = choice.delta.content || choice.delta.reasoning_content;
          if (content) return mc(content);
        }
      }

      // 阿里云通义千问格式
      if (chunkData.output) {
        const output = chunkData.output;
        if (output.text) return mc(output.text);
        if (Array.isArray(output.choices) && output.choices.length > 0) {
          const choice = output.choices[0];
          if (choice.message) {
            const content = choice.message.content || '';
            return mc(content);
          }
        }
      }

      return null;
    } catch (_) {
      return null;
    }
  }

  // ==================== Embedding 提取 ====================

  /**
   * 从各种模型响应中提取 embedding 向量
   * @param {object} responseData
   * @returns {number[][]}
   */
  static extract_embedding(responseData) {
    if (!responseData) throw new Error(t('响应数据为空'));

    // OpenAI 格式
    if (Array.isArray(responseData.data) && responseData.data.length > 0) {
      const first = responseData.data[0];
      if (first.embedding) return responseData.data.filter(i => i.embedding).map(i => i.embedding);
      if (first.vector) return responseData.data.filter(i => i.vector).map(i => i.vector);
    }

    // 阿里云
    if (responseData.output && Array.isArray(responseData.output.embeddings)) {
      return responseData.output.embeddings.map(e => e.embedding || []);
    }

    // 腾讯云
    if (responseData.Response && Array.isArray(responseData.Response.Embeddings)) {
      return responseData.Response.Embeddings.map(e => e.Vector || []);
    }

    // 直接字段
    if (Array.isArray(responseData.embedding)) {
      return [responseData.embedding];
    }

    function findEmbeddingVectors(data) {
      if (Array.isArray(data)) {
        for (const item of data) {
          const result = findEmbeddingVectors(item);
          if (result) return result;
        }
      } else if (data && typeof data === 'object') {
        for (const [key, value] of Object.entries(data)) {
          if (['embedding', 'vector', 'embeddings'].includes(key) && Array.isArray(value)) {
            if (value.length > 0) {
              if (typeof value[0] === 'number') return [value];
              if (Array.isArray(value[0])) return value;
            }
          }
          const result = findEmbeddingVectors(value);
          if (result) return result;
        }
      }
      return null;
    }

    const vectors = findEmbeddingVectors(responseData);
    if (vectors) return vectors;

    throw new Error(t('无法从响应中提取embedding向量: {}', JSON.stringify(responseData)));
  }
}

// ============================================================
// partial JSON 解析（迁移自 partial_json.py）
// ============================================================

/**
 * 重新计算 s.slice(0, end) 的 bracket 栈
 * @param {string} s
 * @param {number} end
 * @returns {string[]}
 */
function _stackAt(s, end) {
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < end; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') stack.push('{');
    else if (ch === '[') stack.push('[');
    else if (ch === '}' && stack.length && stack[stack.length - 1] === '{') stack.pop();
    else if (ch === ']' && stack.length && stack[stack.length - 1] === '[') stack.pop();
  }
  return stack;
}

/**
 * 根据栈补足闭合括号
 * @param {string} body
 * @param {string[]} stack
 * @returns {string}
 */
function _closeBrackets(body, stack) {
  const tail = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    tail.push(stack[i] === '{' ? '}' : ']');
  }
  return body + tail.join('');
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function _tryParse(text) {
  try { JSON.parse(text); return true; } catch (_) { return false; }
}

/**
 * 把不完整的 JSON 子串补全为合法 JSON 字符串
 * @param {string} text
 * @returns {string|null}
 */
export function completePartialJson(text) {
  if (!text) return null;

  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{' || text[i] === '[') { start = i; break; }
  }
  if (start < 0) return null;

  const s = text.slice(start);
  const n = s.length;
  const stack = [];
  let inString = false;
  let escape = false;
  let safeEnd = -1;
  let lastNonspace = '';

  let i = 0;
  while (i < n) {
    const ch = s[i];

    if (inString) {
      if (escape) { escape = false; }
      else if (ch === '\\') { escape = true; }
      else if (ch === '"') { inString = false; lastNonspace = '"'; }
      i++;
      continue;
    }

    if (ch === '"') { inString = true; escape = false; i++; continue; }

    if (ch === '{') { stack.push('{'); lastNonspace = '{'; }
    else if (ch === '[') { stack.push('['); lastNonspace = '['; }
    else if (ch === '}') {
      if (stack.length && stack[stack.length - 1] === '{') { stack.pop(); lastNonspace = '}'; safeEnd = i + 1; }
    } else if (ch === ']') {
      if (stack.length && stack[stack.length - 1] === '[') { stack.pop(); lastNonspace = ']'; safeEnd = i + 1; }
    } else if (ch === ',') { lastNonspace = ','; safeEnd = i; }
    else if (ch === ':') { lastNonspace = ':'; }
    else if (!/\s/.test(ch)) { lastNonspace = ch; }

    i++;
  }

  // 已合法
  if (!inString && stack.length === 0) {
    if (_tryParse(s)) return s;
  }

  // 字符串未闭合
  if (inString) {
    let body = s;
    if (body.endsWith('\\')) body = body.slice(0, -1);
    body = body + '"';
    const closed = _closeBrackets(body, stack);
    if (_tryParse(closed)) return closed;
    if (safeEnd <= 0) return null;
    const b2 = s.slice(0, safeEnd);
    const c2 = _closeBrackets(b2, _stackAt(s, safeEnd));
    return _tryParse(c2) ? c2 : null;
  }

  // 末尾是残段
  if (lastNonspace === ',' || lastNonspace === ':') {
    if (safeEnd <= 0) return null;
    const body = s.slice(0, safeEnd);
    const closed = _closeBrackets(body, _stackAt(s, safeEnd));
    return _tryParse(closed) ? closed : null;
  }

  // 尝试直接补全
  const closed = _closeBrackets(s, [...stack]);
  if (_tryParse(closed)) return closed;

  // 兜底回退
  if (safeEnd > 0) {
    const body = s.slice(0, safeEnd);
    const c2 = _closeBrackets(body, _stackAt(s, safeEnd));
    if (_tryParse(c2)) return c2;
  }

  return null;
}

/**
 * 解析不完整 JSON 文本，失败返回 null
 * @param {string} text
 * @returns {any|null}
 */
export function parsePartialJson(text) {
  if (!text) return null;
  const stripped = text.trim();
  if (stripped) {
    try { return JSON.parse(stripped); } catch (_) { }
  }
  const closed = completePartialJson(text);
  if (closed === null) return null;
  try { return JSON.parse(closed); } catch (_) { return null; }
}

/**
 * 从不完整 JSON 构造一个简单对象（跳过验证）——流式 typed 场景用
 * 对标 Python parse_partial_into_model（Node 版无 Pydantic，返回原始 dict）
 * @param {string} text
 * @returns {object|null}
 */
export function parsePartialIntoObject(text) {
  const data = parsePartialJson(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data;
}

// ============================================================
// 模型配置解析（ModelConfigResolver — Node 简化版）
// ============================================================

/**
 * 模型角色 → category 映射
 * @type {Record<string, string>}
 */
const _ROLE_TO_CATEGORY = { primary: 'PRIMARY', secondary: 'SECONDARY' };

/**
 * 把 model_role（primary/secondary）归一化为 category 值
 * @param {string|null|undefined} modelRole
 * @returns {string}
 */
export function resolveModelCategory(modelRole) {
  if (!modelRole) return 'PRIMARY';
  const key = modelRole.trim().toLowerCase();
  if (_ROLE_TO_CATEGORY[key]) return _ROLE_TO_CATEGORY[key];
  return modelRole.trim().toUpperCase();
}

/**
 * TTL 内存缓存（简化版，无 DB 查询依赖）
 * Node 桌面版直接从环境变量 / 配置对象读取模型 config，
 * 不连接后端 PostgreSQL / Vastbase，与 Python 版解耦。
 */
class SimpleCache {
  /** @param {number} ttlMs */
  constructor(ttlMs = 180_000) {
    this._ttlMs = ttlMs;
    /** @type {Map<string, { value: any, expires: number }>} */
    this._map = new Map();
  }

  get(key) {
    const entry = this._map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) { this._map.delete(key); return undefined; }
    return entry.value;
  }

  set(key, value) {
    this._map.set(key, { value, expires: Date.now() + this._ttlMs });
  }

  invalidate() {
    this._map.clear();
  }
}

const _modelConfigCache = new SimpleCache(180_000);

/**
 * 模型配置解析器（Node 版 — 从外部注入或环境变量读取）
 *
 * Python 版依赖 SQLAlchemy + Vastbase DB 三层查找。Node 版简化为：
 * 1. 调用方通过 setModelConfigProvider() 注册一个 async 解析函数（供桌面应用注入 Electron Store 等）
 * 2. 若未注册，fallback 到环境变量 LLM_API_BASE / LLM_API_KEY / LLM_MODEL_NAME
 *
 * TODO: 若需要连 Vastbase 读取配置，可在此实现 HTTP 代理调用后端接口。
 */
export class ModelConfigResolver {
  /** @type {((opts: { model_id?: string, project_id?: string, category?: string }) => Promise<object>)|null} */
  static _provider = null;

  /**
   * 注册外部模型配置提供者
   * @param {(opts: object) => Promise<object>} fn
   */
  static setProvider(fn) {
    ModelConfigResolver._provider = fn;
    _modelConfigCache.invalidate();
  }

  static hasProvider() {
    return typeof ModelConfigResolver._provider === 'function';
  }

  /** 使 TTL 缓存即时失效（模型/项目配置变更后调用） */
  static invalidate() {
    _modelConfigCache.invalidate();
  }

  /**
   * 解析模型配置
   * @param {{ model_id?: string, project_id?: string, category?: string }} opts
   * @returns {Promise<{ model_name: string, api_base: string, api_key?: string, category?: string, extra_config?: object }>}
   */
  static async resolve({ model_id, project_id, category = 'PRIMARY' } = {}) {
    const cacheKey = `${model_id}|${project_id}|${category}`;
    const cached = _modelConfigCache.get(cacheKey);
    if (cached) return cached;

    let config;

    if (ModelConfigResolver._provider) {
      try {
        config = await ModelConfigResolver._provider({ model_id, project_id, category });
      } catch (error) {
        const missing = error instanceof ModelNotFoundError
          || /未找到可用模型|model[^\n]{0,40}not found/i.test(String(error?.message || error));
        if (String(category).toUpperCase() !== 'SECONDARY' || !missing) throw error;
        const fallbackCategory = 'PRIMARY';
        const fallbackKey = `${model_id}|${project_id}|${fallbackCategory}`;
        config = _modelConfigCache.get(fallbackKey);
        if (!config) {
          config = await ModelConfigResolver._provider({ model_id, project_id, category: fallbackCategory });
          _modelConfigCache.set(fallbackKey, config);
        }
        console.warn(`[model] SECONDARY 未配置，回退到 PRIMARY: project=${project_id || 'global'} model=${config?.model_name || ''}`);
      }
    } else {
      // fallback：环境变量
      const apiBase = process.env.LLM_API_BASE || '';
      const apiKey = process.env.LLM_API_KEY || '';
      const modelName = process.env.LLM_MODEL_NAME || model_id || 'gpt-4o';
      if (!apiBase) throw new ModelNotFoundError('未配置 LLM_API_BASE，且未注册 ModelConfigResolver provider');
      config = {
        id: model_id,
        model_name: modelName,
        api_base: apiBase,
        api_key: apiKey,
        category,
        supports_streaming: true,
        is_enabled: true,
        extra_config: {},
      };
    }

    _modelConfigCache.set(cacheKey, config);
    return config;
  }
}

/** 模块级失效入口（供外部调用） */
export function invalidateModelConfigCache() {
  ModelConfigResolver.invalidate();
}

/**
 * 文本向量化（OpenAI 兼容 /embeddings,默认解析 category=EMBEDDING 的模型,如 text-embedding-v3）。
 * 供 schema/实体/指标的向量召回(配合 vexdb_lite 扩展)。
 * @param {string|string[]} texts
 * @param {{model_id?:string, project_id?:string}} [opts]
 * @returns {Promise<number[]|number[][]>} 输入为单串返回单向量;为数组返回向量数组(按输入顺序)
 */
// 部分 embedding 服务(如 DashScope text-embedding-v3)单次请求 input 条数有上限(10),
// 这里内部自动分批,调用方无需关心批大小。
const EMBED_BATCH = Number(process.env.EMBED_BATCH || 10);

export async function embed(texts, { model_id = null, project_id = null } = {}) {
  const single = !Array.isArray(texts);
  const inputs = (single ? [texts] : texts).filter((s) => s != null && String(s).length);
  if (!inputs.length) return single ? null : [];
  const config = await ModelConfigResolver.resolve({ model_id, project_id, category: 'EMBEDDING' });
  const base = String(config.api_base || '').replace(/\/+$/, '');
  const url = /\/embeddings$/.test(base) ? base : `${base}/embeddings`;

  const all = [];
  for (let i = 0; i < inputs.length; i += EMBED_BATCH) {
    const chunk = inputs.slice(i, i + EMBED_BATCH);
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${config.api_key}` },
      body: JSON.stringify({ model: config.model_name, input: chunk }),
    });
    if (!resp.ok) {
      throw new Error(`embed ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    }
    const d = await resp.json();
    const vecs = (d.data || []).slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((x) => x.embedding);
    all.push(...vecs);
  }
  return single ? all[0] : all;
}

// ============================================================
// SelfConsistencyConfig
// ============================================================

/**
 * Self-consistency 配置对象
 */
export class SelfConsistencyConfig {
  /**
   * @param {object} [opts]
   * @param {number} [opts.n_candidates=1]
   * @param {number} [opts.base_temperature=0.3]
   * @param {number} [opts.temperature_variance=0.05]
   * @param {boolean} [opts.strict_mode=false]
   */
  constructor({ n_candidates = 1, base_temperature = 0.3, temperature_variance = 0.05, strict_mode = false } = {}) {
    if (n_candidates < 1) throw new Error('n_candidates must be >= 1');
    if (base_temperature < 0 || base_temperature > 2.0) throw new Error('base_temperature must be between 0 and 2.0');
    if (temperature_variance < 0) throw new Error('temperature_variance must be >= 0');
    this.n_candidates = n_candidates;
    this.base_temperature = base_temperature;
    this.temperature_variance = temperature_variance;
    this.strict_mode = strict_mode;
  }

  get enabled() {
    return this.n_candidates > 1;
  }
}

// ============================================================
// HTTP 请求构建（迁移自 http_client.py）
// ============================================================

/**
 * 构建请求头
 * @param {object} config
 * @returns {Record<string, string>}
 */
// 三套 API 协议族的端点路径(对齐厂商):Anthropic 原生 / OpenAI 兼容 / OpenAI Responses。
export const API_FORMAT_PATHS = {
  anthropic: '/v1/messages',
  chat_completions: '/chat/completions',
  responses: '/responses',
};
const apiFormatOf = (config) => {
  const f = config && config.api_format;
  return API_FORMAT_PATHS[f] ? f : 'chat_completions';
};

export function buildRequestHeaders(config) {
  const headers = { 'Content-Type': 'application/json' };
  // Anthropic 用 x-api-key + anthropic-version,其余(chat_completions/responses)用 Bearer
  if (apiFormatOf(config) === 'anthropic') {
    if (config.api_key) headers['x-api-key'] = config.api_key;
    headers['anthropic-version'] = config.anthropic_version || '2023-06-01';
  } else if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`;
  }
  const extra = config.extra_config;
  if (extra && typeof extra === 'object') {
    let extraHeaders = extra.extra_headers;
    if (extraHeaders) {
      try {
        if (typeof extraHeaders === 'string') extraHeaders = JSON.parse(extraHeaders);
        if (typeof extraHeaders === 'object') Object.assign(headers, extraHeaders);
      } catch (_) { }
    }
  }
  return headers;
}

/**
 * 按点路径设置嵌套值，如 'a.b' → data.a.b = value
 * @param {object} data
 * @param {string} path
 * @param {any} value
 */
function _setByPath(data, path, value) {
  const keys = String(path).split('.').filter(Boolean);
  if (!keys.length) return;
  let d = data;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!d[keys[i]] || typeof d[keys[i]] !== 'object') d[keys[i]] = {};
    d = d[keys[i]];
  }
  d[keys[keys.length - 1]] = value;
}

/**
 * 把 raw（dict 或 JSON 字符串）浅合并进 data
 * @param {object} data
 * @param {any} raw
 */
function _mergeJsonInto(data, raw) {
  if (!raw) return;
  try {
    let parsed = raw;
    if (typeof raw === 'string') parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') Object.assign(data, parsed);
  } catch (_) { }
}

/**
 * 注入「思考设置」参数（对标 Python _apply_thinking）
 * @param {object} data
 * @param {object} extra
 */
function _applyThinking(data, extra) {
  const th = extra.thinking;
  if (th && typeof th === 'object' && th.param) {
    _setByPath(data, th.param, th.value !== undefined ? th.value : false);
    return;
  }
  // 兼容旧格式 disable_thinking
  const dt = extra.disable_thinking;
  if (dt && typeof dt === 'object' && dt.enabled) {
    _mergeJsonInto(data, dt.params);
  }
}

/**
 * 构建请求体
 * @param {object} config
 * @param {object} kwargs  其余字段（messages, temperature, max_tokens, stream, ...）
 * @returns {object}
 */
export function buildRequestData(config, kwargs = {}) {
  const fmt = apiFormatOf(config);
  const extra = config.extra_config;
  if (fmt === 'anthropic') return _buildAnthropicData(config, kwargs, extra);
  if (fmt === 'responses') return _buildResponsesData(config, kwargs, extra);
  // chat_completions(默认,行为不变)
  const data = { model: config.model_name, ...kwargs };
  if (extra && typeof extra === 'object') {
    _applyThinking(data, extra);
    _mergeJsonInto(data, extra.extra_body);
  }
  return data;
}

// Anthropic Messages:system 拆出顶层、max_tokens 必填、只保留 user/assistant 轮次;
// OpenAI 专有字段(stream_options/enable_thinking/chat_template_kwargs 等)不透传。
// 注:tools 的 schema 与 OpenAI 不同,此处不做工具转译(基础对话/连通性可用)。
function _buildAnthropicData(config, kwargs, extra) {
  const { messages, max_tokens, temperature, stream } = kwargs;
  const msgs = Array.isArray(messages) ? messages : [];
  const systemParts = msgs.filter((m) => m.role === 'system').map((m) => m.content).filter(Boolean);
  const convo = msgs.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content }));
  const data = {
    model: config.model_name,
    max_tokens: max_tokens || 4096,
    messages: convo.length ? convo : [{ role: 'user', content: '' }],
  };
  if (systemParts.length) data.system = systemParts.join('\n\n');
  if (temperature != null) data.temperature = temperature;
  if (stream != null) data.stream = stream;
  if (extra && typeof extra === 'object') _mergeJsonInto(data, extra.extra_body);
  return data;
}

// OpenAI Responses:input 取代 messages、max_output_tokens 取代 max_tokens。
function _buildResponsesData(config, kwargs, extra) {
  const { messages, max_tokens, temperature, stream } = kwargs;
  const data = {
    model: config.model_name,
    input: Array.isArray(messages)
      ? messages.map((m) => ({ role: m.role, content: m.content }))
      : (messages || ''),
  };
  if (max_tokens != null) data.max_output_tokens = max_tokens;
  if (temperature != null) data.temperature = temperature;
  if (stream != null) data.stream = stream;
  if (extra && typeof extra === 'object') _mergeJsonInto(data, extra.extra_body);
  return data;
}

/**
 * 构建 API URL（取 api_base 并 rstrip '/')
 * @param {object} config
 * @returns {string}
 */
export function getApiUrl(config) {
  const apiBase = config.api_base || '';
  if (!apiBase) throw new Error(t('缺少API Base URL'));
  const base = apiBase.replace(/\/+$/, '');
  // api_base 已含任一已知端点路径(/chat/completions、/v1/messages、/responses)时按原样用
  for (const p of Object.values(API_FORMAT_PATHS)) {
    if (base.endsWith(p)) return base;
  }
  return `${base}${API_FORMAT_PATHS[apiFormatOf(config)]}`;
}

/**
 * 从响应体 bytes/text 提取错误详情
 * @param {string|Buffer} body
 * @returns {string}
 */
export function extractErrorDetail(body) {
  try {
    const text = typeof body === 'string' ? body : body.toString('utf-8');
    const err = JSON.parse(text);
    return err?.error?.message || err?.message || text.slice(0, 200);
  } catch (_) {
    const text = typeof body === 'string' ? body : (body ? body.toString() : '');
    return text.slice(0, 200);
  }
}

/**
 * 构建统一的模型服务错误
 * @param {string} detail
 * @returns {Error}
 */
export function buildModelServiceError(detail) {
  if (detail) {
    return new Error(`${t('模型服务报错，该模型服务返回报错信息为：')}\n${detail}\n${t('请检查模型服务配置。')}`);
  }
  return new Error(t('模型服务报错，请检查模型服务配置。'));
}

// ============================================================
// 核心 LLM 请求函数
// ============================================================

/**
 * 发送非流式 POST 请求并返回响应 JSON
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {object} body
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<object>}
 */
async function _makeApiRequest(url, headers, body, { timeoutMs = 60_000, maxRetries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // 网络瞬时错误(非超时)退避重试;超时直接抛(避免成倍放大已超时的等待)
      if (err.name !== 'AbortError' && attempt < maxRetries) {
        await sleep(_retryBackoffMs(attempt + 1));
        continue;
      }
      if (err.name === 'AbortError') throw new Error(`${t('API请求超时')}: ${url}`);
      throw err;
    }
    clearTimeout(timer);

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const detail = extractErrorDetail(bodyText);
      // 429 限流 / 5xx 瞬时错误:指数退避重试(尊重 Retry-After 头),避免并发压测把答案打空
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const ra = Number(response.headers.get('retry-after'));
        const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : _retryBackoffMs(attempt + 1);
        console.warn(`API ${response.status} 限流/瞬时错误,第 ${attempt + 1}/${maxRetries} 次退避 ${waitMs}ms 后重试`);
        await sleep(waitMs);
        continue;
      }
      console.error(`API错误(${response.status}): ${detail}`);
      throw buildModelServiceError(detail);
    }

    const payload = await response.json();
    const usage = extractUsageFromResponse(payload);
    if (usage) recordUsage(usage, body.model || '');
    return payload;
  }
}

/** 指数退避 + 抖动(毫秒):1s/2s/4s/8s/16s,上限 20s。 */
function _retryBackoffMs(attempt) {
  const base = Math.min(1000 * 2 ** (attempt - 1), 20_000);
  return base + Math.floor(Math.random() * 500);
}

/**
 * 规范化消息列表
 * @param {string|Array<object>} messages
 * @param {string|null} [systemMessage]
 * @returns {Array<object>}
 */
function _normalizeMessages(messages, systemMessage = null) {
  if (typeof messages === 'string') {
    const result = [];
    if (systemMessage) result.push({ role: 'system', content: systemMessage });
    result.push({ role: 'user', content: messages });
    return result;
  }
  if (Array.isArray(messages)) {
    if (systemMessage && !messages.some(m => m.role === 'system')) {
      return [{ role: 'system', content: systemMessage }, ...messages];
    }
    return messages;
  }
  throw new Error(`${t('不支持的消息类型')}: ${typeof messages}`);
}

/**
 * 确保 messages 中包含 'json' 关键词（部分模型 API 要求）
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
function _ensureJsonHintInMessages(messages) {
  if (messages.some(m => (m.content || '').toLowerCase().includes('json'))) return messages;
  const result = messages.map(m => ({ ...m }));
  for (let i = result.length - 1; i >= 0; i--) {
    if (result[i].role === 'user') {
      result[i].content = result[i].content + '\n请以json格式返回结果。';
      break;
    }
  }
  return result;
}

/**
 * 格式化日志消息
 * @param {string} role
 * @param {string} content
 * @returns {string}
 */
function _formatLogMessage(role, content) {
  return content; // 与 Python 一致：全量输出（过滤规则当前为空）
}

/**
 * 记录 LLM 调用输入/输出到 console
 * @param {string} modelName
 * @param {Array<object>} messages
 * @param {string} response
 * @param {boolean} [isStream=false]
 */
function _logLlmCall(modelName, messages, response, isStream = false) {
  const inputLines = messages.map(m => `[${m.role || 'unknown'}]: ${_formatLogMessage(m.role, m.content || '')}`);
  const sep = '='.repeat(60);
  console.info([
    '',
    sep,
    `Model: ${modelName}${isStream ? ' [stream]' : ''}`,
    sep,
    '>>> INPUT:',
    inputLines.join('\n'),
    sep,
    '<<< OUTPUT:',
    response,
    sep,
    '',
  ].join('\n'));
}

// ============================================================
// 计算 Self-consistency 温度
// ============================================================

function _calculateTemperature(sc, index) {
  if (sc.n_candidates === 1) return sc.base_temperature;
  const minTemp = sc.base_temperature - sc.temperature_variance * (sc.n_candidates - 1) / 2;
  return Math.max(0.01, Math.min(2.0, minTemp + index * sc.temperature_variance));
}

// ============================================================
// 流式响应生成器（SSE 解析）
// ============================================================

/**
 * 流式 SSE 请求，yield delta 文本 chunks
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {object} body
 * @param {boolean} [cleanThinkingTags=true]
 * @returns {AsyncGenerator<string, void, undefined>}
 */
async function* _streamResponse(url, headers, body, cleanThinkingTags = true, onUsage = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600_000);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`${t('API请求超时')}: ${url}`);
    throw err;
  }

  if (!response.ok) {
    clearTimeout(timer);
    const bodyText = await response.text().catch(() => '');
    const detail = extractErrorDetail(bodyText);
    throw buildModelServiceError(detail);
  }

  let lastUsage = null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // 最后一段可能不完整
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === 'data: [DONE]') break;

        const content = ResponseExtractor.extract_stream_chunk(trimmed, cleanThinkingTags);
        if (content !== null) {
          yield content;
        }

        // 捕获 usage（流式末尾 chunk）
        if (trimmed.startsWith('data: ') && trimmed.includes('"usage"')) {
          try {
            const chunkData = JSON.parse(trimmed.slice(6));
            const u = extractUsageFromResponse(chunkData);
            if (u) lastUsage = u;
          } catch (_) { }
        }
      }
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
    if (lastUsage) recordUsage(lastUsage, body.model || '');
    if (lastUsage && typeof onUsage === 'function') onUsage(lastUsage);
  }
}

// ============================================================
// 流式连接重试包装
// ============================================================

const _RETRIABLE = new Set([
  'ConnectionError', 'TimeoutError', 'FetchError', 'AbortError',
  'NetworkError', 'TypeError',  // fetch network failure often surfaces as TypeError
]);

/**
 * 流式调用的"连接 + 首 chunk"重试包装
 * @param {() => AsyncGenerator<string, void, undefined>} makeStream
 * @param {{ maxRetries?: number, baseDelay?: number }} [opts]
 * @returns {AsyncGenerator<string, void, undefined>}
 */
async function* _streamWithConnectRetry(makeStream, { maxRetries = 2, baseDelay = 0.5 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const gen = makeStream();
    try {
      const { value, done } = await gen.next();
      if (done) return;  // 空流
      yield value;
      // 首 chunk 已出——不可重试
      yield* gen;
      return;
    } catch (err) {
      lastErr = err;
      // 关闭 generator（尽力）
      try { await gen.return(); } catch (_) { }

      const isRetriable = _RETRIABLE.has(err.name) || err.name?.includes('Timeout') || err.name?.includes('Network');
      if (!isRetriable || attempt >= maxRetries) {
        console.warn(`[stream-retry] 连接重试 ${attempt + 1} 次仍失败，放弃: ${err.message}`);
        throw err;
      }
      const delay = (baseDelay * Math.pow(2, attempt) + Math.random() * 0.3) * 1000;
      console.warn(`[stream-retry] 第 ${attempt + 1}/${maxRetries + 1} 次连接失败，${(delay / 1000).toFixed(2)}s 后重试: ${err.message}`);
      await sleep(delay);
    }
  }
  if (lastErr) throw lastErr;
}

// ============================================================
// _chatRaw
// ============================================================

/**
 * 处理普通和流式输出的底层 chat 调用
 * @param {object} opts
 * @returns {Promise<string | AsyncGenerator<string>>}
 */
async function _chatRaw({
  messages,
  stream,
  temperature,
  max_tokens,
  model_id,
  project_id,
  model_category = 'PRIMARY',
  clean_thinking_tags = true,
  response_format,
  call_site,
  request_timeout_ms = 600_000,
  request_retries = 5,
  ...rest
}) {
  const config = await ModelConfigResolver.resolve({ model_id, project_id, category: model_category });

  set_current_model_meta({
    model_id: config.id,
    model_category: config.category,
    requested_role: _current_requested_role_val,
  });

  const headers = buildRequestHeaders(config);
  const requestKwargs = {
    messages,
    temperature,
    max_tokens,
    ...rest,
  };
  if (response_format) requestKwargs.response_format = response_format;

  const requestData = buildRequestData(config, requestKwargs);

  // 流式时要求 provider 在末尾 chunk 带 usage(stream_options 仅 OpenAI 兼容端点支持)
  if (stream && apiFormatOf(config) === 'chat_completions' && !requestData.stream_options) {
    requestData.stream_options = { include_usage: true };
  }
  requestData.stream = stream;

  const apiUrl = getApiUrl(config);
  const traceCallSite = call_site || _current_call_site_val || 'unknown';

  if (stream) {
    let traceUsage = null;
    const makeStream = () => _streamResponse(apiUrl, headers, requestData, clean_thinking_tags, (usage) => {
      traceUsage = usage;
    });
    const baseGen = _streamWithConnectRetry(makeStream);

    // 用于 logging：累积后打日志
    async function* _loggingStream() {
      const chunks = [];
      const traceStartedAt = Date.now();
      let streamError = null;
      try {
        for await (const c of baseGen) {
          chunks.push(c);
          yield c;
        }
      } catch (err) {
        streamError = err;
        throw err;
      } finally {
        const output = chunks.join('');
        if (chunks.length > 0) _logLlmCall(config.model_name, messages, output, true);
        recordTraceLlmCall({
          callSite: traceCallSite,
          model: config.model_name,
          modelId: config.id,
          input: messages,
          output,
          error: streamError,
          durationMs: Date.now() - traceStartedAt,
          usage: traceUsage,
          attrs: { stream: true, response_format: response_format?.type || '' },
        });
      }
    }

    return _loggingStream();
  } else {
    const traceStartedAt = Date.now();
    let content = '';
    let callError = null;
    let traceUsage = null;
    try {
      const responseData = await _makeApiRequest(apiUrl, headers, requestData, {
        timeoutMs: Math.max(1, Number(request_timeout_ms) || 600_000),
        maxRetries: Math.max(0, Math.trunc(Number(request_retries) || 0)),
      });
      traceUsage = extractUsageFromResponse(responseData);
      content = ResponseExtractor.extract_chat_content(responseData, clean_thinking_tags);
      content = (content || '').trim();
      return content;
    } catch (err) {
      callError = err;
      throw err;
    } finally {
      if (!callError || content) _logLlmCall(config.model_name, messages, content);
      recordTraceLlmCall({
        callSite: traceCallSite,
        model: config.model_name,
        modelId: config.id,
        input: messages,
        output: content,
        error: callError,
        durationMs: Date.now() - traceStartedAt,
        usage: traceUsage,
        attrs: { stream: false, response_format: response_format?.type || '' },
      });
    }
  }
}

// ============================================================
// _chatTyped（带 schema 的 JSON 输出）
// ============================================================

/**
 * 获取 schema 字段提示字符串
 * @param {object|null} schema  JSON Schema object（response_model 的 JSON Schema）
 * @returns {string}
 */
function _getSchemaFieldsHint(schema) {
  if (!schema || typeof schema !== 'object') return '请参考系统提示词中的输出格式要求';
  try {
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    return Object.keys(props)
      .map(name => `- ${name}: ${required.has(name) ? '必填' : '可选'}`)
      .join('\n') || '请参考系统提示词中的输出格式要求';
  } catch (_) {
    return '请参考系统提示词中的输出格式要求';
  }
}

/**
 * 类型安全的非流式 chat 调用（返回解析后的 JS 对象）
 * response_model 可为 JSON Schema 对象，也可为 class（有 fromJSON 静态方法）
 *
 * @param {object} opts
 * @param {Array<object>} opts.messages
 * @param {object|null} [opts.response_model]  JSON Schema / class
 * @param {number} [opts.temperature]
 * @param {number} [opts.max_tokens]
 * @param {string} [opts.model_id]
 * @param {string} [opts.project_id]
 * @param {string} [opts.model_category]
 * @param {number} [opts.max_retries]
 * @param {boolean} [opts.clean_thinking_tags]
 * @param {object} [opts.response_format]
 * @param {boolean} [opts._skip_json_hint]
 * @returns {Promise<object>}
 */
async function _chatTyped({
  messages,
  response_model,
  temperature,
  max_tokens,
  model_id,
  project_id,
  model_category = 'PRIMARY',
  max_retries = 2,
  clean_thinking_tags = true,
  response_format,
  _skip_json_hint = false,
  call_site,
  ...rest
}) {
  const errors = [];
  let lastError = null;
  let msgs = _skip_json_hint ? messages : _ensureJsonHintInMessages(messages);
  let retryMsgs = msgs;

  for (let attempt = 0; attempt < max_retries; attempt++) {
    try {
      const adjustedTemp = Math.min(temperature + attempt * 0.1, 1.0);
      const raw = await _chatRaw({
        messages: retryMsgs,
        stream: false,
        temperature: adjustedTemp,
        max_tokens,
        model_id,
        project_id,
        model_category,
        clean_thinking_tags: false,
        response_format: { type: 'json_object' },
        call_site,
        ...rest,
      });

      const cleanedJson = ResponseExtractor.clean_llm_json_response(raw, true);
      const parsed = JSON.parse(cleanedJson);

      // 如果 response_model 是有 fromJSON 静态方法的 class，用它
      if (response_model && typeof response_model.fromJSON === 'function') {
        return response_model.fromJSON(parsed);
      }
      return parsed;
    } catch (err) {
      lastError = err;
      if (err instanceof JSONExtractionError) {
        errors.push(`尝试${attempt + 1}: ${err.message}`);
        console.warn(`LLM 响应格式错误(尝试${attempt + 1}): ${err.message}`);
        if (attempt < max_retries - 1) {
          const hint = `你的上一次响应格式错误，未返回有效的 JSON 对象。\n` +
            `请严格按照要求的 JSON 格式响应，必须包含以下字段:\n` +
            _getSchemaFieldsHint(response_model);
          retryMsgs = [...msgs,
            { role: 'assistant', content: (err.raw_response || '').slice(0, 200) },
            { role: 'user', content: hint },
          ];
          await sleep(500 * (attempt + 1));
        }
      } else if (err instanceof SyntaxError || err.name === 'SyntaxError') {
        // JSON.parse 失败
        errors.push(`尝试${attempt + 1}: ${err.message}`);
        console.warn(`响应验证失败(尝试${attempt + 1}): ${err.message}`);
        if (attempt < max_retries - 1) {
          const hint = `你的上一次响应的 JSON 字段不完整或格式不正确。\n错误: ${String(err).slice(0, 200)}\n` +
            `请严格按照要求的 JSON 格式响应。`;
          retryMsgs = [...msgs, { role: 'user', content: hint }];
          await sleep(500 * (attempt + 1));
        }
      } else {
        errors.push(`尝试${attempt + 1}: ${err.message}`);
        console.error(`类型化调用失败: ${err.message}`);
        if (attempt < max_retries - 1) await sleep(1000 * (attempt + 1));
      }
    }
  }

  const modelName = response_model?.name || 'object';
  const error = new Error(
    `${t('无法生成有效的')}${modelName}${t('对象')}: ${errors.join('; ')}`,
    lastError ? { cause: lastError } : undefined,
  );
  error.code = lastError instanceof JSONExtractionError
    || lastError instanceof SyntaxError
    || lastError?.name === 'SyntaxError'
    ? 'LLM_JSON_INVALID'
    : 'LLM_TYPED_FAILED';
  throw error;
}

// ============================================================
// _chatTypedStream（流式 + 部分 JSON 解析）
// ============================================================

/**
 * 类型安全的流式 chat，逐步 yield 部分对象，最后 yield 完整 validated 对象
 * @param {object} opts
 * @returns {AsyncGenerator<object, void, undefined>}
 */
async function* _chatTypedStream({
  messages,
  response_model,
  temperature,
  max_tokens,
  model_id,
  project_id,
  model_category = 'PRIMARY',
  clean_thinking_tags = true,
  response_format,
  call_site,
  ...rest
}) {
  const msgs = _ensureJsonHintInMessages(messages);
  const rawBuffer = [];
  let lastDict = null;
  const t0 = Date.now();

  try {
    const streamGen = await _chatRaw({
      messages: msgs,
      stream: true,
      temperature,
      max_tokens,
      model_id,
      project_id,
      model_category,
      clean_thinking_tags: false,
      response_format: { type: 'json_object' },
      call_site,
      ...rest,
    });

    for await (const chunk of streamGen) {
      if (!chunk) continue;
      rawBuffer.push(chunk);
      const buffer = rawBuffer.join('');

      const partial = parsePartialIntoObject(buffer);
      if (partial === null) continue;

      // 只有字段真正变化时才 yield
      const partialStr = JSON.stringify(partial);
      if (partialStr !== lastDict) {
        lastDict = partialStr;
        yield partial;
      }
    }
  } catch (streamErr) {
    console.warn(`typed-stream 解析失败，回退到非流式: ${streamErr.message}`);
    const final = await _chatTyped({
      messages: msgs,
      response_model,
      temperature,
      max_tokens,
      model_id,
      project_id,
      model_category,
      clean_thinking_tags,
      response_format,
      _skip_json_hint: true,
      call_site,
      ...rest,
    });
    yield final;
    return;
  }

  // 流结束：严格 validate
  const raw = rawBuffer.join('');
  try {
    const cleaned = ResponseExtractor.clean_llm_json_response(raw, true);
    const final = JSON.parse(cleaned);
    // 总是 yield 一次 validated final
    yield final;
  } catch (parseErr) {
    console.warn(`typed-stream 最终 validate 失败，回退到非流式: ${parseErr.message}`);
    const final = await _chatTyped({
      messages: msgs,
      response_model,
      temperature,
      max_tokens,
      model_id,
      project_id,
      model_category,
      clean_thinking_tags,
      response_format,
      _skip_json_hint: true,
      call_site,
      ...rest,
    });
    yield final;
  }
}

// ============================================================
// _chatWithSelfConsistency
// ============================================================

async function _chatWithSelfConsistency({
  messages,
  response_model,
  self_consistency,
  max_tokens,
  model_id,
  project_id,
  model_category = 'PRIMARY',
  clean_thinking_tags = true,
  response_format,
  call_site,
}) {
  const tasks = [];
  for (let i = 0; i < self_consistency.n_candidates; i++) {
    const temperature = _calculateTemperature(self_consistency, i);
    const params = { messages, temperature, max_tokens, model_id, project_id, model_category, clean_thinking_tags, response_format, call_site };
    if (response_model) {
      tasks.push(_chatTyped({ ...params, response_model }));
    } else {
      tasks.push(_chatRaw({ ...params, stream: false }));
    }
  }

  const results = await Promise.allSettled(tasks);
  const finalResults = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      finalResults.push(r.value);
    } else {
      console.warn(`候选 ${i + 1} 失败: ${r.reason}`);
      if (self_consistency.strict_mode) {
        throw new Error(`${t('候选')} ${i + 1} ${t('失败')}: ${r.reason}`);
      }
    }
  }

  if (self_consistency.strict_mode && finalResults.length < self_consistency.n_candidates) {
    throw new Error(`${t('严格模式失败')}: ${finalResults.length}/${self_consistency.n_candidates} ${t('成功')}`);
  }

  return finalResults;
}

// ============================================================
// 重试装饰器（内联实现，对标 Python @retry）
// ============================================================

/**
 * 带重试的 async 函数包装
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ maxRetries?: number, delay?: number, backoff?: number }} [opts]
 * @returns {Promise<T>}
 */
async function _withRetry(fn, { maxRetries = 3, delay = 1000, backoff = 2.0 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const waitMs = delay * Math.pow(backoff, attempt);
        console.warn(`重试LLM调用(${attempt + 1}): ${err.message}`);
        await sleep(waitMs);
      }
    }
  }
  console.error(`LLM调用失败: ${lastErr?.message}`);
  throw lastErr;
}

// ============================================================
// chat() — 统一 LLM 调用接口（对外暴露）
// ============================================================

/**
 * 统一的 LLM 调用接口，对标 Python chat()
 *
 * 支持五种模式：
 * 1. 普通模式: chat("你好") -> Promise<string>
 * 2. 流式模式: chat("你好", { stream: true }) -> Promise<AsyncGenerator<string>>
 * 3. 类型安全: chat("你好", { response_model: schema }) -> Promise<object>
 * 4. 类型安全流式: chat("你好", { response_model: schema, stream: true }) -> AsyncGenerator<object>
 * 5. Self-consistency: chat("你好", { self_consistency: config }) -> Promise<Array>
 *
 * @param {string|Array<object>} messages
 * @param {object} [opts]
 * @param {object|null} [opts.response_model]  JSON Schema / class with fromJSON
 * @param {boolean} [opts.stream=false]
 * @param {number} [opts.temperature=0.7]
 * @param {number} [opts.max_tokens=8000]
 * @param {string|null} [opts.model_id]
 * @param {string|null} [opts.project_id]
 * @param {string} [opts.model_role='primary']  'primary' | 'secondary'
 * @param {boolean} [opts.clean_thinking_tags=true]
 * @param {string|null} [opts.system_message]
 * @param {object|null} [opts.response_format]
 * @param {number} [opts.transport_retries=3] 网关层失败后的额外重试次数
 * @param {SelfConsistencyConfig|null} [opts.self_consistency]
 * @param {string|null} [opts.call_site]
 * @returns {Promise<string|object|Array|AsyncGenerator>}
 */
export async function chat(messages, {
  response_model = null,
  stream = false,
  temperature = 0.7,
  max_tokens = 8000,
  model_id = null,
  project_id = null,
  model_role = 'primary',
  clean_thinking_tags = true,
  system_message = null,
  response_format = null,
  transport_retries = 3,
  self_consistency = null,
  call_site = null,
  // 吃掉杂散的 messages 键:调用方常以 chat(kwargs.messages, kwargs) 形式传入(kwargs 内含 messages),
  // 若不在此捕获,它会落进 ...kwargs 并在下游 {messages: normalized, ...kwargs} 中覆盖掉带 system 的 normalized。
  messages: _ignoredMessages = undefined,
  ...kwargs
} = {}) {
  const model_category = resolveModelCategory(model_role);
  const transportRetryOptions = {
    maxRetries: Math.max(0, Math.trunc(Number(transport_retries) || 0)),
  };

  // 调用点 id 设置（供 token 按调用点计量）
  set_current_call_site(call_site || 'unknown');
  set_current_requested_role(model_role);

  console.debug(`[CHAT] 入口参数: model_id=${model_id}, project_id=${project_id}, role=${model_role}, category=${model_category}, stream=${stream}, typed=${Boolean(response_model)}`);

  const normalized = _normalizeMessages(messages, system_message);

  // Self-consistency 与流式互斥
  let effectiveStream = stream;
  if (self_consistency && self_consistency.enabled && stream) {
    effectiveStream = false;
  }

  // Self-consistency 模式
  if (self_consistency && self_consistency.enabled) {
    return _withRetry(() => _chatWithSelfConsistency({
      messages: normalized,
      response_model,
      self_consistency,
      max_tokens,
      model_id,
      project_id,
      model_category,
      clean_thinking_tags,
      response_format,
      call_site,
    }), transportRetryOptions);
  }

  // typed + stream
  if (response_model && effectiveStream) {
    return _chatTypedStream({
      messages: normalized,
      response_model,
      temperature,
      max_tokens,
      model_id,
      project_id,
      model_category,
      clean_thinking_tags,
      response_format,
      call_site,
      ...kwargs,
    });
  }

  // typed（非流式）
  if (response_model) {
    return _withRetry(() => _chatTyped({
      messages: normalized,
      response_model,
      temperature,
      max_tokens,
      model_id,
      project_id,
      model_category,
      clean_thinking_tags,
      response_format,
      call_site,
      ...kwargs,
    }), transportRetryOptions);
  }

  // 普通 / 流式（无 response_model）
  const rawOpts = {
    messages: normalized,
    stream: effectiveStream,
    temperature,
    max_tokens,
    model_id,
    project_id,
    model_category,
    clean_thinking_tags,
    response_format,
    call_site,
    ...kwargs,
  };

  if (effectiveStream) {
    // 流式：直接返回 generator（不包 retry，_streamWithConnectRetry 内部已处理首 chunk 重试）
    return _chatRaw(rawOpts);
  }

  return _withRetry(() => _chatRaw(rawOpts), transportRetryOptions);
}

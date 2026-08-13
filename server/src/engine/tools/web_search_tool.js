// 迁移自 core/agentic_flow/demo/deep_research_discussion/tools/web_search_tool.py
//
// WebSearchTool - 网络搜索工具
//
// 支持多种搜索引擎 API，提供统一的搜索接口；根据不同专家角色调整搜索策略。
//
// 迁移要点：
// - Python httpx/requests → Node 内置 fetch（无需第三方依赖）。
// - API key：优先取构造时注入的 deps（{ env }），否则回落 process.env；不硬编码。
// - logging → console。
// - 对外接口保持一致：class WebSearchTool extends BaseTool，execute(context, kwargs) → Result。

import { BaseTool, Result } from '../core/base_tool.js';

// 轻量 logger（对应 Python logging.getLogger）
const logger = {
  error: (...args) => console.error('[WebSearchTool]', ...args),
  warn: (...args) => console.warn('[WebSearchTool]', ...args),
  info: (...args) => console.info('[WebSearchTool]', ...args),
};

function appendQuery(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined) continue;
    url.searchParams.append(k, String(v));
  }
  return url.toString();
}

function searchEndpoint(rawValue, fallback, label) {
  const value = String(rawValue || fallback || '').trim();
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('unsupported URL');
    }
    return { url: parsed.toString(), config_error: null };
  } catch {
    return { url: value, config_error: `${label} API URL 无效` };
  }
}

/**
 * 网络搜索工具（对应 Python class WebSearchTool）
 *
 * 默认使用内置网页搜索；如配置通用搜索 API，则改用该接口。
 */
export class WebSearchTool extends BaseTool {
  /**
   * @param {object} [deps] 可注入依赖
   * @param {object} [deps.env] API 配置来源（覆盖 process.env），如 { DSH_WEB_SEARCH_API_URL, DSH_WEB_SEARCH_API_KEY }
   * @param {typeof fetch} [deps.fetch] 自定义 fetch（便于测试），默认全局 fetch
   */
  constructor(deps = {}) {
    super('web_search', '网络搜索工具，获取最新信息', { version: '1.0.0' });

    // API key / fetch 注入：优先 deps.env，回落 process.env
    this._env = deps.env || (typeof process !== 'undefined' ? process.env : {}) || {};
    this._fetch = deps.fetch || (typeof fetch !== 'undefined' ? fetch : null);

    const customUrl = String(this._getEnv('DSH_WEB_SEARCH_API_URL') || '').trim();
    const customKey = String(this._getEnv('DSH_WEB_SEARCH_API_KEY') || '').trim();
    const customRequested = Boolean(customUrl || customKey);
    const customEndpoint = customUrl
      ? searchEndpoint(customUrl, '', '搜索')
      : { url: '', config_error: customRequested ? '搜索 API URL 未配置' : null };

    this.search_engines = {
      custom: {
        ...customEndpoint,
        api_key_env: 'DSH_WEB_SEARCH_API_KEY',
        enabled: Boolean(customUrl) && !customEndpoint.config_error,
      },
      builtin: {
        url: 'https://html.duckduckgo.com/html/',
        config_error: null,
        api_key_env: null,
        enabled: !customRequested,
      },
    };

    this.custom_search_requested = customRequested;
    this.configuration_error = null;

    // 选择可用的搜索引擎
    this.active_engine = this._select_search_engine();
  }

  /** 从注入的 env / process.env 读取 key（对应 os.getenv） */
  _getEnv(name) {
    if (!name) return undefined;
    return this._env?.[name];
  }

  /**
   * 配置了通用 API 时固定使用它；否则使用内置搜索。
   * @returns {string|null}
   */
  _select_search_engine() {
    if (this.custom_search_requested) {
      const selected = this.search_engines.custom;
      if (selected?.config_error) {
        this.configuration_error = selected.config_error;
        logger.warn(this.configuration_error);
        return null;
      }
      if (selected?.enabled) {
        logger.info('使用自定义搜索 API');
        return 'custom';
      }
      this.configuration_error = '搜索 API 配置不可用';
      logger.warn(this.configuration_error);
      return null;
    }
    if (this.search_engines.builtin.enabled) {
      logger.info('使用内置搜索');
      return 'builtin';
    }
    logger.warn('没有可用的搜索引擎');
    return null;
  }

  /**
   * 执行网络搜索（对应 async execute）
   *
   * @param {object} context Agent 上下文
   * @param {object} [kwargs]
   * @param {string} [kwargs.query] 搜索查询
   * @param {number} [kwargs.max_results=10] 最大结果数
   * @param {string} [kwargs.role='general'] 专家角色，用于调整搜索策略
   * @param {string} [kwargs.search_type='web'] 搜索类型（web, news, academic 等）
   * @returns {Promise<Result>}
   */
  async execute(context, kwargs = {}) {
    const query = kwargs.query ?? '';
    if (!query) {
      return Result.createError('缺少查询参数');
    }

    const max_results = kwargs.max_results ?? 10;
    const role = kwargs.role ?? 'general';
    const search_type = kwargs.search_type ?? 'web';

    // 根据角色调整查询
    const adapted_query = this._adapt_query_for_role(query, role);

    logger.info(`开始搜索: ${adapted_query} (角色: ${role})`);
    this.last_error = null;

    // 执行搜索
    if (!this.active_engine) return Result.createError(this.configuration_error || '没有可用的搜索引擎');
    const results = await this._real_search(adapted_query, max_results, search_type);

    if (!results || results.length === 0) {
      return Result.createError(this.last_error ? `搜索失败：${this.last_error}` : '搜索无结果');
    }

    // 处理结果
    const processed_results = this._process_results(results, role);

    return Result.create({
      query,
      adapted_query,
      role,
      search_engine: this.active_engine,
      results: processed_results,
      total_results: processed_results.length,
      search_time: new Date().toISOString(),
    });
  }

  /**
   * 根据角色调整搜索查询（对应 _adapt_query_for_role）
   * @param {string} query
   * @param {string} role
   * @returns {string}
   */
  _adapt_query_for_role(query, role) {
    const role_keywords = {
      技术专家: ['技术实现', '架构设计', '最佳实践', 'scalability', 'performance'],
      业务分析师: ['商业模式', 'ROI', '市场分析', '成本效益', 'business case'],
      行业专家: ['行业趋势', '标杆案例', '最佳实践', 'industry report'],
      研究员: ['研究', '数据', '统计', '报告', 'study'],
      质疑者: ['风险', '挑战', '问题', '失败案例', 'limitations'],
      主持人: ['概述', '总结', '关键点', 'overview'],
    };

    if (Object.prototype.hasOwnProperty.call(role_keywords, role)) {
      // 添加角色相关关键词
      const keywords = role_keywords[role];
      return `${query} (${keywords.slice(0, 2).join(' OR ')})`;
    }

    return query;
  }

  /**
   * 真实的网络搜索（对应 _real_search）
   * @param {string} query
   * @param {number} max_results
   * @param {string} search_type
   * @returns {Promise<Array<object>>}
   */
  async _real_search(query, max_results, search_type) {
    if (this.active_engine === 'custom') {
      return this._search_with_custom_api(query, max_results, search_type);
    }
    if (this.active_engine === 'builtin') {
      return this._search_with_builtin(query, max_results);
    }
    return [];
  }

  async _getText(baseUrl, { params = {}, headers = {} } = {}) {
    if (!this._fetch) throw new Error('当前运行环境不支持 fetch');
    const url = appendQuery(baseUrl, params);
    const response = await this._fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15_000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; DshSearch/1.0)', ...headers },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    return response.text();
  }

  async _postJson(url, { body = {}, headers = {} } = {}) {
    if (!this._fetch) throw new Error('当前运行环境不支持 fetch');
    const response = await this._fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    return response.json();
  }

  /**
   * 使用统一的 JSON 搜索接口。
   * @param {string} query
   * @param {number} max_results
   * @param {string} search_type
   * @returns {Promise<Array<object>>}
   */
  async _search_with_custom_api(query, max_results, search_type = 'web') {
    const apiKey = String(this._getEnv('DSH_WEB_SEARCH_API_KEY') || '').trim();

    try {
      const data = await this._postJson(this.search_engines.custom.url, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: { query, max_results, search_type },
      });

      const results = Array.isArray(data)
        ? data
        : Array.isArray(data?.results)
          ? data.results
          : Array.isArray(data?.data?.results)
            ? data.data.results
            : null;
      if (!results) throw new Error('搜索 API 返回格式不兼容：缺少 results 数组');

      return results.slice(0, max_results).flatMap((item) => {
        const url = String(item?.url ?? item?.link ?? '').trim();
        if (!/^https?:\/\//i.test(url)) return [];
        let displayed_link = '';
        try { displayed_link = new URL(url).hostname; } catch { /* leave empty */ }
        return [{
          title: String(item?.title ?? item?.name ?? displayed_link),
          url,
          snippet: String(item?.snippet ?? item?.content ?? item?.description ?? ''),
          displayed_link: String(item?.displayed_link ?? displayed_link),
          date: String(item?.date ?? item?.published_at ?? item?.published_date ?? '').slice(0, 10),
          source: String(item?.source ?? displayed_link ?? 'Web'),
        }];
      });
    } catch (e) {
      this.last_error = e?.message ?? String(e);
      logger.error(`自定义搜索 API 失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 使用 DuckDuckGo HTML 搜索。即时答案 API 不是完整网页搜索，不能作为
   * Chat 的通用搜索结果来源。
   * @param {string} query
   * @param {number} max_results
   * @returns {Promise<Array<object>>}
   */
  async _search_with_builtin(query, max_results) {
    const params = { q: query, kl: 'cn-zh' };

    try {
      const html = await this._getText(this.search_engines.builtin.url, { params });
      return parseDuckDuckGoHtml(html).slice(0, max_results);
    } catch (e) {
      this.last_error = e?.message ?? String(e);
      logger.error(`内置搜索失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * 处理搜索结果，根据角色添加额外信息（对应 _process_results）
   * @param {Array<object>} results
   * @param {string} role
   * @returns {Array<object>}
   */
  _process_results(results, role) {
    const processed = [];
    for (const result of results) {
      // 添加相关性评分
      result.relevance_score = this._calculate_relevance(result, role);

      // 提取关键信息
      result.key_points = this._extract_key_points(result.snippet ?? '');

      // 添加角色特定的分析
      result.role_analysis = this._analyze_for_role(result, role);

      processed.push(result);
    }

    // 按相关性排序（降序）
    processed.sort((a, b) => b.relevance_score - a.relevance_score);
    return processed;
  }

  /**
   * 计算结果与角色的相关性（对应 _calculate_relevance）
   * @param {object} result
   * @param {string} role
   * @returns {number}
   */
  _calculate_relevance(result, role) {
    const title = String(result?.title ?? '').toLowerCase();
    const snippet = String(result?.snippet ?? '').toLowerCase();
    const content = `${title} ${snippet}`.toLowerCase();

    const role_keywords = {
      技术专家: ['技术', '实现', '架构', '性能', '可扩展'],
      业务分析师: ['商业', '市场', '成本', '收益', 'roi'],
      行业专家: ['行业', '趋势', '标杆', '实践'],
      研究员: ['研究', '数据', '报告', '统计'],
      质疑者: ['风险', '问题', '挑战', '局限'],
      主持人: ['概述', '总结', '关键', '要点'],
    };

    let score = 0.5; // 基础分

    if (Object.prototype.hasOwnProperty.call(role_keywords, role)) {
      const keywords = role_keywords[role];
      for (const keyword of keywords) {
        if (content.includes(keyword)) {
          score += 0.1;
        }
      }
    }

    return Math.min(score, 1.0);
  }

  /**
   * 从文本中提取关键点（对应 _extract_key_points）
   * @param {string} text
   * @returns {Array<string>}
   */
  _extract_key_points(text) {
    // 简单的句子分割和过滤
    const sentences = String(text ?? '').split('。');
    const key_points = [];

    for (let sentence of sentences) {
      sentence = sentence.trim();
      if (sentence.length > 20 && !sentence.includes('?')) {
        key_points.push(sentence);
      }
    }

    return key_points.slice(0, 3); // 最多返回 3 个关键点
  }

  /**
   * 为特定角色分析搜索结果（对应 _analyze_for_role）
   * @param {object} result
   * @param {string} role
   * @returns {string}
   */
  _analyze_for_role(result, role) {
    const analysis = {
      技术专家: '技术实现需要考虑架构设计和性能优化',
      业务分析师: '需要评估商业价值和投资回报率',
      行业专家: '这与当前行业发展趋势相符',
      研究员: '需要更多的数据支持这一结论',
      质疑者: '可能存在未考虑到的风险因素',
      主持人: '这是讨论中的一个重要观点',
    };

    return analysis[role] ?? '值得关注的信息';
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function duckDuckGoTarget(rawHref) {
  const href = decodeHtml(rawHref);
  try {
    const resolved = new URL(href, 'https://duckduckgo.com');
    const target = resolved.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : resolved.toString();
  } catch {
    return '';
  }
}

export function parseDuckDuckGoHtml(html) {
  const source = String(html || '');
  const anchors = [...source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
    .flatMap((match) => {
      const attributes = match[1] || '';
      const className = attributes.match(/\bclass\s*=\s*["']([^"']*)["']/i)?.[1] || '';
      const href = attributes.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1] || '';
      return className.split(/\s+/).includes('result__a') && href
        ? [{ ...match, href, label: match[2] || '' }]
        : [];
    });
  return anchors.flatMap((match, index) => {
    const url = duckDuckGoTarget(match.href);
    const title = decodeHtml(match.label);
    if (!url || !title || !/^https?:\/\//i.test(url)) return [];
    const nextOffset = anchors[index + 1]?.index ?? source.length;
    const segment = source.slice((match.index || 0) + match[0].length, nextOffset);
    const snippetMatch = segment.match(/<(?:a|div)\b[^>]*class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    return [{
      title,
      url,
      snippet: decodeHtml(snippetMatch?.[1] || ''),
      displayed_link: (() => { try { return new URL(url).hostname; } catch { return ''; } })(),
      source: 'DuckDuckGo',
    }];
  });
}

export default WebSearchTool;

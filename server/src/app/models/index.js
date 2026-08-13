// L1 use-case layer for LLM model CRUD / connectivity tests / project models / project web-search models.
// Aligned line-by-line with index.js. Signature is always async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
//
// Coverage:
//   /api/llm_model/{create,delete,detail,llm_models,test-config,update}
//   /api/projects/:pid/models
//   /api/projects/:pid/web-search-models
//
// Note: app/models/ is one layer deeper than routes/, so engine/db uses ../../.
// getCompanyId / MODEL_COLS / normApiFormat / toExtraConfigText / testModelConnection
// Private helpers in index.js were copied by recipe to this file; LLM request utilities reuse engine/core/llm.js.
import {
  buildRequestHeaders,
  buildRequestData,
  getApiUrl,
  extractErrorDetail,
  ResponseExtractor,
  invalidateModelConfigCache,
} from '../../engine/core/llm.js';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../errors.js';

async function getCompanyId(ctx, userId) {
  const u = await ctx.queryOne(`SELECT company_id FROM users WHERE id=$1`, [userId]);
  return u?.company_id;
}

// Project model config (copied from index.js)
const MODEL_COLS = `id, model_name, display_name, category, api_base, supports_streaming, dimension,
  is_enabled, company_id, project_id, extra_config, api_format, created_at, updated_at`;
const VALID_API_FORMATS = new Set(['anthropic', 'chat_completions', 'responses']);
const normApiFormat = (v) => (VALID_API_FORMATS.has(v) ? v : 'chat_completions');

// A scope can save multiple models per category, but only one model is enabled per category.
const VALID_MODEL_CATEGORIES = new Set(['PRIMARY', 'SECONDARY', 'VISION', 'EMBEDDING', 'IMAGE']);
const VALID_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
function validatePrimaryModel(category, body) {
  if (!['PRIMARY', 'VISION', 'IMAGE'].includes(category)) return;
  if (!body.api_key) {
    const label = category === 'IMAGE' ? '图片模型' : category === 'VISION' ? '视觉模型' : '主模型';
    throw new ApiError(`${label}必须填写 API 密钥`, 400);
  }
  if (category === 'IMAGE') return;
  if (!['responses', 'chat_completions'].includes(normApiFormat(body.api_format))) {
    const label = category === 'VISION' ? '视觉模型' : '主模型';
    throw new ApiError(`${label}仅支持 Responses 或 Chat Completions API`, 400);
  }
}
// Store extra_config as a JSON object. Older endpoints accepted arbitrary text,
// which could create rows the runtime could not interpret and permanently
// bypass capability migrations.
const toExtraConfigText = (v) => {
  if (v == null) return null;
  let parsed = v;
  if (typeof v === 'string') {
    if (!v.trim()) return null;
    try {
      parsed = JSON.parse(v);
    } catch {
      throw new ApiError('extra_config 必须是有效的 JSON 对象', 400);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('extra_config 必须是 JSON 对象', 400);
  }
  try {
    return JSON.stringify(parsed);
  } catch {
    throw new ApiError('extra_config 不能包含循环引用', 400);
  }
};

// Test model connectivity (aligned with backend/core/llm/embed.py test_client). Returns {success,message,test_type,...}
async function testModelConnection(config) {
  const category = String(config.category || 'PRIMARY').toUpperCase();
  const testType = category === 'EMBEDDING'
    ? 'embedding_test'
    : category === 'IMAGE'
      ? 'image_config_test'
      : category === 'VISION' ? 'vision_test' : 'llm_test';
  try {
    if (category === 'IMAGE') {
      if (!String(config.api_base || '').trim()) throw new Error('缺少 API Base URL');
      if (!String(config.api_key || '').trim()) throw new Error('缺少 API 密钥');
      if (!String(config.model_name || '').trim()) throw new Error('缺少模型名称');
      return {
        success: true,
        message: '图片模型配置完整；请在对话中生成图片完成真实验证',
        model: config.model_name,
        api_base: config.api_base,
        test_type: testType,
      };
    }
    if (category === 'EMBEDDING') {
      const base = String(config.api_base || '').replace(/\/+$/, '');
      if (!base) throw new Error('缺少 API Base URL');
      const url = /\/embeddings$/.test(base) ? base : `${base}/embeddings`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: buildRequestHeaders(config),
        body: JSON.stringify({ model: config.model_name, input: ['测试文本'] }),
      });
      if (!resp.ok) {
        const detail = extractErrorDetail(await resp.text().catch(() => ''));
        return { success: false, message: `连接失败: ${detail}`, test_type: testType };
      }
      const data = await resp.json();
      let vectors = [];
      try { vectors = ResponseExtractor.extract_embedding(data) || []; } catch { vectors = []; }
      const vec = vectors[0];
      if (Array.isArray(vec) && vec.length) {
        return {
          success: true, message: '连接成功', model: config.model_name, api_base: config.api_base || '',
          dimension: vec.length, vector_preview: vec.slice(0, 10), vector_full: vec, test_type: testType,
        };
      }
      return { success: false, message: '响应格式错误', test_type: testType };
    }
    if (category === 'VISION') {
      // Keep the built-in probe above common vision-model minimum dimensions.
      // Bailian rejects images whose width or height is 10px or less.
      const sample = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAKklEQVR4nO3NQQ0AAAjEsCPBv2UwAb9OwFrJ5LN+vQMAAAAAAAAAAIDDFhnEAX2X/8JuAAAAAElFTkSuQmCC';
      const content = normApiFormat(config.api_format) === 'responses'
        ? [{ type: 'input_text', text: '请用一句话描述这张测试图片。' }, { type: 'input_image', image_url: sample }]
        : [{ type: 'text', text: '请用一句话描述这张测试图片。' }, { type: 'image_url', image_url: { url: sample } }];
      const body = buildRequestData(config, {
        messages: [{ role: 'user', content }],
        temperature: 0.2,
        max_tokens: 64,
      });
      const resp = await fetch(getApiUrl(config), {
        method: 'POST',
        headers: buildRequestHeaders(config),
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const detail = extractErrorDetail(await resp.text().catch(() => ''));
        return { success: false, message: `视觉输入验证失败: ${detail}`, test_type: testType };
      }
      const data = await resp.json();
      let contentText = null;
      try { contentText = ResponseExtractor.extract_chat_content(data); } catch { contentText = null; }
      return contentText
        ? { success: true, message: '视觉输入验证成功', response_preview: String(contentText).slice(0, 80), test_type: testType }
        : { success: false, message: '视觉模型响应中没有文字描述', test_type: testType };
    }

    // Chat models: send a tiny request and disable native thinking to avoid it consuming max_tokens and causing false failures.
    const body = buildRequestData(config, {
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.3,
      max_tokens: 16,
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    });
    const resp = await fetch(getApiUrl(config), {
      method: 'POST',
      headers: buildRequestHeaders(config),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const detail = extractErrorDetail(await resp.text().catch(() => ''));
      return { success: false, message: `连接失败: ${detail}`, test_type: testType };
    }
    const data = await resp.json();
    let content = null;
    try { content = ResponseExtractor.extract_chat_content(data); } catch { content = null; }
    if (content) {
      return {
        success: true, message: '连接成功', model: config.model_name, api_base: config.api_base || '',
        response_preview: String(content).slice(0, 50), test_type: testType,
      };
    }
    let finish = '';
    try { finish = data?.choices?.[0]?.finish_reason || ''; } catch { /* ignore */ }
    const message = finish === 'length'
      ? '模型输出被 max_tokens 截断且 content 为空，常见于推理模型未关闭思考；请确认该模型支持 enable_thinking=false'
      : `响应中无可用 content（finish_reason=${finish || 'unknown'}）`;
    return { success: false, message, test_type: testType };
  } catch (e) {
    return { success: false, message: `连接失败: ${e?.message || e}`, test_type: testType };
  }
}

// ════════════════════════════════════════════
// Project models / company available models / default models
// ════════════════════════════════════════════

// GET /api/projects/:pid/models — project-level models (company_id + project_id)
export async function listProjectModels(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const params = [cid, input.params.pid];
  let sql = `SELECT ${MODEL_COLS} FROM llm_models WHERE company_id=$1 AND project_id=$2 AND deleted_at IS NULL`;
  if (input.query.category) { params.push(input.query.category); sql += ` AND category=$3`; }
  sql += ` ORDER BY created_at DESC`;
  const rows = await ctx.query(sql, params);
  return { data: { items: rows, total: rows.length }, message: '获取项目模型成功' };
}

export async function getProjectAgentSettings(ctx, input) {
  const row = await ctx.queryOne(
    `SELECT reasoning_effort FROM project_agent_settings WHERE project_id=$1`,
    [input.params.pid],
  );
  return { data: { reasoning_effort: row?.reasoning_effort || 'medium' }, message: '获取项目 Agent 设置成功' };
}

export async function updateProjectAgentSettings(ctx, input) {
  const reasoningEffort = String(input.body?.reasoning_effort || '').trim().toLowerCase();
  if (!VALID_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new ApiError('无效的推理强度', 400);
  }
  await ctx.query(
    `INSERT INTO project_agent_settings (project_id, reasoning_effort, created_at, updated_at)
     VALUES ($1,$2,now(),now())
     ON CONFLICT(project_id) DO UPDATE SET reasoning_effort=$2, updated_at=now()`,
    [input.params.pid, reasoningEffort],
  );
  return { data: { reasoning_effort: reasoningEffort }, message: '项目 Agent 设置已保存' };
}

// GET /api/projects/:pid/models/:modelId — full project model for the edit form.
export async function getProjectModelDetail(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const row = await ctx.queryOne(
    `SELECT ${MODEL_COLS}, api_key FROM llm_models
      WHERE id=$1 AND company_id=$2 AND project_id=$3 AND deleted_at IS NULL`,
    [input.params.modelId, cid, input.params.pid],
  );
  if (!row) throw new ApiError('模型不存在', 404);
  return { data: row, message: '获取项目模型详情成功' };
}

// POST /api/projects/:pid/models — save multiple project models; the first model is enabled automatically.
export async function createProjectModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const pid = input.params.pid;
  const b = input.body || {};
  const category = String(b.category || 'PRIMARY').toUpperCase();
  if (!VALID_MODEL_CATEGORIES.has(category)) {
    throw new ApiError('无效的模型类别，支持: EMBEDDING, IMAGE, PRIMARY, SECONDARY, VISION', 400);
  }
  if (!b.model_name || !b.api_base) throw new ApiError('模型名称与 API 地址不能为空', 400);
  validatePrimaryModel(category, b);

  const active = await ctx.queryOne(
    `SELECT id FROM llm_models
      WHERE company_id=$1 AND project_id=$2 AND category=$3
        AND is_enabled=true AND deleted_at IS NULL LIMIT 1`,
    [cid, pid, category],
  );
  const shouldEnable = b.is_enabled === true || !active;

  const id = randomUUID();
  const dimension = category === 'EMBEDDING' ? (b.dimension ?? 1024) : (b.dimension ?? null);
  await ctx.query(
    `INSERT INTO llm_models
       (id, company_id, project_id, model_name, display_name, category, api_base, api_key,
        supports_streaming, dimension, is_enabled, extra_config, api_format, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now(),now())`,
    [id, cid, pid, b.model_name, b.display_name || b.model_name, category, b.api_base, b.api_key || null,
     b.supports_streaming !== false, dimension, false, toExtraConfigText(b.extra_config), normApiFormat(b.api_format)],
  );
  if (shouldEnable) {
    await ctx.query(
      `UPDATE llm_models SET is_enabled=CASE WHEN id=$4 THEN true ELSE false END, updated_at=now()
        WHERE company_id=$1 AND project_id=$2 AND category=$3 AND deleted_at IS NULL`,
      [cid, pid, category, id],
    );
  }
  invalidateModelConfigCache();
  const row = await ctx.queryOne(`SELECT ${MODEL_COLS} FROM llm_models WHERE id=$1`, [id]);
  return { data: row, message: '创建项目模型成功' };
}

// PUT /api/projects/:pid/models — update project-level model.
export async function updateProjectModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const pid = input.params.pid;
  const b = input.body || {};
  if (!b.id) throw new ApiError('缺少模型ID', 400);
  const model = await ctx.queryOne(
    `SELECT id, category, api_key, api_format FROM llm_models
      WHERE id=$1 AND company_id=$2 AND project_id=$3 AND deleted_at IS NULL`,
    [b.id, cid, pid],
  );
  if (!model) throw new ApiError('模型不存在', 404);
  const nextCategory = String(b.category || model.category || 'PRIMARY').toUpperCase();
  validatePrimaryModel(nextCategory, {
    api_key: b.api_key && !String(b.api_key).includes('****') ? b.api_key : model.api_key,
    api_format: b.api_format || model.api_format,
  });
  if (b.is_enabled === true) {
    await ctx.query(
      `UPDATE llm_models SET is_enabled=CASE WHEN id=$4 THEN true ELSE false END, updated_at=now()
        WHERE company_id=$1 AND project_id=$2 AND category=$3 AND deleted_at IS NULL`,
      [cid, pid, nextCategory, b.id],
    );
  }

  const sets = [];
  const params = [];
  let i = 1;
  const setCol = (col, val) => { sets.push(`${col}=$${i++}`); params.push(val); };
  if (b.model_name != null) {
    setCol('model_name', b.model_name);
    if (b.display_name == null) setCol('display_name', b.model_name);
  }
  if (b.display_name != null) setCol('display_name', b.display_name);
  if (b.category != null) setCol('category', String(b.category).toUpperCase());
  if (b.api_base != null) setCol('api_base', b.api_base);
  if (b.api_key != null && !String(b.api_key).includes('****') && String(b.api_key) !== '') setCol('api_key', b.api_key);
  if (b.supports_streaming != null) setCol('supports_streaming', b.supports_streaming);
  if (b.dimension != null) setCol('dimension', b.dimension);
  if (b.is_enabled === false) setCol('is_enabled', false);
  if (b.api_format != null) setCol('api_format', normApiFormat(b.api_format));
  if (b.extra_config !== undefined) setCol('extra_config', toExtraConfigText(b.extra_config));
  sets.push('updated_at=now()');
  params.push(b.id, cid, pid);
  await ctx.query(
    `UPDATE llm_models SET ${sets.join(', ')}
      WHERE id=$${i++} AND company_id=$${i++} AND project_id=$${i++}`,
    params,
  );
  invalidateModelConfigCache();
  const row = await ctx.queryOne(`SELECT ${MODEL_COLS} FROM llm_models WHERE id=$1`, [b.id]);
  return { data: row, message: '更新项目模型成功' };
}

// DELETE /api/projects/:pid/models/:modelId — delete project-level model.
export async function deleteProjectModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const { pid, modelId } = input.params;
  if (!modelId) throw new ApiError('缺少模型ID', 400);
  const model = await ctx.queryOne(
    `SELECT id, category, is_enabled FROM llm_models
      WHERE id=$1 AND company_id=$2 AND project_id=$3 AND deleted_at IS NULL`,
    [modelId, cid, pid],
  );
  if (!model) throw new ApiError('模型不存在', 404);
  await ctx.query(
    `UPDATE llm_models SET deleted_at=now(), deleted_by=$1, updated_at=now()
      WHERE id=$2 AND company_id=$3 AND project_id=$4`,
    [ctx.userId, modelId, cid, pid],
  );
  if (model.is_enabled) {
    const fallback = await ctx.queryOne(
      `SELECT id FROM llm_models
        WHERE company_id=$1 AND project_id=$2 AND category=$3 AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
      [cid, pid, model.category],
    );
    if (fallback) {
      await ctx.query(`UPDATE llm_models SET is_enabled=true, updated_at=now() WHERE id=$1`, [fallback.id]);
    }
  }
  invalidateModelConfigCache();
  return { data: null, message: '删除项目模型成功' };
}

// GET /api/llm_model/llm_models — company available system-level models (project_id IS NULL)
export async function listModels(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const params = [cid];
  let sql = `SELECT ${MODEL_COLS} FROM llm_models WHERE company_id=$1 AND project_id IS NULL AND deleted_at IS NULL`;
  if (input.query.category) { params.push(input.query.category); sql += ` AND category=$2`; }
  sql += ` ORDER BY created_at DESC`;
  const rows = await ctx.query(sql, params);
  return { data: { items: rows, total: rows.length }, message: '获取模型列表成功' };
}

// ════════════════════════════════════════════
// System-level model CRUD
// ════════════════════════════════════════════

// POST /api/llm_model/create
export async function createModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const b = input.body || {};
  const category = String(b.category || 'PRIMARY').toUpperCase();
  if (!VALID_MODEL_CATEGORIES.has(category)) {
    throw new ApiError('无效的模型类别，支持: EMBEDDING, IMAGE, PRIMARY, SECONDARY, VISION', 400);
  }
  if (!b.model_name || !b.api_base) throw new ApiError('模型名称与 API 地址不能为空', 400);
  validatePrimaryModel(category, b);
  const active = await ctx.queryOne(
    `SELECT id FROM llm_models
      WHERE company_id=$1 AND project_id IS NULL AND category=$2
        AND is_enabled=true AND deleted_at IS NULL LIMIT 1`,
    [cid, category],
  );
  const shouldEnable = b.is_enabled === true || !active;

  const id = randomUUID();
  const dimension = category === 'EMBEDDING' ? (b.dimension ?? 1024) : (b.dimension ?? null);
  await ctx.query(
    `INSERT INTO llm_models
       (id, company_id, project_id, model_name, display_name, category, api_base, api_key,
        supports_streaming, dimension, is_enabled, extra_config, api_format, created_at, updated_at)
     VALUES ($1,$2,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now())`,
    [id, cid, b.model_name, b.display_name || b.model_name, category, b.api_base, b.api_key || null,
     b.supports_streaming !== false, dimension, false, toExtraConfigText(b.extra_config), normApiFormat(b.api_format)],
  );
  if (shouldEnable) {
    await ctx.query(
      `UPDATE llm_models SET is_enabled=CASE WHEN id=$3 THEN true ELSE false END, updated_at=now()
        WHERE company_id=$1 AND project_id IS NULL AND category=$2 AND deleted_at IS NULL`,
      [cid, category, id],
    );
  }
  invalidateModelConfigCache();
  const row = await ctx.queryOne(`SELECT ${MODEL_COLS} FROM llm_models WHERE id=$1`, [id]);
  return { data: row, message: '创建模型成功' };
}

// POST /api/llm_model/update
export async function updateModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const b = input.body || {};
  if (!b.id) throw new ApiError('缺少模型ID', 400);
  const model = await ctx.queryOne(
    `SELECT id, category, api_key, api_format FROM llm_models WHERE id=$1 AND company_id=$2 AND project_id IS NULL AND deleted_at IS NULL`,
    [b.id, cid],
  );
  if (!model) throw new ApiError('模型不存在', 404);
  const nextCategory = String(b.category || model.category || 'PRIMARY').toUpperCase();
  validatePrimaryModel(nextCategory, {
    api_key: b.api_key && !String(b.api_key).includes('****') ? b.api_key : model.api_key,
    api_format: b.api_format || model.api_format,
  });
  if (b.is_enabled === true) {
    await ctx.query(
      `UPDATE llm_models SET is_enabled=CASE WHEN id=$3 THEN true ELSE false END, updated_at=now()
        WHERE company_id=$1 AND project_id IS NULL AND category=$2 AND deleted_at IS NULL`,
      [cid, nextCategory, b.id],
    );
  }

  // Update only explicitly provided fields (None does not overwrite); keep id/company_id/project_id/created_at unchanged.
  const sets = [];
  const params = [];
  let i = 1;
  const setCol = (col, val) => { sets.push(`${col}=$${i++}`); params.push(val); };
  if (b.model_name != null) {
    setCol('model_name', b.model_name);
    if (b.display_name == null) setCol('display_name', b.model_name);
  }
  if (b.display_name != null) setCol('display_name', b.display_name);
  if (b.category != null) setCol('category', String(b.category).toUpperCase());
  if (b.api_base != null) setCol('api_base', b.api_base);
  // api_key contains masked marker ****, which is not a real key; ignore and keep existing key.
  if (b.api_key != null && !String(b.api_key).includes('****')) setCol('api_key', b.api_key);
  if (b.supports_streaming != null) setCol('supports_streaming', b.supports_streaming);
  if (b.dimension != null) setCol('dimension', b.dimension);
  if (b.is_enabled === false) setCol('is_enabled', false);
  if (b.api_format != null) setCol('api_format', normApiFormat(b.api_format));
  if (b.extra_config !== undefined) setCol('extra_config', toExtraConfigText(b.extra_config));
  sets.push('updated_at=now()');
  params.push(b.id, cid);
  await ctx.query(
    `UPDATE llm_models SET ${sets.join(', ')} WHERE id=$${i++} AND company_id=$${i++}`,
    params,
  );
  invalidateModelConfigCache();
  const row = await ctx.queryOne(`SELECT ${MODEL_COLS} FROM llm_models WHERE id=$1`, [b.id]);
  return { data: row, message: '更新模型成功' };
}

// POST /api/llm_model/delete
export async function deleteModel(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const id = input.body?.model_id;
  if (!id) throw new ApiError('缺少模型ID', 400);
  const model = await ctx.queryOne(
    `SELECT id, category, is_enabled FROM llm_models
      WHERE id=$1 AND company_id=$2 AND project_id IS NULL AND deleted_at IS NULL`,
    [id, cid],
  );
  if (!model) throw new ApiError('模型不存在', 404);
  await ctx.query(
    `UPDATE llm_models SET deleted_at=now(), deleted_by=$1, updated_at=now() WHERE id=$2 AND company_id=$3`,
    [ctx.userId, id, cid],
  );
  if (model.is_enabled) {
    const fallback = await ctx.queryOne(
      `SELECT id FROM llm_models
        WHERE company_id=$1 AND project_id IS NULL AND category=$2 AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
      [cid, model.category],
    );
    if (fallback) {
      await ctx.query(`UPDATE llm_models SET is_enabled=true, updated_at=now() WHERE id=$1`, [fallback.id]);
    }
  }
  invalidateModelConfigCache();
  return { data: null, message: '删除模型成功' };
}

// GET /api/llm_model/detail — return full api_key (for edit-mode prefill)
export async function getModelDetail(ctx, input) {
  const cid = await getCompanyId(ctx, ctx.userId);
  const id = input.query.model_id;
  if (!id) throw new ApiError('缺少模型ID', 400);
  const row = await ctx.queryOne(
    `SELECT ${MODEL_COLS}, api_key FROM llm_models
      WHERE id=$1 AND company_id=$2 AND project_id IS NULL AND deleted_at IS NULL`,
    [id, cid],
  );
  if (!row) throw new ApiError('模型不存在', 404);
  return { data: row, message: '获取模型详情成功' };
}

// POST /api/llm_model/test-config — test with one-time unsaved temporary config
export async function testModelConfig(_ctx, input) {
  const b = input.body || {};
  const config = {
    model_name: b.model_name,
    category: String(b.category || 'PRIMARY').toUpperCase(),
    api_base: b.api_base,
    api_key: b.api_key,
    api_format: normApiFormat(b.api_format),
    supports_streaming: b.supports_streaming !== false,
    dimension: b.dimension,
    extra_config: {
      input_field: b.input_field || 'input',
      extra_headers: b.extra_headers,
      extra_body: b.extra_body,
    },
  };
  const result = await testModelConnection(config);
  return { data: result, message: '测试模型配置成功' };
}

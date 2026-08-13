// L0 传输适配层(ipc 侧):进程消息 → 匹配 registry → 注入本地数据归属 → makeCtx → 调用例 → 信封回传。
// strangler:命中 registry 走新纯函数路径(不经 express);未命中返回 false,调用方回退旧 Express shim。
// 消息契约与 ipc_dispatch.js 一致:in {id,method,url,headers,body};out {id,type:'head'|'data'|'end'}。
import { makeRouter } from './router.js';
import { okBody, failBody } from './envelope.js';
import { makeCtx } from '../ctx.js';
import { ApiError } from '../errors.js';
import { LOCAL_OWNER_ID } from '../app/local_identity.js';
import { ROUTES } from './registry.js';
import { createTransportStream } from './stream_events.js';

const match = makeRouter(ROUTES);
const activeStreams = new Map(); // id → AbortController(流式 abort)

// 主进程 stream-abort → 中断对应流式用例(ctx.signal)
export function abortIpcStream(id) {
  const c = activeStreams.get(id);
  if (c) { try { c.abort(); } catch { /* ignore */ } activeStreams.delete(id); }
}

export function abortAllIpcStreams() {
  for (const [, controller] of activeStreams) {
    try { controller.abort(); } catch { /* ignore */ }
  }
  activeStreams.clear();
}

export function handleIpcMessage(msg, send) {
  const method = String(msg.method || 'GET').toUpperCase();
  const rawUrl = msg.url || '/';
  const qIdx = rawUrl.indexOf('?');
  const path = qIdx >= 0 ? rawUrl.slice(0, qIdx) : rawUrl;
  const search = qIdx >= 0 ? rawUrl.slice(qIdx + 1) : '';
  const hit = match(method, path);
  if (!hit) {
    // 全部路由已迁入 registry;未命中 = 真·未找到(不再回退 Express)。打日志便于发现漏迁。
    console.warn(`[未命中 registry] ${method} ${path}`);
    const id = msg.id;
    send({ id, type: 'head', status: 404, statusText: '', headers: { 'content-type': 'application/json; charset=utf-8' } });
    send({ id, type: 'data', chunk: JSON.stringify(failBody(`接口未找到: ${method} ${path}`, 404)) });
    send({ id, type: 'end' });
    return;
  }
  void runUsecase(hit, search, msg, send);
}

async function runUsecase(hit, search, msg, send) {
  const id = msg.id;
  const { route, params } = hit;
  const reply = (status, obj) => {
    send({ id, type: 'head', status, statusText: '', headers: { 'content-type': 'application/json; charset=utf-8' } });
    send({ id, type: 'data', chunk: JSON.stringify(obj) });
    send({ id, type: 'end' });
  };
  try {
    // App 是本地单用户应用。auth:false 的公开读取保持匿名，其余用例使用固定数据归属 ID。
    const userId = route.auth === false ? null : LOCAL_OWNER_ID;
    let body = msg.body;
    if (typeof body === 'string' && body) {
      try { body = JSON.parse(body); } catch { /* 非 JSON 保留原串 */ }
    }
    const input = {
      params,
      query: Object.fromEntries(new URLSearchParams(search)),
      body: body ?? {},
      headers: msg.headers || {},
    };
    // ── 流式(SSE):emit 由 transport 加 `data: …\n\n` 帧;head / [DONE] / end 统一收尾;ctx.signal 接 abort ──
    if (route.stream) {
      const controller = new AbortController();
      activeStreams.set(id, controller);
      const sctx = makeCtx({ userId, signal: controller.signal });
      const stream = createTransportStream(
        (event) => { try { send({ id, type: 'data', chunk: `data: ${JSON.stringify(event)}\n\n` }); } catch { /* renderer gone */ } },
        { threadId: params.sid || null },
      );
      send({ id, type: 'head', status: 200, statusText: '', headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
      try {
        await route.fn(sctx, input, stream.emit);
      } catch (e) {
        const em = e instanceof ApiError ? e.message : '服务错误: ' + (e?.message || e);
        if (!(e instanceof ApiError)) console.error('[ipc stream]', route.p, e?.message || e);
        stream.fail(em);
      } finally {
        try { send({ id, type: 'data', chunk: 'data: [DONE]\n\n' }); } catch { /* ignore */ }
        try { send({ id, type: 'end' }); } catch { /* ignore */ }
        activeStreams.delete(id);
      }
      return;
    }
    const ctx = makeCtx({ userId });
    const result = await route.fn(ctx, input);
    // 二进制下载:用例返回 { data:Buffer, _binary:true, headers } → 走 base64(main 端还原 Blob)
    if (result && result._binary) {
      const buf = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data ?? '');
      send({ id, type: 'head', status: result.status || 200, statusText: '', headers: result.headers || { 'content-type': 'application/octet-stream' } });
      send({ id, type: 'data', b64: true, chunk: buf.toString('base64') });
      send({ id, type: 'end' });
      return;
    }
    const data = result && typeof result === 'object' && 'data' in result ? result.data : (result ?? null);
    const message = (result && result.message) || '操作成功';
    reply(200, okBody(data, message));
  } catch (e) {
    if (e instanceof ApiError) return reply(e.status, failBody(e.message, e.code));
    console.error('[ipc usecase]', route.m, route.p, e?.message || e);
    reply(500, failBody('服务错误: ' + (e?.message || e), 500));
  }
}

// L0 传输适配层(HTTP 侧):薄 express,把 TCP 请求喂进**同一个 registry/usecase/信封**。
// 仅用于 eval/CI(独立启动 或 DSH_TCP=1);app 路径走 ipc_server,不经这里。
// 与 ipc_server 共享 router/envelope/ctx —— eval 测的就是 app 跑的同一份用例代码。
import express from 'express';
import { makeRouter } from './router.js';
import { okBody, failBody } from './envelope.js';
import { makeCtx } from '../ctx.js';
import { ApiError } from '../errors.js';
import { LOCAL_OWNER_ID } from '../app/local_identity.js';
import { ROUTES } from './registry.js';
import { createTransportStream } from './stream_events.js';

const match = makeRouter(ROUTES);

function isLocalOrigin(origin) {
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname;
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

export function startHttpServer(port) {
  const app = express();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (!isLocalOrigin(origin)) return res.status(403).json(failBody('仅允许本机开发页面访问', 403));
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept-Language');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      return res.status(204).end();
    }
    next();
  });
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  app.all('/api/*', async (req, res) => {
    const hit = match(req.method, req.path);
    if (!hit) return res.status(404).json(failBody(`接口未找到: ${req.method} ${req.path}`, 404));
    const { route, params } = hit;
    try {
      const userId = route.auth === false ? null : LOCAL_OWNER_ID;
      const input = { params, query: req.query || {}, body: req.body || {}, headers: req.headers || {} };

      // 流式 SSE
      if (route.stream) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const controller = new AbortController();
        req.on('close', () => controller.abort());
        const stream = createTransportStream(
          (event) => { try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ } },
          { threadId: params.sid || null },
        );
        try {
          await route.fn(makeCtx({ userId, signal: controller.signal }), input, stream.emit);
        } catch (e) {
          const m = e instanceof ApiError ? e.message : '服务错误: ' + (e?.message || e);
          stream.fail(m);
        } finally {
          try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* closed */ }
        }
        return;
      }

      const result = await route.fn(makeCtx({ userId }), input);
      // 二进制下载
      if (result && result._binary) {
        const buf = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data ?? '');
        if (result.headers) for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
        return res.status(result.status || 200).send(buf);
      }
      const data = result && typeof result === 'object' && 'data' in result ? result.data : (result ?? null);
      const message = (result && result.message) || '操作成功';
      res.json(okBody(data, message));
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json(failBody(e.message, e.code));
      console.error('[http usecase]', route.m, route.p, e?.message || e);
      res.status(500).json(failBody('服务错误: ' + (e?.message || e), 500));
    }
  });

  // 无账号模式只能绑定 loopback；HTTP 仅供本机开发、eval 和 CI 使用。
  const srv = app.listen(port, '127.0.0.1', () => console.log(`🟢 desktop server (node) HTTP(eval/CI) on http://127.0.0.1:${port} [LOCAL_ONLY]`));
  srv.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') console.warn(`[server] TCP ${port} 已占用,跳过监听`);
    else throw e;
  });
  return srv;
}

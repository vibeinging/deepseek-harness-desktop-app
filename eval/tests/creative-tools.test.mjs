import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { dataPath } from '../../server/src/config/paths.js';
import { query, queryOne } from '../../server/src/db.js';
import { createCreativeTools, _setDnsLookupForTests } from '../../server/src/engine/agents/creative_tools.js';
import { deliverToolOutput } from '../../server/src/engine/agents/tool_output_delivery.js';
import { ModelConfigResolver } from '../../server/src/engine/core/llm.js';
import { runWithTraceContext } from '../../server/src/engine/trace/trace_context.js';

const ONE_PIXEL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test('image_gen uses the configured IMAGE model and persists the generated file', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'creative-tools-'));
  const readableWorkspace = await mkdtemp(join(tmpdir(), 'creative-tools-readonly-'));
  ModelConfigResolver.setProvider(async ({ category }) => {
    assert.equal(category, 'IMAGE');
    return {
      model_name: 'image-test-model',
      api_base: 'https://image.test/v1',
      api_key: 'test-key',
      extra_config: {},
    };
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://image.test/v1/images/generations');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'image-test-model');
    assert.equal(body.prompt, '画一张测试图');
    return new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG.toString('base64') }], usage: { total_tokens: 7 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const tool = createCreativeTools({
      project_id: 'p1',
      workspace_roots: [readableWorkspace, workspace],
      workspace_write_root: workspace,
    }).find((item) => item.name === 'image_gen');
    const llmCalls = [];
    const output = await runWithTraceContext({ recordLlmCall: (event) => llmCalls.push(event) }, () => (
      tool.execute('call-1', { prompt: '画一张测试图' })
    ));
    assert.equal(output.details.success, true);
    assert.equal(output.details.usage.total_tokens, 7);
    assert.equal(existsSync(output.details.path), true);
    assert.equal(output.details.path.startsWith(`${workspace}/`), true);
    assert.equal(output.details.path.startsWith(`${readableWorkspace}/`), false);
    assert.deepEqual(await readFile(output.details.path), ONE_PIXEL_PNG);
    assert.match(output.content[0].text, /承接当前图片请求完成回复/);
    assert.match(output.content[0].text, /"success": true/);
    assert.equal(output.content[0].text.includes(output.details.path), false);
    assert.match(output.content[0].text, /不要向用户展示内部文件路径或保存位置/);
    assert.equal(output.content.some((item) => item.type === 'image'), true);
    assert.equal(llmCalls[0].usage.total_tokens, 7);
    assert.equal(llmCalls[0].callSite, 'image_gen');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('the shared output delivery layer publishes image_gen to Library', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'creative-artifact-'));
  const userId = `image-user-${randomUUID()}`;
  const projectId = `image-project-${randomUUID()}`;
  const memberId = randomUUID();
  const sessionId = randomUUID();
  const managedProjectRoot = join(dataPath('project_artifacts'), projectId);
  const recordedArtifacts = [];
  const previousFetch = globalThis.fetch;

  t.after(async () => {
    globalThis.fetch = previousFetch;
    await query('DELETE FROM project_artifact_versions WHERE artifact_id IN (SELECT id FROM project_artifacts WHERE project_id=$1)', [projectId]).catch(() => undefined);
    await query('DELETE FROM project_artifacts WHERE project_id=$1', [projectId]).catch(() => undefined);
    await query('DELETE FROM sessions WHERE id=$1', [sessionId]).catch(() => undefined);
    await query('DELETE FROM project_members WHERE id=$1', [memberId]).catch(() => undefined);
    await query('DELETE FROM projects WHERE id=$1', [projectId]).catch(() => undefined);
    await rm(managedProjectRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  });

  await query(
    `INSERT INTO projects (id,name,status,created_at,updated_at)
     VALUES ($1,'图片产物测试','active',now(),now())`,
    [projectId],
  );
  await query(
    `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
     VALUES ($1,$2,$3,1,now(),now())`,
    [memberId, projectId, userId],
  );
  await query(
    `INSERT INTO sessions
      (id,project_id,created_by,source_type,source_id,action_type,title,status,created_at,updated_at)
     VALUES ($1,$2,$3,'agent',$2,'agentic_chat','图片产物测试','active',now(),now())`,
    [sessionId, projectId, userId],
  );

  ModelConfigResolver.setProvider(async () => ({
    model_name: 'image-artifact-model',
    api_base: 'https://image.test/v1',
    api_key: 'test-key',
    extra_config: {},
  }));
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ b64_json: ONE_PIXEL_PNG.toString('base64') }],
  }), { status: 200 });

  const agentContext = {
    db: { query, queryOne },
    user_id: userId,
    project_id: projectId,
    session_id: sessionId,
    runtime_turn_id: 'image-turn-1',
    workspace_roots: [workspace],
    workspace_write_root: workspace,
    runtime: {
      runId: 'image-run-1',
      async recordArtifact(payload) { recordedArtifacts.push(payload); },
    },
  };
  const tool = createCreativeTools(agentContext).find((item) => item.name === 'image_gen');

  assert.equal(tool.produces_artifact, true);
  assert.equal(tool.host_action_capable, true);
  const generated = await tool.execute('image-call-1', { prompt: '生成项目图片产物' });
  const output = await deliverToolOutput({ agentContext, tool, result: generated, callId: 'image-call-1' });
  const artifact = output.details.artifact;
  assert.equal(output.details.success, true);
  assert.ok(artifact?.id, JSON.stringify(output.details));
  assert.equal(artifact.kind, 'image');
  assert.equal(artifact.current_version.source_session_id, sessionId);
  assert.equal(artifact.current_version.source_turn_id, 'image-turn-1');
  assert.equal(artifact.current_version.source_run_id, 'image-run-1');
  assert.equal(artifact.current_version.source_tool_call_id, 'image-call-1');
  assert.equal(output.details.host_actions[0].event.event, 'artifact_published');
  assert.equal(output.details.host_actions[0].event.artifact_id, artifact.id);
  assert.equal(output.details.output_delivery.role, 'deliverable');
  assert.equal(output.details.output_delivery.persistence, 'library');
  assert.doesNotMatch(output.content[0].text, /host_actions/);
  assert.equal(recordedArtifacts[0].metadata.project_artifact_id, artifact.id);
  const stored = await queryOne('SELECT kind,name FROM project_artifacts WHERE id=$1', [artifact.id]);
  assert.equal(stored.kind, 'image');
  assert.match(stored.name, /\.png$/);
});

test('image_gen preserves the actual JPEG output format', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'creative-jpeg-'));
  ModelConfigResolver.setProvider(async () => ({
    model_name: 'image-test-model',
    api_base: 'https://image.test/v1',
    api_key: 'test-key',
    extra_config: {},
  }));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [{ b64_json: JPEG_BYTES.toString('base64') }],
  }), { status: 200 });
  try {
    const tool = createCreativeTools({ project_id: 'p1', workspace_roots: [workspace] }).find((item) => item.name === 'image_gen');
    const output = await tool.execute('call-jpeg-output', { prompt: '生成 JPEG 测试图' });
    assert.equal(output.details.success, true);
    assert.match(output.details.path, /\.jpg$/);
    assert.equal(output.content.find((item) => item.type === 'image')?.mimeType, 'image/jpeg');
    assert.deepEqual(await readFile(output.details.path), JPEG_BYTES);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('image_gen supports the official DashScope multimodal image endpoint', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dashscope-image-'));
  ModelConfigResolver.setProvider(async () => ({
    model_name: 'qwen-image-2.0-pro',
    api_base: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1',
    api_key: 'test-key',
    extra_config: { image_provider: 'dashscope_multimodal' },
  }));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://result.test/')) return new Response(ONE_PIXEL_PNG, { status: 200 });
    assert.equal(url, 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
    const body = JSON.parse(options.body);
    assert.equal(body.input.messages[0].content[0].text, '中文海报');
    return new Response(JSON.stringify({
      usage: { image_count: 1 },
      output: { choices: [{ message: { content: [{ image: 'https://result.test/image.png' }] } }] },
    }), { status: 200 });
  };
  // SSRF 校验会解析下载地址；测试环境 DNS 会把外部域名劫持到内网代理，
  // 用公网地址 mock DNS 以通过校验，同时验证私有地址仍被拒绝。
  const previousDns = _setDnsLookupForTests(async (hostname) => [{ address: '93.184.216.34', family: 4 }]);
  try {
    const tool = createCreativeTools({ project_id: 'p1', workspace_roots: [workspace] }).find((item) => item.name === 'image_gen');
    const output = await tool.execute('call-3', { prompt: '中文海报', size: '2048x2048' });
    assert.equal(output.details.success, true);
    assert.equal(output.details.usage.image_count, 1);
  } finally {
    _setDnsLookupForTests(previousDns);
    globalThis.fetch = previousFetch;
  }
});

test('image_gen composes a VISION model with a generation-only IMAGE model', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'composed-image-'));
  const reference = join(workspace, 'reference.png');
  await writeFile(reference, ONE_PIXEL_PNG);
  ModelConfigResolver.setProvider(async ({ category }) => {
    if (category === 'IMAGE') {
      return {
        id: 'image-model',
        model_name: 'generation-only-model',
        api_base: 'https://image.test/v1',
        api_key: 'image-key',
        extra_config: { supports_reference_image: false },
      };
    }
    assert.equal(category, 'VISION');
    return {
      id: 'vision-model',
      model_name: 'vision-test-model',
      api_base: 'https://vision.test/v1',
      api_key: 'vision-key',
      api_format: 'chat_completions',
      extra_config: {},
    };
  });
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    if (url === 'https://vision.test/v1/chat/completions') {
      const body = JSON.parse(options.body);
      assert.equal(body.messages[0].content[1].type, 'image_url');
      return new Response(JSON.stringify({
        choices: [{ message: { content: '紫色背景，中央白色几何图形，极简风格。' } }],
        usage: { total_tokens: 11 },
      }), { status: 200 });
    }
    assert.equal(url, 'https://image.test/v1/images/generations');
    const body = JSON.parse(options.body);
    assert.match(body.prompt, /中央白色几何图形/);
    return new Response(JSON.stringify({
      data: [{ b64_json: ONE_PIXEL_PNG.toString('base64') }],
      usage: { total_tokens: 5 },
    }), { status: 200 });
  };
  try {
    const tool = createCreativeTools({ project_id: 'p1', workspace_roots: [workspace] }).find((item) => item.name === 'image_gen');
    const llmCalls = [];
    const output = await runWithTraceContext({ recordLlmCall: (event) => llmCalls.push(event) }, () => (
      tool.execute('call-4', { prompt: '生成同风格海报', reference_image_path: reference })
    ));
    assert.equal(output.details.success, true);
    assert.deepEqual(calls, [
      'https://vision.test/v1/chat/completions',
      'https://image.test/v1/images/generations',
    ]);
    assert.deepEqual(llmCalls.map((item) => item.callSite), ['image_vision', 'image_gen']);
    assert.equal(llmCalls[1].attrs.composed_with_vision, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('image_gen reuses a multimodal PRIMARY model when no dedicated VISION model exists', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'primary-vision-image-'));
  const reference = join(workspace, 'reference.png');
  await writeFile(reference, ONE_PIXEL_PNG);
  ModelConfigResolver.setProvider(async ({ category }) => {
    if (category === 'IMAGE') return {
      model_name: 'generation-only-model',
      api_base: 'https://image.test/v1',
      api_key: 'image-key',
      extra_config: { supports_reference_image: false },
    };
    if (category === 'VISION') throw new Error('not configured');
    assert.equal(category, 'PRIMARY');
    return {
      id: 'primary-model',
      model_name: 'multimodal-primary',
      api_base: 'https://primary.test/v1',
      api_key: 'primary-key',
      api_format: 'chat_completions',
      extra_config: { supports_image_input: true },
    };
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url === 'https://primary.test/v1/chat/completions') {
      return new Response(JSON.stringify({ choices: [{ message: { content: '蓝色科技风格。' } }] }), { status: 200 });
    }
    assert.equal(url, 'https://image.test/v1/images/generations');
    assert.match(JSON.parse(options.body).prompt, /蓝色科技风格/);
    return new Response(JSON.stringify({ data: [{ b64_json: ONE_PIXEL_PNG.toString('base64') }] }), { status: 200 });
  };
  try {
    const tool = createCreativeTools({ project_id: 'p1', workspace_roots: [workspace] }).find((item) => item.name === 'image_gen');
    const llmCalls = [];
    const output = await runWithTraceContext({ recordLlmCall: (event) => llmCalls.push(event) }, () => (
      tool.execute('call-5', { prompt: '生成同风格图片', reference_image_path: reference })
    ));
    assert.equal(output.details.success, true);
    assert.equal(llmCalls[0].attrs.model_role, 'PRIMARY');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

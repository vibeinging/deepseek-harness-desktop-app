function calledTools(output) {
  return new Set((output?.events || [])
    .filter((event) => event.item_type === 'dynamicToolCall' && event.tool_name)
    .map((event) => String(event.tool_name)));
}

function hasTool(output, expected) {
  return [...calledTools(output)].some((name) => name === expected || name.endsWith(`__${expected}`));
}

export default {
  id: 'dsh-real-canvas-site',
  desc: '当前真实模型通过 Canvas 工具创建并按版本修改本地 Site',
  eval: {
    feature: 'dsh.canvas-site',
    layer: 'model_eval',
    risk: 'P0',
    interaction: 'app',
    model: 'real',
    data: 'synthetic',
    platforms: ['darwin', 'win32', 'linux'],
    timeoutMs: 720_000,
    repeats: 1,
    minPassRate: 1,
    requirements: ['chat.canvas.create', 'chat.canvas.edit', 'chat.site.local-preview'],
    tags: ['model-nightly', 'dsh-alignment'],
    criteria: [
      {
        id: 'site.created',
        description: '真实模型实际调用 canvas_create 并保存指定 Site 内容',
        evidence: ['tool_event', 'api'],
      },
      {
        id: 'site.edited',
        description: '真实模型先检查版本，再调用 canvas_edit 保存第二版内容',
        evidence: ['tool_event', 'api'],
      },
    ],
    scenario: {
      project: { mode: 'new', name: 'dsh-real-canvas-site-eval' },
      turns: [
        { id: 'create-site', user: '通过 canvas_create 创建本地 Site', criteria: ['site.created'] },
        { id: 'edit-site', user: '先检查版本再通过 canvas_edit 修改 Site', criteria: ['site.edited'] },
      ],
    },
  },
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const stamp = Date.now().toString(36);
    const firstMarker = `SITE_VERSION_ONE_${stamp}`;
    const secondMarker = `SITE_VERSION_TWO_${stamp}`;
    const pid = await driver.ensureProjectRecord(`真实Site能力-${stamp}`);
    let sid = '';

    try {
      const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      if (!model?.json?.data?.model_name) assert.blocked('隔离环境没有可用的真实 PRIMARY 模型');

      const created = await driver.askAgent(pid, [
        '请实际调用 canvas_create 创建一个本地 Site，不能只在回答里贴代码。',
        `标题写“真实 Site ${stamp}”，kind 必须是 site，language 必须是 html。`,
        `完整单文件 HTML 的可见 h1 必须包含 ${firstMarker}，并包含一个按钮。`,
        '工具完成后简短确认。',
      ].join('\n'), { title: `真实Site-${stamp}`, searchMode: 'off', timeoutMs: 300_000 });
      sid = created.sid || '';
      assert.ok(hasTool(created, 'canvas_create'), '真实模型实际调用 canvas_create', { criterion: 'site.created' });

      const listed = await api('GET', `/api/agent/sessions/${sid}/canvases`);
      assert.status(listed, 200, '读取真实模型创建的 Canvas', { criterion: 'site.created' });
      const site = (listed.json?.data?.items || []).find((item) => item.kind === 'site');
      assert.ok(Boolean(site?.id), '会话中保存了 Site Canvas', { criterion: 'site.created' });
      if (!site?.id) return;

      const detailV1 = await api('GET', `/api/agent/sessions/${sid}/canvases/${site.id}`);
      assert.ok(String(detailV1.json?.data?.content || '').includes(firstMarker), 'Site 第一版包含指定可见标记', { criterion: 'site.created' });
      assert.eq(detailV1.json?.data?.current_version?.version_number, 1, 'Site 第一版版本号为 1', { criterion: 'site.created' });

      const edited = await driver.continueAgent(pid, sid, [
        `请修改刚才创建的 Site：把 ${firstMarker} 替换成 ${secondMarker}。`,
        '必须先调用 canvas_inspect 取得当前版本，再使用返回的 current_version_id 调用 canvas_edit。',
        '不能只给修改建议。',
      ].join('\n'), { searchMode: 'off', timeoutMs: 300_000 });
      assert.ok(hasTool(edited, 'canvas_inspect'), '修改前真实调用 canvas_inspect', { criterion: 'site.edited' });
      assert.ok(hasTool(edited, 'canvas_edit'), '真实调用 canvas_edit 保存修改', { criterion: 'site.edited' });

      const detailV2 = await api('GET', `/api/agent/sessions/${sid}/canvases/${site.id}`);
      const contentV2 = String(detailV2.json?.data?.content || '');
      assert.ok(contentV2.includes(secondMarker), 'Site 第二版包含新标记', { criterion: 'site.edited' });
      assert.ok(!contentV2.includes(firstMarker), 'Site 第二版已移除旧标记', { criterion: 'site.edited' });
      assert.ok(
        Number(detailV2.json?.data?.current_version?.version_number || 0) >= 2,
        'Site 修改后至少形成第二个版本',
        { criterion: 'site.edited' },
      );
    } finally {
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCanvas } = require('../../server/node_modules/@napi-rs/canvas');

function outputText(output) {
  return (output?.blocks || []).map((block) => String(block?.content || '')).join('\n');
}

function calledTools(output) {
  return new Set((output?.events || [])
    .filter((event) => event.item_type === 'dynamicToolCall' && event.tool_name)
    .map((event) => String(event.tool_name).replace(/^.*__/, '')));
}

function createColorFixture(root) {
  const canvas = createCanvas(320, 180);
  const context = canvas.getContext('2d');
  context.fillStyle = '#1261d8';
  context.fillRect(0, 0, 160, 180);
  context.fillStyle = '#ffd92f';
  context.fillRect(160, 0, 160, 180);
  context.fillStyle = '#ffffff';
  context.font = 'bold 28px sans-serif';
  context.fillText('BLUE', 38, 98);
  context.fillStyle = '#161616';
  context.fillText('YELLOW', 182, 98);
  const imagePath = path.join(root, 'blue-left-yellow-right.png');
  writeFileSync(imagePath, canvas.toBuffer('image/png'));
  return imagePath;
}

export default {
  id: 'dsh-real-web-image',
  desc: '当前真实模型接收本地图片，并在必须联网模式下搜索、打开网页和给出来源',
  eval: {
    feature: 'dsh.web-image',
    layer: 'model_eval',
    risk: 'P0',
    interaction: 'app',
    model: 'real',
    data: 'synthetic',
    platforms: ['darwin', 'win32', 'linux'],
    timeoutMs: 720_000,
    repeats: 1,
    minPassRate: 1,
    requirements: ['chat.image-understanding', 'chat.web-search', 'chat.web-citations'],
    tags: ['model-nightly', 'dsh-alignment'],
    criteria: [
      {
        id: 'image.understood',
        description: '真实多模态模型正确识别合成图片左右两侧的主颜色',
        evidence: ['model_output', 'local_image'],
      },
      {
        id: 'web.researched',
        description: '必须联网模式真实调用搜索和打开工具，并保存可见来源编号',
        evidence: ['tool_event', 'model_output'],
      },
    ],
    scenario: {
      project: { mode: 'new', name: 'dsh-real-web-image-eval' },
      files: [
        { id: 'color-image', path: '<generated>/blue-left-yellow-right.png', selection: 'prepared', purpose: '真实图片理解' },
      ],
      turns: [
        { id: 'understand-image', user: '识别图片左右两侧主颜色', uses: ['file:color-image'], criteria: ['image.understood'] },
        { id: 'required-web', user: '联网核对 Example Domain 的用途并引用来源', criteria: ['web.researched'] },
      ],
    },
  },
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const stamp = Date.now().toString(36);
    const pid = await driver.ensureProjectRecord(`真实联网图片-${stamp}`);
    const root = mkdtempSync(path.join(tmpdir(), 'dsh-real-web-image-'));
    const sessions = [];

    try {
      const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      if (!model?.json?.data?.model_name) assert.blocked('隔离环境没有可用的真实 PRIMARY 模型');

      const imagePath = createColorFixture(root);
      const image = await driver.askAgent(
        pid,
        '请看图并回答左右两侧的主颜色。只用“左边：颜色；右边：颜色”的格式回答，不要调用工具。',
        {
          title: `真实图片-${stamp}`,
          searchMode: 'off',
          input: [
            { type: 'text', text: '请看图并回答左右两侧的主颜色。只用“左边：颜色；右边：颜色”的格式回答，不要调用工具。' },
            { type: 'localImage', path: imagePath, detail: 'high' },
          ],
          timeoutMs: 240_000,
        },
      );
      sessions.push(image.sid);
      const imageText = outputText(image);
      assert.ok(/蓝|blue/i.test(imageText), '真实模型识别出左侧蓝色', { criterion: 'image.understood' });
      assert.ok(/黄|yellow/i.test(imageText), '真实模型识别出右侧黄色', { criterion: 'image.understood' });

      const web = await driver.askAgent(
        pid,
        '请联网搜索并打开 Example Domain 的官方页面，核对这个页面的用途。回答必须引用你实际打开的网页来源。',
        { title: `真实联网-${stamp}`, searchMode: 'required', timeoutMs: 300_000 },
      );
      sessions.push(web.sid);
      const tools = calledTools(web);
      assert.ok(tools.has('web_search'), '必须联网模式真实调用 web_search', { criterion: 'web.researched' });
      assert.ok(tools.has('web_open'), '真实打开搜索结果网页核对内容', { criterion: 'web.researched' });
      const webText = outputText(web);
      assert.ok(/【S\d+】/.test(webText), '最终回答包含可见来源编号', { criterion: 'web.researched' });
      assert.ok((web.blocks || []).some((block) => block.type === 'web_sources'), '流中保存网页来源卡片', { criterion: 'web.researched' });
    } finally {
      for (const sid of sessions.filter(Boolean)) {
        await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      }
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  },
};

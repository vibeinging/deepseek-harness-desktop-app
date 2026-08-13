// Skill runtime: validate native Agent discovery and explicit Skill execution without a fake use_skill Tool.
import { readFile } from 'node:fs/promises';

export default {
  id: 'skill-runtime',
  desc: 'Agent Skill 原生发现与显式执行',
  async run({ driver, assert }) {
    await driver.login();
    const pid = await driver.ensureProjectRecord('skill-runtime-eval');
    const api = driver.raw.api;
    const streamBlocks = driver.raw.streamBlocks;
    const appSkillName = `eval-native-skill-${Date.now()}`;
    let sid = '';
    try {
      const appListed = await api('GET', '/api/agent/skills');
      assert.status(appListed, 200, '可通过 Agent skills/list 列出 Skill');
      const names = (appListed.json?.data || []).map((skill) => skill.name);
      assert.ok(!names.includes('template-creator'), '列表不再注入旧的 App 模板 Skill');
      assert.ok(!names.includes('create-pdf-document'), '列表不再注入旧的 PDF Plugin Skill');
      assert.ok(!names.includes('excel-workbook'), '列表不再注入旧的 Excel Plugin Skill');

      const created = await api('POST', '/api/agent/skills', {
        name: appSkillName,
        description: 'eval 原生 Agent Skill',
        instructions: '用户明确使用本 Skill 时，只回答 NATIVE-SKILL-OK，不调用任何工具。',
      });
      assert.status(created, 200, '可创建标准用户 Skill 文件');
      assert.eq(created.json?.data?.editable, true, '新 Skill 是可编辑用户文件');
      assert.eq(Object.hasOwn(created.json?.data || {}, 'allowed_tools'), false, '用户 Skill 对象不暴露旧工具白名单字段');
      assert.eq(JSON.stringify(created.json?.data?.tool_visibility_limit || []), '[]', '用户 Skill 不会收窄或扩大 Host 工具');
      const markdown = await readFile(created.json?.data?.path, 'utf8');
      assert.ok(!/(?:allowed[_-]tools|required[_-]tools):/i.test(markdown), '用户 SKILL.md 不保存工具白名单或私有依赖字段');

      const projectSkills = await api('GET', `/api/projects/${pid}/skills/enabled/list`);
      assert.ok((projectSkills.json?.data || []).some((skill) => skill.name === appSkillName), '项目按 Agent 目录规则发现用户 Skill');

      const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      if (!model?.json?.data?.model_name) {
        assert.blocked('未配置真实模型，无法执行 Skill Turn 判分');
      }

      const session = await api('POST', `/api/projects/${pid}/sessions`, {
        title: 'native-skill-runtime-eval',
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      sid = session.json?.data?.id || session.json?.data?.session_id;
      const output = await streamBlocks(`/api/agent/projects/${pid}/threads/${sid}/turns`, {
        input: [{ type: 'text', text: '请按当前明确选择的 Skill 执行。' }],
        approvalMode: 'ask',
        skill: appSkillName,
      });
      const blocks = output.blocks || [];
      const text = blocks.map((block) => `${block.title || ''} ${block.content || ''}`).join('\n');
      assert.ok(/NATIVE-SKILL-OK/.test(text), '显式 Skill 的 SKILL.md 指令进入同一个主 Agent Turn');
      assert.ok(!/use_skill/.test(text), '运行时没有虚构 use_skill Tool');
    } finally {
      await api('DELETE', `/api/agent/skills/${encodeURIComponent(appSkillName)}`).catch(() => {});
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
    }
  },
};

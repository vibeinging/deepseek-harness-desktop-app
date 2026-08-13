// Agent Skill storage: definitions live in SKILL.md and enablement lives in config.toml.
export default {
  id: 'skill-library-binding',
  desc: 'Agent Skill 文件与 config.toml 契约',
  async run({ driver, assert }) {
    await driver.login();
    const pid = await driver.ensureProjectRecord('skill-file-storage-eval');
    const api = driver.raw.api;
    const skillName = `eval-skill-${Date.now()}`;

    try {
      const invalidName = await api('POST', '/api/agent/skills', {
        name: 'bad/skill',
        description: 'eval invalid name',
        instructions: 'should fail',
      });
      assert.status(invalidName, 400, 'Skill 名称不能包含路径字符');

      const builtinCreate = await api('POST', '/api/agent/skills', {
        name: 'query-project-data',
        description: 'eval duplicate builtin',
        instructions: 'should fail',
      });
      assert.status(builtinCreate, 400, '不能创建与内置 Skill 同名的自定义 Skill');

      const created = await api('POST', '/api/agent/skills', {
        name: skillName,
        description: 'eval Agent file Skill',
        instructions: 'Eval skill instructions v1.',
        allow_implicit_invocation: false,
        default_enabled: false,
      });
      assert.status(created, 200, '可创建 Agent 用户 Skill 文件');
      assert.eq(created.json?.data?.name, skillName, '创建返回名称正确');
      assert.eq(created.json?.data?.editable, true, 'App 创建的用户 Skill 可编辑');
      assert.eq(created.json?.data?.is_enabled, false, '关闭状态由 项目配置 生效');
      assert.ok(/\/skills\/.+\/SKILL\.md$/.test(created.json?.data?.path || ''), '返回真实 SKILL.md 路径');

      const duplicate = await api('POST', '/api/agent/skills', {
        name: skillName,
        description: 'duplicate',
        instructions: 'duplicate',
      });
      assert.status(duplicate, 409, '重复目录返回 409');

      const projectList = await api('GET', `/api/projects/${pid}/skills`);
      assert.status(projectList, 200, '项目页按 Agent 工作区规则列出 Skill');
      const projectSkill = (projectList.json?.data || []).find((skill) => skill.name === skillName);
      assert.ok(!!projectSkill, '项目可发现用户 Skill');
      assert.eq(projectSkill?.is_enabled, false, '项目读取同一 Agent 配置状态');
      assert.ok(!Object.hasOwn(projectSkill || {}, 'enabled_override'), '不存在项目数据库覆盖字段');

      const removedBindingRoute = await api('PATCH', `/api/projects/${pid}/skills/${encodeURIComponent(skillName)}/binding`, {
        enabled_override: true,
      });
      assert.status(removedBindingRoute, 404, '项目 Skill 数据库绑定路由已删除');

      const enabled = await api('PATCH', `/api/agent/skills/${encodeURIComponent(skillName)}/toggle`, {
        is_enabled: true,
      });
      assert.status(enabled, 200, '可通过 Agent 配置启用 Skill');
      assert.eq(enabled.json?.data?.is_enabled, true, '启用状态立即生效');

      const updated = await api('PUT', `/api/agent/skills/${encodeURIComponent(skillName)}`, {
        description: 'eval updated file Skill',
        instructions: 'Eval skill instructions v2.',
        allow_implicit_invocation: true,
      });
      assert.status(updated, 200, '可更新标准 Skill 文件');
      assert.eq(updated.json?.data?.description, 'eval updated file Skill', '文件更新后重新扫描生效');
      assert.eq(updated.json?.data?.allow_implicit_invocation, true, 'openai.yaml 策略更新生效');

      const deleted = await api('DELETE', `/api/agent/skills/${encodeURIComponent(skillName)}`);
      assert.status(deleted, 200, '可删除 App 创建的用户 Skill 目录');
      const afterDelete = await api('GET', `/api/agent/skills/${encodeURIComponent(skillName)}`);
      assert.status(afterDelete, 404, '删除后文件扫描不再返回 Skill');
    } finally {
      await api('DELETE', `/api/agent/skills/${encodeURIComponent(skillName)}`).catch(() => {});
    }
  },
};

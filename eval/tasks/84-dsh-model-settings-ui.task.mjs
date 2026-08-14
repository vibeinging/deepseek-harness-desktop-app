export default {
  id: "dsh-model-settings-ui",
  desc: "无模型验证模型设置页直接读写 DSH Settings、Credentials 和模型目录",
  eval: {
    feature: "dsh.model-settings-ui",
    layer: "ui_e2e",
    risk: "P0",
    interaction: "cdp",
    model: "none",
    data: "synthetic",
    platforms: ["darwin", "win32", "linux"],
    timeoutMs: 90_000,
    repeats: 1,
    minPassRate: 1,
    requirements: [
      "dsh.model-settings-authoritative",
      "dsh.model-credentials-write-only",
    ],
    tags: ["pr", "ui", "dsh", "models"],
    criteria: [
      {
        id: "dsh.model-settings-authoritative",
        description: "dsh-work 模型设置页通过 DSH Settings 新增和删除提供方",
        evidence: ["ui", "api"],
      },
      {
        id: "dsh.model-credentials-write-only",
        description: "模型密钥只写入 DSH Credentials，读取快照不返回密钥值",
        evidence: ["api"],
      },
    ],
  },
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const ui = driver.ui;
    const stamp = Date.now().toString(36);
    const route = "minimax-cn";
    const credentialRef = "MINIMAX_CN_API_KEY";
    const secret = `eval-secret-${stamp}`;
    let saved = false;

    const snapshot = async () => {
      const response = await api("GET", "/api/dsh/models");
      assert.status(response, 200, "DSH 模型设置快照可读取", {
        criterion: "dsh.model-settings-authoritative",
      });
      return response.json?.data || {};
    };

    try {
      const before = await snapshot();
      const piNamespace = (before.namespaces || []).find((item) => item.ns === "llm-pi-ai");
      assert.ok(before.writable === true, "当前 DSH Profile 公布可写设置", {
        criterion: "dsh.model-settings-authoritative",
      });
      assert.ok(Boolean(piNamespace), "当前 DSH Profile 公布 llm-pi-ai 设置空间", {
        criterion: "dsh.model-settings-authoritative",
      });
      if (!before.writable || !piNamespace) return;

      await ui.goto("/agent");
      await ui.waitFor('[data-agent-window-titlebar]', { timeout: 15_000 });
      await ui.click('button[title="设置"]', { timeout: 10_000 });
      await ui.clickText("模型设置", { selector: "button", exact: true, timeout: 10_000 });
      const settingsRoot = '[data-dsh-standard-settings-section="models"]';
      await ui.waitFor(settingsRoot, { timeout: 15_000 });
      const settingsText = await ui.text(settingsRoot);
      assert.ok(settingsText.includes("填入各提供方的 API 密钥即可使用其模型。"), "模型页由 DSH Client 标准 Models 插槽展示", {
        criterion: "dsh.model-settings-authoritative",
      });

      await ui.waitForText("deepseek-official", { selector: "span", exact: true, timeout: 10_000 });
      assert.ok(true, "模型页展示 DSH 公布的可配置提供方", {
        criterion: "dsh.model-settings-authoritative",
      });

      await ui.waitUntil(`async () => {
        const button = [...document.querySelectorAll('button')]
          .find((element) => element.textContent?.trim() === '添加提供方');
        return Boolean(button && !button.disabled);
      }`, {
        timeout: 15_000,
        label: "DSH 提供方目录入口加载完成",
      });
      await ui.clickText("添加提供方", { selector: "button", exact: true, timeout: 10_000 });
      await ui.waitFor('select[aria-label="提供方"]', { timeout: 10_000 });
      const providerSelected = await driver.raw.ev(`
        const select = document.querySelector('select[aria-label="提供方"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        setter?.call(select, ${JSON.stringify(route)});
        select?.dispatchEvent(new Event('change', { bubbles: true }));
        return Boolean(select);
      `);
      await ui.waitUntil(`async () => document.querySelector('select[aria-label="提供方"]')?.value === ${JSON.stringify(route)}`, {
        timeout: 5_000,
        label: "DSH 目录提供方已选择",
      });
      assert.eq(providerSelected, true, "从 DSH 目录选择提供方", {
        criterion: "dsh.model-settings-authoritative",
      });
      const keyFilled = await driver.raw.ev(`
        const select = document.querySelector('select[aria-label="提供方"]');
        let editor = select?.parentElement;
        while (editor && ![...editor.querySelectorAll('button')]
          .some((element) => element.textContent?.trim() === '保存')) {
          editor = editor.parentElement;
        }
        const input = editor?.querySelector('input[aria-label="API 密钥"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, ${JSON.stringify(secret)});
        input?.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(secret)} }));
        return Boolean(input);
      `);
      assert.eq(keyFilled, true, "在 DSH 提供方卡片填写只写密钥", {
        criterion: "dsh.model-credentials-write-only",
      });
      await ui.waitUntil(`async () => {
        const select = document.querySelector('select[aria-label="提供方"]');
        let editor = select?.parentElement;
        while (editor && ![...editor.querySelectorAll('button')]
          .some((element) => element.textContent?.trim() === '保存')) {
          editor = editor.parentElement;
        }
        const button = [...(editor?.querySelectorAll('button') || [])]
          .find((element) => element.textContent?.trim() === '保存');
        return Boolean(button && !button.disabled);
      }`, {
        timeout: 10_000,
        label: "DSH 提供方表单可以保存",
      });
      const saveClicked = await driver.raw.ev(`
        const select = document.querySelector('select[aria-label="提供方"]');
        let editor = select?.parentElement;
        while (editor && ![...editor.querySelectorAll('button')]
          .some((element) => element.textContent?.trim() === '保存')) {
          editor = editor.parentElement;
        }
        const button = [...(editor?.querySelectorAll('button') || [])]
          .find((element) => element.textContent?.trim() === '保存');
        button?.click();
        return Boolean(button);
      `);
      assert.eq(saveClicked, true, "保存 DSH 目录提供方", {
        criterion: "dsh.model-settings-authoritative",
      });
      await ui.waitForText(route, { selector: "li", exact: false, timeout: 20_000 });
      saved = true;

      const afterSave = await snapshot();
      const savedProvider = (afterSave.providers || []).find((provider) => provider.provider === route);
      const savedGroup = (afterSave.groups || []).find((group) => group.id === route);
      assert.eq(savedProvider?.active, true, "UI 新增的提供方已在 DSH 运行时激活", {
        criterion: "dsh.model-settings-authoritative",
      });
      assert.ok((savedGroup?.models || []).length > 0, "UI 新增的提供方进入 DSH 模型目录", {
        criterion: "dsh.model-settings-authoritative",
      });
      assert.eq(afterSave.credentials?.[credentialRef]?.configured, true, "UI 密钥写入 DSH Credentials", {
        criterion: "dsh.model-credentials-write-only",
      });
      assert.eq(JSON.stringify(afterSave).includes(secret), false, "DSH 快照不返回密钥值", {
        criterion: "dsh.model-credentials-write-only",
      });

      const deleteOpened = await driver.raw.ev(`
        const row = [...document.querySelectorAll('li')]
          .find((element) => element.textContent?.includes(${JSON.stringify(route)}));
        const button = row && [...row.querySelectorAll('button')]
          .find((element) => element.textContent?.trim() === '删除');
        button?.click();
        return Boolean(button);
      `);
      assert.eq(deleteOpened, true, "从 DSH Models 行打开删除确认", {
        criterion: "dsh.model-settings-authoritative",
      });
      await ui.clickText(`删除 ${route}`, { selector: "button", exact: true, timeout: 10_000 });
      await ui.waitUntil(`async () => ![...document.querySelectorAll('li')]
        .some((element) => element.textContent?.includes(${JSON.stringify(route)}))`, {
        timeout: 20_000,
        label: "自定义 DSH 提供方已从模型页删除",
      });
      saved = false;
      const afterRemove = await snapshot();
      const removedProvider = (afterRemove.providers || []).find((provider) => provider.provider === route);
      assert.eq(removedProvider?.active, false, "UI 删除后 DSH 目录保留提供方但停用运行时路由", {
        criterion: "dsh.model-settings-authoritative",
      });
    } finally {
      if (saved) {
        const current = await api("GET", "/api/dsh/models").catch(() => null);
        const data = current?.json?.data || {};
        const namespace = (data.namespaces || []).find((item) => item.ns === "llm-pi-ai");
        if (namespace) {
          await api("POST", "/api/dsh/models/settings/mutate", {
            ns: "llm-pi-ai",
            ops: [{ op: "unset", path: ["providers", route] }],
            expected_revision: namespace.revision,
          }).catch(() => {});
        }
      }
      await api("DELETE", `/api/dsh/models/credentials/${encodeURIComponent(credentialRef)}`).catch(() => {});
    }
  },
};

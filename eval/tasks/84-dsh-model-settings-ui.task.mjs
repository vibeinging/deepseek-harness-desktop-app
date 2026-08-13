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
    const route = `eval-ui-${stamp}`;
    const displayName = `Eval UI ${stamp}`;
    const modelId = `eval-model-${stamp}`;
    const credentialRef = `${route.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
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
      await ui.waitFor('[data-testid="dsh-model-settings"]', { timeout: 15_000 });
      const settingsText = await ui.text('[data-testid="dsh-model-settings"]');
      assert.ok(settingsText.includes("DSH 模型提供方"), "模型页明确展示 DSH 提供方目录", {
        criterion: "dsh.model-settings-authoritative",
      });

      const visibleProviders = await driver.raw.ev(`
        return [...document.querySelectorAll('[data-dsh-provider]')]
          .map((element) => element.getAttribute('data-dsh-provider'));
      `);
      const configuredProviders = (before.providers || [])
        .filter((provider) => provider.settingsNs)
        .map((provider) => provider.provider);
      assert.eq(
        configuredProviders.every((provider) => visibleProviders.includes(provider)),
        true,
        "模型页展示 DSH 公布的可配置提供方",
        { criterion: "dsh.model-settings-authoritative" },
      );

      await ui.clickByTestId("dsh-add-provider", { timeout: 10_000 });
      await ui.fillByTestId("dsh-provider-id", route, { timeout: 10_000 });
      await ui.fillByTestId("dsh-provider-display-name", displayName, { timeout: 10_000 });
      await ui.fillByTestId("dsh-provider-base-url", "http://127.0.0.1:1/v1", { timeout: 10_000 });
      await ui.clickByTestId("dsh-provider-api", { timeout: 10_000 });
      await ui.typeText("OpenAI Chat Completions");
      await ui.press("Enter");
      await ui.fillByTestId("dsh-provider-api-key", secret, { timeout: 10_000 });
      await ui.clickByTestId("dsh-add-model", { timeout: 10_000 });
      await ui.fillByTestId("dsh-model-id-0", modelId, { timeout: 10_000 });
      await ui.fillByTestId("dsh-model-name-0", "Eval Model", { timeout: 10_000 });
      await ui.waitUntil(`async () => document.querySelector('[data-testid="dsh-save-provider"]')?.disabled === false`, {
        timeout: 10_000,
        label: "DSH 提供方表单可以保存",
      });
      await ui.clickByTestId("dsh-save-provider", { timeout: 10_000 });
      await ui.waitFor(`[data-dsh-provider="${route}"]`, { timeout: 20_000 });
      saved = true;

      const afterSave = await snapshot();
      const savedProvider = (afterSave.providers || []).find((provider) => provider.provider === route);
      const savedGroup = (afterSave.groups || []).find((group) => group.id === route);
      assert.ok(Boolean(savedProvider), "UI 新增的提供方进入 DSH provider 目录", {
        criterion: "dsh.model-settings-authoritative",
      });
      assert.ok((savedGroup?.models || []).some((model) => model.id === modelId), "UI 新增的模型进入 DSH 模型目录", {
        criterion: "dsh.model-settings-authoritative",
      });
      assert.eq(afterSave.credentials?.[credentialRef]?.configured, true, "UI 密钥写入 DSH Credentials", {
        criterion: "dsh.model-credentials-write-only",
      });
      assert.eq(JSON.stringify(afterSave).includes(secret), false, "DSH 快照不返回密钥值", {
        criterion: "dsh.model-credentials-write-only",
      });

      await driver.raw.ev(`
        document.querySelector('[data-testid="dsh-remove-provider-${route}"]')?.click();
        return true;
      `);
      await ui.clickByTestId(`dsh-confirm-remove-provider-${route}`, { timeout: 10_000 });
      await ui.waitUntil(`async () => !document.querySelector('[data-dsh-provider="${route}"]')`, {
        timeout: 20_000,
        label: "自定义 DSH 提供方已从模型页删除",
      });
      saved = false;
      const afterRemove = await snapshot();
      assert.eq(
        (afterRemove.providers || []).some((provider) => provider.provider === route),
        false,
        "UI 删除同步到 DSH provider 目录",
        { criterion: "dsh.model-settings-authoritative" },
      );
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

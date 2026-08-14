# dsh-work 二次元版

[返回正式 README](README.md) | [English](README.en.md)

> 拳打 WorkBuddy，脚踢 Codex。
>
> 让 Plugin 组队，让每一个好点子真正落地。

dsh-work 是一个披着二次元外衣、认真把任务做完的本地 AI 工作桌面。看板娘负责提醒你继续前进，DSH Session 负责保存消息、计划、工具、队列和运行事实。

![dsh-work 二次元首页](docs/images/readme/dsh-work-home.png)

## 两套主题，两种工作状态

- 专业蓝是默认主题，适合日常项目工作与正式演示。
- 二次元蓝是可选主题，启用后看板娘会回到新对话首页。
- 两套主题都来自 `@deepseek-ai/dsh-theme-pack`，跟随 DSH Web Profile 安装和加载，不是 App 里写死的两份开关。

## 真正的力量来自 Plugin

- Plugin 注册模型、工具、Skill、MCP、策略或界面能力。
- Bundle 带着 `cordis.patch.yml` 进入 Profile。
- Profile 决定本次启动有哪些能力以及它们的顺序。
- UI Plugin 通过 `dsh.client` 进入同一套 DSH Client Context。

看板娘只是表现层。消息、计划、工具调用、队列、权限、历史和 Agent 运行都以 DSH 为准；项目、文件和产物数据由 dsh-work 产品层按 Session 授权。

## 开始开发

准备 Node.js 24 或更高版本：

```bash
npm install
npm run doctor
npm run dev
```

当前仍处于内测阶段。真实验收要在 Electron 中完成，不能只看浏览器里的 Renderer 页面。

插件安装、兼容性检查、UI Slot 边界、开发合同和完整架构见[正式 README 的“使用其他插件”](README.md#使用其他插件)。

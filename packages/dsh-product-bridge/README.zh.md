# dsh-work 产品桥接

[English](README.md) | 中文

这个私有 Profile Bundle 在不导入、不修改 DSH 源码检出目录的前提下扩展官方 DSH Web Profile。它把 `project_list`、`conversation_list`、四个 dsh-work Canvas/Site 工具、三个 Office 产物工具和 `ui_render` 注册到 Agent 作用域的 DSH 工具目录。它的 `product.json` 还向 dsh-work 的 `agent.workbench.tool` 产品位置贡献结果、浏览器、文件、产物和站点页面；应用外壳从当前 Profile 目录读取这些贡献，不再在 `AgentShell` 中维护第二份页面清单。

子进程只发送 DSH Session id。父进程把它绑定到一个已授权的 dsh-work Session、用户和项目，再通过一个受控 IPC dispatcher 处理项目、对话、Canvas/Site 和 Office 请求。请求不能切换到另一身份或项目；Canvas/Site 创建、编辑、建议以及 Office 创建、编辑都需要 DSH 审批。每次调用都会生成普通且可持久恢复的 DSH 工具事件；写入成功后还会投影一条隐藏工作台事件，让实时界面和恢复后的历史打开同一个 Canvas、Site 或产物。

每个进入模型的步骤都会通过同一个父进程绑定读取允许使用的应用指令、项目指令和全局/项目记忆。产品桥把它们作为不可变用户消息加入 `agent/pre-step` 的进入批次，并分别以 `dsh-work-context` 和 `dsh-work-memory` 来源写入 DSH Session Log；读取失败只跳过这次补充，不会替换用户消息或建立第二份历史。

产品桥还记录父 Agent 最终解析出的 provider/model。DSH 创建子 Agent 时，它会在第一次请求前固定同一目标，避免子 Agent 回退到进程启动默认模型；父 Agent 之后的新请求仍按自己的正常设置解析。

运行时就绪消息和产品 IPC 使用带回调的发送方式，因此父进程关闭会正常胜过较晚完成的 Loader，不会留下未处理的通道错误。

已删除的项目 Plugin 挂载、Skill 和 MCP 数据不会通过 ProductHost 投影。它们的目录方法返回空目录，而 Profile Bundle 的 Skill 和工具继续由 DSH 原生注册表管理。

工作台产品位置使用官方 rc.6 `SlotCore` 和 `createSlotRenderer`，但它的 SlotMap 和 Host 服务属于 dsh-work，而不是 DSH Web。dsh-work 主界面通过经过审核的 `dsh-work-shell` Client Plugin 进入当前 Profile 的 Client 图。工作台页只渲染经过允许的本地组件；在社区 Client 代码能够离开高权限 Electron Renderer 独立运行之前，候选 Bundle 只要包含 `dsh.client` 就会在预检时被拒绝。因此用户安装的 Bundle 既不能执行 Client 代码，也不能只靠 JSON 名称进入 Renderer。

## 模型体验

模型通过 DSH 获得 `project_list`、`conversation_list`、`canvas_inspect`、`canvas_create`、`canvas_edit`、`canvas_suggest`、三个 `artifact_office_*` 工具和 `ui_render`，并在同一 Session Log 中接收已授权的指令与记忆。Canvas 与 Site 写入使用不可变基础版本；Office 读取保留稳定编辑锚点，并从模型结果中去掉界面预览 SVG 数据。`ui_render` 由父进程校验有界的结构化文档，并能从 DSH 历史恢复同一交互界面。

#### KV Cache 影响

同一 Bundle 版本的工具 Schema 保持稳定。Profile 顺序或 Bundle 版本变化会重启 DSH 运行时，并可能改变可复用的工具前缀。

## 已知限制和后续工作

- rc.6 SDK 已不再发布原来的 ProductHost 和项目工具包，因此这个应用自有 Bundle 直接持有十个产品工具及其安全父进程桥接。
- rc.6 SDK 包可以公开读取，不需要 `NPM_TOKEN`，但开发时必须显式固定 `next`/rc.6 发布系列，因为部分细包的 `latest` 仍指向旧版本。开发时不能链接 DSH 源码，也不能混装不同 RC 系列。
- 本包为私有包；成品必须携带相同的审核版本和匹配的官方 NPM SDK 版本。

# dsh-work 产品桥接

[English](README.md) | 中文

这个私有 Profile Bundle 在不导入、不修改 DSH 源码检出目录的前提下扩展官方 DSH Web Profile。它把 `project_list`、`conversation_list` 和 dsh-work 自有 Office 产物工具注册到 Agent 作用域的 DSH 工具目录。它的 `product.json` 还向 dsh-work 的 `agent.workbench.tool` 产品位置贡献结果、浏览器、文件、产物和站点页面；应用外壳从当前 Profile 目录读取这些贡献，不再在 `AgentShell` 中维护第二份页面清单。

子进程只发送 DSH Session id。父进程把它绑定到一个已授权的 dsh-work Session、用户和项目，再通过一个受控 IPC dispatcher 处理项目、对话和 Office 请求。请求不能切换到另一身份或项目，Office 创建和编辑需要 DSH 审批，每次调用都会生成普通且可持久恢复的 DSH 工具事件。

已删除的项目 Plugin 挂载、Skill 和 MCP 数据不会通过 ProductHost 投影。它们的目录方法返回空目录，而 Profile Bundle 的 Skill 和工具继续由 DSH 原生注册表管理。

工作台产品位置使用官方 rc.2 `SlotCore` 和 `createSlotRenderer`，但它的 SlotMap 和 Host 服务属于 dsh-work，而不是 DSH Web。Bundle/Profile 是共同的安装和生命周期权威；DSH 浏览器插件使用嵌套 `dsh.client` 与官方 Slot，dsh-work 的宿主页只渲染经过允许的本地组件。当前只有随应用提供的 Bundle 可以取得这些组件的渲染权限，用户安装的 Bundle 不能只靠 JSON 名称进入 Electron renderer。

## 模型体验

模型通过 DSH 获得 `project_list`、`conversation_list` 和三个 `artifact_office_*` 工具。Office 读取保留稳定编辑锚点，并从模型结果中去掉界面预览 SVG 数据。

#### KV Cache 影响

同一 Bundle 版本的工具 Schema 保持稳定。Profile 顺序或 Bundle 版本变化会重启 DSH 运行时，并可能改变可复用的工具前缀。

## 已知限制和后续工作

- rc.2 SDK 已不再发布原来的 ProductHost 和项目工具包，因此这个应用自有 Bundle 直接持有五个产品工具及其安全父进程桥接。
- 私有 npm SDK 必须使用有权限的 `NPM_TOKEN`，并显式固定同一发布系列；不能使用无权限的旧 npm 登录、依赖错误的 `latest` 标签、链接 DSH 源码或混装不同 RC 系列。
- 本包为私有包；成品必须携带相同的审核版本和匹配的官方 NPM SDK 版本。

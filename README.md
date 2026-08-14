# dsh-work

中文 | [English](README.en.md)

> [查看二次元版 README：二次元主题与看板娘](README.anime.md)

dsh-work 是建立在 DeepSeek Harness（DSH）之上的本地 AI 工作桌面。它把 DSH 的 Session、Agent、Tool、Skill、MCP、Profile Bundle 和 Web Client 运行时组织成一个面向项目、文件、网页与产物的桌面产品。

当前项目仍处于内测阶段，不代表已经公开发布。

![dsh-work 项目会话](docs/images/readme/dsh-work-project-session.png)

## 快速开始

本地开发要求 Node.js 24 或更高版本。当前代码精确使用公开 npm 上的 DSH `0.1.0-rc.6` 发布线，安装官方 SDK 不需要 `NPM_TOKEN`。

```bash
npm install
npm run doctor
npm run dev
```

切换 Node.js 大版本、CPU 架构或操作系统后，重新准备依赖：

```bash
npm run setup
```

最终验收必须运行真实 Electron。单独打开 Renderer 页面不能证明 DSH 子进程、IPC、系统权限、本地文件和原生模块正常。

## 功能全景与融合状态

这里的“使用 DSH 官方 Web”不是把官方页面原样放进 Electron。dsh-work 保留官方 Web Profile 的 Session、Agent、Tool、Skill、MCP、Client Loader 和 Slot 运行图，再用自己的桌面外壳替换可见的布局、侧栏、对话和通用设置页面。功能分为三类：

- **DSH 原生**：状态和执行都由官方 DSH 服务与 Session Log 管理。
- **DSH 正式桥接**：产品数据属于 dsh-work，但通过 Profile Bundle、Agent Tool、Session 绑定或 Slot 合同进入同一条 DSH 运行链。
- **桌面产品能力**：由 Electron 或 dsh-work 产品层负责；不会伪装成 DSH 原生功能，只在需要时把网页、文件、目录或产物交给当前 DSH Session。

### DSH 原生能力

| 功能 | 用户可以做什么 | 融合与权威来源 |
|---|---|---|
| 对话与恢复 | 流式回答、思考、工具卡片、停止、继续和重启后恢复 | 一个产品会话绑定一个 DSH Session；`session.history` 是消息和恢复权威 |
| 运行中控制 | 排队发送、运行中补充 steer、查看等待状态 | DSH Agent 队列与 Session 事件，不维护第二份产品队列 |
| 模型与推理 | 选择 Provider、模型、推理强度和凭据引用 | DSH Settings、Credentials 和模型目录；界面不读取明文密钥 |
| 权限、审批、提问、计划与待办 | 切换 Session 权限，处理工具审批与模型提问，查看 Plan/todo 进度，执行 `/compact` | DSH 命令、交互协议、投影和 `todo/write` 事件；审批规则可按本次、当前 Session 或长期范围记住 |
| Tool、Skill、MCP 与 Hook | 使用 Profile 中已经加载的工具、技能、MCP 服务和 Hook | DSH Web Profile 的 Host 运行树与 Agent 作用域注册表 |
| 多 Agent | 分派子任务，在对话和轨迹中查看子 Agent 工具事件，等待并汇总回主对话 | DSH Subagent 与 Workflow；子 Agent 固定继承父会话已解析的模型目标；官方独立子 Agent 管理页尚未映射 |
| 图片与联网结果 | 粘贴或选择图片、使用 DSH Web 工具、恢复网页来源卡 | DSH 内容寻址附件、ToolEventView 和 Session Log |
| 结果与证据 | 查看每一轮事件、工具输入输出、耗时、Token 和最终回答 | 只读取 DSH `session.history`；`/runs` 与 `/trace` 打开同一权威轨迹 |

### 通过 DSH 正式桥接的产品能力

| 功能 | 用户可以做什么 | 融合方式 |
|---|---|---|
| 应用/项目上下文与记忆 | 设置应用指令、项目指令、临时对话边界，启用全局或项目记忆 | `dsh-product-bridge` 在 `agent/pre-step` 注入不可变消息，并以 `dsh-work-context` / `dsh-work-memory` 写入同一 Session Log |
| 项目和对话查询 | 让模型列出当前用户的项目和当前项目的对话 | Agent 作用域中的 `project_list`、`conversation_list`；父进程决定用户和项目身份 |
| Git Worktree | 创建、启用、停用和删除隔离工作目录；让新对话在所选目录执行 | 产品层管理 Git 生命周期，启用目录作为新 DSH Session 的 `cwd`；Diff 和按行编辑使用同一活动根目录 |
| Canvas 与本地 Site | 让模型读取、创建、修改 Canvas，生成精确行内建议；创建和更新单文件 Site | `canvas_inspect/create/edit/suggest` 注册为 DSH Tool；写操作需要 DSH 审批，结果事件打开对应工作台 |
| Office 产物 | 读取、创建和定点编辑 Markdown、DOCX、XLSX、PPTX、PDF，保留不可变版本 | `artifact_office_inspect/create/edit` 注册为 DSH Tool；父进程限制在绑定项目和 Session 内 |
| 结构化界面 | 让模型在回答中生成布局、文字、指标、表格、图表、图片、按钮和表单 | `ui_render` 注册为 DSH Tool；父进程校验整个文档并写入 Session Log，按钮和表单操作作为下一条用户消息返回模型 |
| 右侧工作台 | 添加、切换、折叠和关闭结果、浏览器、文件、产物与 Site 标签 | 当前 Profile 通过 dsh-work 自有的 `agent.workbench.tool` 位置提供受信任页面清单，底层复用 DSH SlotCore |
| 随应用 UI 与主题 Bundle | 使用设置扩展、浮层、侧栏动作、输入区停靠内容和受限主题 token | 经过审核并随应用提供的 Client Bundle 进入同一 DSH Client 图；用户安装的 `dsh.client` 新候选被阻止，旧安装从活动图隔离 |

### dsh-work 桌面产品能力

| 功能 | 用户可以做什么 | 与 DSH 的交接 |
|---|---|---|
| 桌面外壳与导航 | 三列工作台、左右栏折叠、前进/后退、新对话、全局搜索、缩放快捷键和应用更新检查 | Electron 与产品路由负责；会话内容仍由绑定的 DSH Session 提供 |
| 项目与源码目录 | 创建、重命名、排序、置顶和归档项目，维护多个授权源码目录，在 Finder 中打开并设置 Agent 写入目标 | 产品数据库负责组织和权限；新 DSH Session 获得解析后的活动工作目录，项目记忆按项目隔离 |
| 对话组织 | 新建项目/全局/临时对话，置顶、排序、重命名、归档、恢复和删除 | 对话绑定 DSH Session；跨项目移动因 DSH 不支持而明确禁用 |
| 输入与引用 | 通过 `@` 引用项目文件、通过 `#` 引用其他对话，粘贴图片；大段文本自动转为 TXT 附件 | 引用和附件进入当前 DSH 请求；临时对话退出后清理，不进入普通历史 |
| 消息操作 | 复制回答，从用户消息或回答处编辑、重试并建立分支 | 新分支建立新的产品会话和 DSH Session，原对话保持不变 |
| 编码工作区 | 查看当前 Diff、逐行评论和编辑、在外部编辑器打开、发起 AI Review，安全撤销模型产生的文件修改 | Diff、编辑和回退锁定 Session 创建时的 `cwd`，用内容哈希拒绝过期操作；不提供 stage、commit 或 push |
| 文件工作台 | 浏览 Source、任务和产物根目录，预览文本、代码、图片与 Office 提取内容，按文件名或正文搜索，在本机打开或显示，并发布为产物 | 文件树属于产品界面；文件引用进入对话，Agent 实际读写仍通过 DSH 当前 `cwd`、文件工具和权限 |
| Browser Workspace | 最多 12 个标签页，支持导航、历史、页内查找、缩放、下载、打印、开发者工具、站点权限、存储清理、网页快照和“使用此页” | Electron WebContentsView 负责真实网页；页面文字和截图可交给当前 DSH Session，但它不是 DSH Web Tool 的替身 |
| 全局搜索 | 搜索项目、对话、文件、产物和已保存网页来源，并按类型过滤 | 搜索结果打开对应产品页面；需要模型处理时再加入当前对话 |
| 产物库与 Office 编辑器 | 搜索、筛选、预览、比较和恢复版本，发布本地文件，选择 Office 内容并插入结构化引用 | 手动管理在产品层；模型侧 Office 写入通过上面的 DSH Tool 桥接 |
| Canvas 工作区 | 查看版本、编辑内容、比较变化，接受或拒绝行内建议，并处理版本冲突 | 产品层保存不可变版本；模型读写走上面的 Canvas DSH Tool |
| 本地 Site 工作区 | 桌面/平板/手机响应式预览、选择 DOM 后询问 DSH、查看版本并导出单文件页面 | 页面在隔离沙箱中预览；模型读写走 Canvas/Site DSH Tool，目前没有部署服务 |
| 主题与外观 | 在 Profile 提供的正式蓝和二次元蓝间切换，调整明暗模式、个人背景和透明度 | Profile 描述主题 token，产品外观 Store 保存个人选择；普通版本关闭本地主题创建和导入 |
| 桌面设置 | 语言、缩放、外观、终端字体、代理、证书、超时、联网方式、通知、声音、草稿和显示选项 | 应用设置属于 Electron；模型、凭据、权限和 Profile 设置仍由 DSH 管理 |
| 公开分享查看 | 通过 `/share/:token` 打开只读分享内容 | 当前只有查看路由；创建、管理和撤销分享的产品入口尚未接入 |
| 首次使用与隐私 | 本地初始化、数据位置提示和隐私选项 | 产品层负责本地体验，不改变 DSH 的凭据和网络边界 |

## DSH 轨迹就是结果与证据

右侧“结果与证据”不维护第二套运行中心。它只读取当前绑定 DSH Session 的 `session.history`，把用户消息、请求上下文、模型输出、工具调用、工具结果、权限变化、投影和最终回答放在同一条可回放轨迹里。普通对话历史在 DSH 读取失败时可以退化到带 `dsh_degraded` 标记的本地产品投影，但结果与证据面板本身不会拿这份投影冒充 DSH 轨迹。

![DSH 轨迹演示](docs/images/readme/dsh-trajectory.gif)

这段 GIF 来自真实 Electron、当前 DSH Profile、当前配置模型和一轮真实 `todo_write` 调用。录制脚本会确认轨迹来源为 `session.history`，并在结束后删除临时项目和会话。

![DSH session.history 轨迹](docs/images/readme/dsh-trajectory.png)

轨迹面板会聚合隐藏高频 `assistant/chunk` 流分片，但保留最终模型消息、工具调用和工具结果。每个保留事件都可以展开查看原始 DSH HistoryEntry，不会混入旧运行中心或其他 Trace 产品的数据。

## 对话和工作台

一个项目会话对应一个 DSH Session。当前 Profile Bundle 可以向右侧工作台提供结果与证据、浏览器、文件、产物和 Site 标签；Agent 执行、DSH 工作目录、当前 Diff 和行编辑跟随当前项目与启用的 Worktree。项目文件树和文件引用仍按项目配置的授权源码目录展示，避免切换 Worktree 时悄悄改变用户正在浏览的目录。

![dsh-work 文件面板](docs/images/readme/dsh-work-files.png)

### Canvas 与 Site 工作区证据

下面两张截图来自对应的真实 Electron 冒烟。Canvas 截图是在创建、编辑、行内建议、恢复和两次并发冲突分支完成后拍摄，显示保留本地稿得到的 v7；Site 截图是在创建、交互、DOM 选择、源码编辑、恢复、导出和 App 重启恢复完成后拍摄。

![dsh-work Canvas 版本与冲突处理](docs/images/readme/dsh-work-canvas.png)

![dsh-work 本地 Site 响应式预览](docs/images/readme/dsh-work-site.png)

## Git Worktree 隔离开发

项目设置中的 Git Worktree 不是只读状态展示。它覆盖一条完整的隔离开发链路：

1. 在项目的 Git 仓库根目录下创建独立分支和 `.dsh-worktrees/<id>` 工作目录；分支名可以填写，也可以留空自动生成。
2. 同一项目可以管理多个 Worktree，但一次只启用一个。启用后，新建对话的 Agent、DSH Session、当前 Diff 和按行编辑都使用该 Worktree，主检出保持不变；项目文件树仍显示项目配置的授权源码目录。
3. 可以随时切回主检出。启用中的 Worktree 不能直接删除，必须先切回主检出并确认删除；删除工作目录后保留 Git 分支，避免误删提交。
4. 项目成员可以查看 Worktree，只有项目所有者可以创建、切换和删除。非 Git 目录、仓库子目录、重复分支、越界或符号链接目录都会被拒绝；磁盘上已经丢失的 Worktree 会标记为不可用。
5. 创建记录保存失败时会补偿删除刚创建的 Worktree 和分支；多个 Worktree 意外同时标记为启用时会回退主检出，下一次明确切换会修复状态。

DSH Session 会固定创建时的工作目录。应先启用目标 Worktree，再新建对话；已有对话不会静默迁移到另一个目录，切换后请为新的工作目录创建新对话。

下面的 GIF 来自真实 Electron 和临时本地 Git 仓库，不调用模型。录制过程同时核对 UI、项目 API、Git Worktree、当前 Diff 和主检出文件，结束后删除临时项目。

![dsh-work Git Worktree 完整流程](docs/images/readme/dsh-work-worktree.gif)

![dsh-work 已启用的 Git Worktree](docs/images/readme/dsh-work-worktree.png)

## 与 DSH 官方 Web 的准确关系

当前项目对话的执行只走所选官方 DSH Web Profile 的 Session 与 Agent，也没有把完整官方 Web 页面套进 iframe。dsh-work Server 仍负责产品数据、授权、历史投影、运行诊断和少量非项目对话服务；插件安装与加载顺序以 `web` Profile 为准。正式 Electron 启动官方 npm `0.1.0-rc.6` Web Profile，继续使用它的 Host 服务、Web API、Session、Agent、Tool、Skill、MCP、Client Loader 和 Client 插件图。`@deepseek-ai/dsh-work-shell` 在同一个 Cordis Client Context 中替换可见桌面外壳。

```text
Electron 主进程
  -> 官方 DSH Web Profile
     -> Host：Session / Agent / Tool / Skill / MCP / Settings / Web API
     -> Client Loader 与同一 Client 插件图
        -> dsh-work-shell：桌面布局、侧栏、对话、通用设置
        -> 已映射的官方 Slot 与随应用提供的受信任 UI
     -> dsh-product-bridge：绑定产品 Session 后提供上下文、记忆、Canvas/Site、Office、结构化界面工具
  -> dsh-work 产品服务：项目、授权目录、BrowserView、Worktree、产物与本地设置
```

为了只保留一套可见产品界面，当前 Profile 补丁会关闭官方 `ui-layout`、`ui-sidebar`、`ui-conversation` 和 `ui-settings-general` 页面行，再由 dsh-work shell 提供对应界面。这不会关闭底层 DSH 服务，也不会建立第二份 Session 或 Agent 状态。

当前主窗口已经为随应用提供的受信任 Client Bundle 映射 `settings.section`、部分 `settings.general.item`、Profile 自有的 `settings.plugins.tab`、`shell.overlay`、`sidebar.footer.action` 和只读的 `conversation.composer.dock`，模型设置页直接复用官方 DSH Models section。交互式 input/message、完整 `conversation.composer`、`conversation.session.header.actions` 和官方子 Agent 页面尚未支持；`details` 只用于满足插件依赖，还没有渲染。替换整个 `sidebar`、`conversation` 或 `details` 的 UI 也不会显示在 dsh-work 主窗口。

这条边界有四条规则：

1. Session 的消息、运行、计划、队列、权限、工具事件和历史以 DSH 为准。
2. Profile 的依赖与 `dsh.profile.bundles` 是插件安装和加载顺序的唯一权威。
3. 产品能力必须通过绑定 Session、DSH Tool、Client Plugin 或明确 Slot 进入运行链，不能直接改 DSH 源码或维护平行状态。
4. 项目数据库、文件授权、BrowserView、Worktree 和产物版本由 dsh-work 负责；只有需要模型使用的部分才通过窄桥授权给 DSH。

![DSH Web Profile Bundle 列表](docs/images/readme/dsh-profile-bundles.png)

## 使用其他插件

dsh-work 的安装单位是 DSH Profile Bundle。普通用户应从应用左侧的“插件”页面安装；这个入口使用应用当前的 `DSH_HOME` 和 `web` Profile，避免把插件装进另一个 DSH 环境。

### 从插件中心安装

1. 打开左侧“插件”，选择“安装 Bundle”。
2. 输入一个不可变来源。npm 包必须带精确版本，例如 `@example/dsh-tools@1.2.3`；[dsh-external](https://github.com/dsh-external) 仓库必须带完整 40 位 commit，例如 `github:dsh-external/DSH-better-sidebar#<40位commit>`。
3. 选择“检查兼容性”。dsh-work 会在隔离的候选 Profile 中安装来源，检查 Bundle 清单、当前 DSH SDK、浏览器构建产物和最终组合配置。
4. 只有检查结果为“可以安装”时，才能选择“安装到当前 Profile”。安装完成后 DSH 运行时会重启，Bundle 顺序会出现在插件列表中。
5. 打开 Bundle 详情确认来源、版本、加载顺序和浏览器表层。用户安装的 Bundle 可以从列表卸载；DSH 内置和随 dsh-work 提供的 Bundle 不能从这里卸载。

插件中心不接受 `latest`、分支名、普通 GitHub 页面地址或没有固定版本的 npm 包。安装使用 `--ignore-scripts`，不会自动执行社区仓库的构建脚本；插件作者必须把运行入口和 `exports["./client"]` 指向的浏览器产物放进发布包或固定 commit。

本地插件目录只用于开发。需要显式设置 `DSH_PROFILE_ALLOW_LOCAL_PLUGINS=1` 后启动应用，再在安装框中输入包含 `package.json` 的绝对目录；普通用户不应使用这条路径。

### 安装后会出现什么

| 插件类型 | 当前结果 |
|---|---|
| Tool、Skill、MCP、Hook 或 Host 服务 | 进入 DSH Host 运行树，可能没有独立页面；是否生效应从对应能力和 Session 事件确认 |
| 用户安装的 `dsh.client` UI | 新候选由 `DSH_PROFILE_CLIENT_ISOLATION_REQUIRED` 阻止；旧安装会保留依赖记录，但在每次启动前从活动 Bundle 图隔离，并在插件中心显示为“已隔离”、允许卸载 |
| 随应用提供的受信任 Client Bundle | 可以使用已映射的 `settings.section`、`shell.overlay`、`sidebar.footer.action` 和只读 `conversation.composer.dock`；完整侧栏、对话和详情页仍未映射 |
| 数据型主题 Bundle | 可以通过受限的 `dshWork.themes` 描述提供颜色和外观 token，不允许注入任意 CSS；带 `dsh.client` 代码的社区主题仍会被阻止 |
| dsh-work 工作台页面 | `agent.workbench.tool` 目前只允许随应用提供的受信任组件；社区 Bundle 不能通过 JSON 名称请求任意 Electron 组件 |

因此，当前插件中心面向社区开放的是 Host Bundle。带 Client 代码的候选不会显示“可以安装”，已安装的社区 Client Bundle 也不会进入主窗口运行图，直到它能在与 Electron API 隔离的渲染环境中运行；已经随应用审核交付的 Client Bundle 仍按上面的映射位置工作。

### 开发可安装的 Bundle

最小 Host Bundle 需要在 `package.json` 中声明补丁文件，并由 `cordis.patch.yml` 把插件行放进运行树：

```json
{
  "name": "@example/dsh-tools",
  "version": "1.2.3",
  "type": "module",
  "main": "./lib/index.js",
  "files": ["lib/index.js", "cordis.patch.yml"],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.6"
  }
}
```

```yaml
- insert:
    - id: example-tools
      name: '@example/dsh-tools'
```

开发依赖必须来自官方 npm SDK，保持在当前 rc.6 发布线；不能把 TypeScript 配置或包依赖指向本地 DSH 源码检出目录。第三方 `dsh.client` Bundle 当前只能开发和测试，不能通过插件中心安装到主窗口；需要作为随应用组件经过审核，或等待独立 Client 渲染宿主完成。

可参考应用内的 [dsh-work shell Client Plugin](packages/dsh-work-shell/README.md)、[主题 Bundle](packages/dsh-theme-pack/README.md) 和 [产品桥 Bundle](packages/dsh-product-bridge/README.zh.md)。需要界面能力时必须先建立并评审隔离的宿主合同，不能绕过 Profile、Slot 和 Electron 权限边界直接导入组件。

## 主题

正式蓝和二次元蓝都由 `@deepseek-ai/dsh-theme-pack` Profile Bundle 提供，不登记为两套 App 内置主题。

- `professional-blue` 是默认主题，使用克制的工作界面，不显示二次元首页角色。
- `anime-blue` 是可选主题，保留清透蓝配色和看板娘首页。
- Renderer 只保留一个不出现在主题库中的安全底座，用于 Profile 尚未就绪或主题 Bundle 异常时恢复界面。

主题来源、顺序和卸载跟随 Web Profile。`dshWork.themes` 是 dsh-work 的受控产品描述，只允许颜色、色板和外观 token；它不是 DSH 官方字段，也不建立第二套插件生命周期。

正式产品不提供本地主题导入或新建入口。用户可以单独调整个人背景与透明度，但新的视觉主题必须作为 Profile Bundle 交付。

## 当前没有的功能

下面这些能力目前不应写成已经支持：

- 自动化后端和调度合同已经存在，但五列任务看板与定时任务页面尚未接入当前产品壳；用户现在能使用的是对话内 DSH 计划和待办。
- 没有 Git 图谱、提交历史时间线和 stage/unstage/discard 面板；已有 Worktree、Diff、行编辑和安全回退。
- 没有独立终端页，也没有官方完整子 Agent 管理页、子会话导航和 Header 操作；子 Agent 执行及其工具事件可在当前对话和 DSH 轨迹中查看。
- 本地 Site 没有部署，公开分享只有只读查看路由，没有创建、管理和撤销入口。
- 没有移动端远程控制、二维码配对、公网隧道和 SSH/SFTP/端口转发。
- 没有可互动宠物、成长系统和多皮肤市场；当前提供 `professional-blue` 与 `anime-blue` 两个主题 Bundle，二次元主题中的角色是静态首页内容。
- DSH Session 当前不能跨项目移动，因此“移动对话”入口明确显示为暂不支持；分支、重试和编辑消息可以正常使用。
- Token 用量来自 DSH 轨迹，当前没有输入框下方的实时 TPS、LLM 耗时和缓存命中率条。

## 产品桥

[`@deepseek-ai/dsh-product-bridge`](packages/dsh-product-bridge/README.zh.md) 是随应用提供的 Profile Bundle。它通过 DSH 正式接口向当前 Agent 作用域注册项目、对话、Canvas/Site、Office 产物与 `ui_render` 共 10 个工具，并向 `agent.workbench.tool` 贡献工作台页面。

产品桥只传递 DSH Session id。用户、项目、目录权限和凭据由父进程解析，Renderer 与 Bundle 配置不会持有明文凭据。

应用指令、项目指令和允许使用的记忆由产品桥在 `agent/pre-step` 注入，并以 `dsh-work-context` 或 `dsh-work-memory` 来源写入同一 Session Log。子 Agent 启动前会固定父会话已经解析出的 provider/model，避免继承启动默认模型。

## 开发检查

```bash
npm run typecheck
npm run test:renderer
npm run test:unit
npm run eval:pr
npm run eval:ui
```

重新录制 README 轨迹媒体：

```bash
node eval/readme-media-capture.mjs
node eval/readme-worktree-media-capture.mjs
```

## 目录

| 目录 | 作用 |
|---|---|
| `electron/` | 桌面窗口、IPC、原生能力与打包 |
| `renderer/` | dsh-work React 产品界面与 Client Plugin 构建 |
| `server/` | 产品服务、权限、Profile 管理与 DSH 进程连接 |
| `packages/` | 随应用进入 Web Profile 的 Bundle 与 Client Plugin |
| `eval/` | 合同测试、运行时测试和真实 Electron 评测 |
| `docs/` | 架构审查、计划、设计与阶段护栏 |

## 数据与安全

本地数据默认位于 `~/.dsh`，包括 Profile、Session、运行记录、项目数据和产物版本。

- 不要把 API Key、密码、私有地址、真实业务数据或本地数据库提交到 Git。
- 本地 Source 目录默认只读；Agent 写入需要明确授权目录。
- Bundle 不能通过浏览器参数选择其他用户、项目或凭据。
- 模型、MCP、OAuth 和远程服务仍受各自网络与账号边界限制。

完整规则见 [PRIVACY.md](PRIVACY.md)、[SECURITY.md](SECURITY.md) 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 平台状态

| 平台 | 当前状态 |
|---|---|
| macOS Apple Silicon | 开发与目录包已验证 |
| macOS Intel | Rosetta 检查通过，仍需 Intel 实机验收 |
| Windows x64 | 已接入构建流程，仍需安装包实机验收 |
| Windows arm64 | 暂不支持 |
| Linux | 暂无桌面打包配置 |

未签名产物只用于内部测试。正式分发前仍需完成 macOS 签名与公证、Windows 代码签名和安装包实机检查。

## 许可证

项目代码使用 [MIT License](LICENSE)。第三方依赖与二进制文件的来源、许可证和分发限制见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

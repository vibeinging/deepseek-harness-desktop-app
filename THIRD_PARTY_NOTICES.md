# 第三方组件和分发说明

本文件记录dsh-work正式安装包中的关键第三方代码和原生二进制。完整依赖版本以各目录的 `package-lock.json` 为准，具体许可证文本保存在对应 npm 包或仓库文件中。

| 组件 | 当前版本 | 许可证 | 分发说明 |
| --- | --- | --- | --- |
| Electron | 42.4.1 | MIT | 桌面运行时 |
| React | 18.3.1 | MIT | 界面运行时 |
| electron-updater | 6.8.9 | MIT | 安装包更新组件 |
| Model Context Protocol SDK | 1.30.0（随 `@deepseek-ai/dsh` 传递引入） | MIT | MCP 客户端与协议支持 |
| OpenAI Agent Runtime | 0.147.0 | Apache-2.0 | 随包第三方 Agent 运行组件；许可证见 `legal/openai-agent-runtime-LICENSE.txt` |
| DuckDB Node API | 1.5.4-r.1 | MIT | 随包原生数据引擎 |
| better-sqlite3 | 12.11.1 | MIT | 随包 SQLite 原生模块 |
| yiTrace DB | 0.1.8 | MIT | 随包 Trace 存储模块 |
| SheetJS Community Edition | 0.20.3 | Apache-2.0 | 表格文件读取；许可证文本随 npm 包分发 |
| VexDB Lite | 上游发行版 v0.0.17；随包文件见来源记录 | MIT | SQLite 向量扩展；许可证与来源见 `server/vendor/vexdb_lite/LICENSE` 和 `RELEASE-PROVENANCE.md` |

## OpenAI Agent Runtime

产品随 macOS/Windows 安装包分发 OpenAI 提供的 Apache-2.0 Agent 运行组件。当前接入层只通过公开协议调用，没有修改上游源码。

分发遵守以下要求：

1. `server/package-lock.json` 固定来源版本和包校验值；
2. 安装包包含 `legal/openai-agent-runtime-LICENSE.txt`；
3. 当前 npm 分发包没有附带独立 NOTICE 文件；升级版本时必须重新检查；
4. dsh-work没有获得 OpenAI 商标授权，不得把产品宣传成 OpenAI 官方产品；
5. 如果以后修改上游源码，必须记录修改文件并保留明显的修改说明。

## VexDB Lite

已核对上游 `v0.0.17` 正式发行版及其 MIT 许可证。随包保留许可证、二进制
SHA-256 和来源记录。由于 v0.0.17 没有 Windows 预编译包，当前 Windows 文件不标记为
该发行版资产；替换二进制时必须重新核对平台、架构、来源和校验值。

## 发布硬门槛

以下任一项未完成时，不得对外分发正式安装包：

- VexDB Lite 或其他仓库内二进制缺少许可证、来源记录或校验值；
- 生产依赖许可证清单没有复核；
- macOS 安装包没有 Developer ID 签名、公证和票据；
- Windows 安装包没有代码签名和 Windows x64 实机验收。

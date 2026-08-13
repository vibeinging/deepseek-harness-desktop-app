# VexDB Lite 分发来源

- 上游仓库：https://github.com/VexDB-THU/VexDB-Lite
- 已核对发行版：https://github.com/VexDB-THU/VexDB-Lite/releases/tag/v0.0.17
- 发布时间：2026-07-29
- 上游许可证：MIT，许可证原文来自 `v0.0.17` 标签根目录的 `LICENSE`
- 发行版校验文件：`SHA256SUMS.txt`

## 当前随包文件

| 文件 | SHA-256 | 说明 |
| --- | --- | --- |
| `macos/vexdb_lite.dylib` | `eaea547f2e2d5c73a85cc1d0a963e57bf185f84150d1166578a885edbb3d83aa` | macOS universal，包含 arm64 和 x86_64 |
| `windows-x64/vexdb_lite.dll` | `a30868600817b1a4720f0c23aa6f20a98d677b6e6d17a7e5551f52b66c1b3534` | Windows x64 |

v0.0.17 提供 macOS arm64、macOS x86_64、Linux、iOS、Android 和 WASM 的 SQLite
产物，但没有 Windows 预编译包。因此，本记录只用该发行版确认上游项目的 MIT
许可和正式发行状态，不把当前 Windows 文件错误标记为 v0.0.17 发行资产。

替换随包二进制时，必须同时更新本文件和 `SHA256SUMS`，并核对对应发行版的资产清单。

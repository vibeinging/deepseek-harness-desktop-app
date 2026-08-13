// 应用显示名（运行时可配）。
// 主进程启动 server 子进程时通过 DSH_APP_NAME 环境变量注入用户自定义应用名（见 electron/main.js）。
// 缺省回退"dsh-work"。所有面向用户/模型的文案应引用本常量，不要硬编码应用名。
//
// 注意：这是模块加载时一次性求值；运行时改环境变量不会回灌（server 进程不重启）。
// 主进程 brand-set-name IPC 只更新窗口标题/About，不重启 server——这是预期行为
// （Agent 自称在下次 server 重启时跟随，用户立即改名的 UI 已即时更新）。
export const APP_DISPLAY_NAME =
  (process.env.DSH_APP_NAME && process.env.DSH_APP_NAME.trim().slice(0, 32)) || 'dsh-work';

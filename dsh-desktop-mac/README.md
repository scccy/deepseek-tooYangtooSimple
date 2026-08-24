# DeepSeek Harness Desktop（macOS · Tauri，原生版）

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装进 macOS 桌面的应用（DeepSeek Harness Desktop）：
**Rust（Tauri）+ 原生 WKWebView** 做壳，DeepSeek Harness 的 Node 宿主以私有 sidecar
运行。参考 [deepseek-harness-desktop-windows](https://github.com/Easyhoov/deepseek-harness-desktop-windows)
的零端口思路重写为 macOS 原生壳。

> 非官方：本项目与 DeepSeek 无隶属或背书关系，仅封装开源发行版 `@deepseek-ai/dsh`。

## 架构（无端口）

```
┌──────────────────────────────────────────────────────────────┐
│ Tauri / WKWebView 窗口                                        │
│  dsh://localhost/index.html（自定义协议，本地站点）            │
│  └ __tauri_bridge.js：fetch / WebSocket / EventSource 全部走  │
│    Tauri IPC（Tauri Channel 流式回传）                        │
└──────────────┬───────────────────────────────────────────────┘
               │ NDJSON over stdin/stdout（私有 sidecar，无监听端口）
               ▼
   node <app>/host/sidecar.mjs
   └ 在进程内 boot 官方 `web` profile；禁用真实 HTTP server，
     仅保留零套接字 route registry（HTTP out, IPC in）
```

- 不再占用 `127.0.0.1:3080`；本机不需要 `dsh web` 预先运行。
- 默认复用 `~/.dsh` 的 **`web` profile**：原 CLI 的会话、工作区、安装的插件与设置
  在桌面版直接可见。设置 `DSH_MAC_PROFILE` 可改用独立 profile。
- 前端 dist 与插件 client bundles 物化到 app 数据目录的 `www/`（启动时更新）。

## 原生壳层特性

- 标准 macOS 菜单栏：App / Edit / View / Window，Cmd+Q、Cmd+R、复制粘贴快捷键
- 通用设置里的「热重启 / Hot restart」：不关闭、不移动窗口，原地替换 Node
  sidecar 进程组，新主机就绪后自动重新加载页面
- 通用设置里的「dsh 版本与更新 / DSH version & update」：显示本地/仓库版本，支持
  手动「检测更新」，或一键「更新 dsh」（运行 `npm install -g @deepseek-ai/dsh@latest`
  升级到最新版后自动热重启）
- 每次启动自动对比本地与 npm 仓库的 dsh 版本，有新版本时弹出系统通知
- 原生 overlay titlebar：顶部 26px 可拖拽、双击窗口化/最大化（含 macOS 原生 zoom 动画）
- 左/右/下边缘 + 两个下角支持拖拽改变窗口大小，带指针捕获与合帧提交
- 菜单栏托盘：红色关闭按钮隐藏窗口，会话继续运行；托盘单击恢复，菜单可退出
- Dock 激活（`Reopen`）与单实例：再次启动聚焦既有窗口
- Notification Center 原生态通知：审批 / 提问 / Agent 错误 / 回复完成（后台时）
- sidecar 进程组管理：退出时 SIGTERM → SIGKILL，清理 agent 子进程

## 目录

```
src-tauri/       Rust 壳（bridge.rs 协议、host.rs sidecar 进程、site.rs dsh:// 协议）
host/            Node 桥（sidecar.mjs + 零套接字 route registry + ws 帧 mock）
ui/              Tauri 前端占位（实际页面由 host 物化）
scripts/         打包脚本（dmg / debug .app）
```

## 构建与打包

构建环境只需要 **Rust stable + Xcode Command Line Tools**。`node` 与全局安装的
`@deepseek-ai/dsh` 是**目标机器的运行依赖**，构建过程不依赖它们——两条纯 shell
脚本（`package-macos.sh` / `build-debug-app.sh`）都不调用 npm。

| 命令 | 产物 | 说明 |
|---|---|---|
| `scripts/package-macos.sh` | `.dmg` + release `.app`（`src-tauri/target/release/bundle/...`，~7MB） | **正常发布只跑这条**，不依赖 npm / Tauri CLI |
| `npm install && npm run build:dmg` | 走 Tauri CLI 的 release `.app` + `.dmg` | 与上一条等效的官方 CLI 路径（需 npm + Tauri CLI） |
| `scripts/build-debug-app.sh` | debug `.app`（`src-tauri/target/debug/bundle/...`，~34MB） | 仅本机冒烟测试，**不用于分发** |
| `scripts/package-windows.ps1`（Windows 机器/CI） | NSIS 安装器 + portable `.exe` | Windows 产物 |

**发布流程：只需要 release 构建一条。** debug 产物之所以有 ~34MB，是因为保留了完整
调试符号且未开启优化（体积约为 release 的 5 倍），只适合本地快速验证，不要对外分发。

macOS 产物在本机直接生成；Windows `.exe` 需要在 Windows 机器或 GitHub Actions
（`.github/workflows/build-desktop.yml`）上执行，不能在 macOS 上交叉出 NSIS 安装器；
旧 Windows Electron 仓库 `deepseek-harness-desktop-windows` 仍保留
`npm ci && npm run dist` 可继续使用。

签名：`package-macos.sh` 默认 ad-hoc 签名（适合本机/内部分发）；正式发布前设置
`APPLE_SIGNING_IDENTITY="Developer ID Application: ..."` 并走 notarytool 公证
（正式签名使用 hardened runtime，纯 Tauri/WKWebView 壳无需额外 entitlements）。

运行环境（刻意不内嵌，保持与 CLI 同一套生态）：

- **Node ≥ 20**（启动时校验，过旧会在启动页给出明确提示）；
- **全局安装 `@deepseek-ai/dsh`**（`npm i -g @deepseek-ai/dsh`）；
- 解析完全自发现：环境变量覆盖 → 标准安装前缀（Homebrew / 官方安装包）→
  login-shell 探测（覆盖 nvm/fnm/volta）。桌面版与 CLI 共享同一个 node、
  同一份 dsh 包、同一个 `~/.dsh`——插件、会话、设置天然一致，无隔离副本。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_MAC_NODE` | 覆盖 `node` 二进制路径 | 标准前缀 → login-shell 探测 → `node`(PATH) |
| `DSH_MAC_DSH_BIN` | 覆盖 dsh `lib/bin.js` 路径 | 由 node 前缀 / `npm root -g` 推导 |
| `DSH_MAC_DSH_ROOT` | 覆盖 `@deepseek-ai/dsh` 包根目录 | 由 bin 路径推导 |
| `DSH_MAC_PROFILE` | host boot 使用的 profile 名 | `web`（与 CLI 共享） |
| `DSH_MAC_CWD` | host 启动工作目录 | `$HOME` |
| `DSH_HOME` / `DSH_MAC_HOME` | DSH 数据目录 | `~/.dsh` |
| `DSH_MAC_TRACE_BRIDGE` | `1` 时打印桥接协议与路由跟踪（调试） | 关 |

## 运行

```sh
cd src-tauri && cargo run
# 或运行 target/debug/dsh-desktop / bundle 中的 DeepSeek Harness Desktop.app
```

启动流程：spawn Node host → in-process boot `web` profile → 物化站点 → 打开
`dsh://localhost/index.html`。退出应用（Cmd+Q）会回收整个 sidecar 进程组。

## 已知限制

- 尚未接入 notarytool 公证，分发给他人需 notarytool + stapler。
- 目标机器必须预装 Node ≥ 20 并全局安装 `@deepseek-ai/dsh`（有意为之，
  见「运行环境」）；缺失时启动页会给出安装提示而不是静默失败。
- 强杀（SIGKILL）应用时系统不会执行 Rust 退出钩子；sidecar 现在会监听
  stdin EOF 并随壳自退（覆盖壳被强杀的场景），正常 Cmd+Q / 菜单退出
  仍走 SIGTERM → SIGKILL 进程组回收。
# DeepSeek Harness Desktop（跨平台 · Tauri）

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 装进桌面的应用（DeepSeek Harness Desktop）：
**Rust（Tauri）做壳，DeepSeek Harness 的 Node 宿主以私有 sidecar 运行**。参考
[deepseek-harness-desktop-windows](https://github.com/Easyhoov/deepseek-harness-desktop-windows)
的零端口思路，跨平台化到 macOS（WKWebView）/ Windows（WebView2）/ Linux（WebKitGTK）。

> 非官方：本项目与 DeepSeek 无隶属或背书关系，仅封装开源发行版 `@deepseek-ai/dsh`。

## 架构（无端口）

```
┌──────────────────────────────────────────────────────────────┐
│ Tauri / 系统 webview 窗口                                     │
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

- 不再占用 `127.0.0.1:<port>`；本机不需要 `dsh web` 预先运行。
- 默认复用 DSH 数据目录的 **`web` profile**：原 CLI 的会话、工作区、安装的插件与设置
  在桌面版直接可见。设置 `DSH_DESKTOP_PROFILE` 可改用独立 profile。
- 前端 dist 与插件 client bundles 物化到 app 数据目录的 `www/`（启动时更新）。

### 平台差异

| 维度 | macOS | Windows | Linux |
|---|---|---|---|
| 渲染引擎 | WKWebView | WebView2（Chromium） | WebKitGTK |
| 窗口壳 | Overlay 标题栏 + traffic lights | 系统装饰 | 系统装饰（交给 WM） |
| 页面加载 | `dsh://` scheme | `dsh://` scheme | `dsh://` scheme |
| 网络 | IPC bridge，零端口 | IPC bridge，零端口 | IPC bridge，零端口 |
| 通知 | Notification Center | 系统通知 | libnotify / portal |
| 二次启动 | Dock `Reopen` | single-instance 插件 | single-instance 插件 |

- **macOS 专属**：overlay titlebar 顶部 26px 拖拽、边沿 resize hack、Dock 激活、
  traffic lights——这些在 Windows/Linux 上禁用，交由 OS 窗口管理器。
- **Linux 待验证**：`dsh://` 自定义协议在 WebKitGTK 各发行版的行为需真机验证；
  若静态资源加载存在兼容问题，回退方案是启用 `host/ipc-web-server.mjs` 的
  `127.0.0.1` 单端口本地站点（仍不对外暴露），当前版本暂未实现该回退开关。

## 壳层特性

- 应用菜单栏：App / Edit / View / Window（跨平台；macOS 为顶部菜单栏）
- 通用设置里的「热重启 / Hot restart」：不关闭、不移动窗口，原地替换 Node
  sidecar 进程组，新主机就绪后自动重新加载页面
- 通用设置里的「dsh 版本与更新 / DSH version & update」：显示本地/仓库版本，支持
  手动「检测更新」，或一键「更新 dsh」（运行 `npm install -g @deepseek-ai/dsh@latest`
  升级到最新版后自动热重启）
- 每次启动自动对比本地与 npm 仓库的 dsh 版本，有新版本时弹出系统通知
- 菜单栏托盘：关闭按钮隐藏窗口，会话继续运行；托盘单击恢复，菜单可退出
- 单实例：再次启动聚焦既有窗口（macOS 额外支持 Dock `Reopen`）
- OS 系统通知：需要审批 / 等待回答 / 完成对话 / 会话错误 / 插件批准（后台时）
- sidecar 进程组管理：退出时 SIGTERM → SIGKILL 回收 agent 子进程
  （Windows 用 `taskkill /T /F`）

## 目录

```
src-tauri/       Rust 壳（bridge.rs 协议、host.rs sidecar 进程、site.rs dsh:// 协议）
host/            Node 桥（sidecar.mjs + 零套接字 route registry + ws 帧 mock）
ui/              Tauri 前端占位（实际页面由 host 物化）
scripts/         打包脚本（macOS dmg / Windows NSIS / debug .app）
```

## 构建与打包

构建环境只需要 **Rust stable**（macOS 另需 Xcode Command Line Tools）。`node` 与
全局安装的 `@deepseek-ai/dsh` 是**目标机器的运行依赖**，构建过程不依赖它们。

| 平台 | 命令 | 产物 |
|---|---|---|
| macOS | `scripts/package-macos.sh` | `.dmg` + release `.app`（aarch64 / x86_64 双架构） |
| Windows | `scripts/package-windows.ps1`（Windows 机器 / CI） | NSIS 安装器 `.exe` |
| Linux | CI `cargo build --release`（x86_64 / aarch64） | 单二进制（deb/AppImage 待补） |

**发布流程：本机只出 macOS 产物（Apple Silicon 出 aarch64；Intel 需在 CI 的
arm64 runner 上交叉编译出 x86_64）。** Windows `.exe` 需要在 Windows 机器或 GitHub
Actions（`.github/workflows/build-desktop.yml`）上执行，不能在 macOS 上交叉出
NSIS 安装器。Linux 的 deb/AppImage 打包尚未接入，需在 Linux 环境补齐。

签名：`package-macos.sh` 默认 ad-hoc 签名（适合本机/内部分发）；正式发布前设置
`APPLE_SIGNING_IDENTITY="Developer ID Application: ..."` 并走 notarytool 公证
（正式签名使用 hardened runtime，纯 Tauri/WKWebView 壳无需额外 entitlements）。

运行环境（刻意不内嵌，保持与 CLI 同一套生态）：

- **Node ≥ 20**（启动时校验，过旧会在启动页给出明确提示）；
- **全局安装 `@deepseek-ai/dsh`**（`npm i -g @deepseek-ai/dsh`）；
- 解析完全自发现：环境变量覆盖 → 标准安装前缀（macOS：Homebrew / 官方安装包；
  Linux：`/usr/bin`、`/usr/local/bin`；Windows：`where node`）→ login-shell 探测
  （覆盖 nvm/fnm/volta；Windows 用 `cmd`）。桌面版与 CLI 共享同一个 node、
  同一份 dsh 包、同一个 DSH 数据目录——插件、会话、设置天然一致，无隔离副本。

## 环境变量

| 变量 | 作用 | 默认 |
|---|---|---|
| `DSH_DESKTOP_NODE` | 覆盖 `node` 二进制路径 | 标准前缀 → 探测 → `node`(PATH) |
| `DSH_DESKTOP_NPM` | 覆盖 `npm`/`npm.cmd` 路径 | 与 node 同级或探测 |
| `DSH_DESKTOP_DSH_BIN` | 覆盖 dsh `lib/bin.js` 路径 | 由 node 前缀 / `npm root -g` 推导 |
| `DSH_DESKTOP_DSH_ROOT` | 覆盖 `@deepseek-ai/dsh` 包根目录 | 由 bin 路径推导 |
| `DSH_DESKTOP_PROFILE` | host boot 使用的 profile 名 | `web`（与 CLI 共享） |
| `DSH_DESKTOP_CWD` | host 启动工作目录 | 用户主目录 |
| `DSH_HOME` / `DSH_DESKTOP_HOME` | DSH 数据目录 | 平台默认（`~/.dsh` / `%APPDATA%`） |
| `DSH_DESKTOP_TRACE_BRIDGE` | `1` 时打印桥接协议与路由跟踪（调试） | 关 |

> 兼容：旧的 `DSH_MAC_*` 前缀仍被识别，但新配置请使用 `DSH_DESKTOP_*`。

## 运行

```sh
cd src-tauri && cargo run
# 或运行 target/debug/dsh-desktop / bundle 中的可执行文件
```

启动流程：解析 node + dsh → spawn Node host → in-process boot `web` profile →
物化站点 → 打开 `dsh://localhost/index.html`。退出应用会回收整个 sidecar 进程组
（Windows：`taskkill /T /F`；Unix：SIGTERM → SIGKILL）。

## 已知限制

- 目标机器必须预装 Node ≥ 20 并全局安装 `@deepseek-ai/dsh`（有意为之，见「运行
  环境」）；缺失时启动页会给出安装提示而不是静默失败。Windows 用户多数无 Node，
  这是本节覆盖范围外的权衡（如需内嵌运行时需另行设计）。
- macOS 尚未接入 notarytool 公证，分发给他人需 notarytool + stapler。
- Linux 的 `dsh://` scheme 行为与 deb/AppImage 打包尚未真机验证。
- Windows/Linux 使用系统窗口装饰；dsh 前端页面没有窗口控制按钮，因此未采用
  `decorations(false)` 自绘标题栏（否则最小化/关闭入口会缺失）。
- 强杀应用时系统不会执行退出钩子；sidecar 监听 stdin EOF 并随壳自退
  （覆盖壳被强杀的场景），正常菜单退出仍走进程组回收。
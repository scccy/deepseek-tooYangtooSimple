# DSH Desktop (dsh-desktop)

Tauri 桌面壳 + Node sidecar：Rust 做壳，dsh 官方 `web` profile 以私有 sidecar 在进程内
boot；前端页面走 `dsh://` 自定义协议，页面里所有 HTTP/WebSocket 经 NDJSON bridge 转发。

## 空间清理（每次构建/发布后必做）

- `src-tauri/target/` 是 cargo 构建缓存，debug + release 加起来能到 3.5G+。**发布或构建后
  清掉 `src-tauri/target/debug`**（保留 release 以加速下次打包），立即回收约 1.5-2.5G。
- **不要删 `src-tauri/target/release`**（打包脚本要复用它的依赖缓存）。
- 顺手清掉 `src-tauri/target/release/bundle/dmg/` 里旧版本的 dmg。

## 版本号 bump（发布前）

同步到这些位置：`package.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`
（dsh-desktop 条目）、`src-tauri/tauri.conf.json`、`scripts/package-macos.sh` 的 `VERSION`、
`scripts/build-debug-app.sh` 的 Info.plist 两处。`src-tauri/src/updater.rs` 里的版本字符串
是单元测试断言，不动。Cargo.lock 里其它 `0.7.x` 是第三方依赖版本，别改。

## 发布

- `scripts/package-macos.sh` → release `.app` + dmg（ad-hoc 签名）。
- 覆盖安装 `/Applications` 前先杀掉运行中的实例（single-instance 会让新进程静默退出让位）：
  `pkill -f "DSH Desktop.app/Contents/MacOS"`，然后 `ditto` 复制过去。
- 改了 `host/sidecar.mjs` 的 `ABOUT_CLIENT_TEMPLATE`（设置面板 UI）时，**必须 bump
  `ABOUT_BUNDLE_REVISION`**，否则已装 app 的 settings cache 不会刷新展示新界面。

## 开发

- debug 构建：`cd src-tauri && cargo build`；debug 二进制用仓库布局的 `host/*.mjs`
  （改 sidecar 只需重新运行二进制，不用重编 Rust——除非 Rust 也动了）。
- 冒烟：`DSH_DESKTOP_TRACE_BRIDGE=1 DSH_DESKTOP_DEBUG_UI=1 ./src-tauri/target/debug/dsh-desktop`，
  看 stdout 的 `[dsh-host]` / `[dsh-ui-top]`（UI DOM dump）。
- sidecar 可脱离 Rust 单独驱动：设 `DSH_DESKTOP_DSH_ROOT`（全局安装路径）+
  `DSH_DESKTOP_WWW_DIR`（临时目录），用 NDJSON 帧喂 stdin 即可复现请求/事件流。

## 通知系统

- 通知由 sidecar `host/sidecar.mjs` 的 `installNotificationPumps()` 订阅宿主事件发出：
  `session/event`（`approval/asked`、`turn/start`→`user/message`→`turn/end` 追踪用户发起的
  turn）、`api-session/error`、`cordis/request-run`，然后发 `type: notify` 帧给 Rust →
  `bridge::show_notification`。turn 逻辑参考 `anywhere-labs/dsh-desktop`（openTurns 表 +
  仅用户发起的 turn + reason completed/error 区分）。
- 开关存 app data dir 的 `notify-prefs.json`（全局 `enabled` + `turn_end`/`turn_failure`/
  `approval`/`error`/`plugin`），设置界面调 `shell_get/set_notify_prefs`，sidecar 收
  `set-notify-prefs` 桥帧实时生效，无需重启。
- **已知问题**：Tauri 通知插件走 mac-notification-sys（已弃用的 NSUserNotificationCenter），
  app 处于前台/活跃时不弹横幅（delegate 未实现 `shouldPresentNotification`，默认只进通知
  中心）。真正修前台呈现需要改走 UNUserNotificationCenter（objc2 依赖已在树里）。
# 第四批：快捷键系统（keybindings.json + chord 拦截 + DevTools）

前置：第一批（i18n）与第二批完成后动工；crates.io 可达（已验证）。

## 语义（对齐官方 packages/client/shortcuts）

- 配置文件：`<app_data_dir>/keybindings.json`（注意：**不放** `DSH_HOME`，与官方一致地跟随 app userData）。格式：`{ "version": 1, "bindings": { "reloadPage": "CmdOrCtrl+R", "toggleDevtools": "F12", ... } }`。
- Rust 侧校验（新 `keybindings.rs`）：主进程读入 → 结构/键名合法性校验 → 通过才发布给窗口与菜单；解析失败保留上次可用绑定并**封锁编辑**（包括 Restore All），文件损坏不崩壳。未知/未来版本文件原样跳过。
- 命令集（首批）：reloadPage、closePage、toggleDevtools、minimize、quit、checkForUpdates。默认绑定 = 现有菜单加速器。
- 菜单联动：菜单项 accelerator 跟随当前绑定；macOS File 菜单显示单键绑定。

## chord 拦截

- Electron 的 `before-input-event` 在 Tauri/wry 没有等价物，方案：
  1. **双键 chord 的第一键放行页面**（官方同语义）：JS 层（bridge.js / 注入脚本）维护 pending-chord 状态；完整 chord 命中 → `invoke('shell_dispatch_shortcut', {command})` 并 `preventDefault()`；第一键只记录不拦截。
  2. Rust 侧 `shell_dispatch_shortcut` 按绑定表执行本地动作（reload/devtools/quit…），UI 动作则 eval 到页面。
  3. 输入法组合（composition）期间不拦截（JS 层 `isComposing` 判断）；终端/编辑器输入框内的可打印单键不进 chord 状态机。
- DevTools：tauri `devtools` feature（debug 默认有；release 需显式开启该 feature 编译，macOS WKWebView 打开 WebKit inspector）。`F12` / `Cmd+Opt+I` / `Ctrl+Shift+I` 三默认绑定。

## 验收

- keybindings.json 改绑 → 菜单 accelerator 与页面 chord 双路径都生效；写坏文件 → 保留旧绑定 + 编辑封锁。
- `cargo build` 通过；chord 状态机在 `DSH_DESKTOP_SELFTEST` 风格的注入脚本里有合成键盘事件自测。

## 风险与裁剪

- WKWebView 对 F12 等功能键的 DOM 事件支持需真机验证；不生效就只保留 Cmd/Ctrl 系绑定并在设置里禁用该项。
- 全局（系统级）快捷键不在本批范围（官方也没有）。

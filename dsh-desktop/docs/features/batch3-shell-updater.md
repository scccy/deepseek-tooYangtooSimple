# 第三批：壳自更新系统（tauri-plugin-updater + 强制更新 + 上传脚本）

前提：crates.io 可达（已验证 `static.crates.io` 200）。dsh 本体升级**维持现有 npm 方式不动**（updater.rs 的 dsh 更新逻辑保留），本批只加**壳（Rust app 本体）**的自更新。

## 发布单元与版本策略

- 壳版本独立演进（`tauri.conf.json` / `package.json` 同步 bump，沿用现有手工流程）。不引入官方"壳+dsh 同版本"约束——我们的架构本来就是壳与 dsh 解耦的。
- 测试版派生：`<base>-test.YYYYMMDD.N`（Asia/Shanghai 日期，N 从 1 递增，永不复用已发布版本）；正式版直接用 `<base>`。上传脚本实现 `--build-version auto` 时只做"提议 + 打印"，必须人工确认后再传（沿用官方防呆）。
- 客户端只接受更高版本（tauri-plugin-updater 默认行为）；feed 被替换也不能把高版本拉回低版本。

## tauri-plugin-updater v2 接入

1. 依赖：`tauri-plugin-updater = "2"`（Rust）+ `@tauri-apps/plugin-updater`（前端可选，可纯 Rust 调用，免前端改动）。签名密钥：`cargo tauri signer generate -w ~/.tauri/dsh-desktop.key`；公钥进 `tauri.conf.json` 的 `plugins.updater.pubkey`，打包时 `TAURI_SIGNING_PRIVATE_KEY`（+ `_PASSWORD`）环境变量注入。
2. `tauri.conf.json`：`bundle.createUpdaterArtifacts: true` → 产物 macOS `*.app.tar.gz(+.sig)`、Windows `*.nsis.zip(+.sig)`、Linux `*.AppImage.tar.gz(+.sig)`。
3. endpoint：`plugins.updater.endpoints: ["https://<feed-host>/dsh-desktop/{{target}}/{{arch}}/{{current_version}}"]`，并在 `host/sidecar.mjs`… **不需要**——endpoint 是静态 JSON（latest.json：`{version, notes, pub_date, platforms:{"darwin-aarch64":{signature,url},...}}`），放我们的静态托管即可。feed 地址用 env `DSH_DESKTOP_UPDATER_ENDPOINT` 可覆盖（本地测试指向临时静态目录）。
4. Rust 集成（`updater.rs` 扩展，不动 npm-dsh 部分）：
   - 启动后台静默检查（失败只记日志）；有更新 → 复用现有系统通知文案（i18n）提示。
   - 设置面板新增「检查应用更新 / 立即更新」command（`shell_check_app_update` / `shell_app_update`）：下载进度经 `Emitter` 发 `dsh:app-update-progress` 给前端展示；完成后 `download_and_install` → 重启（`app.restart()`）。
   - **强制更新**：latest.json 里我们自定义 `mandatory: true` 字段；检查到强制版本时弹模态（不可关闭）对话框，只给「立即安装」一个动作；安装完成前热重启/退出确认照常可用，但主界面操作被覆盖层阻止（复用 RESTART_OVERLAY_JS 思路注入全屏遮罩）。官方的"安装前等待 analytics intake"语义我们不适用（无埋点），跳过。
5. 更新与退出确认的次序：强制更新安装触发的是受控重启，跳过退出确认（与官方 installer-owned quit 一致）。

## scripts/upload-desktop-release.mjs（新脚本）

- 输入：`--version`（必填，人工确认过的完整版本号）、`--latest`（把该版本写为 latest feed）、`--mandatory`（latest.json 标记强制）、`--feed-dir <dir>`（本地 feed 暂存目录，随后由 `--publish` 子命令推到远端）。
- 流程：校验版本号合法且 ≠ 已发布 → 收集 `src-tauri/target/release/bundle/` 产物 → `tauri signer sign` 补签/校验 `.sig` → 生成 latest.json（记录 version/notes/pub_date/platforms URL+signature、`dshBuildCommit`、`dshBuildDirty`）→ 复制到 feed 目录 → `--publish` 时推送到远端（默认 GitHub Release：`gh release create desktop-v<version>`，fork 仓库；远端存储类型做成可换的适配函数）。
- 完成记录：`scripts/.release-records/desktop-v<version>.json`（本地上传台账，上传脚本查重用它）。
- 打包脚本串联：`scripts/package-macos.sh` 增加 `TAURI_SIGNING_PRIVATE_KEY` 透传与 `--skip-update-artifacts` 开关。

## 待用户决策（实现时再问一次即可）

1. feed 托管位置：GitHub Releases（fork 仓库，零成本，推荐）/ 自有对象存储 / 纯本地测试。
2. 签名密钥保管：本机 keychain / CI secret。

## 验收

- `cargo build` 通过；本地 mock feed（python -m http.server 挂一个手写 latest.json + 假 tar.gz）走完整「检查→下载→安装→重启」闭环（可用调试版本自举验证）。
- `--build-version auto` 提议逻辑 + 台账查重有单测或可复现手动验证记录。

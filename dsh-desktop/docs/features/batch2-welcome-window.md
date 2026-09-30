# 第二批：Welcome 引导窗（API key / 语言偏好 / 材质窗口 + 凭据过期检测）

参考：官方 `apps/desktop` 的 welcome-window.ts / WelcomePage.tsx / preload-welcome.ts（语义借鉴，不抄 Electron API）。
前置：第一批完成后动工（需要 main.rs / i18n.rs 空闲）。改动集中在 `src-tauri/`（新 `welcome.rs`）+ `ui/welcome/`（新静态页）+ `host/sidecar.mjs`（新桥帧）。

## 启动流程变化

1. 启动时（`wait_for_bridge` 成功后、导航到 index 前）检查凭据：sidecar 查询 `DEEPSEEK_API_KEY` 是否已配置。
   - 已配置 → 维持现状：直接进主窗口（不弹 Welcome）。
   - 未配置 / 查询失败(3s 超时) → 先打开 Welcome 窗口，主窗口保持 loading（或隐藏），用户完成/跳过后再导航进主界面。
2. Welcome 提供：① 粘贴 API key → 保存；② 「稍后在设置中配置」直接进入；③ 语言偏好（见下）。
3. 与官方一致：`autocomplete="new-password"`，key 输入框初始为空。

## 新增 sidecar 桥帧（NDJSON，走现有 handleMessage 分发）

请求 → 响应（终端帧，Rust 侧 bridge.rs 按现有 pending 模式接）：

| 请求帧 | 响应帧 | sidecar 实现 |
|---|---|---|
| `{type:"credentials-describe", ref:"DEEPSEEK_API_KEY", id}` | `{type:"credentials-info", id, configured:bool, source?:string, writable:bool, notes}` | `ctx.credentials.describe(credentialRef(ref))`（`@deepseek-ai/dsh-credentials`，见其 README； Host 未 ready → configured:false + notes 说明） |
| `{type:"credentials-set", ref, value, id}` | `{type:"credentials-result", id, ok:bool, error?}` | `ctx.credentials.set(ref, value)`；只读源遮蔽时把错误原文带给前端 |
| `{type:"settings-get", key:"locale.preference", id}` | `{type:"settings-value", id, value:unknown}` | 读宿主 settings 服务；服务缺失 → value:null + notes |

防回退：任何 API 缺失/超时都回终端帧，绝不悬空；全部 <2s。

## Welcome 窗口（Rust）

- 页面实现：按 `site.rs` 的 `LOADING_HTML` 模式**内联常量** `WELCOME_HTML`（include_str! 或 r#""#），路由 `/__welcome.html`；不走 www 物化（引导窗要在主站之外独立可用）。最终资产草稿：`docs/features/assets/welcome-draft.html`（含 zh/en 文案、明暗自适应、Enter 提交）。
- 前端命令契约（welcome.rs 提供，页面草稿已按此实现）：
  - `welcome_get_state` → `{locale:"zh"|"en", credential:{configured:bool, source?:string, writable:bool}}`（locale 来自 settings-get + i18n 检测；credential 来自 credentials-describe）
  - `welcome_save_api_key {value}` → `{ok:bool, error?}`（credentials-set）
  - `welcome_complete {action:"enter"|"later"}` → 关闭 Welcome 并导航/显示主窗口
- `WebviewWindowBuilder` label `welcome`，600×700 逻辑像素，居中，加载 `dsh://localhost/__welcome.html`。
- 材质：`window-vibrancy` crate（本地缓存已有 0.6.0，离线可装）。macOS `NSVisualEffectMaterial::UnderWindowBackground/HudWindow`（明暗自适应）；Windows `apply_acrylic`；Linux 深浅色纯色回退。
- 关闭 Welcome = 「稍后配置」语义：关窗即导航主窗口进站（不退出 app）。macOS 上主窗口先隐藏，进入时再 show。

## 语言偏好

- Welcome 读取 `locale.preference`（settings-get）：显式 zh/en 生效；未设置则用系统语言（复用第一批 i18n.rs 的检测结果）；Welcome 页 UI 按 i18n 表渲染，不提供选择器（与官方一致，语言在主界面设置里改）。

## 凭据过期检测（回引导提示）

- sidecar 通知泵已订阅 `api-session/error`：在泵里识别凭据类错误（401/403、credential/authorization 关键字，宽松匹配 + notes 标注），命中时追加发帧 `{type:"notify", ...}` 之外的新帧 `{type:"credential-state", state:"expired"}`。
- bridge.rs 收到后 `emit_to("main", "dsh:credential-expired")`；主页面由现有设置面板 bundle 显示「凭据已过期」横幅（desktop-about client bundle 加一个监听即可），并提供打开 Models 设置页的跳转。本轮不做整窗回退 Welcome（官方在无 API key 时才回 Welcome，而我们主界面自带完整凭据 UI，横幅足够）。

## 验收

- cargo build 通过；`node --check host/sidecar.mjs` 通过。
- 手动冒烟：删除（或备份）`.credentials.yaml` 中的 DEEPSEEK_API_KEY 引用后启动 → 弹 Welcome；粘贴 key 保存 → `ctx.credentials.describe` 报 configured:true；「稍后」直接进站；主界面正常。

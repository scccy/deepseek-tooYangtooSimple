# DSH 整合包仓库 · deepseek-tooYangtooSimple

> 围绕 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`@deepseek-ai/dsh`，下称 DSH）的**整合包 monorepo**：
> 一个桌面壳、一组插件、一套 Spec-Driven Development 工具链，全部放进同一个 git 仓库统一维护。

仓库名 `deepseek-tooYangtooSimple` 是 “DeepSeek Harness” 的玩梗缩写（too young too simple），本地目录习惯叫 `dsh`。

## 这是什么

本仓库把围绕 DSH 的所有东西集中管理：

| 类别 | 内容 |
|---|---|
| **桌面壳** | [`dsh-desktop`](dsh-desktop/README.md)：Tauri 壳 + 私有 sidecar，零端口，跨 macOS / Windows / Linux |
| **DSH 插件** | [`dsh-remote`](dsh-remote/README.md)（SSH 远程工作区）、[`dsh-speckit-workflow`](dsh-speckit-workflow/README.md)（Spec 流水线工作台）、[`dsh-token-meter`](dsh-token-meter/README.md)（token 统计）、[`dsh-session-eraser`](dsh-session-eraser/README.md)（删会话）、[`dsh-channel-models`](dsh-channel-models/README.md)（自定义渠道模型）、[`deepseek-harness-remote`](deepseek-harness-remote/README.md)（手机/浏览器远程接入） |
| **SDD 工具链** | [`spec-kit`](spec-kit/README.md)（vendored GitHub 官方工具包）、`.agents/skills` 下的 13 个 `speckit-*` 技能、仓库级 `.specify` 骨架 |
| **示例 / 测试** | `specs/`（示例 Feature）、`speckit-scratch-v08/`（冒烟测试项目） |
| **开发技能** | `cordis-plugin-development/`（Dynamic Cordis 插件开发 SKILL） |
| **CI** | `.github/workflows/build-desktop.yml`（打 v* tag 自动构建三平台并发布 Release） |

> 非官方：本仓库封装/定制的是开源发行版 DSH；插件延用各自上游协议，桌面版与 DeepSeek 无隶属或背书关系。

## 目录结构

```
dsh/
├── dsh-desktop/               # 桌面版：Tauri（Rust 壳） + Node sidecar，零端口（macOS/Windows/Linux）
├── dsh-remote/                # 插件：SSH 多机管理 + 远程工作区 + SFTP 同步 + 端口转发（21 个 rw_* 工具）
├── deepseek-harness-remote/   # 插件：手机/平板/任意浏览器远程接入（vendored）
├── dsh-speckit-workflow/      # 插件：Spec 流水线看板 / Feature 工作台 (v0.8)
├── dsh-token-meter/           # 插件：token 用量统计（含缓存命中拆分 + 热点图）
├── dsh-session-eraser/        # 插件：一键结束并永久删除会话
├── dsh-channel-models/        # 插件：自定义渠道模型发现与推理等级补充
├── spec-kit/                  # vendored github/spec-kit（Spec-Driven Development 工具包）
├── speckit-scratch-v08/       # speckit 冒烟测试用的空白项目（含 .specify 骨架）
├── specs/                     # 仓库级示例 Feature（001-create-text-file、002-echo-test-command）
├── .specify/                  # 仓库根级 spec-kit 骨架与脚本
├── .agents/skills/            # speckit-* 技能（specify/plan/tasks/analyze/implement/... 共 13 个）
├── cordis-plugin-development/  # “Dynamic Cordis 插件开发” SKILL
├── .github/workflows/         # CI：dsh-desktop 三平台编译打包
└── .gitignore
```

> 本机可见但未纳入 git 的目录：`.worktrees/`、`.dsh/`、`.workbuddy/`、`.claude/`，
> 均为本地运行状态（worktree、账本、缓存/配置），已被 `.gitignore` 排除。

## 子项目一览

| 目录 | 类型 | 包名 / 版本 | 说明 |
|---|---|---|---|
| [`dsh-desktop`](dsh-desktop/) | 桌面应用 | `dsh-desktop`（private，v0.6.5） | Tauri 跨平台桌面壳，零端口 sidecar 桥接，复用 `web` profile |
| [`dsh-remote`](dsh-remote/) | 插件 | `dsh-remote` v0.8.8 | SSH 远程工作区：多机、SFTP 双向同步、端口转发、审计日志。上游 [flymysql/dsh-remote](https://github.com/flymysql/dsh-remote) |
| [`deepseek-harness-remote`](deepseek-harness-remote/) | 插件 | `ds-harness-remote` v0.3.15 | 从手机/浏览器回到同一会话（中继端到端加密）。上游 [liguobao/deepseek-harness-remote](https://github.com/liguobao/deepseek-harness-remote) |
| [`dsh-speckit-workflow`](dsh-speckit-workflow/) | 插件 | `dsh-speckit-workflow` v0.8.0 | Feature 工作台：Spec Kit SDD 拆成 9 个阶段线程，子代理线程 + SQLite 账本驱动 |
| [`dsh-token-meter`](dsh-token-meter/) | 插件 | `dsh-token-meter-scccy` | token 用量统计（日/模型/小时三维聚合，缓存命中拆分、热点图），个人定制版 |
| [`dsh-session-eraser`](dsh-session-eraser/) | 插件 | `dsh-session-eraser` | 侧边栏/头部一键“结束 + 删除”会话，补上 DSH 原生缺失的真删除 |
| [`dsh-channel-models`](dsh-channel-models/) | 插件 | `dsh-channel-models` | 自定义渠道模型发现（openai-completions/responses、anthropic-messages），补推理等级与图片能力 |
| [`spec-kit`](spec-kit/) | 工具包 | spec-kit 0.16.5.dev0 | vendored [github/spec-kit](https://github.com/github/spec-kit)：Spec-Driven Development 官方工具 |
| [`specs`](specs/) | 示例 | — | 仓库级 Feature 产物（spec/plan/tasks 等）示例 |
| [`speckit-scratch-v08`](speckit-scratch-v08/) | 测试项目 | — | 用于 speckit 流程冒烟测试的空白项目 |
| [`.agents/skills`](.agents/skills/) | 技能 | — | 13 个 `speckit-*` / `speckit-worktrees-*` 技能 |
| [`cordis-plugin-development`](cordis-plugin-development/) | 技能 | — | 开发/调试 Dynamic Cordis 插件的 SKILL |

## dsh-desktop（跨平台桌面版）

把 DSH 装进桌面窗口：**Rust（Tauri）做壳，DSH 的 Node 宿主以私有 sidecar 运行**，
前端通过 `dsh://` 自定义协议加载，`fetch / WebSocket / EventSource` 全部走 Tauri IPC
（Channel 流式回传），**不监听任何 TCP 端口**。

- 渲染引擎：macOS WKWebView / Windows WebView2 / Linux WebKitGTK
- 默认复用 DSH 数据目录的 **`web` profile**：CLI 里的会话、工作区、插件、设置直接可见
- 具备菜单栏、托盘（隐藏后继续运行）、单实例、系统通知、热重启、dsh 版本检测与一键更新
- 目标机需预装 Node ≥ 20 并全局安装 `@deepseek-ai/dsh`

详见 [`dsh-desktop/README.md`](dsh-desktop/README.md)。

## 快速开始

### 桌面版

```sh
cd dsh-desktop
npm install
npm run dev            # tauri dev
# 或直接跑 Rust 侧：cd src-tauri && cargo run
```

### 插件（web profile 通用装法）

直接通过 CLI 安装发布到 npm 的插件：

```sh
dsh plugin add dsh-remote
dsh plugin add ds-harness-remote
```

本地源码联调（以 profile 依赖 + bundle 注入方式，各插件 README 有完整示例）：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dsh": { "profile": { "bundles": ["dsh-speckit-workflow"] } },
  "dependencies": { "dsh-speckit-workflow": "file:/Volumes/project/github/dsh/dsh-speckit-workflow" }
}
```

```sh
cd ~/.dsh/profiles/web && pnpm install --force
```

### Spec Kit / Speckit

```sh
# 安装指定版本 CLI（需 uv；替换 vX.Y.Z 为最新 release tag）
uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@vX.Y.Z
# 或直接用 PyPI 版
uv tool install specify-cli

# 在目标项目初始化 .specify 骨架（脚本用 python）
specify init --here --script py
```

`dsh-speckit-workflow` 的 Feature 工作台与 `speckit-*` 技能均依赖项目的 `.specify` 骨架（含 templates 与 python 脚本）。

## CI / CD

`.github/workflows/build-desktop.yml`：打 `v*` tag 自动触发（构建三平台并发布 Release）；手动 `workflow_dispatch` 可随时验证构建：

- **macOS**：`macos-14`（aarch64，Apple Silicon）+ `macos-13`（x86_64，Intel）各打 `.app` + `.dmg`
- **Windows**：`windows-latest`（x64）打 NSIS `.exe`
- **Linux**：`ubuntu-latest`（x86_64）+ `ubuntu-24.04-arm`（aarch64）各编译单个 `dsh-desktop` 二进制

产物作为 artifacts 上传，命名 `DeepSeek-Harness-Desktop-{macOS,Windows,Linux}-<arch>`。

## 许可

仓库根目录不设统一 LICENSE；各子项目携带独立许可（多为 MIT），详细以各自目录内的
`LICENSE` / `README` 为准。`spec-kit`、`dsh-remote`、`deepseek-harness-remote` 为
上游项目（GitHub / flymysql / liguobao）的 vendored 副本，保留原作者署名与许可协议；
二次使用请遵守对应上游许可。
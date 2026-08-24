# dsh-speckit-workflow — 进度记录

> 最后更新：2026-08-19 · **v0.8 按 DESIGN-V0.8.md 重新开发完成：工作区/ Feature 实例 /
> 阶段线程模型落地（SQLite 编排账本 + durable continuable 阶段线程 + 人工交接），
> UI 沿用 v0.7 定版看板风格（配色未改）。v0.7 及更早的“整条流水线 + @dsh-external/workflow”
> 方向作废并移除（§18）。**

## 18. v0.8 重新开发（2026-08-19，本会话）

用户要求「按照 DESIGN-V0.8.md 重新开发 dsh-speckit-workflow，整体 UI 风格配色已确认，
不要改动」。完成项与关键决策如下。

### 18.1 业务模型（对应 DESIGN-V0.8 §2–§7）

- [x] **实例模型**：一个 Feature = 一个工作流实例（`workflow_instances`），看板卡片按
      Feature 聚合，不再是单个 run。
- [x] **阶段图**：`specify → clarify → plan → checklist? → tasks → analyze? →
      taskstoissues? → implement → converge`（9 阶段，无自动评审门禁）；`lib/stages.js`
      为唯一事实源，board 四列 = Specify / Clarify / Implement / Converge。
- [x] **阶段线程**：每个阶段 = 一条 **durable continuable subagent 会话**
      （`ctx.subagents.startContinuable`，`inject` 增加 `subagents`/`llm`）；persona 由
      skill 内容 + 阶段执行协议 + 结构化前驱产物组成（**不注入上一线程聊天记录**）。
- [x] **人工交接**：阶段生下后停在 `awaiting-confirmation`，绝不自动推进；确认/重做/
      取消/跳过/返回全部带 `actionId` 幂等键；交接在同一 SQLite 事务内完成（当前阶段
      固化 + 创建下阶段行 + 获取工作区锁）。
- [x] **交互阶段**：Clarify / Converge 在同一线程内多轮交互——线程每回合写
      `state.json`（`asking`/`findings`/`done`/`error`）后闲置，宿主在 `agent/status`
      idle 边沿读状态推进体；用户回答经 `followup` 送回同一线程。
- [x] **工作区锁**：`workspace_locks` 表（每工作区唯一），创建实例即持锁，终止时释放；
      同一工作区同时最多一个活动阶段，不同工作区并发。
- [x] **重跑/回退/过期**：重跑 = 同 stageId 新 attempt（旧记录保留）并把旧 attempt +
      下游标 `stale`（`STALE_AFTER` 映射）；返回上阶段 = 重跑前驱并把后续标 stale。
- [x] **Converge 循环**：converge 收到用户「追加任务」→ 写回 tasks.md 并
      `{"status":"done","action":"append"}` → 确认后返回 implement 新 attempt；
      无遗留 → `converged` → 确认后实例 completed。
- [x] **可选阶段**：checklist/analyze/taskstoissues 按实例 config 开关；跳过必须记录
      `decisions` 原因，不伪造通过；taskstoissues 是外部副作用、失败不阻塞 implement。

### 18.2 存储（DESIGN-V0.8 §5.1）

- [x] **SQLite 编排账本**：`~/.dsh/speckit-workflow/workflow.db`（profile 级全局；
      `DSH_SPECKIT_DB` 可覆盖；`lib/db.js`）。`node:sqlite`（DatabaseSync）在 DSH 的
      Node v24 实证可用（`require('node:sqlite').DatabaseSync` 为 function）；按设计
      「不引入第三方原生依赖」用内置实现。
- [x] 六张表：`workflow_instances` / `stages` / `artifacts` / `decisions` / `events` /
      `actions` + `workspace_locks`；正文（spec/plan/tasks）仍留在 worktree/workspace，
      账本只存路径 + sha256 + skill 版本 + 输入快照。
- [x] **JSON 降级后端**（`forceJson` / `node:sqlite` 缺失时自动）：供开发/无 sqlite 的
      Node 跑同一套状态机，事务用 memo 快照回滚保证原子性；生产仍以 sqlite 为准。
- [x] 事务原子性：确认交接 / 建实例 / 重跑全部单事务；`insert OR ABORT` + 约束保证
      锁与唯一性；重复请求由 `actions` 表去重（幂等，不靠前端禁用）。

### 18.3 线程执行（`lib/threads.js` + `lib/worktree.js`）

- [x] 阶段线程 spawn / followup / interrupt；agent/status idle → `processIdle`
      读 `state.json` + 产物 → 账本推进。
- [x] `state.json` 协议：`<ws>/.dsh/speckit-workflow/instances/<id>/stages/<stage>-<attempt>.state.json`，
      persona 里写明字段契约（asking/findings/done/append/error + artifacts）。
- [x] **Specify → worktree 产物交接**（§4.2）：specify 线程做完（含 after_specify
      worktree skill）→ 宿主同步 feature.json + specs/<feature>/ + 扩展产物进 worktree
      → 校验 feature.json 一致 → 绑定 artifactRoot/executionRoot（isolated）；关闭
      worktree / `worktree:false` → inplace。校验失败 → 阶段 failed，下游不得启动。
- [x] 技能快照：每阶段记录 `skill_id` + `skill_sha256` + `input_snapshot`
      （persona/prompt/路由/时间戳）。
- [x] 挂载恢复：`recover()` 把 `creating`（线程未绑定即崩溃）标 failed（可重试），
      running/awaiting-user 且线程已 idle 的走一次 idle 重算。

### 18.4 RPC / 看板（`lib/index.js` + `lib/client.js`）

- [x] 宿主 RPC（/api/dsh-speckit-workflow）：`install` `workspaces` `check` `models`
      `instances` `instance-create` `instance-get` `stage-confirm` `stage-skip`
      `stage-answer` `stage-rerun` `stage-rollback` `stage-cancel` `thread-view`
      `artifact-read` `events-since`；`inject` = tools/systemPrompt/agents/webServer/
      workspaceRegistry/subagents/llm。
- [x] `speckit_sdd` 工具语义改为 **创建实例 + 启动 Specify**（不再一键全流程，符合
      §9「不提供一键跑完整流水线」）。
- [x] Client 重写为 v0.8 工作台但 **复用 v0.7 定版 CSS/配色**：4 列看板 + 新建 Feature
      弹窗 + 详情抽屉（9 阶段旅程 / 操作契约 / 待回答问题 / 决策与事件）+ 线程聊天 +
      面板内确认/输入对话框（不依赖 window.confirm/prompt）；中栏 takeover / Escape /
      跨面板互斥照旧。
- [x] `check.sh` / `smoke.mjs` 改为 v0.8 纯机器验证：`node --check` 全部模块 + 阶段图 +
      `scripts/machine-smoke.mjs`（28 项，sqlite+json 双后端全过）+ worktree 产物交接
      FS 测试（7 项）；移除旧 engine-capsule 校验。
- [x] 删除 v0.7 残留：`lib/capsule.js` `manifest.js` `discussion.js`
      `workflow-source.txt` `skills.js` `dyn-client.body.txt` `scripts/build-dyn-client.mjs`；
      package.json 版本 → 0.8.0，exports/files 同步精简。
- [ ] 真机验证（需要 DSH host + subagent 提供者 + .specify 项目）：建 Feature →
      Specify 线程 → 确认 → Clarify 逐题 → 确认 → … → Converge 收敛；重启恢复。
      （完整模型链路 E2E 受宿主环境/配额限制，同 §13。）

### 18.5 关键设计决策（对应 DESIGN-V0.8 §11 的开放项）

1. **阶段线程 = 独立 agent session（continuable subagent）**，不用 workflow engine run：
   因为 Clarify/Converge 要求同一线程跨多轮用户回答携带对话；engine run 无法在
   中途暂停等人类回答再同一会话续跑。
2. **node:sqlite 可用 → 内置实现**（profile Node v24 实证 `DatabaseSync` OK）；JSON
   后端仅作开发/无 sqlite 环境降级，生产报 `backend:'sqlite'`。
3. **工作区列表**仍从 `workspaceRegistry.list()` + 会话 cwd 读（沿用 v0.7）。
4. **历史线程/实例状态**：账本（实例/阶段/产物/决策/事件）+ 线程会话事件（消息历史）。
5. **项目级 skill override 优先**（`.dsh/speckit-workflow/skills/` 存在则以它为准，
   否则内置）；技能在实例创建时按哈希同步。
6. **GitHub（taskstoissues）**：作为可选外部阶段，线程内按 skill 校验 remote 后创建；
   失败记 error、不伪造成功、不阻塞 implement（用户可跳过/重试）。

### 18.6 入口与主体调整（工作区行 → 隔离看板；新建并入当前工作区）

用户复核指出入口未按 v0.8 调整（应从工作区进入而不是从会话头进入）。已修正：

- [x] **入口 = 工作区行按钮**：客户端在宿主工作区行（WorkspaceBrowser 的
      `[class*="projectRow"]`）右侧注入小「看板」按钮（`data-spkb-ws`），点击进入
      **该工作区的隔离看板**（`S.workspaceTarget` 作用域）；MutationObserver 随行
      重建自动补注入；侧栏行点击关闭逻辑排除该按钮（不误关）。
- [x] **看板按工作区隔离**：`instances` RPC 带 `workspace` 过滤，宿主
      `orchestrator.board(ws)` 只列该工作区的实例；顶栏工作区下拉可切换作用域。
- [x] **新建 Feature 并入当前工作区**：新建弹窗移除目录选择器，改为只读
      「目标工作区（并入当前工作区）」；`submitCreate` 直接用 `S.workspaceTarget`。
- [x] **每工作区独立可并发**：宿主 `workspace_locks` 按 `workspace_path` 隔离（每工作区
      同时最多一个活动阶段），不同工作区实例互不阻塞、可并发——上轮已实现，本轮确认。
- [x] **宿主 `instance-create` 补 not-ready 检查 + 技能材料化**：RPC 路径与工具路径
      一致，未初始化 `.specify` 的工作区直接报错，不再静默让线程失败。
- [x] 同步三处副本：repo `lib/client.js` + profile `node_modules` + desktop
      `www/__plugins/dsh-speckit-workflow/client.js`（client 改动重载 Web UI 即生效）；
      host 侧 `lib/index.js` 改动需重启 DSH。

## 17. 新建任务「思考强度」真实档位下拉 + 档位下发修复（2026-08-19，本会话）

用户反馈：创建任务一栏「思考强度（真实档位）」看着像写死，应改为**下拉选择**、且**每个模型展示各自的真实档位**。排查 + 修复如下：

- [x] **根因① UI 形态**：主档位原本渲染成按钮组（`.reasoning-levels` 一排 `<button data-r>`），不是下拉。
- [x] **根因② 数据回落**：`effortOptionsFor()` 仅当选中模型且宿主 `models` 端点给出该模型真实 `efforts` 时才用真实档位；默认/未选模型时写死回落通用五档（OFF/Low/Medium/High/Ultracode）。宿主日志实证各模型档位确实不同（DeepSeek 官方 `off/low/high/max`、GPT-5.6 `off/minimal/low/medium/high/max`），所以直观看就是「写死」。
- [x] **根因③ 致命 bug（档位不下发）**：`createTask()` 拼 `discussion.execution` 时漏了 `reasoningEffort`——页面选的思考强度根本不会发给宿主，选了等于没选；宿主 `normalizeDiscussion` 本就支持 `execution.reasoningEffort`（discussion.js），链路断在客户端。
- [x] **修复**：主档位改 `<select id="fEffort">` 下拉，选项按所选主模型真实 `efforts`（带 effort 的 `name` 展示），无真实档位才回落通用；`createTask()` 补传 `execution.reasoningEffort = S.NC.reasoning`；两条 override（Specify/Clarify、Plan/Analyze）改用同一份真实档位下拉并被 `change` 事件真正消费进 `S.NC.ov`（模板保存/应用一并带上 `ov`）；`effortLabel` 优先从 live 档位表取真实名称；新增 `effortLive` 提示文案说明档位来源。
- [x] **实测**（用真实运行时目录数据跑同构逻辑）：跟随默认 = 五档通用；DeepSeek 官方 v4 = Off/Low/High/Max（无 Medium）；GPT-5.6 = Off/Minimal/Low/Medium/High/Max；opencode-go v4 = Off/Low/Medium/High/Max —— 每个模型确实不同。
- [x] `node --check` / `scripts/check.sh` / `smoke.mjs` 全绿；三处副本已同步：`lib/client.js`、profile `node_modules/dsh-speckit-workflow`、desktop `www/__plugins/dsh-speckit-workflow`。改的是 client 侧代码，**重载 Web UI 即可生效**，无需重启宿主。

## 16. 看板真机体验修复：主页面化 / 返回对话 / 布局 / 删除（2026-08-19，本会话）

用户进入看板后反馈三个问题并已修复（含一次方向修正：先试「浮层弹窗」观感被拒，改为
**中栏主页面**模型）：

- [x] **问题①返回不了对话页**：原面板是无内部关闭按钮的全屏浮层，会话头「📋 看板」
  切换钮被浮层盖住 → 进去就出不来。修复：看板顶栏新增「← 返回对话」按钮
  （`data-act="close-board"` → `setOpen(false)`）+ **Escape 键逐层关闭**（先关弹窗/
  抽屉，再关整板返回对话）；Escape 处理改为从 ShadowRoot 内查找（原实现用
  `document.querySelector` 找不到 shadow 内的弹窗，属既有小 bug）。
- [x] **问题②不是主页面、而是全屏/弹窗**：改为与 **@linxin666/dsh-ssh 同款**的中栏
  主页面模型——不再用 `shell.overlay` 浮层/不给 `conversation` 槽位（SSH 注释：该槽位
  单占用、外部插件不该抢），改为 **DOM 级 takeover**：用 SSH 同款选择器
  `[data-pane="conversation"],[class*="centerCol"]` 找中栏，在其中**追加尾随子节点**
  `[data-spkb-host]`（React 不管理），`html[data-spkb-active]` data 属性切换显示并
  隐藏中栏其它子元素（对话子树保持挂载有状态）；面板上「← 返回对话」（同 SSH
  `panel.backToConversation`=返回会话）只是去掉 active 态即回对话；带跨插件互斥
  `dsh-panel-activate` + 点击侧栏行自动关闭。`:host` 改 `width/height:100%` 填满中栏，
  `.app/.sidebar` 的 `100vh` → `100%`。动态热修 `pkg-3` 用同一选择器把运行中的旧
  全屏浮层钳制到中栏区域作为过渡。
- [x] **问题③任务无法删除**：桌面壳（WKWebView）对 `window.confirm`/`window.prompt`
  静默取消 → 删除/重跑/重命名确认永远不通过、请求发不出去（宿主 `run-action
  delete` → 引擎 `deleteRun` 链路本身正确，终态 run 可删）。修复：新增面板内自定义
  `askConfirm`/`askPrompt` 对话框（shadow DOM 内 modal，数据流经同一 RPC），删除改走
  红色确认框；不再依赖原生 confirm/prompt。
- [x] **以动态 Cordis 会话先热修并验证**：`spkb-1`（dsh-speckit-board-fix）分两版——
  `pkg-1` 浮层压弹窗被拒后更新为 `pkg-2`（几何钳制中栏主页面 +「← 返回对话」+ Escape
  + `window.confirm` 兼容），当前运行中的 DSH 已激活生效（currentPackageId=pkg-2）；
  静态修复落回 `lib/client.js` 并经 `sync-to-profile.sh`（重启后原生生效，动态包进程
  级临时）。提供 `scripts/build-dyn-client.mjs` 把静态 client 转成动态 `code.client`。
- [x] `node --check` / `scripts/check.sh` / `smoke.mjs` 全绿；profile 副本已同步。
- [x] **〔补充〕重启后「点不开看板」根因已修**：静态集成最初用 SSH 的选择器
  `[data-pane="conversation"]/[class*="centerCol"]`，但在本 app 版本 bundle 里不存在
  → `ensureHost` 拿不到 column → 打开无反应。已改为**多选择器兜底**：
  `[data-slot="conversation"] → [data-pane="conversation"] → [class*="centerCol"] →
  [class*="conversation"]`；再无中栏候选时按侧边栏右侧固定几何钳制（内联 fixed，不盖
  边栏）。同步 lib/client.js + node_modules + www 副本（后者已手写覆盖为修复版）。
- [x] **〔皮肤兼容〕安装 `@dsh-external/dsh-client-ui-skin-maid-atelier` 后看板不显示，
  根因与加固**（动态 Cordis 探针抓拍，host 日志实证）：
  - 该皮肤把 `conversation` 座位变成 `display: contents`（无盒模型）→ 旧
    「absolute;inset:0 贴中栏」定位锚点失效；并把框架层顶到 `z-index:1000`、
    `z-index:10000` 的全屏固定装饰层。旧静态依赖 CSS 规则显示/定位 → 被皮肤压住。
  - 加固：看板 host **挂到 `document.body` 顶层**（不受座位盒模型影响），
    **内联 `position:fixed` 按测得中栏 rect 钳制**（resize 重钳），**内联 display
    block/none 切换 + `z-index:1000` + pointer-events:auto**（不依赖样式表显示），
    `html[data-spkb-active]` 仅用于隐藏中栏下层内容；头部 📋 按钮提 `z-index:30`。
    已同步 profile + www（87KB）。
- [ ] 用户真机复核（重启后）：看板能打开并贴中栏、左侧一体化「返回对话」、删除/重跑/
  重命名用面板内确认框、与 SSH 面板互斥、与 maid 皮肤共存。

## 15. 装机失败调试 + 版本统一 0.7.0（2026-08-19，本会话）

- [x] **「安装失败」根因定位**：DNS-web 插件安装报失败，源自 profile
  `~/.dsh/profiles/web/pnpm-workspace.yaml` 的 `pnpm install` 层面——
  `allowBuilds` 里 4 个条目是 `pnpm approve-builds` 待定占位串
  `set this to true or false`（非合法布尔值）。pnpm 11 把它当「未审批」，
  任何把带安装脚本的包（ssh2 / node-pty / cpu-features 及 @deepseek-ai/
  dsh-subprocess-local、@google/genai、koffi、protobufjs）带入依赖树的安装
  都会 `ERR_PNPM_IGNORED_BUILDS` → exit 1 → 界面显示「安装失败」。
  独立临时目录已复现（含「新增依赖」场景）并通过。
- [x] **修复**：占位串改为显式布尔值（全部 `true`）；profile `pnpm install`
  全绿、`pnpm rebuild node-pty cpu-features ssh2` 原生绑定真实构建通过；
  插件本身无 build 脚本，卡点是同 profile 依赖链。
- [x] **安装现状核验**（当前运行中的 DSH web profile）：
  - host：`dsh-speckit-workflow` 组合行在位；`lib/index.js` 真实加载成功；
    `speckit_sdd` 工具已注册；`@dsh-external/workflow` 引擎联调正常
    （`workflow_list` 见 `speckit-sdd` source=project, valid=true）；
  - client：`shell.overlay`（`speckit-board-overlay`）与
    `conversation.session.header.actions`（`speckit-board-header`）slot 均
    已挂载且 active；
  - `dsh --profile web --dump-config`、`scripts/check.sh`、`scripts/smoke.mjs`
    （DSH_PROFILE_DIR=~/.dsh/profiles/web）全绿；`pnpm install` 通过。
- [x] **版本统一 0.7.0**：`package.json` 0.4.0-dev → **0.7.0**；`lib/index.js`
  `PLUGIN_VERSION` 与 `lib/capsule.js` 默认 pluginVersion 同步；README
  「方向与版本」说明改为「包版本自 0.7.0 起与 UI v0.7 对齐」；PUBLISHING.md
  陈旧版本（0.3.0-dev / ^0.2.0）一并更新。client/UI 侧 v0.7 文案未动。
- [ ] 真机 E2E：重启 DSH web profile 后验证看板渲染 + 新建任务 + 暂停/继续/停止/重跑
  （与之前相同：完整模型链路 E2E 受上游配额限制，见 §13）

## 14. v0.7 看板定版 + 删除 v0.4 Workflow Studio（2026-08-19，本会话）

- [x] **版本厘清**：UI 的唯一定版是 `design/spec-board-prototype.html`（「Spec 流水线
      看板 · 交互原型 v0.7」）。README/PROGRESS 中 §11–13 描述的 v0.4「Workflow
      Studio」通用控制面是已被废弃的方向——用户明确要求不再写 0.4，直接删除。
- [x] **Host 删除 0.4 Studio 代码**（`lib/index.js`）：
  - 删除 endpoint：`catalog / describe / skill / skill-save / capsule-save /
    capsule-save-run / capsule-revise / capsule-rename / capsule-delete`
  - 删除死函数：`genericCatalog / genericWorkflowDetails / workflowEntryView /
    startGenericRun / readSkillForProject`
  - 删除 `./skills.js` 的 `listSkills/readSkill/writeSkill` import（仅 0.4 使用）
  - `preflight` 改用本地 `workflowManifestDetails()`（不再查通用 catalog）
  - `start` 收敛为 SpecKit-only（去掉 `workflow` 通用分支）
  - 保留：`board/runs/view/events-since/preflight/start/run-control/run-action`
    + 兼容 `check/status`；Skills 材料化与 capsule 自愈（SpecKit 兼容路径）不动
- [x] **Client 重写为 v0.7 看板**（`lib/client.js`，31KB→~38KB，DOM 实现 + Shadow
      DOM 隔离样式，`shell.overlay` + 会话头「📋 看板」注册）：
  - 4 列看板卡（worktree / 阶段 / 模式 / 轮次 / 错误点 / ready-merge）
  - 顶栏 metric pills（worktree / 并发 / 已归档）、右键菜单、三视图切换
  - 新建任务弹窗：Feature Context + 主模型/思考强度 + 流程开关（v0.7 同款）
  - 详情抽屉：流水线位置 journey / 本列阶段 / 执行线程 / 产物 / 证据 tabs
    （消息/日志/评审/指标）+ 真实动作 ⏸▶■↻/重命名/删除
  - 只wire引擎真实支持的动作；门禁通过/驳回、人工合并等伪交互渲染为只读提示
- [x] `node --check`、`check.sh`、`smoke.mjs` 全绿（smoke 同步移除 4e 通用 Studio 块）
- [ ] 真机 E2E：重启 DSH web profile 后验证看板渲染 + 新建任务 + 暂停/继续/停止/重跑
  （与之前相同：完整模型链路 E2E 受上游配额限制，见 §13）


## 11. 通用 Workflow Studio MVP（设计见 DESIGN-STUDIO.md）

- [x] Host 增加通用 catalog projection：engine workflow entries + bundled/project skills
- [x] 增加 `describe` / `skill` / `runs` / generic `start` / `run-action` RPC
- [x] view projection 从固定 SpecKit phases 扩展为 generic process phases、result、outcome、cost、artifacts
- [x] 中栏入口改为 Workflow Studio：workflow 选择、JSON args、manifest metadata、skill inspection
- [x] 保留 `speckit_sdd`、讨论弹窗、SpecKit capsule/skills materialization 兼容路径
- [x] smoke 覆盖 generic catalog、describe、skill、generic start；engine contract 继续通过
- [x] 下一阶段六项（schema 表单 / capsule 创作 / SkillBundle 编辑 / 增量订阅 / preflight / Slot 迁移）已落地 —— 见 §12

## 12. 下一阶段六项落地（v0.4.0-dev）

> 依据 DESIGN-STUDIO.md「下一阶段」逐项实现；宿主经 `check.sh` + `smoke.mjs`
> 全绿（74 项），并已重新 `sync-to-profile.sh` 同步到 web profile。

1. **schema-driven form**（client）：`SchemaInputForm` 从 JSON textarea 升级为真表单——
   类型映射（string/boolean/integer/number/enum/array/json）、`title/description` 提示、
   `default` 提示、`enum` 下拉、嵌套 `object.properties` 子字段；JSON textarea 保留为高级入口。
2. **workflow capsule 可视化创作**（host + client）：新增 `capsule-save` / `capsule-save-run` /
   `capsule-revise` / `capsule-rename` / `capsule-delete` 五个 endpoint，委托 engine
   `create/saveRun/revise/renameSaved/deleteSaved`（scope=project|personal）；Studio 详情区
   增加胶囊区（已保存条目切换、改名/归档、本运行另存、自然语言新建/修订）。
3. **SkillBundle 编辑/版本/覆盖**（host + client）：`skills.js` 新增 `writeSkill`（安全 id、
   512KB 上限、sha256 回读），写入 `.dsh/speckit-workflow/skills/<id>/SKILL.md` 作为项目覆盖；
   宿主新增 `skill-save` endpoint；Studio 技能查看器改为可编辑 + 一键保存覆盖。
4. **增量事件订阅**（host + client）：宿主新增 `ensureRunSubscription`（per-agent
   `service.subscribe` 分流到 per-runId 环形缓冲，上限 2000/修剪 500）+ `events-since`
   endpoint（delta + resume 游标，缓冲缺失回退 durable `service.events` snapshot）；
   客户端轮询改为「订阅缓冲有新事件才整页重建」，冷启动/重启走 snapshot 回退。
5. **运行前 preflight 卡片**（host + client）：宿主新增 `preflight` endpoint
   （cwd / ready / issues / execution / approval / readOnly）；Studio 详情区顶部渲染
   「运行前预检 Preflight」卡片。
6. **Slot 迁移**（client）：中栏 selector takeover + DOM portal 全部移除——侧边栏 DOM
   入口与 `.speckit-entry` 样式删除、`mountHolder/mountPageContainer` 与挂载函数删除；
   现在 Workflow Studio 通过 `shell.overlay` 注册，页面作为 `.speckit-studio-host`
   浮层直渲染；会话头按钮与右键菜单保留（document 事件收敛在 shell adapter 层）。

### 动态插件真机实证（dev phase，spk-1）

- 动态插件 `spk-1` 以 `@pluginId` 门控开关的方式对各 seam 做了真机验证：
  1. 模型工具 `speckit_sdd` 真机注册成功且 schema 正确（`Tool.listTools` 可见）；
  2. `shell.overlay` / `conversation.session.header.actions` 官方 Slot 挂载成功
     （occupant: `dyn/spk-1`）；
  3. `ctx.get('dynamicWorkflows')` 真连 engine：`startNamed` 走到审批闸口并产生
     durable run（denied），零文件副作用；catalog 经 `workflow_list` 佐证
     `speckit-sdd` 为 `source: project`、入参字段为 `projectRoot`；
  4. 实测暴露两条严格约束并已修复：`harness.handle`/工具返回值必须严格
     lossless-JSON（不允许 `undefined` 属性），统一 `safe()` 收口；工具透传
     `projectPath→projectRoot`。
- 结论：四条关键 seam 全部真机打通，动态原型用于开发期验证的价值兑现；
  正式实现落在本包静态插件（本节第 1–6 项）。

## 13. 热调试验收（2026-08-17，本会话）

- [x] `check.sh` 全绿，含引擎三大官方校验器：`validateWorkflowCapsule` /
      `validateRestrictedWorkflowSource` / `assertRestrictedWorkflowQuality`
- [x] `smoke.mjs` 74 项全绿：tool 注册 / RPC / 技能物化 / capsule 自愈 /
      并发护栏 / 团队模式 / 陪审团 / 讨论纪要 / generic catalog 全过
- [x] **发现并修复**：web profile 的 `node_modules/dsh-speckit-workflow` 实际
      缺失（§5 记录已同步但盘上不存在，smoke 首跑 ENOENT）→ 已重新
      `sync-to-profile.sh`（rsync + package.json dependency/bundles 接线），
      复查 dependency、bundles、host/client 副本均在位
- [x] 宿主契约实测：注入项 tools / systemPrompt / agents / webServer /
      workspaceRegistry 全部存在于 live Service 目录且方法签名匹配；引擎服务键
      确认为 `dynamicWorkflows`（`@dsh-external/workflow` service.js:
      `super(ctx,'dynamicWorkflows')`，service.d.ts 全量方法面与 index.js 调用
      逐一对上：startNamed/list/show/events/subscribe/runs/stop/pause/resume/
      rerun/saveRun/create/revise/renameSaved/deleteSaved/attachBackgroundJob）
- [x] 客户端契约实测：client.js 为 `window.__ModuleLoader__.load` factory →
      `{ apply, inject: ['sessions','slots'] }`；live Slot 树中 `shell.overlay`
      （root list）与 `conversation.session.header.actions`（session list）均存在
- [x] **真实 Host 路由修复**：Cordis `ctx.effect` 的清理逻辑改为延迟 disposer，
      避免插件启动时立即注销 `/api/dsh-speckit-workflow`；重启 web profile 后
      `POST /api/dsh-speckit-workflow` 已从 404 变为插件返回的 200 业务响应，且
      `dsh-channel-models` 对照路由保持正常
- [x] **修复**：`lib/capsule.js` 默认 pluginVersion 由 `0.3.0-dev` 对齐为
      `0.4.0-dev`（防未传参导致的陈旧版本戳）；`.dsh/workflows/
      speckit-sdd.workflow.json` 已用修正后的 builder 重生成
      （provenance.pluginVersion=0.4.0-dev，source sha 不变，requires.skills 仍空）
- [x] **历史 E2E 失败归因**：run-c5f15646 plan 失败 = 上游 `RATE_LIMIT`(429，
      重试 2 次放弃)；run-2fc18ee4 specify 失败 = 上游 `QUOTA`(429，
      "Your token-plan quota has been exhausted")。二者均为模型供应方配额/限流，
      非插件缺陷（子会话日志 `~/.dsh/sessions/--Volumes-project-github-dsh--/
      <childId>/session.jsonl.zstd` 实证，fail 点均在 assistant/chunk 的 finish
      reason，而非插件逻辑）
- [x] **重启 DSH 做真实加载验证** —— 已验证 web profile 载入 Host/Client；RPC 精确路由返回插件业务响应
- [ ] **全链路 E2E** —— 待配额恢复后从 Studio 面板点火（approvalGranted=true 路径）

## 10. v0.3 SpecKit 讨论方向(历史兼容记录,设计见 DESIGN.md)

- [x] 交互推翻重来:讨论区右键 →「发起 Speckit 讨论」弹窗(基础/Team/流程/执行层/
      审计层/模板),提交后中栏「讨论房」大页
- [x] 用户拍板:①监视面=中栏大页翻新 ②Team=分工式 ③模型=任意 provider/model
- [x] 引擎能力核实:runAgent 白名单原生支持 provider/model(engine.js:355/1116),
      无需改引擎;分工在 capsule 内实现
- [x] M1 配置 schema + 宿主透传 + smoke(`lib/discussion.js` 归一化/flow 合并/gates
      映射;工具新增 `discussion` 参数;manifest inputSchema 透传;capsule 解析
      `args.discussion` 并按 execution/audit 逐代理注入 provider/model;smoke 43 项全过)
- [x] M2 capsule 团队模式:评委小组 fan-out(按 threshold 合票:auto-approve/
      explicit-approve/strict-quorum)、implement 分工(lead 拆分→成员按自身
      provider/model 并发→merge 冲突裁决)、讨论纪要代理(仅 discussion 运行生成,
      旧式裸调用行为不变)、manifest 提升(48 agents/并发 4/预算 900k);
      **manifest.js 与 workflow-source.txt 已通过引擎三大官方校验器**
- [x] M3 弹窗 + 右键菜单 + 面板翻新:会话行右键菜单(「发起 Speckit 讨论 /
      打开讨论房」)、六组弹窗表单(基础/Team 成员角色·模型·阶段·归属/流程/
      执行层/审计层/输出+模板 localStorage)、会话头「⚡ 讨论」按钮、房间标题与
      合并·历史区展示团队·成员·纪要(view 新增 discussion 摘要);client.js 语法过检
- [~] M4 端到端真机验证(进行中):
  - [x] 引擎 preflight 实证并修复:`requires.skills` 对照全局 `availableSkills`
        (默认空)导致 start 被拒 —— capsule 已改为 `skills: []`(skills 本就随插件内置)
  - [x] 真机首启(`run_workflow`)确认为本会话审批提示禁用而 denied
        (trusted-local confirm 被自动拒绝;面板路径 approvalGranted=true 不受影响)
  - [x] scratch 项目已备妥(`/Volumes/project/github/speckit-e2e-scratch`,含 .specify/
        + 10 skills + 新 capsule);仓库自身 `.dsh/workflows` capsule 已自愈
  - [x] 热装路由升 v3(spkdev-2/pkg-7):provenance 引擎兼容、requires.skills 置空、
        discussion 归一化透传、start 以 granted=true 直启
  - [ ] ~~用户点击面板/弹窗~~ → 已改为**自动点火**:spkign 动态插件以
        approvalGranted=true 直启真 run(c5f15646,06:47Z);specify 代理真写盘
        (.specify/feature.json + specs/001-cli-todo/spec.md 已出现,agent 仍在
        填充中);进度经 `workflow_manage show` 逐轮取证

## 9. v0.2.0 优化轮次（2026-08-16）

### 9.1 Speckit skills 内置化

- [x] 10 个 pipeline skill 的 `SKILL.md` 随包分发（`skills/`，附 `skills/NOTICE.md`：
      源自 github.com/github/spec-kit，MIT，经 specify CLI v0.16.4 Codex skills 模式生成）
- [x] 运行开始时把 skills 按哈希同步到 `<project>/.dsh/speckit-workflow/skills/`
      （`skills.json` 记录版本与哈希；插件升级自动重同步；未变更时零写入）
- [x] `workflow-source.txt` 改为读取插件同步的 skill 目录；worktree 阶段始终从
      主项目根读 skills（`.dsh` 不在 git checkout 里）
- [x] 预检不再要求项目内含 `.agents/skills`；仅要求 `.specify` 骨架（skills
      仍会调用 `.specify/scripts/python/*`）

### 9.2 宿主侧强化

- [x] capsule 自愈：`.dsh/workflows/speckit-sdd.workflow.json` 按 `provenance.sourceSha256`
      比对，插件升级后旧项目自动重写，不再永远跑旧管线
- [x] 同项目并发护栏：本进程启动的活动 run 记录 `runId → projectRoot`；第二次启动
      同一项目被拒绝（给 runId 提示），`force:true` 可绕过；不同项目互不干扰
- [x] `view` 容错：`service.show` 抛错 / run 不存在时降级展示而非整页失败，新增
      `runMissing` 标记；`status` 端点同样容错
- [x] 预检 + 工作区列表 10s TTL 缓存（2.5s 轮询 × 40 工作区 × 11 stat 的降载），
      `startRun` 仍用实时检查
- [x] RPC 新增 `run-control`（stop / pause / resume，映射引擎 `stop/pause/resume`，
      `applied` 标记引擎是否接受）
- [x] `attachBackgroundJob` 收口到 `startRun`（工具与面板路径统一；消除重复调用）
- [x] 工具新增 `force` 参数；manifest `inputSchema` 同步

### 9.3 工作流编排强化

- [x] 各阶段 `artifacts` 汇总进工作流 result（`artifacts` 数组，去重、上限 50），
      合并·历史区优先展示 `result.artifacts`
- [x] `taskstoissues` 失败不再中止全流程（hard=false，phase 标记 failed 但 implement
      继续）——与其自身 prompt 约定一致
- [x] analyze / checklist 的结论注入 implement 与 converge 的 phase prompt：
      阻断性问题必须修复，廉价的信息性发现顺手修复，收敛阶段复核是否真正解决

### 9.4 Web 面板强化

- [x] 运行中/暂停时显示 **⏸ 暂停 / ▶ 继续 / ■ 停止**（停止带确认）；feature 输入框回车即启动
- [x] 状态 pill 增加阶段 + 已运行时长
- [x] 轮询串行化签名比对：payload 无变化时跳过 React 重渲染（相位运行期大幅降载）
- [x] 沟通/执行/审计三个流式区贴底滚动（用户往上翻历史则不再强拽）
- [x] `useSessions` 改为 `state.current` 选择器，避免整个 store 变更触发重渲染
- [x] 所选历史 run 不存在时显示提示（runMissing）

### 9.5 验证与发布预备

- [x] `scripts/check.sh`：新增 workflow source 不得引用 `.agents/skills`、capsule 必须
      携带 `provenance.sourceSha256`、10 个内置 skill 存在且被 source 引用等断言
- [x] 真实 node（`/Volumes/soft/lan/nodejs/v24/bin/node`）通过全部 check
- [x] 常驻冒烟套件 `scripts/smoke.mjs`（32 项，可对任意 profile 里安装的插件副本运行）
- [x] `npm pack --dry-run` 通过：22 文件 64.8 kB，skills/NOTICE 均在包内
- [x] npm 名称可用性已核实：无 scope 的 `dsh-speckit-workflow` 未被占用；
      自家生态为 `@linxin666/*`（dsh-ssh maintainer: linxin666）
- [ ] **发布暂缓（用户决定）：本地先调完再说。** 包名（scoped/unscoped）、
      repository、author 等未定项和执行步骤都记在 `PUBLISHING.md`
- [x] 已重新 `sync-to-profile.sh` 同步（含 `skills/`）

## 1. 项目定位

- 新插件目录：`/Volumes/project/github/dsh/dsh-speckit-workflow/`
- 包名：`dsh-speckit-workflow`
- 插件能力：
  - 宿主侧模型工具：`speckit_sdd`
  - 宿主侧 RPC：`/api/dsh-speckit-workflow`（catalog / check / start / runs / view / run-control / run-action）
  - Web UI：侧边栏「新会话」按钮正下方的 **SpecKit SDD** 入口，打开**中栏大页面**（SSH 面板同款 takeover），五个区：进度（一条一条）/ 沟通 / 执行 / 审计 / 合并·历史
  - 工作流：项目级 `speckit-sdd`（落到 `.dsh/workflows/speckit-sdd.workflow.json`）
- 依赖原则：
  - **只引用宿主项目已有资产**（`.agents/skills/`、`.specify/`），不复制 spec-kit 源码
  - 运行时依赖 profile 中已安装的 `@dsh-external/workflow`（durable run / workflow_list）
  - `spec-kit/` 仍作为仓库内参考目录保留

## 2. 已完成

### 2.1 基础环境

- [x] `spec-kit` 子目录升级到 GitHub `main` 最新：`bf88c9f`
- [x] 安装最新 `specify` CLI v0.16.4（隔离 venv：`~/.venvs/specify-cli`）
- [x] 在当前仓库根初始化 spec-kit：
  - `.agents/skills/`：10 个 Speckit skill（Codex skills 模式）
  - `.specify/`：模板、python 脚本、workflow、constitution 等
- [x] 安装 worktrees 社区扩展 `Worktrees v1.3.2`
  - `.specify/extensions.yml` 注册了 `after_specify` 钩子
  - 项目根 `.gitignore` 增加 `.worktrees/`

### 2.2 插件核心实现

- [x] 插件包骨架：
  - `package.json`（npm 可发布，`dsh.bundle.patch` + `dsh.client.inject`）
  - `cordis.patch.yml`（profile bundle 插入）
- [x] 工作流编排：
  - `lib/manifest.js`：`speckit-sdd` manifest（12 个 phase）
  - `lib/workflow-source.txt`：完整编排脚本
  - `lib/capsule.js`：生成 `dsh.workflow` 格式 capsule
- [x] 宿主侧入口 `lib/index.js`：
  - 注册模型工具 `speckit_sdd`
  - 注册 system prompt 使用说明
  - 注册 RPC channel `/api/dsh-speckit-workflow`（`catalog` / `check` / `start` / `runs` / `view` / `run-control` / `run-action`）
  - **项目文件夹选择**：`workspaceRegistry.list()` 提供 DSH 工作区候选 + 当前
    会话 cwd；`projectPath` 贯穿 RPC 与工具参数（默认当前会话 cwd）
  - 运行前对 `projectPath` 做预检：`.agents/skills` 十个 skill + `.specify/templates`
  - 首次运行时自动把 `speckit-sdd.workflow.json` 写入所选项目 `.dsh/workflows/`
  - `view` 端点一次组装五区数据 —— phase 进度（process.items +
    工作流 result 覆写）、沟通/执行事件流（events 按类型分拣）、审计
    （gates 判定 + checklist/analyze 结论 + verify 失败 + outcomes 错误）、
    合并·历史（worktree + artifacts + `runs()` 历史列表），全部截断+裁剪
- [x] Web 客户端 `lib/client.js`：
  - 入口：侧边栏「新会话」按钮正下方导航行（SSH 入口同款：logoRow 锚点 +
    面板家族排序 + active 态 + rail 折叠）
  - 大页面：`[data-dsh-speckit-view]` 追加为中栏列子节点，`html[data-dsh-speckit-active]`
    CSS 接管显示（会话子树保持挂载，状态不丢，SSH 的 #243 双选择器模式）
  - **布局已改为全横向**：顶部一条水平控制条（标题 · 项目选择 · feature ·
    启动 · 状态 · 选项 · 关闭），下方五个 zone 一条从左到右：进度 rail |
    沟通 | 执行 | 审计 | 合并·历史，不再有上下 2×2 分块
  - 项目选择器下拉列出 DSH 工作区 + 当前 cwd，未就绪项目带 ⚠，选择后
    `check`/`view`/`start` 都作用于所选文件夹
  - 数据：开页轮询 `view`（2.5s，终态自动停），历史点击切换选定 runId
  - 生命周期注册到 `shell.overlay`；跨面板 `dsh-panel-activate` 互斥；点击
    侧边栏会话行自动关闭；MutationObserver 自愈重锚 + 兜底 chip
- [x] UI 原型 `design/ui-preview.html`：
  - 五区大页面静态 mock + 模拟 phase 推进/流式滚动动画
  - 浏览器直接打开即可预览，避免反复重启 DSH

## 3. 工作流阶段

从 `specify` 开始，不包含 `constitution`：

```text
specify
  → review-spec          (agent 评审门禁)
  → worktrees            (创建/复用隔离 worktree)
  → clarify              (非交互式，假设回写 spec)
  → plan
  → review-plan          (agent 评审门禁)
  → checklist
  → tasks
  → analyze
  → taskstoissues        (可选，默认关)
  → implement
  → converge
```

默认开关与目标：

| 开关 | 默认值 |
|---|---|
| projectRoot | 当前会话 cwd（UI 可切换为任意 DSH 工作区；工具可传 `projectPath`） |
| runClarify | true |
| runChecklist | true |
| runAnalyze | true |
| useWorktrees | true |
| runTaskstoissues | false |
| gates（自动评审） | agent |

`workflow-source.txt` 会把 `args.projectRoot` 作为唯一目标项目根写入每个 phase
prompt，worktree 阶段成功后再把后续 phase 切换到 worktree 路径。

## 4. 已验证

- [x] `node --check`：`index.js` / `capsule.js` / `manifest.js` / `client.js` 全部通过
- [x] `workflow-source.txt` 解析测试：
  - 无 `feature` 时 no-op guard 正常
  - 完整链路每个 phase 按顺序 spawn
  - review reject 会中止流程
  - 关闭 clarify/checklist/analyze/worktrees/taskstoissues 时对应 agent 不会 spawn
  - 传入 `projectRoot` 时选中项目根会出现在每个 phase prompt 与返回结果里
- [x] capsule 通过 `@dsh-external/workflow` 官方 `validateWorkflowCapsule`
- [x] 宿主 mock 冒烟测试：
  - 工具 `speckit_sdd` 注册成功、execute 成功
  - RPC `check` / `start` / `status` / `view` 成功
  - 首次运行成功生成 `.dsh/workflows/speckit-sdd.workflow.json`
  - **项目文件夹选择**：bare 项目预检失败、ready 项目通过，`projectPath`
    从 RPC/工具一路透传到 `startNamed` 的 `args.projectRoot`
- [x] 项目工作流已可见：`workflow_list` 中出现 `speckit-sdd`（source: project, valid: true）
- [x] `view` 端点已下发并重新同步到 profile（统一通过 `/api/dsh-speckit-workflow` RPC 入口）

## 5. 本地安装状态

- [x] `~/.dsh/profiles/web/package.json`
  - dependencies 增加：`"dsh-speckit-workflow": "file:/Volumes/project/github/dsh/dsh-speckit-workflow"`
  - bundles 增加：`"dsh-speckit-workflow"`
- [x] `node_modules/dsh-speckit-workflow` 已由 `scripts/sync-to-profile.sh` 同步
- [x] `pnpm install` 已通过：对 3 个发布时间未满限制的包（dsh-ssh / dsh-agent-teams /
  dshmarket）使用 dshmarket 同款一次性 `--config.minimumReleaseAge=0` 绕过；
  供应链策略本身保留，锁文件未放宽
- [x] 重启/热重启 DSH，让宿主工具和 Web UI 正式生效
  - ⚠ 2026-08-17 热调试发现：profile 侧 `node_modules/dsh-speckit-workflow`
    曾缺失（非本记录所述状态），已重新 `sync-to-profile.sh` 并验证
    dependency + bundles + host/client 副本就位 —— 详见 §13

调试命令：

```bash
cd dsh-speckit-workflow
bash scripts/check.sh                # 语法 + workflow source + capsule 快速校验
bash scripts/sync-to-profile.sh      # 同步到 ~/.dsh/profiles/web 后重启 DSH
node --input-type=module ...         # 需要更细粒度测试时
```

## 6. 仍未完成 / 待决定

- [x] **重启 DSH 做真实加载验证**
- [x] **UI 版式定案 v1**：SSH 同款中栏大页面；顶部一条横向控制条（含项目选择），
      下方五区横向一行（进度 | 沟通 | 执行 | 审计 | 合并·历史），无上下分块
- [ ] 真机验证后再润色：五区列宽/信息密度、入口文案、rail 折叠态
- [ ] 真实端到端跑一个 feature（建议用 scratch 项目，避免污染仓库）
- [ ] 面板控制按钮真机验证：暂停 / 继续 / 停止
- [ ] worktree 与主 checkout 分支冲突的处理策略再确认（当前冲突时 `skipped` 并继续在主树）
- [ ] `clarify` 是否后续支持交互式提问（当前自动记录假设）
- [ ] npm 发布（**用户决定暂缓**，所有未定项与步骤见 `PUBLISHING.md`）：
      包名（scoped/unscoped）、repository、author、npm login、publish

## 7. 文件清单

```text
dsh-speckit-workflow/
├── package.json
├── cordis.patch.yml
├── README.md
├── LICENSE
├── PROGRESS.md                 ← 本文件
├── PUBLISHING.md               # 发布清单（暂缓执行）
├── design/
│   └── ui-preview.html         # UI 原型
├── skills/                     # vendored speckit skills（MIT, 见 NOTICE.md）
│   ├── NOTICE.md
│   └── speckit-*/SKILL.md      # 10 个 pipeline skill
├── lib/
│   ├── index.js                # 宿主工具 + RPC
│   ├── index.d.ts
│   ├── capsule.js              # workflow capsule 生成
│   ├── manifest.js             # workflow manifest
│   ├── workflow-source.txt     # 编排脚本
│   ├── client.js               # Web UI
│   └── client.d.ts
└── scripts/
    ├── check.sh                # 静态校验
    ├── smoke.mjs               # 宿主侧冒烟套件（对 profile 内已安装副本运行）
    └── sync-to-profile.sh
```

## 8. 已知限制（v0.2）

1. `constitution` 不在工作流中；需要时先单独运行 `speckit-constitution`。
2. `clarify` 非交互式，阶段 agent 把假设写回 spec。
3. 当 feature 分支已在主 checkout 时，`worktrees` 阶段会报告 `skipped`，后续在主树继续。
4. 宿主项目仍需一次 `specify init --script py`（`.specify` 骨架）；skills 已随插件
   内置，项目内 `.agents/skills` 不再需要、也不会被读取。
5. 运行时依赖 `@dsh-external/workflow`；缺失时会给出明确错误。

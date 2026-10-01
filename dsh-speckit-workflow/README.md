# dsh-speckit-workflow · Spec 流水线看板 / Feature 工作台 (v0.8)

DSH 的 **Feature 工作台**：围绕一个 Feature，按 DESIGN-V0.8.md 的流程把 Spec Kit SDD
拆成九个独立阶段线程，每个阶段**默认停在人工确认点**，Clarify / Converge 在**同一条线程**
内多轮交互。4 列看板（**Specify → Clarify → Implement → Converge**）只是聚合视图，
真正的执行单位是阶段线程；视觉沿用已定版的 v0.7 看板原型
（`design/spec-board-prototype.html`，配色/风格未改）。

> **v0.8 与 v0.7 的本质区别**：不再用 `@dsh-external/workflow` 跑一整条流水线，也
> 没有 `review-spec/review-plan` 自动门禁。阶段线程 = durable continuable subagent
> 会话（`ctx.subagents.startContinuable`）；编排状态存于宿主侧 SQLite
> 账本（`~/.dsh/speckit-workflow/workflow.db`）。一次只执行一个活动阶段。

```text
Feature 工作流实例（一个 Feature 一条看板卡片）
  specify →(确认)→ clarify ⇄(逐题回答)→ plan → checklist?(可跳) → tasks
          → analyze?(可跳) → taskstoissues?(可跳) → implement →(确认)→ converge
  converge 有遗留 → 用户确认追加任务 → 返回 implement 循环
  converge 无遗留 → 用户确认收敛并结束
```

## What the plugin provides

| Surface | Entry | Behavior |
|---|---|---|
| 隔离看板（入口 = 工作区行按钮） | 侧栏每个工作区行右侧「看板」按钮（`[class*="projectRow"]` 注入）；header「📋 看板」为当前会话工作区兜底入口 | 每张卡 = 一个 Feature 实例：当前阶段、状态（running / 等待你回答 / 等待确认 / 失败…）、worktree/inplace、attempt；看板按工作区隔离，各工作区独立可并发 |
| 新建 Feature | 顶栏「新建 Feature」 | **并入当前工作区（无目录选择器）** + Feature 描述 + 流程开关（worktrees/checklist/analyze/taskstoissues）+ 阶段线程模型；创建即启动 **Specify 线程**；工作区未就绪（缺 `.specify`）直接报错 |
| 阶段线程详情 | 卡片 → 抽屉 | 9 阶段旅程、每个阶段的产物/skill 版本/输入快照/人工决策、当前线程消息流、待回答问题/待决策发现、按 §6 契约展示的操作 |
| Clarify / Converge | 抽屉内聊天 / 线程弹窗 | 同线程逐题问答；`done`/`stop` 提前结束；Converge 先展示发现再决策（追加任务或无遗留） |
| 人工交接 | 抽屉脚部动作 | 「确认进入 Clarify/Plan/…」「确认收敛并结束」等**带明确目标**的确认；重做（新 attempt）、跳过可选阶段、取消、返回上阶段 |
| Host RPC | `/api/dsh-speckit-workflow` | `install` `workspaces` `check` `models` `instances` `workspace-init` `instance-create` `instance-get` `instance-cancel` `stage-confirm` `stage-skip` `stage-answer` `stage-rerun` `stage-rollback` `stage-cancel` `thread-view` `artifact-read` `events-since` |
| 阶段线程 | `ctx.subagents` continuable subagent | 每个阶段一条 durable 线程；`agent/status` idle 边沿驱动账本推进；重启后由持久化账本恢复 |
| 编排账本 | `~/.dsh/speckit-workflow/workflow.db` | `workflow_instances` / `stages` / `artifacts` / `decisions` / `events` / `actions` + `workspace_locks`；`node:sqlite` 内置实现（Node 22.5+/24），`node:sqlite` 缺失时降级 JSON 后端（仅开发用） |
| Skills | 内置 `skills/` + 项目 `.dsh/speckit-workflow/skills/` | 10 个 vendored skill 在实例创建时按哈希同步；阶段线程 persona 注入 skill 内容 |

## Prerequisites

1. DSH `web` profile（Node ≥ 22.5 优先使用内置 `node:sqlite`）。
2. **spec-kit `.specify` 骨架**（templates + scripts + workflows 元数据）——由插件
   自动准备，但**必须走官方 `specify init`**：只有它会写入 `workflows/`、
    `integration.json`、`integrations/`、`init-options.json` 与 `.specify/.gitignore`。
   缺了这些，spec-kit 自己就认不出项目里有 SDD 工作流（`specify workflow list`
   返回 `No workflows installed.`），后续阶段无法生成。

   新建 Feature 弹窗对未就绪工作区点「⚙ 初始化工作区」即自动执行官方
   `specify init --here --script py --integration codex --ignore-agent-tools`
   并同步内置 skills。**插件把 spec-kit 版本钉死在 `SPECIFY_CLI_VERSION`
   （当前 v0.16.4，与内置 skills 同版本）**，不跟随本机 CLI 漂移：

   - 本机 `specify` 版本**精确匹配**时直接使用；
   - 否则用 `uvx --from specify-cli==<pinned>`（推荐，需装 [uv](https://docs.astral.sh/uv/)）
     或 `pipx run --spec specify-cli==<pinned>` 按精确版本临时拉取；
   - 三者皆不可用时初始化会明确报错并给出安装指引。

   ```bash
   # 手动等价操作（版本必须与 SPECIFY_CLI_VERSION 一致）
   uvx --from specify-cli==0.16.4 specify init --here --script py \
       --integration codex --ignore-agent-tools
   ```

   注：官方 init 同步到 `.agents/skills/` 的 skills 与插件内置 skills 逐字节相同，
   属预期内的重复副本。

3. **subagent 提供者**（可 spawn durable continuable 线程）已注册，例如
   `subagent-spawn`（agent-teams 同款依赖）；插件在 `install` 端点报告其可用性。

不等依赖 `@dsh-external/workflow`——v0.8 不再使用 workflow engine 执行阶段。

## Install (local dev)

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dsh": { "profile": { "bundles": [ "dsh-speckit-workflow" ] } },
  "dependencies": { "dsh-speckit-workflow": "file:/Volumes/project/github/dsh/dsh-speckit-workflow" }
}
```

```bash
cd dsh-speckit-workflow
bash scripts/sync-to-profile.sh     # rsync 到 profile + 接线 dependencies/bundles
# 重启 DSH；宿主注册 speckit_sdd 工具 + /api/dsh-speckit-workflow
```

> **安装失败排查（pnpm 11 构建脚本审批）**：若 `pnpm install` 报
> `ERR_PNPM_IGNORED_BUILDS`（exit 1 = 界面「安装失败」），把 profile
> `pnpm-workspace.yaml` 的 `allowBuilds` 占位串 `set this to true or false` 改成
> 显式布尔值后重跑。

### 构建前端产物（改过 `web/src/` 就必须做）

工作台 React 界面被打包成单文件 `web/bundle-dist/board.js`，由宿主作为
`/api/dsh-speckit-workflow/board.js` 提供，客户端 `lib/client.js` 强制 fetch 它
并挂载 `window.__SPKB_BOARD__`。**该产物已入库**：本包只经 git 分发（未发布
npm，没有 `prepublish` 钩子），不入库则别人 clone 后点「看板」只会看到
`工作台 bundle 未暴露 __SPKB_BOARD__.mount`。

```bash
npm --prefix web install    # 首次：安装前端依赖
npm run build:bundle        # = cd web && vite build --config vite.bundle.config.js
bash scripts/sync-to-profile.sh
```

改了 `web/src/` 一定要重新构建**并提交**产物；同一份 `web/src` 重复构建产出
逐字节相同的 `board.js`（已实测 sha256 一致），所以 `git status` 就能看出产物
是否已随源码更新。只改 `lib/`、`skills/`、`skeleton/` 时无需重新构建。

## Workbench contract

所有变更都走宿主 RPC；每个用户变更都带 `actionId` 幂等键（不依赖前端按钮禁用）：

```text
instances        → 看板投影 { cwd, projects, columns, instances[] }
workspace-init   → 一键初始化工作区：官方 specify init（版本由插件钉死）+ 内置 skills 同步 → { ready, issues, skeleton }
instance-create  → 建实例 + 启动 Specify 线程 → { instanceId, stageId, threadId }
instance-get     → 全部阶段/产物/决策/事件 + 当前线程消息 + 每个阶段允许的操作
instance-cancel  → 删除整个 Feature 实例（取消活动阶段 + 释放工作区锁，idempotent by actionId）
stage-confirm    → 原子交接：固化当前阶段 + 创建下阶段线程（idempotent by actionId）
stage-skip       → 跳过可选阶段（记录原因，不伪造通过）
stage-answer     → Clarify/Converge 用户回答 → followup 同一线程
stage-rerun      → 同 stageId 新 attempt，旧记录保留，下游标 stale
stage-rollback   → 返回上一阶段，后续标 stale
stage-cancel     → 取消阶段/实例，释放工作区锁
thread-view      → 阶段线程消息历史 + 当前 state.json
artifact-read    → 读取产物正文（spec.md 等）用于查看差异
events-since     → 增量事件游标
```

工作区级并发规则（DESIGN-V0.8 §7.1）：**一个工作区同时最多一个活动阶段**，由
`workspace_locks` 表在事务内强制；不同工作区可以并发。

### From the model / chat

`speckit_sdd` 现在**只创建实例并启动 Specify**（不再一键跑全流程）：

```json
{ "feature": "为桌面端增加多账户切换", "projectPath": "/abs/path" }
```

返回 `{ instanceId, stageId, stageStatus, threadId }`；后续阶段推进全部由用户
在工作台人工确认。可选参数：`useWorktrees` / `runChecklist` / `runAnalyze` /
`runTaskstoissues` / `provider`+`model`（阶段线程模型覆盖）。

### Files written

```text
.specify/feature.json
specs/<NNN-name>/spec.md, plan.md, tasks.md, research.md, ...
.worktrees/<branch>/            (开启 worktree 时，Specify 后产物交接到这里)
.dsh/speckit-workflow/skills/                 (vendored skills, hash-synced)
~/.dsh/speckit-workflow/workflow.db           (编排账本, profile 级)
.dsh/speckit-workflow/instances/<id>/stages/<stage>-<attempt>.state.json  (线程状态文件)
```

## Debugging

```bash
bash scripts/check.sh            # 全部模块语法 + 阶段图 + machine-smoke（sqlite+json）
node scripts/smoke.mjs           # machine-smoke + worktree 产物交接/校验
bash scripts/sync-to-profile.sh  # 同步到 profile 后重启 DSH
```

## Known limitations (v0.8)

- 阶段线程以 `spawn` 提供者创建，需要父会话 agent 存活才能投递回答/续跑；跨会话
  继续（原创建会话离线）时为 best-effort。
- Clarify/Converge 的“线程”是同一 continuable 会话，消息历史在其会话事件里；不是
  workflow engine run。
- `constitution` 不在流程内（需要时单独运行 `speckit-constitution`）。
- `.specify` 骨架由插件内置（v0.16.4，与 vendored skills 同版本）在 workspace-init
  时拷贝生成；已有项目的骨架不会被覆盖运行期产物（specs/、feature.json 不触碰）。
- 数据库为 profile 级全局（跨工作区列出实例）；worktree 可被清理但账本不丢。

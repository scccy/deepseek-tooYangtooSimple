# dsh-speckit-workflow v0.8 设计

> 状态：业务流程定稿，待实现评审
>
> 本文档是 v0.8 的业务流程和状态契约事实源。它只定义工作区、Feature、阶段线程、人工交接、产物和恢复规则，不定义具体代码实现。

## 1. 设计目标

v0.8 将 Spec Kit 从“一次运行完整流水线”改为“围绕一个 Feature，逐阶段创建线程，并由用户确认阶段交接”的工作台。

核心原则：

1. 工作区是运行主体，不是会话或 agent。
2. 每个 Speckit skill 步骤都是一个独立执行阶段和独立线程。
3. 阶段完成后默认停在人工交接点，不自动进入下一阶段。
4. Clarify 和 Converge 是真正的交互阶段，必须允许用户在同一阶段线程中多轮参与。
5. Skill 文件定义阶段行为；插件只负责阶段调度、状态持久化、线程关联和工作台投影。
6. 每个阶段都必须记录实际使用的 skill 版本和提示词输入快照。

## 2. 用户可见的完整流程

```text
选择工作区
  ↓
创建 Feature
  ↓
Specify 线程
  ├─ 生成带编号的 specs/<NNN>-<short-name>/ 目录
  ├─ 生成 spec.md、requirements checklist、feature.json
  └─ Specify 完成后触发强制 after_specify hook
       └─ 创建或复用该 Feature 的 worktree
  ↓ 人工确认
Clarify 线程
  └─ 一次一个问题，多轮补充并写回 spec.md
  ↓ 人工结束并确认
Plan 线程
  └─ 研究、数据模型、契约、quickstart、plan.md
  ↓ 人工确认
Checklist 线程（可选）
  └─ 生成需求质量 checklist
  ↓ 人工确认
Tasks 线程
  └─ 生成按用户故事组织的 tasks.md
  ↓ 人工确认
Analyze 线程（可选）
  └─ 只读检查 spec / plan / tasks 的一致性
  ↓ 人工确认
Taskstoissues 线程（可选、外部副作用）
  └─ 将 tasks.md 转换成 GitHub issues
  ↓ 人工确认
Implement 线程
  └─ 执行 tasks.md，修改代码并验证
  ↓ 人工确认
Converge 线程
  └─ 检查实现与 spec / plan / tasks 的差距
      ├─ 发现遗留工作：用户确认追加任务 → 返回 Tasks/Implement
      └─ 没有遗留工作：用户确认完成
```

四列看板是上面阶段的聚合视图，不是四个大一统 run：

| 看板列 | 包含阶段 | 用户看到的主要结果 |
|---|---|---|
| Specify | `specify` | 需求文件已经生成，等待确认 |
| Clarify | `clarify`、`plan` | 需求已经澄清，设计文件等待确认 |
| Implement | `checklist`、`tasks`、`analyze`、`taskstoissues`、`implement` | 任务和代码逐步生成 |
| Converge | `converge` | 收敛结论，或回到实现循环 |

列只是导航和状态分组。真正的执行单位是阶段线程。

## 3. 阶段线程模型

### 3.1 阶段线程的生命周期

每个阶段都创建一个新的线程，不复用上一阶段的线程上下文。新线程通过结构化上下文读取前一阶段产物和状态。

```text
not-started
    ↓ 用户启动
running
    ├─ 阶段需要用户输入 → awaiting-user
    │                       └─ 用户回复 → running
    ├─ 阶段产物已生成 → awaiting-confirmation
    │                       ├─ 确认 → completed
    │                       ├─ 要求修改 → running（同一阶段线程重开/继续）
    │                       └─ 放弃 → cancelled
    ├─ 失败 → failed
    └─ 完成且无需确认 → completed
```

`awaiting-user` 和 `awaiting-confirmation` 必须区分：

- `awaiting-user`：阶段还没有完成，正在等待 Clarify 或 Converge 的具体回答。
- `awaiting-confirmation`：阶段已经产出结果，等待用户决定是否交接到下一阶段。

### 3.2 阶段交接规则

用户点击“进入下一阶段”时，系统必须：

1. 校验当前阶段状态为 `awaiting-confirmation` 或 `completed`。
2. 固化当前阶段的产物清单、摘要、线程 ID、skill 哈希和输入快照。
3. 创建新的阶段线程。
4. 向新线程注入工作流实例上下文，而不是注入上一线程的全部聊天记录。
5. 将当前阶段标记为 `completed`，将下一阶段标记为 `running`。

用户不能通过修改 URL、刷新页面或重复点击绕过阶段顺序。

### 3.3 阶段重跑和回退

- “重新执行本阶段”：创建同一 `stageId` 的新 attempt，保留旧 attempt 作为历史证据。
- “返回上一阶段”：不删除后续产物，将后续阶段标记为 `stale`，要求从被修改阶段重新确认。
- 如果 spec 被 Clarify 修改，Plan、Tasks、Analyze、Implement、Converge 的旧结果都必须显示为可能过期，不能静默继续。
- 如果 Converge 追加了新任务，旧的 Implement 和 Converge 结果仍保留，但实例回到实现循环。

## 4. 各阶段业务定义

以下定义以 `dsh-speckit-workflow/skills/` 中的 skill 为准。插件不能在编排层重新定义与 skill 冲突的行为。

### 4.1 Worktree 后置准备

对应 skill：`speckit-worktrees-create`

这是 Specify 的后置准备步骤，不是 Specify 前的准备步骤，也不是一个先于 Specify 的用户阶段。

当前项目的真实配置是：

- `.specify/extensions.yml` 只配置了 `after_specify`；
- hook 为 `optional: false`；
- `settings.auto_execute_hooks` 为 `true`；
- `worktree-config.yml` 的 `auto_create` 为 `true`。

因此实际顺序固定为：

```text
Specify 创建 Feature 编号和 spec 产物
  ↓
Specify 执行 after_specify hook
  ↓
speckit.worktrees.create 创建或复用 worktree
  ↓
Specify 阶段才向用户报告完成并进入 awaiting-confirmation
```

职责：

- 确认项目是 Git 仓库并支持 `git worktree`。
- 使用 Specify 产生的 `SPECIFY_FEATURE` 或最近创建的 Feature 分支确定目标分支。
- 根据配置创建或复用 Feature 分支和 worktree。
- 报告 worktree 路径、分支、布局和已有 spec 产物位置。
- 不负责创建 Feature 编号、spec 目录或 `spec.md`；这些始终由 Specify 完成。

如果用户明确选择 `--in-place` 或关闭 worktree，则所有阶段固定使用工作区根目录。

### 4.2 Specify 产物与 Worktree 交接

由于 `after_specify` 在 Specify 写文件之后执行，Spec 文件默认首先位于当前主 checkout。新 worktree 是从目标分支或 base ref 创建的，不能假定未提交的 `spec.md`、checklist 或 `.specify/feature.json` 已经存在于 worktree。

因此 Specify 完成后必须先记录产物归属：

```text
artifactRoot = 产物实际所在目录
workspaceRoot = 用户打开的主工作区
worktreePath  = after_specify 创建的隔离目录（如果启用）
```

在 Clarify 启动前，工作流必须完成一次明确的“产物交接”。v0.8 的默认策略是隔离模式：

1. `after_specify` 创建 worktree 后，插件只同步当前 Feature 相关的未提交产物到 worktree，包括 `.specify/feature.json`、`specs/<feature>/` 和该 Feature 明确依赖的扩展产物。
2. 校验 worktree 中的 `feature.json` 与 Specify 返回的 `BRANCH_NAME`、`FEATURE_NUM` 和 feature directory 一致。
3. 将 `artifactRoot` 和 `executionRoot` 统一绑定到 worktree。
4. 主 checkout 中的 Specify 产物作为原始快照保留，不删除、不覆盖，也不再被后续阶段隐式修改。
5. 从 Clarify 开始，所有阶段线程都在 worktree 中读取和写入 Feature 产物及代码。

如果用户关闭 worktree 或 hook 返回 `worktree: false`，则采用原地模式：所有阶段统一绑定 `workspaceRoot`。

两种模式必须在实例中记录，不能让后续线程自行猜测。同步或校验失败时，实例停在 `awaiting-confirmation`/`failed`，不得启动 Clarify、Plan 或 Implement。

### 4.3 Specify

对应 skill：`speckit-specify`

输入：

- 用户提供的 Feature 描述；
- 项目 constitution；
- `.specify` 模板、脚本和扩展 hook。

职责：

- 生成 2–4 个词的 Feature 短名称；
- 按 `.specify/init-options.json` 的 `feature_numbering` 规则创建带编号的 Feature 目录，例如 `specs/003-user-auth/`；
- 创建该目录中的 `spec.md`；
- 写入 `.specify/feature.json`；
- 输出 `BRANCH_NAME`、`SPEC_FILE` 和 `FEATURE_NUM`，供后置 `after_specify` hook 确定 worktree 分支和产物目录；
- 按模板生成用户故事、功能需求、成功标准、实体、假设和范围；
- 执行需求质量校验；
- 最多保留 3 个关键 `[NEEDS CLARIFICATION]` 标记。

产物：

- `specs/<feature>/spec.md`；
- `.specify/feature.json`；
- `specs/<feature>/checklists/requirements.md`；
- skill 指定的扩展产物。

完成后状态必须是 `awaiting-confirmation`。用户需要能查看 spec 的正文、差异、质量清单和未决标记，再选择：

- 等待 `after_specify` worktree hook 和产物交接完成后，确认进入 Clarify；
- 在 Specify 阶段重新生成；
- 取消 Feature。

### 4.4 Clarify

对应 skill：`speckit-clarify`

这是第一个必须人工接入的阶段。

交互规则来自 skill：

- 读取当前 `spec.md`；
- 对功能范围、数据模型、交互、非功能、安全、边界条件等维度进行扫描；
- 最多提出 5 个高影响问题；
- 一次只展示一个问题；
- 接收用户回答后验证答案；
- 每次接受答案后立即写入 `## Clarifications` 和对应 spec 章节；
- 用户可以回复 `done`、`stop`、`proceed` 提前结束；
- 最终报告已回答问题、修改章节、覆盖情况和遗留问题。

阶段状态：

```text
running → awaiting-user → running → awaiting-user → ...
                                      ↓
                              awaiting-confirmation
```

Clarify 线程不能使用“代理自行猜测并写入假设”替代用户回答。若用户不回答，线程必须保持 `awaiting-user`，用户可以稍后从工作台继续。

Clarify 完成后，用户确认才允许进入 Plan。Clarify 修改过的 spec 是 Plan 的唯一需求输入。

### 4.5 Plan

对应 skill：`speckit-plan`

Plan 必须在 Clarify 完成后创建新的线程。

阶段内部有两个明确子阶段：

1. **研究**：提取技术上下文中的未知项，派发研究工作，生成 `research.md`，解决所有阻塞性的 `NEEDS CLARIFICATION`。
2. **设计与契约**：基于 spec 和 research 生成数据模型、外部契约、quickstart 和 `plan.md`。

产物：

- `research.md`；
- `data-model.md`（适用时）；
- `contracts/*`（存在外部接口时）；
- `quickstart.md`；
- `plan.md`。

Plan 线程只负责技术设计，不应无理由重写 spec。产出后进入 `awaiting-confirmation`，用户确认后才进入 Checklist 或 Tasks。

### 4.6 Checklist

对应 skill：`speckit-checklist`

这是需求质量检查，不是代码测试，也不应被显示成实现验证。

职责：

- 基于用户需求和已有 spec/plan/tasks 上下文动态生成最多 5 个澄清问题；
- 生成 reviewer-owned 的需求质量清单；
- 新项目创建 checklist，已有 checklist 只能追加；
- 新项目全部保持未勾选，不能代替 reviewer 自动批准。

产物：

- `checklists/<type>.md`。

如果 skill 根据当前需求生成了上下文问题，Checklist 线程可以短暂进入
`awaiting-user`，等待用户补充范围、风险重点或验收标准；这类问答只服务于清单生成，不能替代 Clarify 阶段对 spec 的正式澄清。

该阶段可配置为跳过。跳过时必须记录原因，并不能伪造 checklist 已通过。

### 4.7 Tasks

对应 skill：`speckit-tasks`

前置条件：`plan.md`、`spec.md` 和可用的设计产物已经存在。

职责：

- 读取 spec 中的用户故事及优先级；
- 读取 plan、数据模型、契约、research 和 constitution；
- 生成按用户故事组织的依赖有序任务；
- 生成 Setup、Foundational、各用户故事阶段和 Polish 阶段；
- 为每项任务提供明确文件路径；
- 生成依赖图、并行执行示例和 MVP 策略。

任务格式必须保持 Speckit 约定：`- [ ] T001 ...`，并正确使用 `[P]` 和 `[US#]` 标记。

### 4.8 Analyze

对应 skill：`speckit-analyze`

Analyze 是只读的一致性分析，必须在 Tasks 之后、Implement 之前执行。

检查范围：

- spec、plan、tasks 之间的重复、矛盾、歧义和覆盖缺口；
- 用户故事和验收标准覆盖；
- 任务到需求的映射；
- constitution 的 MUST/SHOULD 约束。

Analyze 不修改任何文件。结果是结构化分析报告，用户需要确认：

- 接受并继续 Implement；
- 返回修改 spec/plan/tasks；
- 重新运行 Analyze。

### 4.9 Taskstoissues

对应 skill：`speckit-taskstoissues`

这是可选的外部副作用阶段，不属于核心实现必经路径。

执行前必须：

- 确认 Git remote 是 GitHub URL；
- 读取 tasks.md 的任务 ID；
- 查询现有 issues 去重；
- 只为没有对应 issue 的任务创建 issue。

该阶段失败不能伪造成功，也不应破坏本地 Feature 状态。用户可以跳过、重试或保留本地 tasks.md 继续 Implement。

### 4.10 Implement

对应 skill：`speckit-implement`

前置条件：

- spec、plan、tasks 已存在；
- checklist 状态已被查看；
- Analyze 的阻塞问题已经处理，或用户明确接受风险。

职责：

- 解析 tasks.md；
- 按依赖顺序执行任务；
- 对 `[P]` 任务进行安全并行；
- 遇到失败继续处理可独立任务并记录失败项；
- 更新任务勾选状态；
- 运行验证并报告变更文件、测试结果、失败任务和剩余任务。

Implement 完成后必须等待用户确认。它不能自动进入 Converge，因为用户需要先查看代码变更和验证证据。

### 4.11 Converge

对应 skill：`speckit-converge`

这是第二个必须人工接入的阶段，也是实现循环的决策点。

前置条件：

- Implement 已经在当前 tasks.md 上执行；
- spec、plan、tasks 均存在。

执行顺序：

1. 读取 spec、plan、tasks 和 constitution；
2. 建立需求、验收标准、计划决策和任务的意图清单；
3. 检查当前代码并分类发现：`missing`、`partial`、`contradicts`、`unrequested`；
4. 按 CRITICAL/HIGH/MEDIUM/LOW 分级；
5. 先在当前 Converge 线程中展示发现摘要；
6. 等待用户决定后再追加 Convergence 任务；
7. 如果没有发现，报告已收敛，不修改 tasks.md；
8. 如果追加任务，明确返回 Implement 循环。

Converge 不修改 spec、plan 或代码，只能追加 tasks.md。它不是 Git merge，也不能宣称已经合并主干。

## 5. 工作流实例和持久化状态

看板卡片对应一个 Feature 工作流实例，而不是单个 run。

实例至少包含：

```text
instanceId
workspacePath
featureDir
featureName
branch
worktreePath
currentStage
currentColumn
stageHistory[]
artifacts[]
activeThreadId
inputSnapshot
skillSnapshot
status
```

每个阶段记录：

```text
stageId
stageType
attempt
threadId
status
startedAt
endedAt
input
artifacts
summary
userDecisions[]
skillId
skillSha256
```

每个阶段 run 可以拥有不同的 runId，但必须通过 `instanceId + stageId + attempt` 关联到同一张看板卡片。

### 5.1 本地 SQLite 编排账本

v0.8 建议增加一个由 Host 管理的本地 SQLite 数据库，用来保存工作流实例的编排状态。数据库不是 Speckit 产物仓库，也不是 workflow engine 的替代品。

建议位置：

```text
~/.dsh/speckit-workflow/workflow.db
```

采用 DSH profile 级的全局数据库，而不是把数据库放进某个 worktree，原因是：

- 侧边栏需要跨工作区列出 Feature 实例；
- worktree 可能被清理、移动或重新创建；
- 不同 worktree 不应各自拥有一份互相冲突的实例状态；
- Host 重启后需要从同一个地方恢复阶段和人工交接状态。

SQLite 保存以下信息：

| 数据 | 用途 |
|---|---|
| `workflow_instances` | Feature 实例、workspace、feature directory、当前列和总体状态 |
| `stages` | 每个阶段、attempt、threadId、状态、输入快照、skill 版本和摘要 |
| `artifacts` | 产物路径、来源根目录、当前根目录、哈希和是否过期 |
| `decisions` | 用户确认、返回、跳过、追加任务、收敛等人工决策 |
| `events` | 阶段状态变化、线程事件游标和恢复所需的最小事件索引 |
| `actions` | 防止重复点击造成重复启动的幂等键 |

数据库不保存：

- `spec.md`、`plan.md`、`tasks.md` 等正文；正文仍属于 worktree 或 workspace 文件；
- 完整聊天记录；聊天记录仍由线程持久化系统负责；
- workflow engine 的完整 run snapshot；engine 的 `.dsh/workflow-runs/` 仍是 run 的权威来源。

SQLite 主要解决四个问题：

1. **原子交接**：用户确认阶段和创建下一线程必须在一个事务中完成，避免出现“按钮显示已进入下一阶段，但线程没有创建”的半状态。
2. **工作区锁**：对同一 `workspacePath` 的活动阶段建立唯一约束，保证一个工作区同一时间最多只有一个活动阶段。
3. **重启恢复**：Host 或 UI 重启后，可以恢复当前阶段、等待中的问题、待确认产物和下一步操作。
4. **跨线程聚合**：多个阶段线程和多个 engine run 仍能聚合成一张 Feature 卡片。

状态转移必须使用事务和条件更新，例如只有当前阶段确实处于 `awaiting-confirmation` 时，确认动作才可以创建下一阶段。重复请求使用 `actionId` 去重，不能依赖前端按钮禁用。

运行时需要确认 Node 版本支持 `node:sqlite`。如果插件继续声明 Node 20 兼容，则必须在运行时提供 SQLite 能力检查；如果 DSH profile 的最低 Node 版本已经统一到支持 `node:sqlite` 的版本，则优先使用内置实现，不引入第三方原生依赖。

## 6. 人工操作契约

工作台只显示当前阶段允许的操作：

| 阶段状态 | 允许操作 |
|---|---|
| `running` | 查看线程、查看事件、停止阶段 |
| `awaiting-user` | 打开线程、发送回答、结束交互 |
| `awaiting-confirmation` | 查看产物、确认下一阶段、要求重做、取消 |
| `completed` | 查看结果、重跑阶段、查看历史 |
| `failed` | 查看错误、重试、返回上阶段 |
| `stale` | 查看过期原因、从该阶段重新开始 |

确认操作必须带有明确目标，例如“确认进入 Clarify”“确认进入 Implement”“确认收敛并结束”。不能使用含义不清的“继续”按钮代替。

## 7. 失败、恢复和并发

### 7.1 工作区隔离

- 实例绑定绝对 `workspacePath`，不跟随创建它的会话 cwd。
- 每个工作区同时最多一个活动阶段，防止同时写入 `.specify/feature.json`、spec 产物和 worktree。
- 不同工作区可以并发执行。
- DSH 重启后通过持久化实例和阶段线程恢复看板，不要求原会话仍然存在。

### 7.2 交互恢复

- Clarify 等待回答时，关闭看板不会丢失问题队列和已写入的澄清记录。
- Converge 等待决策时，发现摘要必须持久化，用户回来后可以继续选择。
- 人工确认不是引擎 pause 的替代品，而是阶段线程的业务状态。

### 7.3 上游 skill 更新

每个阶段启动时同步并记录：

- 上游 Spec Kit 版本或 commit；
- 使用的 skill ID；
- skill SHA-256；
- 项目级 skill override（如果存在）。

运行中的阶段继续使用启动时的 skill 快照；新的阶段使用最新已同步版本。升级不能改变历史阶段的证据。

## 8. 看板投影

看板卡片主信息必须是：

- Feature 名称和 workspace 路径；
- 当前列和当前阶段；
- 当前阶段线程；
- 阶段状态是运行、等待用户回答、等待确认还是失败；
- 当前阶段产物和差异；
- 下一步明确的人工操作。

日志、token、agent 消息、模型信息属于辅助证据，不能替代阶段状态和产物视图。

Clarify 和 Converge 的线程必须支持：

- 消息历史；
- 当前待回答问题或待决策发现；
- 已写入产物的差异；
- 继续、结束、返回或重试操作。

## 9. 明确不属于 v0.8 的行为

- 不提供一键跑完整流水线。
- 不在 review 阶段自动批准并跳过用户确认。
- 不把 Clarify 改成代理自行假设的非交互流程。
- 不把 Converge 当作 Git merge 或自动合并主干。
- 不将 Taskstoissues 视为本地实现的必要条件。
- 不让新的阶段线程依赖上一线程的隐式聊天上下文。
- 不允许后续阶段一部分写主 checkout、另一部分写 worktree；完成产物交接后必须只有一个执行根目录。

## 10. v0.8 验收标准

1. 用户可以从一个工作区创建 Feature，并只启动 Specify 线程。
2. Specify 产出文件后，流程停在人工确认点，不会自动启动 Clarify。
3. 用户确认后，Clarify 在新线程中逐题交互，最多 5 个问题，并在每次接受回答后写回 spec。
4. Clarify 未得到用户回答时，刷新、关闭或重启 DSH 后仍可继续。
5. Plan、Checklist、Tasks、Analyze、Taskstoissues、Implement 按 skill 规定的前置关系逐阶段启动。
6. Analyze 不修改文件；Taskstoissues 只在 GitHub remote 校验通过后执行外部创建。
7. Implement 结束后不会自动进入 Converge，必须由用户确认。
8. Converge 在写入新任务前展示发现并等待用户决策；追加任务后返回 Implement。
9. Converge 无发现时不修改 tasks.md，并允许用户确认结束。
10. 任意阶段都能查看线程、产物、skill 版本、输入快照和人工决策记录。
11. 同一工作区不会同时运行两个活动阶段，不同工作区可以并发。
12. 所有历史阶段和阶段 attempt 都可以追溯到同一个 Feature 工作流实例。

## 11. 实现前需要确认的非业务细节

业务流程已经固定，以下事项属于实现设计，不改变上述流程：

- DSH 是否提供可持久化的后台交互线程；
- DSH profile 的 Node 版本是否稳定支持 `node:sqlite`；
- SQLite 数据库的 profile 级路径、备份和清理策略；
- 阶段线程使用 workflow engine 的 run，还是使用独立 agent session；
- 工作区列表从哪个 Host Service 读取；
- 历史线程和实例状态的存储位置；
- 外部 GitHub tools 的可用性和授权方式；
- 项目级 skill override 与插件内置 skill 的优先级。

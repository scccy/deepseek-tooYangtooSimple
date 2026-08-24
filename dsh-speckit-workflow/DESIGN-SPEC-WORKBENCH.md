# Spec 工作台流程设计

> 状态：v0.1，基于 `skills/` 下 10 个 Speckit skill、`lib/workflow-source.txt` 和当前客户端实现整理。
>
> 目标：把 UI 从“通用 Workflow 控制面”调整为“围绕一个 feature、持续产出和审阅 spec 产物的工作台”。

## 1. 设计结论

当前 UI 的核心问题不是颜色或间距，而是心智模型不对：

- 页面把 `speckit-sdd` 当成一个普通 workflow；
- 12 个 phase 被平铺成一条状态 rail；
- 沟通、执行、审计、历史是并列信息区，和当前正在完成的 spec 产物没有直接关系；
- 配置项、JSON 参数、技能查看、胶囊管理同时暴露，用户不知道下一步应该完成什么；
- review、checklist、analyze 都被当成类似的“审计信息”，但它们在流程中的职责完全不同。

Spec 工作台应该围绕下面这个闭环组织：

```text
提出 feature
  ↓
形成并确认 spec
  ↓
补齐设计与实现计划
  ↓
生成可执行任务
  ↓
实现并验证
  ↓
对照 spec 收敛
  ↺ 如果发现缺口，回到任务或实现阶段
```

页面的第一优先级应该始终是：

1. 当前 feature 是什么；
2. 当前处于哪个工作阶段；
3. 当前阶段要解决什么问题；
4. 当前阶段读取了哪些产物；
5. 当前阶段生成或修改了哪些产物；
6. 用户下一步能做什么。

## 2. 事实来源与适用范围

### 2.1 Skill 是阶段行为的事实来源

每个阶段必须读取并遵循对应的 `SKILL.md`。skill 不只是按钮名称，它同时定义了：

- 阶段目标；
- 前置条件；
- 读取的输入；
- 写入或修改的产物；
- 是否允许提问；
- 是否只读；
- 完成后的移交条件；
- 失败或需要回退时的处理方式。

因此 UI 不应该重新发明一套与 skill 不一致的状态含义。

### 2.2 工作流编排是执行顺序的事实来源

`lib/workflow-source.txt` 当前定义的实际顺序为：

```text
specify
  → review-spec
  → worktrees
  → clarify
  → plan
  → review-plan
  → checklist
  → tasks
  → analyze
  → taskstoissues（可选）
  → implement
  → converge
  → discussion-summary（仅 discussion 配置开启时，作为 converge 的收尾动作）
```

其中 `discussion-summary` 不是独立 manifest phase，而是在 `converge` 阶段结束后生成的附加产物。

### 2.3 产物是用户可理解的主线

阶段状态应当围绕产物展示，而不是只展示 agent 事件：

```text
feature 描述
  ↓
spec.md
  ↓
research.md / data-model.md / contracts/ / quickstart.md / plan.md
  ↓
checklists/* / tasks.md
  ↓
代码变更与验证结果
  ↓
收敛结果 / discussion-summary.md
```

agent message、workflow log 和 token 信息属于辅助证据，不能成为主导航。

## 3. 标准流程模型

### 3.0 启动前：建立 Feature Context

这一步是工作台的准备态，不属于 Speckit skill phase，但必须在 UI 中明确展示。

**用户需要提供**：

- feature 描述；
- 目标项目；
- 可选技术栈偏好；
- 是否使用 worktree；
- 是否开启澄清、checklist、analyze、taskstoissues；
- 是否启用 review gate；
- 可选 Team、模型和纪要配置。

**系统需要检查**：

- 项目路径是否可用；
- `.specify/` 骨架是否存在；
- `.specify/templates/` 是否可读取；
- `.specify/feature.json` 当前指向哪个 feature；
- 是否存在同项目活动 run；
- 当前 workflow 是否允许执行、是否需要审批。

**工作台状态**：

```text
未开始 → 配置中 → 可启动
                 ↘ 不可启动：显示具体缺失条件
```

此阶段的主要按钮应只有「开始生成 Spec」，而不是让用户先面对完整 JSON 参数。

### 3.1 Specify：从 feature 生成初始 spec

对应 skill：`speckit-specify`

**目标**：把自然语言 feature 转换为结构化的 `spec.md`。

**输入**：

- feature 描述；
- 可选项目宪法 `.specify/memory/constitution.md`；
- 可选扩展 hook。

**主要动作**：

1. 生成 2–4 个词的短名称；
2. 确定 feature 目录；
3. 创建 `spec.md`；
4. 写入 `.specify/feature.json`；
5. 填写用户场景、功能需求、成功标准、实体和假设；
6. 生成内置需求质量清单 `checklists/requirements.md`；
7. 对 spec 做质量校验。

**产物**：

- `specs/<feature>/spec.md`；
- `.specify/feature.json`；
- `specs/<feature>/checklists/requirements.md`。

**完成条件**：

- spec 文件已创建；
- 用户场景可识别；
- 功能需求可测试；
- 成功标准可验证；
- 质量清单完成，或明确列出未通过项；
- 最多保留 3 个关键 `[NEEDS CLARIFICATION]` 标记。

**UI 应该展示**：

- `spec.md` 作为当前主产物；
- 需求质量清单进度；
- 需求数量、用户故事数量、成功标准数量；
- 尚未解决的 clarification 数量；
- 「查看 Spec」「继续澄清」「重新生成」三个明确动作。

### 3.2 Review Spec：确认需求表达可以进入设计

对应编排 phase：`review-spec`

**目标**：只审阅 spec 的完整性、清晰度和一致性，不审阅实现方案。

**输入**：`spec.md`、feature 描述。

**输出**：

- review decision：通过或驳回；
- reviewer feedback；
- Team 模式下的多成员投票和最终门禁结论。

**UI 语义**：

- 这是“需求门禁”，不是普通日志；
- 通过后进入环境隔离；
- 驳回后应把用户带回 `spec.md`，而不是继续推进后续 phase；
- 驳回原因要挂在对应的 spec 章节或问题列表上。

### 3.3 Worktrees：确定实现隔离边界

对应 skill：`speckit-worktrees-create`

**目标**：为后续设计和实现建立隔离工作目录。

**前置关系**：当前编排在 `review-spec` 之后执行。spec 可能已经在主 checkout 中生成，因此 worktree 中找不到产物时，必须明确提示产物来源。

**可能结果**：

- `completed`：创建或复用 worktree；
- `skipped`：用户关闭 worktree，或当前分支已在主 checkout 中无法再次 checkout；
- `failed`：git 或路径操作失败。

**UI 应该展示**：

- 主项目路径；
- worktree 路径；
- 当前阶段之后的实际工作目录；
- spec 产物位于主 checkout 还是 worktree；
- `skipped` 不应显示为失败，而应显示为“在当前项目目录继续”。

### 3.4 Clarify：补齐 spec 中的关键假设

对应 skill：`speckit-clarify`

**目标**：在进入 plan 前解决会影响范围、体验或安全的歧义。

**重要事实**：skill 原本支持向用户提问，但当前工作流被明确配置为非交互：agent 自己提出问题、选择合理假设，并把结论写回 `spec.md`。

**输入**：`spec.md`、项目上下文。

**输出**：

- 更新后的 `spec.md`；
- 已解决的假设和决策；
- 仍未解决的问题（如果存在）。

**UI 应该展示**：

- “本阶段正在补充假设”，而不是“等待用户回答”；
- 修改了哪些 spec 章节；
- 新增了哪些假设；
- 是否还有高风险未决问题；
- 用户可以展开查看前后差异。

### 3.5 Plan：把需求转成技术设计

对应 skill：`speckit-plan`

**目标**：基于已澄清的 spec 形成可执行的实现设计。

**输入**：

- `spec.md`；
- 已解决的 clarification；
- 技术栈偏好；
- 项目现状和 constitution。

**阶段内部顺序**：

```text
Phase 0：研究并解决 NEEDS CLARIFICATION
  ↓
research.md
  ↓
Phase 1：设计与契约
  ├─ data-model.md
  ├─ contracts/*（如果存在外部接口）
  ├─ quickstart.md
  └─ plan.md
```

**完成条件**：

- `research.md` 中关键问题已解决；
- plan 明确技术栈、依赖、结构和关键决策；
- 数据模型、契约和验证入口已定义；
- 设计仍与 `spec.md` 的用户故事和验收场景一致。

**UI 应该展示**：

- “需求 → 设计”的关系；
- 当前正在生成的设计产物；
- 研究决策和待确认项；
- plan 中引用的 spec 用户故事；
- 「查看差异」「查看设计产物」「进入设计评审」。

### 3.6 Review Plan：确认设计可以拆任务

对应编排 phase：`review-plan`

**目标**：审阅 plan 的技术完整性、与 spec 的一致性，以及是否存在会阻塞任务生成的未知项。

**输入**：`spec.md`、`plan.md` 及 plan 相关设计产物。

**输出**：单人或 Team 评审结论。

**UI 语义**：

- 这是“设计门禁”，和 `review-spec` 分开显示；
- 通过后才能进入需求质量 checklist 和任务拆解；
- 驳回时优先定位到 plan 决策，而不是只显示一段总反馈。

### 3.7 Checklist：对需求质量做专项检查

对应 skill：`speckit-checklist`

**目标**：生成 reviewer-owned 的需求质量 checklist。它检查的是“需求是否写得好”，不是代码是否实现。

**必须在 UI 中区分两类清单**：

1. `specify` / `clarify` 维护的内置 `checklists/requirements.md`；
2. `speckit-checklist` 生成的自定义清单，例如 UX、安全、测试、部署等。

**输入**：feature、`spec.md`、`plan.md`、`tasks.md`（如果已有）。

**输出**：`checklists/<type>.md`，新增项默认保持未勾选。

**UI 应该展示**：

- 清单主题；
- 清单项总数和未完成数；
- 清单负责人是 reviewer，不是 implement agent；
- “需求质量问题”和“实现失败”使用不同颜色和状态。

### 3.8 Tasks：生成依赖有序的执行任务

对应 skill：`speckit-tasks`

**目标**：把 spec 用户故事和 plan 设计转成可直接执行的 `tasks.md`。

**任务组织规则**：

```text
Phase 1：Setup
Phase 2：Foundational
Phase 3+：按 P1 / P2 / P3 用户故事分组
Final Phase：Polish & Cross-Cutting Concerns
```

每个任务必须有：

- checkbox；
- 唯一任务 ID，如 `T001`；
- 用户故事标签（用户故事 phase）；
- 明确动作；
- 目标文件路径；
- 必要时的依赖关系。

**UI 应该展示**：

- 用户故事 → 任务组 → 任务的三层结构；
- 可并行任务和阻塞任务；
- 任务总数、已完成数、阻塞数；
- 每个任务关联的 spec 场景和 plan 决策；
- 进入实现前的“任务可执行性”确认。

### 3.9 Analyze：跨产物一致性分析

对应 skill：`speckit-analyze`

**目标**：在实现前只读检查 `spec.md`、`plan.md`、`tasks.md` 之间的重复、矛盾、歧义、遗漏和覆盖缺口。

**严格约束**：该阶段只读，不修改任何文件。

**输入**：

- `spec.md` 的需求、成功标准、用户故事；
- `plan.md` 的技术决策、阶段和文件范围；
- `tasks.md` 的任务、phase 和路径；
- constitution（如果存在）。

**输出**：结构化分析报告，包含：

- finding ID；
- gap type：`missing`、`partial`、`contradicts`、`unrequested`；
- 严重级别；
- 来源引用；
- 证据；
- 剩余工作。

**UI 应该展示**：

- 把问题挂到具体产物和章节；
- 区分“阻塞实现”和“建议优化”；
- 不把 analyze 误标为成功的实现验证；
- 明确提示：阻塞问题会被带入 implement 和 converge。

### 3.10 Taskstoissues：可选的外部协作出口

对应 skill：`speckit-taskstoissues`

**目标**：把 `tasks.md` 中的任务转换成 GitHub issues。

**前置条件**：

- 项目 remote 必须是 GitHub URL；
- 需要 GitHub issue 工具；
- 必须先按任务 ID 去重；
- 不得向与 remote 不匹配的仓库创建 issue。

**失败策略**：当前工作流将此阶段设为非 hard failure。创建失败时需要标记为失败并给出原因，但不能阻止本地 implement 继续。

**UI 应该展示**：

- 这是外部同步，不是本地开发主线；
- “已创建 / 已跳过 / 失败”数量；
- 失败不会阻断 implement；
- 每个 issue 可回链到任务 ID。

### 3.11 Implement：按 tasks.md 执行实现

对应 skill：`speckit-implement`

**目标**：严格按 `tasks.md` 的依赖顺序实现功能，并在每个阶段完成验证。

**实现内部阶段**：

```text
Setup
  ↓
Tests
  ↓
Core
  ↓
Integration
  ↓
Polish
```

skill 强调：

- 先读取 spec、plan、tasks 和相关 checklist；
- 每次只处理当前任务 phase；
- 完成一个 phase 后进行验证；
- 不应跳过失败的验证 checkpoint；
- 任务勾选状态和实现报告必须反映真实结果。

**Solo 模式**：一个实现 agent 按任务顺序执行。

**Team 模式**：当前 capsule 的真实流程是：

```text
implement-lead：读取 tasks.md 并分配 task IDs
  ↓
成员按角色并行实现各自任务
  ↓
成员报告：status / taskIds / changedFiles / conflicts
  ↓
implement-merge：处理冲突、补齐遗漏、汇总结果
```

**UI 应该展示**：

- 当前任务，而不是只显示当前 agent；
- 任务所属用户故事；
- 当前实现 phase；
- changed files；
- 验证 checkpoint；
- Team 模式下的分工、成员状态和冲突；
- 分析问题和 checklist 问题如何被处理。

### 3.12 Converge：对照意图检查是否真正完成

对应 skill：`speckit-converge`

**目标**：检查当前代码是否满足 spec、plan 和 tasks，并把剩余工作追加到 `tasks.md`。

**严格约束**：

- 不进行 git branch comparison；
- 不依赖 git history；
- 只评估当前代码相对于 feature 产物的完成度；
- 不删除代码；
- 如果没有缺口，不向 `tasks.md` 写空的 Convergence phase。

**结果分支**：

```text
converged
  → 完成

tasks_appended
  → tasks.md 新增 Convergence phase
  → 回到 implement
  → 再次 converge
```

**UI 应该展示**：

- 已检查的需求、验收标准、plan 决策和任务数量；
- finding 的 gap type 和 severity；
- 新追加的任务；
- “回到实现”而不是把整个 workflow 标记为失败；
- 只有真正 converged 才显示完成。

### 3.13 Discussion Summary：形成可回看的纪要

仅当启用了 `discussion` 配置时生成。

**产物**：`<FEATURE_DIR>/discussion-summary.md`

**standard** 内容：

- 发起信息；
- 讨论内容与决策；
- 团队配置；
- 执行结果；
- 产物清单；
- 后续建议。

**minimal** 内容：

- 发起信息；
- 执行结果；
- 产物链接。

它应当被 UI 作为“本次 feature 的总结产物”展示，而不是一个普通日志事件。

## 4. UI 信息架构建议

### 4.1 页面级结构

```text
┌──────────────────────────────────────────────────────────────┐
│ Feature Context                                               │
│ 标题 · 项目 · 分支/worktree · 总状态 · 当前下一步              │
├───────────────┬──────────────────────────────────────────────┤
│ Journey Rail  │ 当前阶段工作区                               │
│               │                                              │
│ 需求           │ 阶段目标                                     │
│  1 Spec        │ 输入产物 → 当前决策 → 输出产物               │
│  2 Review      │                                              │
│ 设计           │ 主产物预览 / diff / checklist / feedback       │
│  3 Clarify     │                                              │
│  4 Plan        │                                              │
│ 拆解           │                                              │
│  5 Checklist   │                                              │
│  6 Tasks       │                                              │
│  7 Analyze     │                                              │
│ 实现           │                                              │
│  8 Implement   │                                              │
│ 收敛           │                                              │
│  9 Converge    │                                              │
│               │                                              │
│               │ [下一步动作] [查看产物] [查看证据]              │
├───────────────┴──────────────────────────────────────────────┤
│ Artifact Dock：spec.md · plan.md · tasks.md · reports · history │
└──────────────────────────────────────────────────────────────┘
```

### 4.2 Journey Rail 不再平铺所有事件

Rail 展示“用户旅程”，而不是引擎内部的每一个事件：

| 用户阶段 | 内部 phase | 主产物 | 用户关心的问题 |
|---|---|---|---|
| 需求 | specify / review-spec | `spec.md` | 需求是否说清楚、是否通过需求门禁 |
| 环境 | worktrees | worktree 路径 | 后续在哪里安全执行 |
| 澄清 | clarify | 更新后的 `spec.md` | 假设是否明确 |
| 设计 | plan / review-plan | `plan.md` 及设计产物 | 怎么实现、是否可以拆任务 |
| 质量 | checklist / analyze | checklist、分析报告 | 需求和产物之间是否有缺口 |
| 拆解 | tasks | `tasks.md` | 是否能直接执行 |
| 实现 | implement | 代码、测试、changed files | 当前完成了哪些任务 |
| 收敛 | converge | findings、追加任务或完成结论 | 是否真的完成 |
| 总结 | discussion-summary | `discussion-summary.md` | 本次讨论留下了什么结论 |

### 4.3 每个阶段统一使用“阶段卡”

阶段卡统一包含：

```text
阶段名称
阶段目标
状态：待开始 / 进行中 / 等待审阅 / 已完成 / 已跳过 / 被阻塞 / 失败

输入产物
  spec.md · plan.md · tasks.md

本阶段决策
  关键假设、review feedback、analyze findings

输出产物
  新文件、被修改文件、changed files

下一步
  继续 / 查看问题 / 返回修改 / 重试 / 跳过
```

这样用户无需阅读 event stream，也能理解流程是否向前推进。

### 4.4 主工作区采用“主产物 + 证据”布局

建议每个阶段的主区域拆成两层：

- 主区域：当前主产物、diff 或任务列表；
- 证据抽屉：agent message、workflow log、review vote、执行耗时、token、原始事件。

默认打开主产物，证据默认收起。只有发生失败、驳回或冲突时，证据抽屉自动展开。

### 4.5 下一步动作必须唯一且明确

每个状态只给一个主行动：

| 状态 | 主行动 |
|---|---|
| 配置完成 | 开始生成 Spec |
| spec 已生成 | 查看并进入 Review |
| review 驳回 | 修改 Spec |
| 等待澄清 | 查看假设 |
| plan 已完成 | 进入设计评审 |
| tasks 已完成 | 开始实现 |
| analyze 有阻塞问题 | 查看并修正产物 |
| implement 进行中 | 查看当前任务 |
| converge 有剩余任务 | 返回实现 |
| converge 通过 | 查看完成总结 |

不要在同一层级同时突出“启动、重跑、继续、保存胶囊、编辑 skill、查看 JSON、删除 run”等多个动作。

## 5. 状态模型

### 5.1 阶段状态

UI 建议将引擎状态映射为更符合工作台语义的状态：

```text
pending       待开始
running       进行中
review        等待审阅
completed     已完成
skipped       已跳过
blocked       被阻塞
failed        执行失败
looping       需要回到前一阶段
```

其中 `review`、`blocked`、`looping` 是 UI 投影状态，可以从 phase result、gate、analyze、converge 结果推导，不要求引擎新增状态。

### 5.2 工作台级状态

```text
draft          只有 feature，还没有 run
preflight      正在检查项目和配置
running        正在推进阶段
needs-review   当前产物等待 review gate
needs-action   用户需要修正产物或选择路径
converging     正在做最终一致性检查
completed      已收敛
failed         无法继续，需要查看原因
```

### 5.3 收敛循环

`converge` 不应只有成功/失败二元状态，而应表现成闭环：

```text
实现完成
  ↓
Converge 检查
  ├─ 无缺口 → 完成
  └─ 有缺口 → 追加 Convergence tasks → 返回 Implement
```

## 6. 配置流程建议

### 6.1 首屏只保留必要配置

首屏只需要：

- Feature 描述；
- 项目；
- 技术栈偏好；
- worktree 开关；
- 开始按钮。

### 6.2 高级配置分层

建议把高级配置拆成三个抽屉，而不是一个六组长弹窗：

1. 流程开关：clarify、checklist、analyze、taskstoissues、review gate；
2. 执行与 Team：provider、model、并发、成员和任务归属；
3. 输出与模板：discussion summary、模板保存/载入。

高级配置应显示“将影响哪些阶段”，例如：

```text
关闭 clarify → Plan 前不再自动补充假设
关闭 analyze → Implement 前不做跨产物一致性检查
关闭 worktrees → 后续直接在当前项目目录执行
开启 taskstoissues → Analyze 后增加 GitHub 同步出口
```

### 6.3 JSON 只作为开发者入口

JSON 参数可以保留，但应放在「高级 / 原始参数」折叠面板中。默认入口应使用针对 Speckit 的表单和阶段配置，不让用户从 JSON 开始理解整个产品。

## 7. 当前实现与目标流程的主要偏差

| 当前实现 | 问题 | 目标调整 |
|---|---|---|
| `WorkflowStudioPage` 默认展示通用 catalog | 用户先选择 workflow，无法感知 feature 主线 | Spec 工作台默认进入当前 feature context |
| 12 个 phase 平铺 rail | 内部编排顺序直接暴露，缺少用户阶段 | 按需求、环境、设计、质量、实现、收敛分组 |
| 沟通/执行/审计/结果·历史四个并列区 | 主产物和证据混在一起 | 主产物为主，事件/审计作为证据抽屉 |
| 详情区同时包含 schema、JSON、skills、capsule | 配置和运行信息混杂 | 配置、产物、运行证据分层 |
| `review-spec` / `review-plan` / `checklist` / `analyze` 都像审计卡片 | 阶段职责不清 | 需求门禁、设计门禁、需求质量、跨产物分析分别表达 |
| `converge` 只有结果展示 | 看不出为何回到 implement | 展示 findings → 追加任务 → 实现循环 |
| `taskstoissues` 与本地主线并列 | 容易误认为必须完成 | 作为可选外部同步出口，失败不阻断本地实现 |
| `design/ui-preview.html` 仍是旧布局 mock | 设计依据与真实 UI 分叉 | 用目标工作台流程重新制作 preview |
| `SpeckitPage` 与 `WorkflowStudioPage` 并存 | 两套状态与 UI 维护成本 | 统一为 Spec 工作台，清理旧页面实现 |

## 8. 第一轮 UI 优化范围

建议先实现一轮不改引擎协议的 UI 重构：

### P0：重做信息架构

- 将页面标题从泛化的 `Workflow Studio` 调整为 feature 工作台；
- 建立 Feature Context；
- 将 phase rail 改为用户阶段分组；
- 增加“当前阶段目标”和“下一步动作”；
- 将 artifact dock 设为主导航。

### P1：重排主工作区

- 默认展示当前主产物；
- 沟通、执行、审计改为证据 tabs 或抽屉；
- 结果/历史独立为历史入口；
- `converge` 的回环状态可视化；
- Team implement 展示成员 → task → changed files 的关系。

### P2：简化配置

- 首屏只保留 feature、项目、技术栈、worktree、启动；
- 高级配置按三组抽屉组织；
- JSON 参数放到开发者模式；
- 讨论弹窗改为渐进式配置，而不是一次展示六组表单。

### P3：体验和可访问性

- 弹窗支持 Escape 关闭；
- 打开弹窗后管理焦点和背景滚动；
- 所有输入有可读 label；
- review、blocked、failed、skipped 使用独立语义和颜色；
- 小宽度窗口下改为纵向阶段布局；
- 同步更新 `design/ui-preview.html`。

## 9. 后续实现验收标准

第一轮 UI 重构完成后，应满足：

- 用户打开页面后，5 秒内能说出当前 feature、当前阶段和下一步动作；
- 不展开日志，也能理解当前主产物和阶段结果；
- 用户能从 `spec.md` 进入 plan，再进入 tasks 和 implement，不需要理解 workflow engine；
- review-spec 和 review-plan 的职责与位置清晰可区分；
- checklist 和 analyze 不再被混为一种审计；
- taskstoissues 失败不会让本地实现看起来被阻断；
- converge 发现缺口时，页面能明确引导回到 implement；
- 任何阶段都能看到输入产物、输出产物和修改路径；
- Team 模式和 solo 模式共享同一条主流程，只在 implement 内部展示不同执行方式；
- 预览页与实际客户端布局、文案和状态模型一致。

## 10. 参考文件

- `skills/speckit-specify/SKILL.md`
- `skills/speckit-clarify/SKILL.md`
- `skills/speckit-plan/SKILL.md`
- `skills/speckit-checklist/SKILL.md`
- `skills/speckit-tasks/SKILL.md`
- `skills/speckit-analyze/SKILL.md`
- `skills/speckit-taskstoissues/SKILL.md`
- `skills/speckit-implement/SKILL.md`
- `skills/speckit-converge/SKILL.md`
- `skills/speckit-worktrees-create/SKILL.md`
- `lib/workflow-source.txt`
- `lib/manifest.js`
- `lib/client.js`


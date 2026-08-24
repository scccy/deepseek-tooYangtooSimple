// dsh-speckit-workflow v0.8 — stage graph, board columns and stage metadata.
//
// Single source of truth for the workbench's stage model (DESIGN-V0.8 §2/§4):
// nine stages, each an independent execution thread, each stopping at a
// human handoff point. Columns are only navigation/status grouping — the real
// execution unit is the stage thread.
//
// The worktree materialization (`speckit-worktrees-create`) is the after_specify
// post-step of the Specify stage (DESIGN-V0.8 §4.1/§4.2), not a separate user
// stage; the plugin's artifact-handoff logic binds artifactRoot/executionRoot
// after Specify completes.

export const STAGE_ORDER = [
  'specify',
  'clarify',
  'plan',
  'checklist',
  'tasks',
  'analyze',
  'taskstoissues',
  'implement',
  'converge'
]

/**
 * Stage definitions.
 * - skill: vendored skill id driving the stage thread.
 * - column: board column the stage belongs to.
 * - interactive: the thread pauses for user answers within the same thread
 *   (Clarify / Converge per DESIGN-V0.8 §4.4/§4.11).
 * - optional: may be skipped by config (checklist / analyze / taskstoissues).
 * - external: stage has real external side effects (GitHub issues).
 * - confirmNext: exact human-facing wording for the handoff action.
 */
export const STAGE_DEFS = {
  specify: {
    skill: 'speckit-specify',
    column: 'specify',
    interactive: false,
    optional: false,
    external: false,
    worktree: true,
    confirmNext: '确认进入 Clarify',
    title: 'Specify'
  },
  clarify: {
    skill: 'speckit-clarify',
    column: 'clarify',
    interactive: true,
    optional: false,
    external: false,
    confirmNext: '确认进入 Plan',
    title: 'Clarify'
  },
  plan: {
    skill: 'speckit-plan',
    column: 'clarify',
    interactive: false,
    optional: false,
    external: false,
    confirmNext: '确认进入 Checklist',
    title: 'Plan'
  },
  checklist: {
    skill: 'speckit-checklist',
    column: 'implement',
    interactive: false,
    optional: true,
    external: false,
    confirmNext: '确认进入 Tasks',
    title: 'Checklist'
  },
  tasks: {
    skill: 'speckit-tasks',
    column: 'implement',
    interactive: false,
    optional: false,
    external: false,
    confirmNext: '确认进入 Analyze',
    title: 'Tasks'
  },
  analyze: {
    skill: 'speckit-analyze',
    column: 'implement',
    interactive: false,
    optional: true,
    external: false,
    confirmNext: '确认进入 Taskstoissues',
    title: 'Analyze'
  },
  taskstoissues: {
    skill: 'speckit-taskstoissues',
    column: 'implement',
    interactive: false,
    optional: true,
    external: true,
    confirmNext: '确认进入 Implement',
    title: 'Taskstoissues'
  },
  implement: {
    skill: 'speckit-implement',
    column: 'implement',
    interactive: false,
    optional: false,
    external: false,
    confirmNext: '确认进入 Converge',
    title: 'Implement'
  },
  converge: {
    skill: 'speckit-converge',
    column: 'converge',
    interactive: true,
    optional: false,
    external: false,
    confirmNext: '确认收敛并结束',
    title: 'Converge'
  }
}

export const COLUMNS = [
  { id: 'specify', name: 'Specify', hint: '需求已经生成，等待确认', stages: ['specify'] },
  { id: 'clarify', name: 'Clarify', hint: '需求已经澄清，设计文件等待确认', stages: ['clarify', 'plan'] },
  {
    id: 'implement',
    name: 'Implement',
    hint: '任务和代码逐步生成',
    stages: ['checklist', 'tasks', 'analyze', 'taskstoissues', 'implement']
  },
  { id: 'converge', name: 'Converge', hint: '收敛结论，或回到实现循环', stages: ['converge'] }
]

export const COLUMN_INDEX = new Map(COLUMNS.map((column, i) => [column.id, i]))
export const STAGE_COLUMN = new Map()
for (const column of COLUMNS) {
  for (const stage of column.stages) STAGE_COLUMN.set(stage, column.id)
}

/** Stages that all run on the execution root after the worktree handoff. */
export const DOWNSTREAM_STAGES = ['clarify', 'plan', 'checklist', 'tasks', 'analyze', 'taskstoissues', 'implement', 'converge']

/** 大阶段（看板列）回退：返回当前阶段所属列的上一列起始小阶段（如 implement → clarify）。 */
export function previousPhaseStart(stageId) {
  const columnId = STAGE_COLUMN.get(stageId)
  const idx = COLUMNS.findIndex((c) => c.id === columnId)
  if (idx <= 0) return null
  const prev = COLUMNS[idx - 1]
  return prev && prev.stages.length ? prev.stages[0] : null
}

export function phaseOf(stageId) {
  return STAGE_COLUMN.get(stageId) || null
}

export function phaseName(stageId) {
  const columnId = STAGE_COLUMN.get(stageId)
  const col = COLUMNS.find((c) => c.id === columnId)
  return col ? col.name : stageId
}

/**
 * Stages invalidated when an upstream spec-affecting stage is modified or
 * rerun. If Clarify rewrites spec, Plan tasks analyze implement converge are
 * potentially stale (DESIGN-V0.8 §3.3).
 */
export const STALE_AFTER = {
  specify: ['clarify', 'plan', 'checklist', 'tasks', 'analyze', 'taskstoissues', 'implement', 'converge'],
  clarify: ['plan', 'checklist', 'tasks', 'analyze', 'taskstoissues', 'implement', 'converge'],
  plan: ['checklist', 'tasks', 'analyze', 'taskstoissues', 'implement', 'converge'],
  checklist: ['tasks', 'analyze', 'taskstoissues', 'implement', 'converge'],
  tasks: ['analyze', 'taskstoissues', 'implement', 'converge'],
  analyze: ['taskstoissues', 'implement', 'converge'],
  taskstoissues: ['implement', 'converge'],
  implement: ['converge'],
  converge: []
}

/** Next stage in the linear graph (undefined for converge). */
export function nextStage(stageId) {
  const index = STAGE_ORDER.indexOf(stageId)
  if (index < 0 || index + 1 >= STAGE_ORDER.length) return undefined
  return STAGE_ORDER[index + 1]
}

/**
 * Default flow config for a new instance. Optional stages are enabled by
 * default; taskstoissues is off (external GitHub side effect).
 * `parentSessionId` is preserved so interactive stage-thread followups can
 * resolve the originating session after restarts.
 * @param overrides - per-instance {useWorktrees, runChecklist, runAnalyze, runTaskstoissues, model, provider, reasoningEffort, parentSessionId}
 */
export function defaultFlowConfig(overrides = {}) {
  return {
    useWorktrees: overrides.useWorktrees !== false,
    runChecklist: overrides.runChecklist !== false,
    runAnalyze: overrides.runAnalyze !== false,
    runTaskstoissues: overrides.runTaskstoissues === true,
    model: typeof overrides.model === 'string' && overrides.model.length > 0 ? overrides.model : null,
    provider: typeof overrides.provider === 'string' && overrides.provider.length > 0 ? overrides.provider : null,
    reasoningEffort: typeof overrides.reasoningEffort === 'string' && overrides.reasoningEffort.length > 0 ? overrides.reasoningEffort : null,
    ...(typeof overrides.parentSessionId === 'string' && overrides.parentSessionId.length > 0 ? { parentSessionId: overrides.parentSessionId } : {})
  }
}

/** Human-facing label for a stage status (client renders badges). */
export const STATUS_META = {
  'not-started': ['未开始', 'pending'],
  running: ['进行中', 'running'],
  'awaiting-user': ['等待你回答', 'review'],
  'awaiting-confirmation': ['等待确认', 'review'],
  paused: ['已暂停', 'review'],
  completed: ['已完成', 'completed'],
  skipped: ['已跳过', 'pending'],
  cancelled: ['已取消', 'blocked'],
  failed: ['失败', 'failed'],
  stale: ['已过期', 'looping']
}

export function statusMeta(status) {
  return STATUS_META[status] || ['未知', 'pending']
}

/**
 * Allowed human operations per stage status (DESIGN-V0.8 §6). This is host
 * policy; the client only renders what the host returns.
 * @param stageRow - stage record with status/interactive/optional.
 */
export function permittedActions(stageRow, isCurrent) {
  const actions = []
  const status = stageRow && stageRow.status
  const interactive = stageRow && STAGE_DEFS[stageRow.stage_id]?.interactive === true
  const optional = stageRow && STAGE_DEFS[stageRow.stage_id]?.optional === true
  const hasThread = !!(stageRow && stageRow.thread_id)
  switch (status) {
    case 'running':
      actions.push({ id: 'thread', label: '进入线程' })
      actions.push({ id: 'pause', label: '暂停' })
      actions.push({ id: 'cancel-current', label: '停止阶段', danger: true })
      break
    case 'paused':
      if (hasThread) actions.push({ id: 'thread', label: '继续对话' })
      actions.push({ id: 'resume', label: '继续执行' })
      actions.push({ id: 'cancel-current', label: '停止阶段', danger: true })
      break
    case 'awaiting-user':
      actions.push({ id: 'thread', label: '打开线程' })
      if (interactive) actions.push({ id: 'answer', label: '发送回答' })
      actions.push({ id: 'end-interactive', label: '结束交互' })
      actions.push({ id: 'cancel-current', label: '取消', danger: true })
      break
    case 'awaiting-confirmation':
      if (hasThread) actions.push({ id: 'thread', label: '进入线程' })
      actions.push({ id: 'artifacts', label: '查看产物' })
      if (isCurrent && stageRow && STAGE_DEFS[stageRow.stage_id]) actions.push({ id: 'confirm', label: STAGE_DEFS[stageRow.stage_id].confirmNext })
      if (optional) actions.push({ id: 'skip', label: '跳过本阶段' })
      actions.push({ id: 'redo', label: '要求重做', danger: false })
      actions.push({ id: 'cancel-current', label: '取消', danger: true })
      break
    case 'completed':
      if (hasThread) actions.push({ id: 'thread', label: '继续对话' })
      actions.push({ id: 'artifacts', label: '查看结果' })
      actions.push({ id: 'redo', label: '重跑阶段' })
      if (stageRow && stageRow.attempt > 1) actions.push({ id: 'history', label: '查看历史' })
      break
    case 'skipped':
      actions.push({ id: 'redo', label: '重新执行' })
      break
    case 'failed':
      if (hasThread) actions.push({ id: 'thread', label: '继续对话' })
      actions.push({ id: 'error', label: '查看错误' })
      actions.push({ id: 'redo', label: '重试' })
      actions.push({ id: 'rollback', label: '返回上阶段' })
      break
    case 'stale':
      if (hasThread) actions.push({ id: 'thread', label: '查看线程' })
      actions.push({ id: 'stale-reason', label: '查看过期原因' })
      actions.push({ id: 'redo', label: '从该阶段重新开始' })
      break
    case 'cancelled':
      actions.push({ id: 'redo', label: '重新执行' })
      break
    default:
      break
  }
  return actions
}

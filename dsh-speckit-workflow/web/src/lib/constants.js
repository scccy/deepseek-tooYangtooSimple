// Stage graph / board columns / status metadata — mirrors lib/stages.js and
// lib/client.js of the dsh-speckit-workflow plugin (single source of truth).

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

export const COLUMNS = [
  { id: 'specify', name: 'Specify', hint: '需求已经生成，等待确认', icon: 'file', stages: ['specify'] },
  { id: 'clarify', name: 'Clarify', hint: '需求已经澄清，设计文件等待确认', icon: 'message', stages: ['clarify', 'plan'] },
  {
    id: 'implement',
    name: 'Implement',
    hint: '任务和代码逐步生成',
    icon: 'hammer',
    stages: ['checklist', 'tasks', 'analyze', 'taskstoissues', 'implement']
  },
  { id: 'converge', name: 'Converge', hint: '收敛结论，或回到实现循环', icon: 'merge', stages: ['converge'] }
]

export const STAGE_COLUMN = new Map()
for (const column of COLUMNS) for (const stage of column.stages) STAGE_COLUMN.set(stage, column.id)

// 大阶段（看板列）回退相关：返回当前阶段所属列的上一列起始小阶段。
export function phaseOf(stageId) {
  return STAGE_COLUMN.get(stageId) || null
}
export function phaseLabel(stageId) {
  const id = phaseOf(stageId)
  const col = COLUMNS.find((c) => c.id === id)
  return col ? col.name : stageId
}
export function previousPhaseStart(stageId) {
  const id = phaseOf(stageId)
  const idx = COLUMNS.findIndex((c) => c.id === id)
  if (idx <= 0) return null
  const prev = COLUMNS[idx - 1]
  return prev && prev.stages.length ? prev.stages[0] : null
}

export const STAGE_TITLES = {
  specify: 'Specify',
  clarify: 'Clarify',
  plan: 'Plan',
  checklist: 'Checklist',
  tasks: 'Tasks',
  analyze: 'Analyze',
  taskstoissues: '任务转 Issue',
  implement: 'Implement',
  converge: 'Converge'
}

export const CONFIRM_NEXT = {
  specify: '确认进入 Clarify',
  clarify: '确认进入 Plan',
  plan: '确认进入 Checklist',
  checklist: '确认进入 Tasks',
  tasks: '确认进入 Analyze',
  analyze: '确认进入 Taskstoissues',
  taskstoissues: '确认进入 Implement',
  implement: '确认进入 Converge',
  converge: '确认收敛并结束'
}

export const OPTIONAL_STAGES = new Set(['checklist', 'analyze', 'taskstoissues'])
export const INTERACTIVE_STAGES = new Set(['clarify', 'converge'])
export const EXTERNAL_STAGES = new Set(['taskstoissues'])

export const ST_META = {
  'not-started': ['未开始', 'pending'],
  creating: ['创建中', 'running'],
  running: ['进行中', 'running'],
  'awaiting-user': ['等待你回答', 'review'],
  'awaiting-confirmation': ['等待确认', 'review'],
  completed: ['已完成', 'completed'],
  skipped: ['已跳过', 'pending'],
  cancelled: ['已取消', 'blocked'],
  failed: ['失败', 'failed'],
  stale: ['已过期', 'looping']
}

export function statusMeta(status) {
  return ST_META[status] || ['未知', 'pending']
}

// Implement 阶段的执行方式：workflow / team 两个引擎都按任务数【自动并行】，
// 不需要用户指定规模（DSH 自带语义）。
export const EXEC_MODES = [
  { id: 'workflow', label: 'workflow', desc: 'workflow 引擎：按任务自动 fan-out 子代理，按批并行推进、逐批汇总' },
  { id: 'team', label: 'Team', desc: 'AgentTeams：按任务自动建队，成员并行认领执行后合并' }
]

export function execLabel(exec) {
  if (!exec || !exec.mode) return null
  return exec.mode === 'team' ? 'Team' : 'workflow'
}

// 确认当前阶段后，下一个要进入的【非跳过】阶段（按实例配置决定可选阶段是否启用）。
// 用于判断「确认后是否会直接进入 Implement」——如果会，就在确认弹窗里带上
// Implement 执行方式（workflow / Team）的选择。
export function nextStageWithConfig(stageId, config = {}) {
  const idx = STAGE_ORDER.indexOf(stageId)
  const enabledOptional = (s) => {
    if (!OPTIONAL_STAGES.has(s)) return true
    if (s === 'checklist') return config.runChecklist !== false
    if (s === 'analyze') return config.runAnalyze !== false
    if (s === 'taskstoissues') return config.runTaskstoissues !== false
    return true
  }
  for (let i = idx + 1; i < STAGE_ORDER.length; i++) {
    if (enabledOptional(STAGE_ORDER[i])) return STAGE_ORDER[i]
  }
  return null
}
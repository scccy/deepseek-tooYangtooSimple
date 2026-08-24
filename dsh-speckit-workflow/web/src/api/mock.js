// Mock host for the standalone web prototype.
//
// Replicates the dsh-speckit-workflow host RPC contract (`/api/dsh-speckit-workflow`):
//   install workspaces check models instances instance-create instance-get
//   instance-cancel exec-config stage-confirm stage-skip stage-answer stage-rerun
//   stage-rollback stage-cancel thread-view artifact-read events-since
//
// State machine mirrors lib/orchestrator.js (per-stage rows, workspace-first
// handoffs, optional-stage config, interactive clarify/converge). The module
// also simulates stage-thread progress with timers so the board "lives".
//
// Swapping to the real plugin = replace src/api/index.js dispatch with the
// actual `window.fetch(CHANNEL)` call and keep every shape here unchanged.

import { buildInstances, PROJECTS, CWD } from './seed.js'
import {
  STAGE_ORDER,
  STAGE_COLUMN,
  OPTIONAL_STAGES,
  INTERACTIVE_STAGES,
  CONFIRM_NEXT,
  EXEC_MODES
} from '../lib/constants.js'
import { newActionId } from '../lib/format.js'

const clone = (value) => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)))

const ACTIVE = new Set(['creating', 'running', 'awaiting-user', 'awaiting-confirmation'])
const TERMINAL = new Set(['completed', 'skipped', 'cancelled', 'failed', 'stale'])

// Implement 阶段执行方式（写入实例，决定进入 Implement 时用 workflow 还是 team 并行）
const DEFAULT_EXEC = { mode: 'workflow', size: 3 }
const EXEC_IDS = new Set(EXEC_MODES.map((m) => m.id))

const state = {
  instances: buildInstances().map((inst) => ({ ...inst, exec: { ...DEFAULT_EXEC, ...(inst.exec || {}) } })),
  projects: PROJECTS,
  cwd: CWD,
  _rowSeq: 1000,
  _nextRowId() { return this._rowSeq++ }
}

const byId = (instanceId) => state.instances.find((i) => i.instanceId === instanceId) || null

function pushEvent(inst, type, data = {}) {
  inst.events.push({ seq: (inst.events[inst.events.length - 1]?.seq || 0) + 1, type, time: Date.now(), data })
  inst.updatedAt = Date.now()
}

function pushDecision(inst, kind, targetStage, note = null, stageRow = null) {
  inst.decisions.push({ kind, targetStage, note, at: Date.now(), stage_row: stageRow })
}

function stageEnabled(inst, stageId) {
  const config = inst.config || {}
  if (stageId === 'checklist') return config.runChecklist !== false
  if (stageId === 'analyze') return config.runAnalyze !== false
  if (stageId === 'taskstoissues') return config.runTaskstoissues === true
  return true
}

function nextStageId(stageId) {
  const index = STAGE_ORDER.indexOf(stageId)
  return index < 0 || index + 1 >= STAGE_ORDER.length ? undefined : STAGE_ORDER[index + 1]
}

function createRow(inst, stageId, attempt = 1, status = 'creating') {
  const row = {
    id: state._nextRowId(),
    instanceId: inst.instanceId,
    stageId,
    attempt,
    status,
    title: stageId,
    summary: '',
    skillId: `speckit-${stageId}`,
    skillSha256: Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''),
    artifacts: [],
    state: null,
    error: null,
    staleReason: null,
    thread: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
  inst.stageRows.push(row)
  return row
}

// ---- stage-thread simulation -------------------------------------------------

const SIM_MS = 720 // delay between simulated thread turns
const CANNED_REPLIES = [
  '已记录，并写回 spec.md 的「假设」章节。还有需要补充的吗？',
  '明白，已加入功能需求 FR 列表并标记为 P1。',
  '好的，作为成功标准 SC 的补充项记录。确认无其他补充后即可结束交互。'
]
let cannedIdx = 0

const STAGE_PLAN = {
  specify: {
    msgs: [
      '读取 feature 描述，生成短名称并创建 feature 目录。',
      '填充用户场景、功能需求、成功标准，写入 spec.md。',
      '内置 requirements.md 校验：通过率达标，2 项标记待澄清。'
    ],
    artifacts: (inst) => [{ rel: `specs/${inst.featureDir}/spec.md`, stale: false }],
    summary: 'spec.md 已生成，等待人工确认'
  },
  clarify: {
    msgs: ['已拆解出若干功能需求，开始逐条澄清边界…'],
    question: '请确认这条需求的关键边界（例如生效范围、兼容策略，或某个 FR 的判定标准）？回答后可通过「结束交互」进入 Plan。',
    interactive: true,
    artifactSave: ['spec.md（已澄清）']
  },
  plan: {
    msgs: [
      'Phase 0：研究并解决 research.md 中的未知项…',
      '生成 data-model.md、contracts/、quickstart.md、plan.md',
      '自检：设计与 spec 的核心用户故事保持一致。'
    ],
    artifacts: (inst) => [{ rel: 'plan.md', stale: false }, { rel: 'quickstart.md', stale: false }],
    summary: 'plan.md 已生成，等待人工确认'
  },
  checklist: {
    msgs: ['生成 UX / 安全专项清单，新增项默认保持未勾选。'],
    artifacts: (inst) => [{ rel: 'checklists/DESIGN.md', stale: false }],
    summary: '需求质量清单已生成'
  },
  tasks: {
    msgs: ['按 P1/P2/P3 用户故事分组生成 tasks.md，标注依赖与可并行任务。'],
    artifacts: (inst) => [{ rel: 'tasks.md', stale: false }],
    summary: 'tasks.md 已生成'
  },
  analyze: {
    msgs: ['只读检查 spec × plan × tasks 的重复、矛盾、遗漏…'],
    artifacts: () => [],
    summary: '一致性检查完成，无阻塞'
  },
  taskstoissues: {
    msgs: ['将 tasks 转换为 GitHub issues（外部副作用）…'],
    artifacts: () => [],
    summary: '已创建 GitHub issues'
  },
  implement: {
    msgs: [
      '按 tasks.md 依赖顺序执行：Setup → Tests → Core → Integration → Polish',
      '核心实现完成，运行验证 checkpoint…'
    ],
    artifacts: (inst) => [{ rel: 'src/features/index.ts', stale: false }, { rel: 'tests/feature.test.ts', stale: false }],
    summary: '实现完成，等待人工确认'
  },
  converge: {
    msgs: [
      '对照 spec / plan / tasks 逐项检查当前代码（不做 git 对比）…',
      '输出 findings；有缺口则追加 Convergence 任务并退回 Implement 循环。'
    ],
    findings: (inst) => ([
      { severity: 'critical', kind: 'missing', title: `spec SC 中「${inst.feature}」的回源/兜底用例未在实现中发现对应代码` },
      { severity: 'major', kind: 'partial', title: '关键路径仅部分覆盖，边界分支待补测试' }
    ]),
    interactive: true
  }
}

function runStageSim(inst, row, { msgs = null } = {}) {
  const plan = STAGE_PLAN[row.stageId]
  if (!plan) { row.status = 'awaiting-confirmation'; return }
  row.status = 'running'
  row.updatedAt = Date.now()
  pushEvent(inst, 'stage-running', { stageId: row.stageId, attempt: row.attempt })

  const list = msgs || plan.msgs
  let index = 0
  const step = () => {
    if (row.status !== 'running') return
    if (index < list.length) {
      row.thread.push({ who: 'agent', at: Date.now(), text: list[index] })
      index += 1
      row.updatedAt = Date.now()
      setTimeout(step, SIM_MS)
      return
    }
    finalize(inst, row, plan)
  }
  setTimeout(step, index === 0 && row.thread.length ? SIM_MS : 200)
}

function finalize(inst, row, plan) {
  if (row.status !== 'running') return
  const now = Date.now()
  row.updatedAt = now
  if (plan.interactive) {
    row.status = 'awaiting-user'
    row.state = {
      status: 'asking',
      question: plan.question,
      assumptions: [],
      ...(plan.findings ? { status: 'findings', findings: plan.findings(inst), question: null } : {})
    }
    pushEvent(inst, 'stage-awaiting-user', { stageId: row.stageId, attempt: row.attempt, question: row.state.question || null, findings: row.state.findings || [] })
  } else {
    row.status = 'awaiting-confirmation'
    row.summary = plan.summary
    row.artifacts = plan.artifacts(inst)
    pushEvent(inst, 'stage-awaiting-confirmation', { stageId: row.stageId, attempt: row.attempt })
  }
}

// Flow control: resolve the current row, create the next stage (skipping
// optional stages that are configured off), and start its thread simulation.
function advanceFrom(inst, fromRow, { skip = false } = {}) {
  fromRow.status = skip ? 'skipped' : 'completed'
  fromRow.updatedAt = Date.now()
  pushEvent(inst, skip ? 'stage-skipped' : 'stage-confirmed', { stageId: fromRow.stageId, attempt: fromRow.attempt })

  if (fromRow.stageId === 'converge') {
    // 确认收敛并结束 → instance completed.
    inst.status = 'completed'
    inst.currentStage = 'converge'
    pushDecision(inst, 'converged', 'converge', '确认收敛并结束', fromRow.id)
    pushEvent(inst, 'instance-completed', {})
    return null
  }

  let stageId = nextStageId(fromRow.stageId)
  while (stageId && OPTIONAL_STAGES.has(stageId) && !stageEnabled(inst, stageId)) {
    const off = stageId
    const skippedRow = createRow(inst, off, 1, 'skipped')
    skippedRow.summary = '配置未启用'
    pushEvent(inst, 'stage-skipped', { stageId: off, attempt: 1, reason: '配置未启用' })
    stageId = nextStageId(off)
  }
  if (!stageId) return null

  inst.currentStage = stageId
  const next = createRow(inst, stageId, 1, 'creating')
  pushEvent(inst, 'stage-creating', { stageId, attempt: 1, stageRowId: next.id })
  runStageSim(inst, next)
  return next
}

// ---- projections (mirror orchestrator.board / detail) -----------------------

function boardActionsFor(card) {
  const actions = []
  if (card.currentStageStatus === 'running') actions.push('thread')
  if (card.currentStageStatus === 'awaiting-confirmation') {
    actions.push('thread')
    if (CONFIRM_NEXT[card.currentStage]) actions.push('confirm')
  }
  if (card.currentStageStatus === 'awaiting-user') actions.push('answer')
  return actions
}

function columnOf(inst) {
  const last = inst.stageRows[inst.stageRows.length - 1]
  return (last && STAGE_COLUMN.get(last.stageId)) || 'specify'
}

export function projectCard(inst) {
  const active = inst.stageRows
    .filter((row) => ACTIVE.has(row.status))
    .sort((a, b) => b.attempt - a.attempt)[0] || null
  const base = {
    instanceId: inst.instanceId,
    workspacePath: inst.workspacePath,
    feature: inst.feature,
    featureDir: inst.featureDir,
    branch: inst.branch,
    worktreePath: inst.worktreePath,
    mode: inst.mode,
    exec: { mode: inst.exec.mode, size: inst.exec.size },
    status: inst.status,
    currentStage: active ? active.stageId : inst.currentStage,
    currentStageStatus: active ? active.status : null,
    currentStageRowId: active ? active.id : null,
    column: active ? STAGE_COLUMN.get(active.stageId) : columnOf(inst),
    createdAt: inst.createdAt,
    updatedAt: inst.updatedAt
  }
  return { ...base, actions: boardActionsFor(base) }
}

function permittedActions(row, isCurrent) {
  const actions = []
  const interactive = INTERACTIVE_STAGES.has(row.stageId)
  const optional = OPTIONAL_STAGES.has(row.stageId)
  const hasThread = Array.isArray(row.thread)
  switch (row.status) {
    case 'running':
      actions.push({ id: 'thread', label: '进入线程' })
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
      if (isCurrent && CONFIRM_NEXT[row.stageId]) actions.push({ id: 'confirm', label: CONFIRM_NEXT[row.stageId] })
      if (optional) actions.push({ id: 'skip', label: '跳过本阶段' })
      actions.push({ id: 'redo', label: '要求重做' })
      actions.push({ id: 'cancel-current', label: '取消', danger: true })
      break
    case 'completed':
      if (hasThread) actions.push({ id: 'thread', label: '查看线程' })
      actions.push({ id: 'artifacts', label: '查看结果' })
      actions.push({ id: 'redo', label: '重跑阶段' })
      if (row.attempt > 1) actions.push({ id: 'history', label: '查看历史' })
      break
    case 'skipped':
      actions.push({ id: 'redo', label: '重新执行' })
      break
    case 'failed':
      if (hasThread) actions.push({ id: 'thread', label: '查看线程' })
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

export function detailOf(inst) {
  const active = inst.stageRows
    .filter((row) => ACTIVE.has(row.status))
    .sort((a, b) => b.attempt - a.attempt)[0] || null
  const stages = inst.stageRows.map((row) => ({
    ...row,
    stageId: row.stageId,
    status: row.status,
    artifacts: row.artifacts || [],
    actions: permittedActions(row, active ? row.id === active.id : row.stageId === inst.currentStage)
  }))
  return {
    instance: {
      instanceId: inst.instanceId,
      feature: inst.feature,
      workspacePath: inst.workspacePath,
      branch: inst.branch,
      worktreePath: inst.worktreePath,
      mode: inst.mode,
      exec: inst.exec ? { mode: inst.exec.mode, size: inst.exec.size } : null,
      status: inst.status,
      currentStage: inst.currentStage
    },
    stages,
    thread: active
      ? {
          stageId: active.stageId,
          stageRowId: active.id,
          attempt: active.attempt,
          messages: active.thread || []
        }
      : null,
    decisions: inst.decisions.slice(-40),
    events: inst.events.slice(-300),
    lastEventSeq: inst.events.length ? inst.events[inst.events.length - 1].seq : -1
  }
}

// ---- RPC endpoints ----------------------------------------------------------

const delay = (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms))
const assertInstance = (instanceId) => {
  const inst = byId(instanceId)
  if (!inst) throw new Error(`实例不存在：${instanceId}`)
  return inst
}

export const api = {
  async install() { await delay(40); return { ok: true, version: '0.8.0', mock: true } },

  async workspaces() { await delay(); return { projects: state.projects } },

  async check() { await delay(); return { ok: true, subagent: { available: true, provider: 'mock-spawn' }, skills: 10 } },

  async models() {
    await delay()
    return {
      current: { provider: 'deepseek', model: 'deepseek-chat' },
      universalEfforts: ['off', 'low', 'medium', 'high', 'max'],
      providers: [
        {
          id: 'deepseek', name: 'DeepSeek',
          models: [
            { id: 'deepseek-chat', name: 'DeepSeek V3', efforts: [{ id: 'low', name: 'low' }, { id: 'medium', name: 'medium' }, { id: 'high', name: 'high' }] },
            { id: 'deepseek-reasoner', name: 'DeepSeek R1', efforts: [{ id: 'low', name: 'low' }, { id: 'medium', name: 'medium' }, { id: 'high', name: 'high' }, { id: 'max', name: 'max' }] }
          ]
        },
        { id: 'openai', name: 'OpenAI', models: [{ id: 'gpt-5.2', name: 'GPT-5.2' }, { id: 'gpt-5.2-mini', name: 'GPT-5.2-mini' }] },
        { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }, { id: 'claude-opus-4-5', name: 'Claude Opus 4.5' }] },
        { id: 'qwen', name: '阿里', models: [{ id: 'qwen3-max', name: 'Qwen3-Max' }, { id: 'qwen3-coder', name: 'Qwen3-Coder' }] }
      ]
    }
  },

  async instances({ workspace } = {}) {
    await delay()
    // 已删除/取消的实例不再出现在看板（“删除实例”即整实例销毁 → 卡片移除）。
    // 实例本身保留在 state 中（供调试/复盘），instance-get 仍可查。
    const scoped = state.instances.filter((i) => i.status !== 'cancelled')
    const filtered = workspace ? scoped.filter((i) => i.workspacePath === workspace) : scoped
    return {
      cwd: state.cwd,
      projects: state.projects,
      instances: filtered.map(projectCard)
    }
  },

  async instanceCreate({ input }) {
    await delay()
    const workspacePath = (input && input.workspacePath) || state.cwd
    const feature = (input && input.feature || '').trim()
    if (!feature) throw new Error('Feature 描述不能为空')
    const config = (input && input.config) || {}
    const dir = feature.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '')
    const inst = {
      instanceId: `wf-${state.instances.length + 100}`,
      workspacePath,
      feature,
      featureDir: dir || 'feature',
      branch: config.useWorktrees !== false ? `feat/${dir || 'feature'}` : null,
      worktreePath: config.useWorktrees !== false ? `${workspacePath}/.worktrees/${dir || 'feature'}` : null,
      mode: config.useWorktrees !== false ? 'isolated' : 'inplace',
      // Implement 执行方式：创建时可带 config.execMode/config.execSize，默认 workflow
      exec: {
        mode: EXEC_IDS.has(config.execMode) ? config.execMode : DEFAULT_EXEC.mode,
        size: Math.max(1, Math.min(8, Number(config.execSize) || DEFAULT_EXEC.size))
      },
      status: 'active',
      currentStage: 'specify',
      config: {
        useWorktrees: config.useWorktrees !== false,
        runChecklist: config.runChecklist !== false,
        runAnalyze: config.runAnalyze !== false,
        runTaskstoissues: config.runTaskstoissues === true
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      stageRows: [],
      decisions: [],
      events: []
    }
    state.instances.push(inst)
    pushEvent(inst, 'instance-created', { workspacePath, feature })
    pushDecision(inst, 'created', null, feature)
    const next = createRow(inst, 'specify', 1, 'creating')
    pushEvent(inst, 'stage-creating', { stageId: 'specify', attempt: 1, stageRowId: next.id })
    runStageSim(inst, next, { msgs: STAGE_PLAN.specify.msgs })
    return { instanceId: inst.instanceId, stageId: 'specify', stageRowId: next.id }
  },

  async instanceGet({ instanceId }) {
    await delay()
    return detailOf(assertInstance(instanceId))
  },

  // 配置/更新 Implement 阶段的执行方式（workflow / team）。与真实插件约定的
  // 新端点对齐：进入 Implement 前配置，卡片显示当前选择，Implement 线程按此执行。
  async execConfig({ instanceId, mode, size, actionId }) {
    await delay()
    const inst = assertInstance(instanceId)
    if (!EXEC_IDS.has(mode)) throw new Error(`未知执行方式：${mode}`)
    const n = Math.max(1, Math.min(8, Number(size) || DEFAULT_EXEC.size))
    inst.exec = { mode, size: n }
    pushDecision(inst, 'exec-config', 'implement', `Implement 采用 ${mode} · ${n} 并行`)
    pushEvent(inst, 'exec-config', { mode, size: n })
    return { exec: inst.exec, actionId: actionId || newActionId() }
  },

  async instanceCancel({ instanceId, actionId }) {
    await delay()
    const inst = assertInstance(instanceId)
    const active = inst.stageRows.filter((row) => ACTIVE.has(row.status)).sort((a, b) => b.attempt - a.attempt)[0] || null
    if (active) { active.status = 'cancelled'; active.updatedAt = Date.now() }
    inst.status = 'cancelled'
    inst.currentStage = active ? active.stageId : inst.currentStage
    pushDecision(inst, 'cancel', active ? active.stageId : null, '取消整个实例', active ? active.id : null)
    pushEvent(inst, 'instance-cancelled', { stageId: active ? active.stageId : null })
    // 整实例销毁：实例退出活动列表（instances() 投影会过滤 cancelled）。
    // 真实宿主在账本里保留 cancelled 记录用于审计；mock 选择软删除以贴合
    // “删除实例 = 卡片移除”的预期，同时保留 instance-get 可查性。
    return { cancelled: true, actionId: actionId || newActionId() }
  },

  async stageConfirm({ instanceId, stageRowId, actionId }) {
    await delay()
    const inst = assertInstance(instanceId)
    const row = inst.stageRows.find((r) => r.id === stageRowId)
    if (!row) throw new Error('阶段不存在')
    pushDecision(inst, 'confirm', row.stageId, null, row.id)
    advanceFrom(inst, row)
    return { stageRowId, actionId: actionId || newActionId() }
  },

  async stageSkip({ instanceId, stageRowId, actionId, reason }) {
    await delay()
    const inst = assertInstance(instanceId)
    const row = inst.stageRows.find((r) => r.id === stageRowId)
    if (!row) throw new Error('阶段不存在')
    row.staleReason = null
    pushDecision(inst, 'skip', row.stageId, reason || null, row.id)
    advanceFrom(inst, row, { skip: true })
    return { stageRowId, actionId: actionId || newActionId(), skipped: true }
  },

  async stageAnswer({ instanceId, stageRowId, actionId, text, kind }) {
    await delay()
    const inst = assertInstance(instanceId)
    const row = inst.stageRows.find((r) => r.id === stageRowId)
    if (!row) throw new Error('阶段不存在')
    const value = String(text || '')
    if (kind === 'end-interactive') {
      if (!TERMINAL.has(row.status) && row.status !== 'awaiting-confirmation') {
        row.status = 'awaiting-confirmation'
        row.updatedAt = Date.now()
      }
      pushDecision(inst, 'end-interactive', row.stageId, value === 'none' ? '无遗留' : (value || '交互结束'), row.id)
      pushEvent(inst, 'stage-awaiting-confirmation', { stageId: row.stageId, attempt: row.attempt })
      return { stageRowId, actionId: actionId || newActionId(), ended: true }
    }
    // kind === 'answer'
    row.thread.push({ who: 'user', at: Date.now(), text: value })
    row.thread.push({ who: 'agent', at: Date.now(), text: CANNED_REPLIES[cannedIdx++ % CANNED_REPLIES.length] })
    if (!row.state) row.state = { status: 'asking', question: '', assumptions: [] }
    row.state.assumptions = row.state.assumptions || []
    if (value && value !== 'none' && value.trim()) row.state.assumptions.push(value.length > 24 ? value.slice(0, 24) + '…' : value)
    row.updatedAt = Date.now()
    return { stageRowId, actionId: actionId || newActionId() }
  },

  async stageRerun({ instanceId, stageId, actionId, reason }) {
    await delay()
    const inst = assertInstance(instanceId)
    const latest = inst.stageRows.filter((r) => r.stageId === stageId).sort((a, b) => b.attempt - a.attempt)[0] || null
    const attempt = (latest ? latest.attempt : 0) + 1
    // mark downstream stale
    const from = STAGE_ORDER.indexOf(stageId)
    for (const row of inst.stageRows) {
      const idx = STAGE_ORDER.indexOf(row.stageId)
      const same = row.stageId === stageId && row.id !== (latest ? latest.id : null)
      if ((idx > from || same) && !TERMINAL.has(row.status)) {
        row.status = 'stale'
        row.staleReason = `上游 ${stageId} 被重新执行，下游结果可能过期`
        row.updatedAt = Date.now()
      }
    }
    inst.currentStage = stageId
    const next = createRow(inst, stageId, attempt, 'creating')
    pushDecision(inst, 'rerun', stageId, reason || null, next.id)
    pushEvent(inst, 'stage-rerun', { stageId, attempt, reason: reason || null })
    runStageSim(inst, next)
    return { stageId, attempt, actionId: actionId || newActionId() }
  },

  async stageRollback({ instanceId, stageId, actionId, reason }) {
    await delay()
    const inst = assertInstance(instanceId)
    const index = STAGE_ORDER.indexOf(stageId)
    const target = index <= 0 ? stageId : STAGE_ORDER[index - 1]
    pushDecision(inst, 'rollback', target, reason || `从 ${stageId} 返回上阶段重跑`, null)
    return this.stageRerun({ instanceId, stageId: target, actionId, reason: reason || `从 ${stageId} 返回上阶段重跑` })
  },

  async stageCancel({ instanceId, stageRowId, actionId }) {
    await delay()
    const inst = assertInstance(instanceId)
    const row = inst.stageRows.find((r) => r.id === stageRowId)
    if (!row) throw new Error('阶段不存在')
    if (!TERMINAL.has(row.status)) { row.status = 'cancelled'; row.updatedAt = Date.now() }
    pushDecision(inst, 'cancel', row.stageId, null, row.id)
    pushEvent(inst, 'stage-cancelled', { stageId: row.stageId, attempt: row.attempt })
    return { stageRowId, cancelled: true, actionId: actionId || newActionId() }
  },

  async threadView({ instanceId, stageRowId }) {
    await delay()
    const inst = assertInstance(instanceId)
    const row = inst.stageRows.find((r) => r.id === stageRowId)
    if (!row) throw new Error('阶段不存在')
    return {
      stageRow: { id: row.id, stageId: row.stageId, attempt: row.attempt, status: row.status },
      messages: row.thread || [],
      state: row.state || null
    }
  },

  async threadMessage({ instanceId, stageRowId, text }) {
    await delay(120)
    const inst = assertInstance(instanceId)
    const row = inst.stageRows.find((r) => r.id === stageRowId)
    if (!row) throw new Error('阶段不存在')
    const value = String(text || '').trim()
    if (!value) throw new Error('消息内容不能为空')
    if (!ACTIVE.has(row.status)) throw new Error(`阶段 ${row.status} 的线程已结束`)
    row.thread.push({ who: 'user', at: Date.now(), text: value })
    pushDecision(inst, 'board-interact', row.stageId, value, row.id)
    pushEvent(inst, 'stage-message', { stageId: row.stageId, attempt: row.attempt })
    if (row.status === 'awaiting-confirmation') {
      // 待确认被拉回 running，再模拟一个回合重新沉淀结果。
      runStageSim(inst, row)
    } else {
      row.thread.push({ who: 'agent', at: Date.now(), text: CANNED_REPLIES[cannedIdx++ % CANNED_REPLIES.length] })
      row.updatedAt = Date.now()
    }
    return { delivered: true, threadId: row.threadId || null }
  },

  async artifactRead({ instanceId, path, limit }) {
    await delay(60)
    if (instanceId) assertInstance(instanceId)
    const name = String(path || '').split('/').filter(Boolean).pop() || 'artifact'
    const head = `# ${name}\n\n> 这是 dsh-speckit-workflow mock 产物（真实内容来自工作区文件）。\n\n`
    const body = {
      'spec.md': '## 用户场景\n- 场景 A：…\n## 功能需求\n- FR-001 …\n## 成功标准\n- SC-001 …\n',
      'plan.md': '## 阶段划分\n- Phase 0: 研究\n- Phase 1: 数据模型与契约\n## 依赖\n- …\n',
      'tasks.md': '## P1\n- [ ] T-001 …\n## 依赖\n- T-003 → T-004\n',
      'quickstart.md': '## 快速开始\n1. …\n2. …\n',
      'DESIGN.md': '## UX 清单\n- [ ] 键盘可访问\n## 安全清单\n- [ ] 输入校验\n',
      'converge-report.md': '## 收敛结论\n- 无遗留缺口\n'
    }[name] || '（该产物为文本占位内容，点击卡片可进入真实工作区查看。）\n'
    const text = head + body
    const limited = typeof limit === 'number' ? text.slice(0, limit) : text
    return { path, text: limited }
  },

  async eventsSince({ instanceId, seq }) {
    await delay(40)
    const inst = assertInstance(instanceId)
    return { events: inst.events.filter((e) => e.seq > (seq || -1)) }
  }
}

// Boot: resume simulation for any seeded row that is still `running`
// (e.g. wf-11 implement / wf-18 specify) so they self-advance like real threads.
function resumeSeededSims() {
  for (const inst of state.instances) {
    for (const row of inst.stageRows) {
      if (row.status === 'running') {
        runStageSim(inst, row, { msgs: ['工作线程继续推进…', `${row.stageId} 阶段收尾中…`] })
      }
    }
  }
}
resumeSeededSims()

export { state }

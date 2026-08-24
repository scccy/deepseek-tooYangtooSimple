// dsh-speckit-workflow v0.8 — host entry.
//
// Redeveloped per DESIGN-V0.8.md: the plugin is now a Feature workbench, not a
// one-shot pipeline runner. The workbench owns:
//   - a profile-level SQLite orchestration ledger (~/.dsh/speckit-workflow/workflow.db)
//   - per-stage durable continuable subagent threads (stage threads)
//   - explicit human handoff points between stages (no auto-advance)
//   - interactive Clarify/Converge threads
//   - a 4-column board projection of feature instances
//
// Injections: tools / systemPrompt / agents / webServer / workspaceRegistry /
// subagents / llm. The `@dsh-external/workflow` engine is no longer the
// execution substrate — stage threads are independent agent sessions.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Ledger, DEFAULT_DB_PATH } from './db.js'
import { Orchestrator, OrchestratorError } from './orchestrator.js'
import { StageThreads, stateFileFor, RESUME_PROMPT } from './threads.js'
import { COLUMNS, STAGE_DEFS, permittedActions, previousPhaseStart, phaseName } from './stages.js'
import { readFeatureJson } from './worktree.js'

export const name = 'dsh-speckit-workflow'
export const TOOL_NAME = 'speckit_sdd'
export const RPC_CHANNEL = '/api/dsh-speckit-workflow'

export const inject = ['tools', 'systemPrompt', 'agents', 'webServer', 'workspaceRegistry', 'subagents', 'llm']

export const PLUGIN_VERSION = '0.8.0'

// 看板消息可投递进线程的阶段状态：活跃状态与「已暂停 / 已结束但仍是当前阶段」
// 的终态。发送消息会把非 running 的行重新拉回 running，在同一个线程上继续，
// 因此「暂停后继续」「失败后继续对话」「断电/重启后继续」都无需重新开线程。
const THREAD_ACCEPT_STATUSES = new Set(['running', 'awaiting-user', 'awaiting-confirmation', 'paused', 'completed', 'failed', 'cancelled'])
// 真正占用工作区的活跃状态：若其它阶段正处其中，旧线程不允许继续（避免双线程）。
const THREAD_LIVE_STATUSES = new Set(['running', 'awaiting-user', 'awaiting-confirmation', 'creating', 'paused'])

const BUNDLED_SKILLS = {
  specify: 'speckit-specify',
  worktrees: 'speckit-worktrees-create',
  clarify: 'speckit-clarify',
  plan: 'speckit-plan',
  checklist: 'speckit-checklist',
  tasks: 'speckit-tasks',
  analyze: 'speckit-analyze',
  taskstoissues: 'speckit-taskstoissues',
  implement: 'speckit-implement',
  converge: 'speckit-converge'
}
const PROJECT_SKILL_DIR = '.dsh/speckit-workflow/skills'

function bundledSkillDir() {
  try {
    return fileURLToPath(new URL('../skills/', import.meta.url))
  } catch {
    return null
  }
}

const SKILL_SHA256S = new Map()
;(() => {
  const dir = bundledSkillDir()
  if (dir === null) return
  for (const skill of Object.values(BUNDLED_SKILLS)) {
    const path = join(dir, skill, 'SKILL.md')
    try {
      const source = readFileSync(path, 'utf8')
      SKILL_SHA256S.set(skill, { source, sha256: createHash('sha256').update(source).digest('hex') })
    } catch {
      /* reported by checkProject */
    }
  }
})()

function missingBundledSkills() {
  const missing = []
  for (const skill of Object.values(BUNDLED_SKILLS)) {
    if (!SKILL_SHA256S.has(skill)) missing.push(skill)
  }
  return missing
}

function projectCwd(agent) {
  const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
  if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) {
    throw new Error('dsh-speckit-workflow requires a parent session with an absolute project cwd')
  }
  return cwd
}

function resolveProjectRoot(raw, fallback) {
  const candidate = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : fallback
  if (typeof candidate !== 'string' || candidate.length === 0 || !isAbsolute(candidate)) return fallback
  try {
    if (!statSync(candidate).isDirectory()) return fallback
  } catch {
    return fallback
  }
  return candidate
}

function checkProject(root) {
  const issues = []
  if (!existsSync(join(root, '.specify', 'templates'))) {
    issues.push('missing .specify/ (run spec-kit `specify init` once; the Speckit skills themselves are bundled with the plugin)')
  }
  const missingSkills = missingBundledSkills()
  if (missingSkills.length > 0) {
    issues.push(`plugin package is incomplete — missing bundled skills: ${missingSkills.join(', ')}`)
  }
  return issues
}

function projectEntry(ctx, root) {
  const issues = checkProject(root)
  return { path: root, title: root.split('/').filter(Boolean).pop() || root, ready: issues.length === 0, issues }
}

function projectEntries(ctx, current) {
  const entries = []
  const seen = new Set()
  const push = (entry) => {
    if (!entry || typeof entry.path !== 'string' || seen.has(entry.path)) return
    seen.add(entry.path)
    entries.push(projectEntry(ctx, entry.path))
  }
  const registry = ctx.get('workspaceRegistry')
  if (registry && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list() || []) {
        if (workspace && typeof workspace.path === 'string') push({ path: workspace.path, title: workspace.title })
      }
    } catch {
      /* best effort */
    }
  }
  push({ path: current })
  return entries.slice(0, 40)
}

/** Sync the vendored skills into the project (project-level override surface). */
async function ensureProjectSkills(root) {
  const missing = missingBundledSkills()
  if (missing.length > 0) {
    throw new Error(`dsh-speckit-workflow package is missing bundled skills: ${missing.join(', ')}`)
  }
  const skillsRoot = join(root, PROJECT_SKILL_DIR)
  const recordPath = join(skillsRoot, 'skills.json')
  let record = null
  try {
    record = JSON.parse(await readFile(recordPath, 'utf8'))
  } catch {
    record = null
  }
  const fresh = record && typeof record === 'object' && Array.isArray(record.files)
  const wants = []
  for (const [skill, packed] of SKILL_SHA256S) {
    const rel = `${skill}/SKILL.md`
    const recordedHash = fresh ? record.files.find((entry) => entry && entry.path === rel)?.sha256 : undefined
    if (recordedHash !== packed.sha256 || !existsSync(join(skillsRoot, rel))) wants.push({ rel, ...packed })
  }
  if (wants.length === 0) return
  await mkdir(skillsRoot, { recursive: true })
  const files = []
  for (const entry of wants) {
    const target = join(skillsRoot, entry.rel)
    await mkdir(join(skillsRoot, entry.rel, '..'), { recursive: true })
    await writeFile(target, entry.source, { encoding: 'utf8' })
    files.push({ path: entry.rel, sha256: entry.sha256 })
  }
  const merged = fresh ? [...record.files.filter((entry) => !files.some((f) => f.path === entry?.path)), ...files] : files
  await writeFile(recordPath, `${JSON.stringify({ pluginVersion: PLUGIN_VERSION, syncedAt: new Date().toISOString(), files: merged }, null, 2)}\n`, { encoding: 'utf8' })
}

function snapshotOf(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return undefined
  }
}

function errorResult(error, aborted = false) {
  return {
    ok: false,
    error: {
      code: aborted ? 'cancelled' : error instanceof OrchestratorError ? error.code : 'bad-request',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

// ---- real model directory for the new-feature form --------------------------

async function modelCatalog(ctx) {
  const llm = ctx.get ? ctx.get('llm') : undefined
  const adm = ctx.get ? ctx.get('agentDefaultModel') : undefined
  const result = { providers: [], current: null, universalEfforts: ['off', 'low', 'medium', 'high', 'max'], error: null }
  if (!llm || typeof llm.listProviders !== 'function') { result.error = 'llm service unavailable'; return result }
  let routes = []
  try { routes = Array.isArray(llm.listProviders()) ? llm.listProviders() : [] } catch (e) { result.error = String((e && e.message) || e); return result }
  for (const provider of routes) {
    let models = []
    try { models = typeof llm.listModels === 'function' ? (await llm.listModels(provider.id)) || [] : [] } catch { /* transient */ }
    const entries = []
    for (const model of models || []) {
      let efforts = null
      try {
        if (typeof llm.resolveModelInfo === 'function') {
          const resolved = await llm.resolveModelInfo(provider.id, model.id)
          if (resolved && resolved.reasoning && Array.isArray(resolved.reasoning.efforts) && resolved.reasoning.efforts.length) {
            efforts = resolved.reasoning.efforts.map((entry) => ({ id: String(entry.id), name: String(entry.name || entry.id) }))
          }
        }
      } catch { /* per-model best effort */ }
      entries.push({ id: model.id, name: model.name || model.id, efforts })
    }
    result.providers.push({ id: provider.id, name: provider.name || provider.id, models: entries })
  }
  try {
    if (adm && typeof adm.currentSelection === 'function') {
      const selection = adm.currentSelection()
      if (selection) {
        const current = { provider: String(selection.provider || ''), model: String(selection.model || '') }
        if (selection.reasoningEffort !== void 0 && selection.reasoningEffort !== null) current.reasoningEffort = String(selection.reasoningEffort)
        result.current = current
      }
    }
  } catch { /* optional */ }
  return result
}

// ---- RPC --------------------------------------------------------------------

async function rpcHandler(ctx, bodies, ledger, orchestrator, threads, sessionId) {
  const endpoint = bodies.endpoint
  const payload = bodies
  const parentAgent = ctx.agents.get(sessionId)
  if (!parentAgent) throw new Error('no agent found for sessionId')
  const input = payload.input && typeof payload.input === 'object' ? payload.input : payload

  const resolveInstance = () => {
    const instanceId = payload.instanceId
    if (typeof instanceId !== 'string' || instanceId.length === 0) throw new OrchestratorError('bad-request', 'instanceId is required')
    const instance = ledger.transaction((tx) => ledger.getInstance(tx, instanceId))
    if (!instance) throw new OrchestratorError('not-found', `实例 ${instanceId} 不存在`)
    return instance
  }

  const parentOf = (instance) => {
    const recorded = instance.config && instance.config.parentSessionId
    if (typeof recorded === 'string' && recorded.length > 0) {
      const recordedAgent = ctx.agents.get(recorded)
      if (recordedAgent) return recordedAgent
    }
    return parentAgent
  }

  const spawnForStageRow = async (instance, stageRowId) => {
    const stageRow = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
    if (!stageRow) throw new OrchestratorError('not-found', 'stage row not found')
    try {
      const bound = await threads.spawnStage({ instance, parentAgent: parentOf(instance), stageRow })
      return bound
    } catch (error) {
      // Binding failed (provider/model/capability) — surface the stage as failed (retryable).
      try {
        orchestrator.failStage(instance.instance_id, stageRowId, String((error && error.message) || error))
      } catch {
        /* already failed */
      }
      return ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
    }
  }

  switch (endpoint) {
    case 'install':
      return {
        ok: true,
        value: {
          version: PLUGIN_VERSION,
          backend: ledger.backend,
          dbPath: ledger.path,
          node: typeof process !== 'undefined' ? process.version : null,
          provider: threads.provider,
          subagents: typeof threads.subagents.list === 'function' ? snapshotOf(threads.subagents.list() || []) : []
        }
      }

    case 'workspaces':
    case 'check': {
      let fallback = null
      try { fallback = projectCwd(parentAgent) } catch { /* no absolute session cwd; registry still lists workspaces */ }
      const root = resolveProjectRoot(typeof payload.projectPath === 'string' ? payload.projectPath : undefined, fallback)
      const issues = checkProject(root)
      return { ok: true, value: { cwd: root, projects: projectEntries(ctx, root), ready: issues.length === 0, issues } }
    }

    case 'models':
      return { ok: true, value: await modelCatalog(ctx) }

    case 'instances': {
      let fallback = null
      try { fallback = projectCwd(parentAgent) } catch { /* no absolute session cwd; fall back to workspace registry */ }
      const root = resolveProjectRoot(typeof payload.projectPath === 'string' && payload.projectPath.length > 0 ? payload.projectPath : undefined, fallback)
      const board = orchestrator.board(typeof payload.workspace === 'string' && payload.workspace.length > 0 ? payload.workspace : (root || undefined))
      return {
        ok: true,
        value: {
          cwd: root,
          projects: projectEntries(ctx, root),
          columns: COLUMNS,
          instances: board.map((card) => ({ ...card, actions: boardActionsFor(card) }))
        }
      }
    }

    case 'exec-config': {
      // Implement 执行方式：到达 Plan 之后、Implement 之前可配置（DESIGN-V0.8）。
      // 持久化到实例 config.exec，board()/detail 投影会回显真实值。
      const instance = resolveInstance()
      const mode = ['workflow', 'team'].includes(String(payload.mode)) ? String(payload.mode) : 'workflow'
      const rawSize = Number(payload.size)
      const size = Number.isFinite(rawSize) ? Math.min(6, Math.max(2, Math.round(rawSize))) : 3
      ledger.transaction((tx) => {
        const fresh = ledger.getInstance(tx, instance.instance_id)
        if (!fresh) throw new OrchestratorError('not-found', '实例不存在')
        fresh.config = { ...(fresh.config || {}), exec: { mode, size } }
        fresh.updated_at = new Date().toISOString()
        ledger.updateInstance(tx, fresh)
      })
      return { ok: true, value: { exec: { mode, size } } }
    }

    case 'instance-create': {
      let workspacePath = typeof input.workspacePath === 'string' && input.workspacePath.length > 0 ? input.workspacePath : null
      if (!workspacePath) {
        try { workspacePath = projectCwd(parentAgent) } catch { workspacePath = null }
      }
      if (!workspacePath) {
        throw new OrchestratorError('bad-request', '缺少目标工作区路径（workspacePath）；请在新建 Feature 弹窗中选择一个已就绪的工作区')
      }
      const feature = typeof input.feature === 'string' ? input.feature : ''
      const issues = checkProject(workspacePath)
      if (issues.length > 0) {
        throw new OrchestratorError('not-ready', `该工作区不是 speckit 就绪项目（${workspacePath}）：\n- ${issues.join('\n- ')}`)
      }
      await ensureProjectSkills(workspacePath)
      const config = { ...(input.config && typeof input.config === 'object' ? input.config : {}), parentSessionId: sessionId }
      const created = orchestrator.createInstance({ workspacePath, feature, config })
      const instance = ledger.transaction((tx) => ledger.getInstance(tx, created.instanceId))
      const stageRow = await spawnForStageRow(instance, created.stageRowId)
      return { ok: true, value: { instanceId: created.instanceId, stageRowId: created.stageRowId, stageId: created.stageId, threadId: stageRow.thread_id, stageStatus: stageRow.status } }
    }

    case 'instance-get': {
      const instance = resolveInstance()
      const detail = orchestrator.detail(instance.instance_id)
      const builder = await buildDetailView(ctx, threads, ledger, orchestrator, instance, detail)
      return { ok: true, value: builder }
    }

    case 'stage-confirm': {
      const instance = resolveInstance()
      const stageRowId = Number(payload.stageRowId)
      const actionId = String(payload.actionId || '')
      if (!actionId) throw new OrchestratorError('bad-request', 'actionId is required')
      const res = orchestrator.confirmStage(instance.instance_id, stageRowId, { actionId, next: payload.next })
      if (res.idempotent) return { ok: true, value: { idempotent: true, ...(res.result || {}) } }
      if (!res.result || res.result.instanceCompleted) {
        return { ok: true, value: { nextStageId: null, instanceCompleted: true } }
      }
      const nextStage = await spawnForStageRow(instance, res.result.stageRowId)
      return {
        ok: true,
        value: {
          nextStageId: res.result.nextStageId,
          stageRowId: res.result.stageRowId,
          threadId: nextStage.thread_id,
          stageStatus: nextStage.status
        }
      }
    }

    case 'stage-skip': {
      const instance = resolveInstance()
      const stageRowId = Number(payload.stageRowId)
      const actionId = String(payload.actionId || '')
      const reason = String(payload.reason || '').trim()
      if (!actionId) throw new OrchestratorError('bad-request', 'actionId is required')
      const res = orchestrator.confirmStage(instance.instance_id, stageRowId, { actionId, skip: true, reason })
      if (res.idempotent) return { ok: true, value: { idempotent: true, ...(res.result || {}) } }
      if (!res.result || res.result.instanceCompleted) return { ok: true, value: { nextStageId: null, instanceCompleted: true } }
      const nextStage = await spawnForStageRow(instance, res.result.stageRowId)
      return { ok: true, value: { nextStageId: res.result.nextStageId, stageRowId: res.result.stageRowId, threadId: nextStage.thread_id, stageStatus: nextStage.status } }
    }

    case 'stage-answer': {
      const instance = resolveInstance()
      const stageRowId = Number(payload.stageRowId)
      const text = String(payload.text || '')
      const actionId = String(payload.actionId || '')
      const kind = String(payload.kind || 'answer')
      if (!actionId) throw new OrchestratorError('bad-request', 'actionId is required')
      if (!text.trim() && kind !== 'end-interactive') throw new OrchestratorError('bad-request', 'answer text is required')
      const stageRow = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
      if (!stageRow) throw new OrchestratorError('not-found', 'stage row not found')
      if (kind === 'end-interactive') {
        const res = await threads.answer({ instance, parentAgent: parentOf(instance), stageRow, text: 'done', kind: 'end-interactive', actionId })
        return { ok: true, value: res }
      }
      const res = await threads.answer({ instance, parentAgent: parentOf(instance), stageRow, text, kind, actionId })
      return { ok: true, value: res }
    }

    case 'stage-rerun': {
      const instance = resolveInstance()
      const stageId = String(payload.stageId || '')
      const actionId = String(payload.actionId || '')
      const reason = String(payload.reason || '').trim()
      if (!stageId || !actionId) throw new OrchestratorError('bad-request', 'stageId and actionId are required')
      const res = orchestrator.rerunStage(instance.instance_id, stageId, { actionId, reason })
      if (res.idempotent) return { ok: true, value: { idempotent: true, ...(res.result || {}) } }
      const stageRow = await spawnForStageRow(instance, res.result.stageRowId)
      return { ok: true, value: { stageId: res.result.stageId, stageRowId: res.result.stageRowId, attempt: res.result.attempt, threadId: stageRow.thread_id, stageStatus: stageRow.status, staleFrom: res.result.staleFrom } }
    }

    case 'phase-rollback': {
      // 大阶段（看板列）回退：从当前列回退到上一列的起始小阶段。
      // 例如 Implement 列 → Clarify 列的 clarify 阶段。复用 rerunStage 的
      // 上游重启机制：目标阶段新建 attempt，当前锁持有阶段标记 stale。
      const instance = resolveInstance()
      const stageId = STAGE_DEFS[String(payload.stageId || '')]
        ? String(payload.stageId)
        : (instance.current_stage || 'specify')
      const actionId = String(payload.actionId || '')
      if (!actionId) throw new OrchestratorError('bad-request', 'actionId is required')
      const target = previousPhaseStart(stageId)
      if (!target) {
        throw new OrchestratorError('bad-request', `已是第一个大阶段（${phaseName(stageId)}），无法回退`)
      }
      const reason = String(payload.reason || '').trim()
      const fullReason = `大阶段回退（${phaseName(stageId)} → ${phaseName(target)}）${reason ? `：${reason}` : ''}`
      const res = orchestrator.rerunStage(instance.instance_id, target, { actionId, reason: fullReason })
      if (res.idempotent) return { ok: true, value: { idempotent: true, ...(res.result || {}) } }
      const stageRow = await spawnForStageRow(instance, res.result.stageRowId)
      return {
        ok: true,
        value: {
          targetStage: target,
          stageId: res.result.stageId,
          stageRowId: res.result.stageRowId,
          attempt: res.result.attempt,
          threadId: stageRow.thread_id,
          stageStatus: stageRow.status,
          staleFrom: res.result.staleFrom
        }
      }
    }

    case 'stage-rollback': {
      const instance = resolveInstance()
      const stageId = String(payload.stageId || '')
      const actionId = String(payload.actionId || '')
      if (!stageId || !actionId) throw new OrchestratorError('bad-request', 'stageId and actionId are required')
      const res = orchestrator.rollbackStage(instance.instance_id, stageId, { actionId })
      if (res.idempotent) return { ok: true, value: { idempotent: true, ...(res.result || {}) } }
      const stageRow = await spawnForStageRow(instance, res.result.stageRowId)
      return { ok: true, value: { stageId: res.result.stageId, stageRowId: res.result.stageRowId, attempt: res.result.attempt, threadId: stageRow.thread_id, stageStatus: stageRow.status } }
    }

    case 'stage-cancel': {
      const instance = resolveInstance()
      const stageRowId = Number(payload.stageRowId)
      const actionId = String(payload.actionId || '')
      const cancelInstance = payload.cancelInstance === true
      if (!actionId) throw new OrchestratorError('bad-request', 'actionId is required')
      const stageRow = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
      if (stageRow && stageRow.status === 'running' && stageRow.thread_id) {
        await threads.interrupt(stageRow.thread_id, parentOf(instance))
      }
      const res = orchestrator.cancelStage(instance.instance_id, stageRowId, { actionId, cancelInstance })
      return { ok: true, value: { idempotent: !!res.idempotent, ...(res.result || {}) } }
    }

    case 'instance-cancel': {
      const instance = resolveInstance()
      const actionId = String(payload.actionId || '')
      if (!actionId) throw new OrchestratorError('bad-request', 'actionId is required')
      // Interrupt the live thread of the active stage, if any, before deleting.
      const activeStage = ledger.transaction((tx) => {
        const stages = ledger.listStages(tx, instance.instance_id)
        return stages
          .filter((stage) => ['running', 'awaiting-user', 'awaiting-confirmation', 'creating', 'paused'].includes(stage.status))
          .sort((a, b) => b.attempt - a.attempt)[0]
      })
      if (activeStage && activeStage.status === 'running' && activeStage.thread_id) {
        await threads.interrupt(activeStage.thread_id, parentOf(instance))
      }
      const res = orchestrator.cancelInstance(instance.instance_id, { actionId })
      return { ok: true, value: { idempotent: !!res.idempotent, ...(res.result || {}) } }
    }

    case 'thread-view': {
      const instance = resolveInstance()
      const stageRowId = payload.stageRowId ? Number(payload.stageRowId) : null
      let stageRow = null
      if (stageRowId) stageRow = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
      if (!stageRow && payload.threadId) {
        stageRow = ledger.transaction((tx) => ledger.findStageByThread(tx, String(payload.threadId)))
      }
      if (!stageRow) throw new OrchestratorError('not-found', 'thread/stage not found')
      const messages = await threads.threadMessages(stageRow.thread_id)
      const stateFile = stateFileFor(instance.workspace_path, instance.instance_id, stageRow.stage_id, stageRow.attempt)
      let state = null
      try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch { state = null }
      return { ok: true, value: { threadId: stageRow.thread_id, messages, state, stageRow: sanitizeStage(stageRow) } }
    }

    case 'thread-message': {
      // 把看板消息投递进阶段线程（"继续对话"）。任何仍在衔接中的阶段
      // （running / awaiting-* / paused，以及已是当前阶段的终态行）都可以
      // 继续：非 running 的行先被拉回 running，再 followup 同一线程，
      // 线程再跑一个回合，结束后由 idle 边缘把结果重新吸收进账本。
      // 这样暂停后继续、失败后继续追问、断电/重启后继续都不需要重开线程。
      const instance = resolveInstance()
      const stageRowId = payload.stageRowId ? Number(payload.stageRowId) : null
      let stageRow = null
      if (stageRowId) stageRow = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
      if (!stageRow && payload.threadId) {
        stageRow = ledger.transaction((tx) => ledger.findStageByThread(tx, String(payload.threadId)))
      }
      if (!stageRow) throw new OrchestratorError('not-found', 'thread/stage not found')
      if (!stageRow.thread_id) throw new OrchestratorError('invalid-state', '该阶段没有可交互的线程（请先重跑本阶段创建线程）')
      const text = String(payload.text || '').trim()
      if (!text) throw new OrchestratorError('bad-request', '消息内容不能为空')
      if (!THREAD_ACCEPT_STATUSES.has(stageRow.status)) {
        throw new OrchestratorError('invalid-state', `阶段 ${stageRow.status} 无法接收消息（如需重新开始，请使用「重跑/重试」）`)
      }
      if (stageRow.status !== 'running') {
        // 终态/暂停的线程重新打开为 running 之前，校验它是本阶段最新的一次
        // attempt，且实例里没有其它活跃阶段在跑（否则会双线程并发）。
        const gate = ledger.transaction((tx) => {
          const all = ledger.listStages(tx, instance.instance_id)
          const latest = all.filter((s) => s.stage_id === stageRow.stage_id).sort((a, b) => b.id - a.id)[0]
          if (latest && latest.id !== stageRow.id) return 'superseded'
          if (stageRow.status === 'stale') return 'stale'
          const liveOthers = all.filter((s) => s.id !== stageRow.id && THREAD_LIVE_STATUSES.has(s.status))
          return liveOthers.length > 0 ? 'busy' : null
        })
        if (gate) {
          throw new OrchestratorError('invalid-state',
            gate === 'superseded'
              ? '该阶段已有更新的 attempt，无法继续旧线程；请操作最新一次执行。'
              : gate === 'stale'
                ? '该阶段已因上游变更而过期，无法继续旧线程；请使用「从该阶段重新开始」。'
                : '该阶段已交接给后续阶段，无法继续旧线程（避免两条线程同时执行）。如需重新开始请使用「重跑/重试」。')
        }
        ledger.transaction((tx) => {
          const fresh = ledger.getStage(tx, stageRow.id)
          if (!fresh) return
          fresh.status = 'running'
          fresh.ended_at = null
          fresh.error = null
          ledger.updateStage(tx, fresh)
          ledger.insertDecision(tx, {
            instance_id: instance.instance_id, stage_row: stageRow.id, kind: 'thread-continue',
            target_stage: stageRow.stage_id, note: text.slice(0, 2000), at: new Date().toISOString()
          })
          ledger.appendEvents(tx, [orchestrator.event(instance.instance_id, 'stage-continued', { stageId: stageRow.stage_id, attempt: stageRow.attempt, threadId: stageRow.thread_id }, stageRow.thread_id)])
        })
      }
      await threads.followup(parentOf(instance), stageRow.thread_id, text, 'board-interact')
      ledger.transaction((tx) => {
        ledger.insertDecision(tx, {
          instance_id: instance.instance_id,
          stage_row: stageRow.id,
          kind: 'board-interact',
          target_stage: stageRow.stage_id,
          note: text.slice(0, 2000),
          at: new Date().toISOString()
        })
        ledger.appendEvents(tx, [orchestrator.event(instance.instance_id, 'stage-message', { stageId: stageRow.stage_id, attempt: stageRow.attempt, threadId: stageRow.thread_id }, stageRow.thread_id)])
      })
      return { ok: true, value: { delivered: true, threadId: stageRow.thread_id, status: 'running' } }
    }

    case 'thread-pause': {
      // 暂停正在执行的线程：先把账本行标记为 paused（幂等），再中断线程。
      // 中断后线程停在原地，绝不把没写完 state.json 的半程回合误判为失败；
      // 之后发送消息或「继续」会在同一线程上恢复。
      const instance = resolveInstance()
      const stageRowId = payload.stageRowId ? Number(payload.stageRowId) : null
      let stageRow = null
      if (stageRowId) stageRow = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
      if (!stageRow && payload.threadId) {
        stageRow = ledger.transaction((tx) => ledger.findStageByThread(tx, String(payload.threadId)))
      }
      if (!stageRow) throw new OrchestratorError('not-found', 'thread/stage not found')
      if (stageRow.status !== 'running') {
        return { ok: true, value: { paused: true, idempotent: true, threadId: stageRow.thread_id, status: stageRow.status } }
      }
      const actionId = String(payload.actionId || '')
      if (!actionId) throw new OrchestratorError('bad-request', 'actionId is required')
      const paused = orchestrator.pauseStage(instance.instance_id, stageRow.id, { actionId, reason: '用户暂停线程' })
      if (stageRow.thread_id) {
        await threads.interrupt(stageRow.thread_id, parentOf(instance))
      }
      return { ok: true, value: { paused: true, ...(paused.result || {}) } }
    }

    case 'thread-resume': {
      // 恢复已暂停的线程：同一线程 followup "继续" 唤醒它，继续完成回合。
      const instance = resolveInstance()
      const actionId = String(payload.actionId || '')
      if (!actionId) throw new OrchestratorError('bad-request', 'actionId is required')
      const stageRowId = payload.stageRowId ? Number(payload.stageRowId) : null
      let stageRow = null
      if (stageRowId) stageRow = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
      if (!stageRow && payload.threadId) {
        stageRow = ledger.transaction((tx) => ledger.findStageByThread(tx, String(payload.threadId)))
      }
      if (!stageRow) throw new OrchestratorError('not-found', 'thread/stage not found')
      if (stageRow.status === 'running') {
        return { ok: true, value: { resumed: true, idempotent: true, threadId: stageRow.thread_id, status: 'running' } }
      }
      if (stageRow.status !== 'paused') {
        throw new OrchestratorError('invalid-state', `阶段状态 ${stageRow.status} 不能恢复（仅已暂停的阶段可恢复）`)
      }
      if (!stageRow.thread_id) throw new OrchestratorError('invalid-state', '该阶段没有可恢复的线程')
      const resumed = orchestrator.resumeStage(instance.instance_id, stageRow.id, { actionId, reason: '用户继续执行线程' })
      await threads.followup(parentOf(instance), stageRow.thread_id, RESUME_PROMPT, 'board-resume')
      return { ok: true, value: { resumed: true, ...(resumed.result || {}) } }
    }

    case 'thread-tail': {
      // 主通道的增量事件尾（重启后依然可用，不依赖动态插件）。
      const threadId = typeof payload.threadId === 'string' ? payload.threadId.trim() : ''
      if (!threadId) throw new OrchestratorError('bad-request', 'threadId is required')
      const fromSeq = Math.max(0, Number(payload.fromSeq) || 0)
      const sp = ctx.get ? ctx.get('sessionPersistence') : undefined
      let events = []
      if (sp && typeof sp.readFrom === 'function') {
        try {
          const read = await sp.readFrom(threadId, fromSeq)
          events = (read && Array.isArray(read.events)) ? read.events : []
        } catch {
          events = []
        }
      }
      let nextSeq = fromSeq
      for (const ev of events) {
        const s = Number(ev && ev.seq)
        if (Number.isFinite(s) && s >= nextSeq) nextSeq = s + 1
      }
      return { ok: true, value: { threadId, fromSeq, nextSeq, events: snapshotOf(events) } }
    }

    case 'thread-history': {
      // 主通道的持久化对话兜底：从持久化会话日志折叠全部消息（重启后可用）。
      const threadId = typeof payload.threadId === 'string' ? payload.threadId.trim() : ''
      if (!threadId) throw new OrchestratorError('bad-request', 'threadId is required')
      const messages = await persistedThreadMessages(ctx, threadId)
      return { ok: true, value: { threadId, messages } }
    }

    case 'artifact-read': {
      const path = String(payload.path || '')
      if (!path || !payload.instanceId) throw new OrchestratorError('bad-request', 'instanceId and path are required')
      const instance = resolveInstance()
      const roots = [instance.execution_root, instance.artifact_root, instance.workspace_path].filter(Boolean)
      let text = null
      let abs = null
      for (const root of roots) {
        const candidate = join(root, path)
        if (candidate.startsWith(root) && existsSync(candidate)) { abs = candidate; break }
      }
      if (!abs) throw new OrchestratorError('not-found', `产物不存在: ${path}`)
      try {
        const limit = Number(payload.limit || 40000)
        let body = await readFile(abs, 'utf8')
        const truncated = body.length > limit
        text = truncated ? body.slice(0, limit) : body
      } catch (error) {
        throw new OrchestratorError('bad-request', `产物不可读: ${String((error && error.message) || error)}`)
      }
      return { ok: true, value: { path: abs, text, truncated: text === null ? false : undefined } }
    }

    case 'events-since': {
      const instanceId = String(payload.instanceId || '')
      const since = typeof payload.since === 'number' ? payload.since : -1
      const events = ledger.transaction((tx) => ledger.eventsSince(tx, instanceId, since))
      const resume = ledger.transaction((tx) => ledger.lastEventSeq(tx, instanceId))
      return { ok: true, value: { events: snapshotOf(events.map((event) => ({ ...event, data: event.data ?? null }))), resume } }
    }

    default:
      throw new Error(`unknown endpoint '${endpoint}'`)
  }
}

function sanitizeStage(stageRow) {
  if (!stageRow) return null
  return {
    id: stageRow.id,
    instance_id: stageRow.instance_id,
    stage_id: stageRow.stage_id,
    attempt: stageRow.attempt,
    thread_id: stageRow.thread_id,
    status: stageRow.status,
    column: stageRow.column,
    started_at: stageRow.started_at,
    ended_at: stageRow.ended_at,
    summary: stageRow.summary,
    skill_id: stageRow.skill_id,
    skill_sha256: stageRow.skill_sha256,
    input_snapshot: stageRow.input_snapshot,
    state_json: stageRow.state_json,
    output: stageRow.output,
    error: stageRow.error,
    stale_reason: stageRow.stale_reason
  }
}

/** 从持久化会话日志折叠出线程的全部消息（不依赖 live agent，重启后可用）。 */
async function persistedThreadMessages(ctx, threadId) {
  const sp = ctx.get ? ctx.get('sessionPersistence') : undefined
  if (!sp || typeof sp.readFrom !== 'function') return []
  let events = []
  try {
    const read = await sp.readFrom(threadId, 0)
    events = (read && Array.isArray(read.events)) ? read.events : []
  } catch {
    return []
  }
  const out = []
  for (const event of events) {
    if (!event) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    const content = Array.isArray(data.content)
      ? data.content
      : (data.message && Array.isArray(data.message.content) ? data.message.content : null)
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (!text) continue
    out.push({
      who: event.type === 'user/message' ? 'user' : 'assistant',
      text,
      at: typeof event.time === 'number' ? event.time : 0
    })
  }
  return out.slice(-160)
}

async function buildDetailView(ctx, threads, ledger, orchestrator, instance, detail) {
  const stages = detail.stages.map((stage) => {
    const def = STAGE_DEFS[stage.stage_id]
    const active = stage.status === 'running' || stage.status === 'awaiting-user' || stage.status === 'awaiting-confirmation' || stage.status === 'creating' || stage.status === 'paused'
    return {
      id: stage.id,
      stageId: stage.stage_id,
      attempt: stage.attempt,
      threadId: stage.thread_id,
      status: stage.status,
      column: stage.column,
      title: def ? def.title : stage.stage_id,
      skillId: stage.skill_id || (def ? def.skill : null),
      skillSha256: stage.skill_sha256,
      summary: stage.summary,
      error: stage.error,
      staleReason: stage.stale_reason,
      startedAt: stage.started_at,
      endedAt: stage.ended_at,
      inputSnapshot: stage.input_snapshot,
      state: stage.state_json,
      output: stage.output,
      artifacts: stage.artifacts.map((artifact) => ({ rel: artifact.rel, root: artifact.root, sha256: artifact.sha256, stale: artifact.stale })),
      actions: permittedActions(stage, active)
    }
  })
  // Thread messages for the current active stage.
  const activeStage = stages.find((stage) => stage.status === 'running' || stage.status === 'awaiting-user' || stage.status === 'awaiting-confirmation' || stage.status === 'creating' || stage.status === 'paused')
  let thread = null
  if (activeStage && activeStage.threadId) {
    thread = {
      threadId: activeStage.threadId,
      messages: await threads.threadMessages(activeStage.threadId),
      state: activeStage.state
    }
  }
  return {
    instance: {
      instanceId: instance.instance_id,
      workspacePath: instance.workspace_path,
      feature: instance.feature_name,
      featureDir: instance.feature_dir,
      branch: instance.branch,
      worktreePath: instance.worktree_path,
      mode: instance.mode,
      exec: instance.config && instance.config.exec ? instance.config.exec : { mode: 'workflow', size: 3 },
      artifactRoot: instance.artifact_root,
      executionRoot: instance.execution_root,
      currentStage: instance.current_stage,
      status: instance.status,
      config: instance.config,
      createdAt: instance.created_at,
      updatedAt: instance.updated_at
    },
    stages,
    decisions: detail.decisions.map((decision) => ({ kind: decision.kind, targetStage: decision.target_stage, note: decision.note, at: decision.at })),
    events: detail.events.slice(-300).map((event) => ({ seq: event.seq, type: event.type, time: event.time, data: event.data ?? null })),
    lastEventSeq: detail.lastEventSeq,
    thread
  }
}

function boardActionsFor(card) {
  // Compact action set for the board card (no drawer needed for these).
  const actions = []
  if (card.currentStageStatus === 'running' || card.currentStageStatus === 'paused') actions.push('thread')
  if (card.currentStageStatus === 'awaiting-confirmation') {
    actions.push('thread')
    const def = STAGE_DEFS[card.currentStage]
    if (def) actions.push('confirm')
  }
  if (card.currentStageStatus === 'awaiting-user') actions.push('answer')
  return actions
}

// ---- tool + plugin ----------------------------------------------------------

export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'tool:speckit_sdd',
    order: 117,
    text:
      'Use the speckit_sdd tool to create a Speckit Feature workbench instance and start its Specify stage ' +
      '(spec-driven development, DESIGN-V0.8). It does NOT run the full pipeline: stages advance only through ' +
      'the workbench board with explicit human confirmations. For a single speckit phase use the matching speckit-* skill directly.'
  })

  const ledger = new Ledger()
  const orchestrator = new Orchestrator({ ledger })
  const threads = new StageThreads({ ctx, ledger, orchestrator, config: { provider: 'spawn' } })

  const disposeTool = ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description:
        'Create a Speckit feature workbench instance in a speckit-initialized project and start its Specify stage as a background thread. Returns immediately with the instance id so the user can continue on the workbench board (stages advance only on explicit human confirmation). Speckit skills are bundled with the plugin; the project only needs the spec-kit .specify skeleton.',
      parameters: {
        feature: {
          type: 'string',
          required: true,
          description: 'Natural-language description of the feature to build.'
        },
        projectPath: {
          type: 'string',
          description: 'Optional absolute path of the speckit-initialized project; defaults to the current session project.'
        },
        useWorktrees: {
          type: 'boolean',
          description: 'Create/reuse a git worktree after Specify (default true).'
        },
        runChecklist: {
          type: 'boolean',
          description: 'Run the optional Checklist stage (default true).'
        },
        runAnalyze: {
          type: 'boolean',
          description: 'Run the optional Analyze stage (default true).'
        },
        runTaskstoissues: {
          type: 'boolean',
          description: 'Run the optional Taskstoissues (GitHub) stage (default false).'
        },
        model: {
          type: 'string',
          description: 'Optional model id override for all stage threads (default: inherit session route).'
        },
        provider: {
          type: 'string',
          description: 'Optional provider id override paired with model.'
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            instanceId: { type: 'string', required: true },
            stageId: { type: 'string', required: true },
            stageStatus: { type: 'string' },
            threadId: { type: 'string' }
          }
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) throw new Error('speckit_sdd requires a calling agent')
        const root = resolveProjectRoot(typeof args.projectPath === 'string' ? args.projectPath : undefined, projectCwd(agent))
        await ensureProjectSkills(root)
        const issues = checkProject(root)
        if (issues.length > 0) throw new Error(`selected project is not speckit-ready (${root}):\n- ${issues.join('\n- ')}`)
        const config = {}
        if (args.useWorktrees === false) config.useWorktrees = false
        if (args.runChecklist === false) config.runChecklist = false
        if (args.runAnalyze === false) config.runAnalyze = false
        if (args.runTaskstoissues === true) config.runTaskstoissues = true
        if (typeof args.provider === 'string' && args.provider) config.provider = args.provider
        if (typeof args.model === 'string' && args.model) config.model = args.model
        config.parentSessionId = agent.id
        const created = orchestrator.createInstance({ workspacePath: root, feature: String(args.feature), config })
        const instance = ledger.transaction((tx) => ledger.getInstance(tx, created.instanceId))
        const stageRow = await threads.spawnStage({ instance, parentAgent: agent, stageRow: ledger.transaction((tx) => ledger.getStage(tx, created.stageRowId)) })
        return {
          instanceId: created.instanceId,
          stageId: created.stageId,
          stageRowId: created.stageRowId,
          stageStatus: stageRow.status,
          threadId: stageRow.thread_id
        }
      }
    })
  )

  // Idle-edge processing: when any stage thread finishes a turn, advance the
  // ledger (awaiting-user / awaiting-confirmation / failed). Mirrors the
  // proven agent/status event wiring used by dsh-agent-teams. Wrapped so a
  // composition without this event can never take the whole plugin down.
  let disposeStatus = null
  try {
    disposeStatus = ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle' || !agent || !agent.id) return
      const found = ledger.transaction((tx) => {
        const stage = typeof ledger.findStageByThread === 'function' ? ledger.findStageByThread(tx, agent.id) : null
        if (stage) {
          const instance = ledger.getInstance(tx, stage.instance_id)
          return instance ? { instance, stage } : null
        }
        return null
      })
      if (!found) return
      threads.processIdle({ instance: found.instance, stageRow: found.stage }).catch((error) => {
        ctx.logger.warn(`speckit-workflow: idle processing failed for ${agent.id}: ${String((error && error.message) || error)}`)
      })
    })
  } catch (error) {
    ctx.logger.warn(`dsh-speckit-workflow: agent/status listener unavailable (stage idle will be picked up on recovery): ${String((error && error.message) || error)}`)
    disposeStatus = null
  }

  // The RPC body reader + router.
  const MAX_BODY_BYTES = 2 * 1024 * 1024
  const readJsonBody = async (req) => {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('request body too large')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.length === 0) return {}
    return JSON.parse(text)
  }

  const handleRpc = async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      send(400, errorResult(error))
      return
    }
    if (!body || typeof body !== 'object') {
      send(400, { ok: false, error: { code: 'bad-request', message: 'request body must be an object' } })
      return
    }
    const endpoint = typeof body.endpoint === 'string' ? body.endpoint : ''
    const sessionId = typeof body.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null
    try {
      if (!sessionId) throw new Error('sessionId is required')
      const value = await rpcHandler(ctx, body, ledger, orchestrator, threads, sessionId)
      send(200, value)
    } catch (error) {
      send(200, errorResult(error))
    }
  }

  const disposeRoute = ctx.webServer.register({
    kind: 'exact',
    path: RPC_CHANNEL,
    handler: handleRpc
  })

  // ---- durable bundle route ---------------------------------------------------
  // 即使动态插件（spkbw-1）在重启后尚未重建，工作台 bundle 依然可从主通道同源
  // 路径加载；前端/动态客户端优先使用该路径，失败再回退 /api/dsh-spkb-web/board.js。
  const BOARD_BUNDLE_PATH = (() => {
    try {
      return fileURLToPath(new URL('../web/bundle-dist/board.js', import.meta.url))
    } catch {
      return null
    }
  })()
  let boardBundleCache = null
  let boardBundleMtime = 0
  const loadBoardBundle = async () => {
    if (!BOARD_BUNDLE_PATH || !existsSync(BOARD_BUNDLE_PATH)) return null
    const mtime = statSync(BOARD_BUNDLE_PATH).mtimeMs
    if (boardBundleCache === null || mtime !== boardBundleMtime) {
      boardBundleCache = await readFile(BOARD_BUNDLE_PATH, 'utf8')
      boardBundleMtime = mtime
    }
    return boardBundleCache
  }
  const disposeBoardRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-speckit-workflow/board.js',
    handler: async (req, res) => {
      let body = null
      try {
        body = await loadBoardBundle()
      } catch (error) {
        body = `// board bundle error: ${String((error && error.message) || error)}`
      }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(body || '// board bundle not found')
    }
  })

  // Recover dangling ledger state on mount (threads are durable and survive
  // restarts; only the in-process listener is new).
  const recoveryTimer = setTimeout(() => {
    threads.recover().catch((error) => {
      ctx.logger.warn(`speckit-workflow: mount recovery failed: ${String((error && error.message) || error)}`)
    })
  }, 1200)

  return ctx.effect(() => async () => {
    clearTimeout(recoveryTimer)
    try { if (typeof disposeTool === 'function') await disposeTool() } catch (error) {
      ctx.logger.warn(`dsh-speckit-workflow: tool cleanup failed: ${String((error && error.message) || error)}`)
    }
    try { if (typeof disposeBoardRoute === 'function') await disposeBoardRoute() } catch { /* noop */ }
    try { if (typeof disposeRoute === 'function') await disposeRoute() } catch (error) {
      ctx.logger.warn(`dsh-speckit-workflow: route cleanup failed: ${String((error && error.message) || error)}`)
    }
    try { if (typeof disposeStatus === 'function') disposeStatus() } catch { /* noop */ }
    try { if (ledger.db) ledger.db.close() } catch { /* noop */ }
  }, 'dsh-speckit-workflow: dispose')
}

export { Ledger, Orchestrator, StageThreads }

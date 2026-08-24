// dsh-speckit-workflow v0.8 — instance/stage orchestrator.
//
// Pure state machine over the SQLite ledger (DESIGN-V0.8 §3/§5/§6). It has no
// knowledge of threads or model calls: thread plumbing lives in threads.js and
// is injected as a `runner` for the moments that must cross a transaction
// boundary (spawn after confirm, followup after answer). Every state
// transition is a single ledger transaction; every user mutation is deduped
// by `actionId` (idempotency, not button disabling).
//
// Key rules implemented:
// - Stages never auto-advance: a completed stage sits at awaiting-confirmation
//   until the user confirms the handoff.
// - Clarify/Converge are interactive: the thread returns to awaiting-user for
//   answers and only reaches awaiting-confirmation when the interaction ends.
// - Re-executing a stage creates a NEW attempt and marks downstream stages
//   stale (their results may no longer reflect the new upstream).
// - One workspace runs at most one active stage at a time (workspace_locks).
// - Optional stages can be skipped with a recorded reason; skipping never
//   fabricates a pass.
// - Install/fail handling never leaves a half-state: a 'creating' stage is
//   always resolved to running (thread bound) or failed (retryable).
//
// The orchestrator never reads artifact *bodies* — it only records artifact
// metadata (paths + sha256) that the host materializes from the filesystem.

import { newId } from './db.js'
import { STAGE_ORDER, STAGE_DEFS, STAGE_COLUMN, STALE_AFTER, nextStage, defaultFlowConfig } from './stages.js'

const ACTIVE_STATUSES = new Set(['creating', 'running', 'awaiting-user', 'awaiting-confirmation'])
const TERMINAL_STATUSES = new Set(['completed', 'skipped', 'cancelled', 'failed', 'stale'])

export class OrchestratorError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

export class Orchestrator {
  /**
   * @param {object} deps
   * @param {import('./db.js').Ledger} deps.ledger
   */
  constructor({ ledger }) {
    this.ledger = ledger
  }

  now() {
    return new Date().toISOString()
  }

  event(instanceId, type, data, threadId) {
    return { instance_id: instanceId, type, data, thread_id: threadId ?? null, time: Date.now() }
  }

  // ---------------------------------------------------------------- 创建

  /**
   * Create a feature instance and open its first stage (Specify) as 'creating'.
   * The caller binds the thread afterwards via activateStage().
   * @param {object} input { workspacePath, feature, config? }
   * @returns {{ instanceId, stageRowId, stageId }}
   */
  createInstance(input) {
    const workspacePath = String(input.workspacePath || '').trim()
    const feature = String(input.feature || '').trim()
    if (!workspacePath) throw new OrchestratorError('bad-request', 'workspacePath is required')
    if (!feature) throw new OrchestratorError('bad-request', 'feature description is required')
    const config = defaultFlowConfig(input.config)
    const now = this.now()
    const instanceId = newId('wf-')
    const stageId = 'specify'
    let stageRowId = 0
    this.ledger.transaction((tx) => {
      this.ledger.insertInstance(tx, {
        instance_id: instanceId,
        workspace_path: workspacePath,
        feature_name: feature,
        feature_dir: null,
        branch: null,
        worktree_path: null,
        mode: 'inplace',
        artifact_root: workspacePath,
        execution_root: workspacePath,
        current_stage: stageId,
        status: 'active',
        config,
        created_at: now,
        updated_at: now
      })
      stageRowId = this.ledger.insertStage(tx, {
        instance_id: instanceId,
        stage_id: stageId,
        attempt: 1,
        status: 'creating',
        column: STAGE_COLUMN.get(stageId),
        started_at: now
      })
      // The workspace lock is acquired as soon as the active stage row exists,
      // so two instances can never race to become the active stage. A
      // constraint violation here rolls back the whole creation atomically.
      const acquired = this.ledger.tryAcquireLock(tx, instanceId, workspacePath, stageId, stageRowId)
      if (!acquired) {
        const holder = this.ledger.lockFor(tx, workspacePath)
        throw new OrchestratorError(
          'workspace-busy',
          `该工作区已有活动阶段 ${holder ? `${holder.instance_id}/${holder.stage_id}` : '（未知）'}。同一工作区同时只能运行一个活动阶段，请先确认/取消该阶段。`
        )
      }
      this.ledger.appendEvents(tx, [
        this.event(instanceId, 'instance-created', { workspacePath, feature }),
        this.event(instanceId, 'stage-creating', { stageId, attempt: 1, stageRowId })
      ])
      this.ledger.insertDecision(tx, { instance_id: instanceId, kind: 'created', note: feature, at: now })
    })
    return { instanceId, stageRowId, stageId }
  }

  // ---------------------------------------------------------- 阶段激活

  /**
   * Bind a just-created stage row to a live thread and make it the active
   * stage, acquiring the workspace lock. Called after the runner spawned the
   * thread. Throws OrchestratorError('workspace-busy') if another instance's
   * active stage already holds the workspace.
   */
  activateStage(instanceId, stageRowId, { threadId, skillId, skillSha256, inputSnapshot }) {
    const now = this.now()
    return this.ledger.transaction((tx) => {
      const stage = this.ledger.getStage(tx, stageRowId)
      if (!stage || stage.instance_id !== instanceId) throw new OrchestratorError('not-found', 'stage not found')
      if (stage.status === 'running') return { ok: true, idempotent: true }
      const instance = this.ledger.getInstance(tx, instanceId)
      if (!instance) throw new OrchestratorError('not-found', 'instance not found')
      // The lock is normally acquired at stage-creation; re-acquire it when
      // binding a stage that predates this plugin process (restart recovery).
      const held = this.ledger.lockFor(tx, instance.workspace_path)
      if (held && !(held.instance_id === instanceId && held.stage_row === stageRowId)) {
        throw new OrchestratorError(
          'workspace-busy',
          `该工作区已有活动阶段 ${held.instance_id}/${held.stage_id}。同一工作区同时只能运行一个活动阶段。`
        )
      }
      if (!held || held.stage_row !== stageRowId) {
        const acquired = this.ledger.tryAcquireLock(tx, instanceId, instance.workspace_path, stage.stage_id, stageRowId)
        if (!acquired) {
          const other = this.ledger.lockFor(tx, instance.workspace_path)
          throw new OrchestratorError(
            'workspace-busy',
            `该工作区已有活动阶段 ${other ? `${other.instance_id}/${other.stage_id}` : '（未知）'}。同一工作区同时只能运行一个活动阶段。`
          )
        }
      }
      stage.thread_id = threadId
      stage.status = 'running'
      stage.started_at = stage.started_at || now
      stage.skill_id = skillId ?? null
      stage.skill_sha256 = skillSha256 ?? null
      if (inputSnapshot !== undefined) stage.input_snapshot = JSON.stringify(inputSnapshot)
      this.ledger.updateStage(tx, stage)
      instance.current_stage = stage.stage_id
      instance.updated_at = now
      this.ledger.updateInstance(tx, instance)
      this.ledger.appendEvents(tx, [
        this.event(instanceId, 'stage-running', { stageId: stage.stage_id, attempt: stage.attempt, threadId }, threadId)
      ])
      return { ok: true }
    })
  }

  /** Mark a stage row failed (thread spawn error, protocol violation, …). */
  failStage(instanceId, stageRowId, error) {
    const now = this.now()
    return this.ledger.transaction((tx) => {
      const stage = this.ledger.getStage(tx, stageRowId)
      if (!stage || stage.instance_id !== instanceId) throw new OrchestratorError('not-found', 'stage not found')
      if (TERMINAL_STATUSES.has(stage.status)) return { ok: true, idempotent: true }
      const instance = this.ledger.getInstance(tx, instanceId)
      if (instance) {
        this.ledger.releaseLock(tx, instance.workspace_path)
        instance.current_stage = stage.stage_id
        instance.updated_at = now
        this.ledger.updateInstance(tx, instance)
      }
      stage.status = 'failed'
      stage.ended_at = now
      stage.error = typeof error === 'string' ? error : (error && error.message) || String(error)
      this.ledger.updateStage(tx, stage)
      this.ledger.appendEvents(tx, [this.event(instanceId, 'stage-failed', { stageId: stage.stage_id, attempt: stage.attempt, error: stage.error }, stage.thread_id)])
      return { ok: true }
    })
  }

  // ------------------------------------------------------- 线程回合结束

  /**
   * A stage thread finished a turn (idle edge or restart re-evaluation).
   * Reads nothing from disk here — the caller passes the parsed thread state
   * (state.json content) plus the artifact metadata discovered from disk.
   * The orchestrator decides where the stage lands:
   *   - interactive + 'asking'/'findings' -> awaiting-user
   *   - interactive + 'done'              -> awaiting-confirmation
   *   - non-interactive + 'done'          -> awaiting-confirmation
   *   - 'error' / unknown                 -> failed
   * @param {object} input
   * @param {string} input.instanceId
   * @param {number} input.stageRowId
   * @param {object} input.threadState parsed state.json {status, question?, findings?, summary?, artifacts?}
   * @param {Array<{rel:string, root:string, absPath?:string}>} [input.artifacts] file metadata discovered on disk
   */
  processThreadTurn({ instanceId, stageRowId, threadState, artifacts }) {
    const now = this.now()
    return this.ledger.transaction((tx) => {
      const stage = this.ledger.getStage(tx, stageRowId)
      if (!stage || stage.instance_id !== instanceId) throw new OrchestratorError('not-found', 'stage not found')
      if (TERMINAL_STATUSES.has(stage.status)) return { ok: true, idempotent: true, status: stage.status }
      const def = STAGE_DEFS[stage.stage_id]
      const state = threadState && typeof threadState === 'object' ? threadState : {}
      const statusRaw = typeof state.status === 'string' ? state.status : ''

      let next = 'failed'
      let failReason = null
      if (statusRaw === 'error') {
        failReason = typeof state.note === 'string' ? state.note : (typeof state.error === 'string' ? state.error : '阶段线程报告了错误')
      } else if (statusRaw === 'done') {
        next = 'awaiting-confirmation'
      } else if (statusRaw === 'asking' || statusRaw === 'findings') {
        // 任意阶段（不只 interactive）都可以在回合里向用户提问/要决策——
        // 例如 implement 的 checklist 门禁、converge 的决策。进入 awaiting-user 等回答。
        next = 'awaiting-user'
      } else {
        failReason = `阶段线程未按协议输出状态（state.status=${JSON.stringify(statusRaw)}）`
      }

      stage.state_json = JSON.stringify(state)
      if (stage.stage_id === 'converge' && statusRaw === 'done' && typeof state.action === 'string' && state.action.length > 0) {
        stage.output = JSON.stringify({ action: state.action, summary: typeof state.summary === 'string' ? state.summary : null })
      } else if (statusRaw === 'done' && typeof state.summary === 'string') {
        stage.summary = state.summary
      }
      // Pending interaction is surfaced to the client through the same state.
      if (next === 'awaiting-confirmation') {
        for (const artifact of artifacts || []) {
          if (!artifact || typeof artifact.rel !== 'string') continue
          this.ledger.insertArtifact(tx, {
            instance_id: instanceId,
            stage_row: stageRowId,
            rel: artifact.rel,
            root: artifact.root || '',
            abs_path: artifact.absPath || null,
            sha256: artifact.sha256 || null
          })
        }
        stage.ended_at = now
      }

      if (next === 'failed') {
        const instance = this.ledger.getInstance(tx, instanceId)
        if (instance) this.ledger.releaseLock(tx, instance.workspace_path)
        stage.status = 'failed'
        stage.ended_at = now
        stage.error = failReason
        this.ledger.updateStage(tx, stage)
        this.ledger.appendEvents(tx, [
          this.event(instanceId, 'stage-failed', { stageId: stage.stage_id, attempt: stage.attempt, error: failReason }, stage.thread_id)
        ])
        return { ok: true, status: 'failed' }
      }

      stage.status = next
      this.ledger.updateStage(tx, stage)
      if (next === 'awaiting-confirmation') {
        this.ledger.appendEvents(tx, [
          this.event(instanceId, 'stage-awaiting-confirmation', { stageId: stage.stage_id, attempt: stage.attempt }, stage.thread_id)
        ])
      } else {
        this.ledger.appendEvents(tx, [
          this.event(instanceId, 'stage-awaiting-user', { stageId: stage.stage_id, attempt: stage.attempt, question: state.question || null, findings: state.findings || [] }, stage.thread_id)
        ])
      }
      return { ok: true, status: next }
    })
  }

  // ------------------------------------------------------------- 交接

  /**
   * User confirms a stage handoff. Atomic: validates the current stage is
   * awaiting-confirmation (or completed), freezes it (completed/skipped),
   * computes the next stage, creates its 'creating' row. The caller then
   * spawns the next thread and calls activateStage(). Returns the next stage
   * draft; the workspace lock is released for the current and will be
   * re-acquired when the next thread activates.
   */
  confirmStage(instanceId, stageRowId, { actionId, next, skip }) {
    return this.advance(instanceId, stageRowId, { actionId, next, skip })
  }

  /**
   * Shared advance: freeze the given stage row and create the next stage.
   * @param {boolean} skip current stage is skipped (optional stage), recorded
   *   with a reason instead of being marked completed.
   */
  advance(instanceId, stageRowId, { actionId, next, skip, reason }) {
    const now = this.now()
    return this.ledger.transaction((tx) => {
      const action = this.ledger.claimAction(tx, actionId, instanceId)
      if (!action.fresh) {
        return { idempotent: true, result: action.result }
      }
      const stage = this.ledger.getStage(tx, stageRowId)
      if (!stage || stage.instance_id !== instanceId) throw new OrchestratorError('not-found', 'stage not found')
      const instance = this.ledger.getInstance(tx, instanceId)
      if (!instance) throw new OrchestratorError('not-found', 'instance not found')
      if (!ACTIVE_STATUSES.has(stage.status) && stage.status !== 'completed' && stage.status !== 'skipped') {
        throw new OrchestratorError('invalid-state', `当前阶段状态 ${stage.status} 不允许交接`)
      }
      const def = STAGE_DEFS[stage.stage_id]
      const freezeAs = skip === true ? 'skipped' : 'completed'
      stage.status = freezeAs
      stage.ended_at = stage.ended_at || now
      if (skip === true) {
        stage.summary = stage.summary || (typeof reason === 'string' && reason.length > 0 ? `已跳过（${reason}）` : '已跳过')
      }
      this.ledger.updateStage(tx, stage)
      this.ledger.releaseLock(tx, instance.workspace_path)

      if (freezeAs === 'skipped') {
        this.ledger.insertDecision(tx, { instance_id: instanceId, stage_row: stageRowId, kind: 'skip', target_stage: stage.stage_id, note: reason || null, at: now })
        this.ledger.appendEvents(tx, [this.event(instanceId, 'stage-skipped', { stageId: stage.stage_id, attempt: stage.attempt, reason: reason || null }, stage.thread_id)])
      } else {
        this.ledger.insertDecision(tx, { instance_id: instanceId, stage_row: stageRowId, kind: 'confirm', target_stage: next || null, note: typeof reason === 'string' && reason.length > 0 ? reason : null, at: now })
        this.ledger.appendEvents(tx, [this.event(instanceId, 'stage-confirmed', { stageId: stage.stage_id, attempt: stage.attempt }, stage.thread_id)])
      }

      const resulting = buildNextStage(this, tx, instance, stage, { next, skip })
      const result = resulting ? { nextStageId: resulting.stageId, stageRowId: resulting.stageRowId, attempt: resulting.attempt } : { nextStageId: null, stageRowId: null, attempt: null, instanceCompleted: true }
      this.ledger.completeAction(tx, actionId, result)
      return { idempotent: false, result }
    })
  }

  // ------------------------------------------------------------ 重做/回退

  /**
   * Re-run a stage as a NEW attempt, keeping old attempts as history. Marks
   * every downstream stage stale (their results may no longer reflect the
   * re-run upstream). The caller spawns a fresh thread for attempt+1.
   */
  rerunStage(instanceId, stageId, { actionId, reason, targetAttempt, staleFrom }) {
    const now = this.now()
    return this.ledger.transaction((tx) => {
      const action = this.ledger.claimAction(tx, actionId, instanceId)
      if (!action.fresh) return { idempotent: true, result: action.result }
      const instance = this.ledger.getInstance(tx, instanceId)
      if (!instance) throw new OrchestratorError('not-found', 'instance not found')
      if (!STAGE_DEFS[stageId]) throw new OrchestratorError('bad-request', `unknown stage '${stageId}'`)
      const latest = this.ledger.latestAttempt(tx, instanceId, stageId)
      const attempt = targetAttempt && targetAttempt > latest ? targetAttempt : latest + 1
      // The target (or an upstream of it) may currently own the workspace.
      const holder = this.ledger.lockFor(tx, instance.workspace_path)
      if (holder) {
        if (holder.instance_id !== instanceId) {
          throw new OrchestratorError('workspace-busy', `该工作区已有活动阶段 ${holder.instance_id}/${holder.stage_id}，无法重跑 ${stageId}`)
        }
        // Same instance. Rerunning a stage that is NOT the lock holder means an
        // upstream restart: deprecate the currently-held stage unless it is
        // actively executing a live thread (that would race with the new run).
        if (holder.stage_id !== stageId) {
          const holderRow = this.ledger.getStage(tx, holder.stage_row)
          if (holderRow && holderRow.status === 'running') {
            throw new OrchestratorError(
              'workspace-busy',
              `该工作区正在执行阶段 ${holder.stage_id}（线程 ${holderRow.thread_id || ''}），无法同时重跑 ${stageId}。请先等待或取消 ${holder.stage_id}。`
            )
          }
          if (holderRow && holderRow.status !== 'stale') {
            holderRow.status = 'stale'
            holderRow.stale_reason = reason || `上游 ${stageId} 被重新执行，当前阶段过期`
            holderRow.ended_at = holderRow.ended_at || now
            this.ledger.updateStage(tx, holderRow)
          }
        }
      }
      this.ledger.releaseLock(tx, instance.workspace_path)
      const stageRowId = this.ledger.insertStage(tx, {
        instance_id: instanceId,
        stage_id: stageId,
        attempt,
        status: 'creating',
        column: STAGE_COLUMN.get(stageId),
        started_at: now
      })
      markDownstreamStale(this.ledger, tx, instanceId, stageId, reason || '上游阶段被重新执行，下游结果可能过期', now, staleFrom)
      instance.current_stage = stageId
      instance.updated_at = now
      this.ledger.updateInstance(tx, instance)
      this.ledger.insertDecision(tx, { instance_id: instanceId, stage_row: stageRowId, kind: 'rerun', target_stage: stageId, note: reason || null, at: now })
      this.ledger.appendEvents(tx, [this.event(instanceId, 'stage-rerun', { stageId, attempt, reason: reason || null })])
      const result = { stageId, stageRowId, attempt, staleFrom: staleFrom || STALE_AFTER[stageId] || [] }
      this.ledger.completeAction(tx, actionId, result)
      return { idempotent: false, result }
    })
  }

  /**
   * Return to the previous stage from a failed/blocked stage: re-run the
   * stage that precedes the given one as a new attempt and mark everything
   * from the given stage onward stale. If stageId is the first stage, re-runs
   * itself.
   */
  rollbackStage(instanceId, currentStageId, { actionId, reason }) {
    const index = STAGE_ORDER.indexOf(currentStageId)
    if (index < 0) throw new OrchestratorError('bad-request', `unknown stage '${currentStageId}'`)
    const target = index === 0 ? currentStageId : STAGE_ORDER[index - 1]
    return this.rerunStage(instanceId, target, {
      actionId,
      reason: reason || `从 ${currentStageId} 返回上阶段重跑`,
      staleFrom: STAGE_ORDER.slice(Math.max(0, index - 1))
    })
  }

  // ------------------------------------------------------------ 交互

  /**
   * Deliver one user answer/decision to an interactive stage thread
   * (awaiting-user). Marks the stage running again and hands the text back;
   * the caller must followup() the thread.
   */
  answerStage(instanceId, stageRowId, { actionId, text, kind }) {
    const now = this.now()
    return this.ledger.transaction((tx) => {
      const action = this.ledger.claimAction(tx, actionId, instanceId)
      if (!action.fresh) return { idempotent: true, result: action.result }
      const stage = this.ledger.getStage(tx, stageRowId)
      if (!stage || stage.instance_id !== instanceId) throw new OrchestratorError('not-found', 'stage not found')
      if (stage.status !== 'awaiting-user') {
        throw new OrchestratorError('invalid-state', `阶段状态 ${stage.status} 不能接收回答（仅 awaiting-user）`)
      }
      stage.status = 'running'
      this.ledger.updateStage(tx, stage)
      this.ledger.insertDecision(tx, {
        instance_id: instanceId, stage_row: stageRowId, kind: kind || 'answer',
        target_stage: stage.stage_id, note: typeof text === 'string' ? text.slice(0, 2000) : null, at: now
      })
      this.ledger.appendEvents(tx, [this.event(instanceId, 'stage-answered', { stageId: stage.stage_id, attempt: stage.attempt }, stage.thread_id)])
      const result = { stageRowId, threadId: stage.thread_id }
      this.ledger.completeAction(tx, actionId, result)
      return { idempotent: false, result }
    })
  }

  // ------------------------------------------------------------ 暂停/继续

  /**
   * Pause a running stage thread (user "暂停", or restart recovery when a
   * mid-turn thread was orphaned by a process death). The thread is
   * interrupted by the caller AFTER this transaction commits, so the idle
   * edge never mistakes an interrupted turn for a protocol failure. The
   * workspace lock stays held: the stage is only held, not cancelled.
   * Resuming delivers a followup on the SAME thread, so no work is lost.
   */
  pauseStage(instanceId, stageRowId, { actionId, reason } = {}) {
    const now = this.now()
    return this.ledger.transaction((tx) => {
      const action = this.ledger.claimAction(tx, actionId, instanceId)
      if (!action.fresh) return { idempotent: true, result: action.result }
      const stage = this.ledger.getStage(tx, stageRowId)
      if (!stage || stage.instance_id !== instanceId) throw new OrchestratorError('not-found', 'stage not found')
      if (stage.status !== 'running') {
        throw new OrchestratorError('invalid-state', `阶段状态 ${stage.status} 不能暂停（仅运行中的阶段可暂停）`)
      }
      stage.status = 'paused'
      this.ledger.updateStage(tx, stage)
      this.ledger.insertDecision(tx, {
        instance_id: instanceId, stage_row: stageRowId, kind: 'pause',
        target_stage: stage.stage_id, note: reason || '用户暂停线程', at: now
      })
      this.ledger.appendEvents(tx, [this.event(instanceId, 'stage-paused', { stageId: stage.stage_id, attempt: stage.attempt }, stage.thread_id)])
      const result = { stageRowId, threadId: stage.thread_id, status: 'paused' }
      this.ledger.completeAction(tx, actionId, result)
      return { idempotent: false, result }
    })
  }

  /**
   * Resume a paused stage: mark it running again (the caller delivers a
   * followup to the same thread, which wakes it and lets it finish its turn).
   */
  resumeStage(instanceId, stageRowId, { actionId, reason } = {}) {
    const now = this.now()
    return this.ledger.transaction((tx) => {
      const action = this.ledger.claimAction(tx, actionId, instanceId)
      if (!action.fresh) return { idempotent: true, result: action.result }
      const stage = this.ledger.getStage(tx, stageRowId)
      if (!stage || stage.instance_id !== instanceId) throw new OrchestratorError('not-found', 'stage not found')
      if (stage.status !== 'paused') {
        throw new OrchestratorError('invalid-state', `阶段状态 ${stage.status} 不能恢复（仅已暂停的阶段可恢复）`)
      }
      stage.status = 'running'
      stage.ended_at = null
      this.ledger.updateStage(tx, stage)
      this.ledger.insertDecision(tx, {
        instance_id: instanceId, stage_row: stageRowId, kind: 'resume',
        target_stage: stage.stage_id, note: reason || '用户继续执行线程', at: now
      })
      this.ledger.appendEvents(tx, [this.event(instanceId, 'stage-resumed', { stageId: stage.stage_id, attempt: stage.attempt }, stage.thread_id)])
      const result = { stageRowId, threadId: stage.thread_id, status: 'running' }
      this.ledger.completeAction(tx, actionId, result)
      return { idempotent: false, result }
    })
  }

  // ------------------------------------------------------------ 取消

  /**
   * Revert a stage that was just flipped to 'running' back to awaiting-user
   * (e.g. a user answer could not be delivered to its thread). Preserves the
   * last recorded state (question/findings) so the user can retry.
   */
  revertStage(instanceId, stageRowId, { to = 'awaiting-user' } = {}) {
    return this.ledger.transaction((tx) => {
      const stage = this.ledger.getStage(tx, stageRowId)
      if (!stage || stage.instance_id !== instanceId) throw new OrchestratorError('not-found', 'stage not found')
      if (stage.status !== 'running') return { ok: true, idempotent: true }
      stage.status = to
      this.ledger.updateStage(tx, stage)
      this.ledger.appendEvents(tx, [this.event(instanceId, 'stage-reverted', { stageId: stage.stage_id, attempt: stage.attempt, to }, stage.thread_id)])
      return { ok: true }
    })
  }

  /**
   * Cancel the current stage (and optionally the whole instance). Releases
   * the workspace lock. The caller interrupts the thread if it is live.
   */
  cancelStage(instanceId, stageRowId, { actionId, cancelInstance }) {
    const now = this.now()
    return this.ledger.transaction((tx) => {
      const action = this.ledger.claimAction(tx, actionId, instanceId)
      if (!action.fresh) return { idempotent: true, result: action.result }
      const stage = this.ledger.getStage(tx, stageRowId)
      if (!stage || stage.instance_id !== instanceId) throw new OrchestratorError('not-found', 'stage not found')
      if (!TERMINAL_STATUSES.has(stage.status)) {
        stage.status = 'cancelled'
        stage.ended_at = now
        this.ledger.updateStage(tx, stage)
      }
      const instance = this.ledger.getInstance(tx, instanceId)
      if (instance) {
        this.ledger.releaseLock(tx, instance.workspace_path)
        if (cancelInstance === true) {
          instance.status = 'cancelled'
          instance.current_stage = stage.stage_id
          instance.updated_at = now
          this.ledger.updateInstance(tx, instance)
        }
      }
      this.ledger.insertDecision(tx, { instance_id: instanceId, stage_row: stageRowId, kind: 'cancel', target_stage: stage.stage_id, note: cancelInstance === true ? '取消整个实例' : null, at: now })
      this.ledger.appendEvents(tx, [this.event(instanceId, cancelInstance === true ? 'instance-cancelled' : 'stage-cancelled', { stageId: stage.stage_id, attempt: stage.attempt }, stage.thread_id)])
      const result = { stageRowId, cancelled: true, cancelInstance: cancelInstance === true }
      this.ledger.completeAction(tx, actionId, result)
      return { idempotent: false, result }
    })
  }

  // ------------------------------------------------------------- 查询

  /** Board projection: lightweight card per instance. */
  board(workspacePath) {
    return this.ledger.transaction((tx) => {
      const instances = this.ledger.listInstances(tx, workspacePath)
      return instances.map((instance) => {
        const stages = this.ledger.listStages(tx, instance.instance_id)
        const active = stages
          .filter((stage) => stage.status === 'running' || stage.status === 'awaiting-user' || stage.status === 'awaiting-confirmation' || stage.status === 'creating' || stage.status === 'paused')
          .sort((a, b) => b.attempt - a.attempt)[0]
        return {
          instanceId: instance.instance_id,
          workspacePath: instance.workspace_path,
          feature: instance.feature_name,
          featureDir: instance.feature_dir,
          branch: instance.branch,
          worktreePath: instance.worktree_path,
          mode: instance.mode,
          exec: instance.config && instance.config.exec ? instance.config.exec : { mode: 'workflow', size: 3 },
          status: instance.status,
          currentStage: active ? active.stage_id : (instance.current_stage || instance.current_stage),
          currentStageStatus: active ? active.status : null,
          // Active stage DB row id — lets the board card wire confirm/delete
          // actions directly (no drawer round-trip needed).
          currentStageRowId: active ? active.id : null,
          column: active ? STAGE_COLUMN.get(active.stage_id) : columnOf(instance),
          createdAt: instance.created_at,
          updatedAt: instance.updated_at
        }
      })
    })
  }

  /**
   * Delete a whole Feature instance ("删除实例" on the board card). Cancels the
   * active stage (if any), releases the workspace lock, and marks the instance
   * `cancelled`. Idempotent by `actionId`. This is the host half of the card's
   * delete button; it mirrors cancelStage(..., { cancelInstance: true }) but
   * resolves the active stage row itself so callers don't need it.
   */
  cancelInstance(instanceId, { actionId }) {
    const now = this.now()
    return this.ledger.transaction((tx) => {
      const action = this.ledger.claimAction(tx, actionId, instanceId)
      if (!action.fresh) return { idempotent: true, result: action.result }
      const instance = this.ledger.getInstance(tx, instanceId)
      if (!instance) throw new OrchestratorError('not-found', 'instance not found')
      const stages = this.ledger.listStages(tx, instanceId)
      const active = stages
        .filter((stage) => ['running', 'awaiting-user', 'awaiting-confirmation', 'creating', 'paused'].includes(stage.status))
        .sort((a, b) => b.attempt - a.attempt)[0]
      if (active && !TERMINAL_STATUSES.has(active.status)) {
        active.status = 'cancelled'
        active.ended_at = now
        this.ledger.updateStage(tx, active)
      }
      this.ledger.releaseLock(tx, instance.workspace_path)
      instance.status = 'cancelled'
      instance.current_stage = active ? active.stage_id : instance.current_stage
      instance.updated_at = now
      this.ledger.updateInstance(tx, instance)
      this.ledger.insertDecision(tx, {
        instance_id: instanceId,
        stage_row: active ? active.id : null,
        kind: 'cancel',
        target_stage: active ? active.stage_id : null,
        note: '取消整个实例',
        at: now
      })
      this.ledger.appendEvents(tx, [
        this.event(instanceId, 'instance-cancelled', { stageId: active ? active.stage_id : null, attempt: active ? active.attempt : null })
      ])
      const result = { cancelled: true, cancelInstance: true }
      this.ledger.completeAction(tx, actionId, result)
      return { idempotent: false, result }
    })
  }

  /** Full instance detail for the drawer/workbench. */
  detail(instanceId) {
    return this.ledger.transaction((tx) => {
      const instance = this.ledger.getInstance(tx, instanceId)
      if (!instance) return null
      const stages = this.ledger.listStages(tx, instanceId)
      const artifacts = this.ledger.listArtifacts(tx, instanceId)
      const decisions = this.ledger.listDecisions(tx, instanceId)
      const events = this.ledger.eventsSince(tx, instanceId, -1)
      const perStage = stages.map((stage) => ({
        ...stage,
        artifacts: artifacts.filter((artifact) => artifact.stage_row === stage.id)
      }))
      return {
        instance,
        stages: perStage,
        decisions,
        events: events.slice(-400),
        lastEventSeq: events.length > 0 ? events[events.length - 1].seq : -1
      }
    })
  }

  /** Latest attempt row for a stage. */
  currentStageRow(instanceId, stageId) {
    return this.ledger.transaction((tx) => {
      const attempt = this.ledger.latestAttempt(tx, instanceId, stageId)
      return attempt > 0 ? this.ledger.getStageByKey(tx, instanceId, stageId, attempt) : null
    })
  }
}

// ---- helpers ----------------------------------------------------------------

/**
 * Compute the next stage after freezing the current one and create its
 * 'creating' row. Handles optional-stage config, the post-converge return to
 * the implementation loop, and skipped stages.
 */
function buildNextStage(orchestrator, tx, instance, fromStage, { next, skip }) {
  const now = orchestrator.now()
  const config = instance.config || {}
  let stageId = null
  if (skip === true) {
    // Skipping an optional stage advances to its natural successor.
    stageId = nextStage(fromStage.stage_id)
  } else if (typeof next === 'string' && next.length > 0) {
    stageId = next
  } else if (fromStage.stage_id === 'converge') {
    // Converge handing off: read the recorded action; 'append' returns to the
    // implementation loop (Implement), otherwise the instance is done.
    const output = fromStage.output
    const action = output && typeof output === 'object' ? output.action : null
    if (action === 'append') {
      stageId = 'implement'
    } else {
      instance.status = 'completed'
      instance.current_stage = 'converge'
      instance.updated_at = now
      orchestrator.ledger.updateInstance(tx, instance)
      orchestrator.ledger.insertDecision(tx, { instance_id: instance.instance_id, kind: 'converged', target_stage: 'converge', note: '确认收敛并结束', at: now })
      orchestrator.ledger.appendEvents(tx, [orchestrator.event(instance.instance_id, 'instance-completed', {})])
      return null
    }
  } else {
    stageId = nextStage(fromStage.stage_id)
  }

  // Skip optional stages that are configured off (record the skip, advance).
  let guard = 0
  while (stageId && STAGE_DEFS[stageId].optional && !stageEnabled(config, stageId)) {
    const off = stageId
    const row = orchestrator.ledger.insertStage(tx, {
      instance_id: instance.instance_id,
      stage_id: off,
      attempt: 1,
      status: 'skipped',
      column: STAGE_COLUMN.get(off),
      started_at: now,
      ended_at: now,
      summary: '已跳过（流程配置关闭）'
    })
    orchestrator.ledger.insertDecision(tx, { instance_id: instance.instance_id, stage_row: row, kind: 'skip', target_stage: off, note: '流程配置关闭', at: now })
    orchestrator.ledger.appendEvents(tx, [orchestrator.event(instance.instance_id, 'stage-skipped', { stageId: off, attempt: 1, reason: '流程配置关闭' })])
    stageId = nextStage(off)
    if (++guard > 16) break
  }
  if (!stageId) {
    // Linear graph reached the end without a converge handoff target — treat
    // as completed (should not normally happen; converge handles the end).
    instance.status = 'completed'
    instance.updated_at = now
    orchestrator.ledger.updateInstance(tx, instance)
    return null
  }
  const attempt = orchestrator.ledger.latestAttempt(tx, instance.instance_id, stageId) + 1
  const stageRowId = orchestrator.ledger.insertStage(tx, {
    instance_id: instance.instance_id,
    stage_id: stageId,
    attempt,
    status: 'creating',
    column: STAGE_COLUMN.get(stageId),
    started_at: now
  })
  // The next active stage holds the workspace lock for its whole lifecycle
  // (creating -> running -> awaiting-* -> terminal). A busy workspace rolls
  // back the entire confirm atomically, leaving the current stage untouched.
  const acquired = orchestrator.ledger.tryAcquireLock(tx, instance.instance_id, instance.workspace_path, stageId, stageRowId)
  if (!acquired) {
    const holder = orchestrator.ledger.lockFor(tx, instance.workspace_path)
    throw new OrchestratorError(
      'workspace-busy',
      `该工作区已有活动阶段 ${holder ? `${holder.instance_id}/${holder.stage_id}` : '（未知）'}。同一工作区同时只能运行一个活动阶段。`
    )
  }
  // If the converged instance returned to implement as a NEW loop, make sure
  // stale flags reflect that the design intent changed. Otherwise just note.
  instance.current_stage = stageId
  instance.updated_at = now
  orchestrator.ledger.updateInstance(tx, instance)
  orchestrator.ledger.appendEvents(tx, [orchestrator.event(instance.instance_id, 'stage-creating', { stageId, attempt, stageRowId })])
  return { stageId, stageRowId, attempt }
}

function stageEnabled(config, stageId) {
  switch (stageId) {
    case 'checklist':
      return config.runChecklist !== false
    case 'analyze':
      return config.runAnalyze !== false
    case 'taskstoissues':
      return config.runTaskstoissues === true
    default:
      return true
  }
}

function markDownstreamStale(ledger, tx, instanceId, fromStageId, reason, now, staleFromOverride) {
  const staleIds = staleFromOverride || STALE_AFTER[fromStageId] || []
  const stageRowIds = []
  for (const stage of ledger.listStages(tx, instanceId)) {
    const isSupersededRerun = stage.stage_id === fromStageId && (stage.status === 'completed' || stage.status === 'awaiting-confirmation')
    if (isSupersededRerun || (staleIds.includes(stage.stage_id) && (stage.status === 'completed' || stage.status === 'awaiting-confirmation' || stage.status === 'failed' || stage.status === 'stale'))) {
      stage.status = 'stale'
      stage.stale_reason = reason
      stage.ended_at = stage.ended_at || now
      ledger.updateStage(tx, stage)
      stageRowIds.push(stage.id)
    }
  }
  if (stageRowIds.length > 0) ledger.markArtifactsStale(tx, stageRowIds)
}

function columnOf(instance) {
  // Instance with no active stage: column derived from the last non-null stage
  // the instance reached is handled by the caller; default to specify.
  return 'specify'
}

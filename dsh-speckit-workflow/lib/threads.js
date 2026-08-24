// dsh-speckit-workflow v0.8 — stage thread execution.
//
// Each stage is one DURABLE CONTINUABLE SUBAGENT (a DSH thread), spawned from
// the calling session agent as parent. A stage thread:
//   - has a persona composed from the vendored skill's SKILL.md + the stage
//     execution protocol + the workflow-instance context (never the previous
//     thread's full chat — only structured prior-stage summaries/artifacts),
//   - works its turn and, before ending, writes a machine-readable state file
//     (state.json) so the orchestrator can advance the ledger on the
//     `agent/status` idle edge,
//   - for interactive stages (Clarify/Converge) returns to `awaiting-user`
//     after each question and is resumed by `followup()` with the user's
//     answer on the SAME thread (multi-round in-thread interaction).
//
// Design decisions (documented against DESIGN-V0.8 §11):
//   - threads use independent agent sessions (not a workflow engine run),
//     because Clarify/Converge need the same thread to carry the conversation
//     across user answers;
//   - skill version + input snapshot are pinned per stage row at spawn;
//   - the worktree handoff after Specify (DESIGN-V0.8 §4.2) runs here because
//     it must happen before any downstream stage can be confirmed.

import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join } from 'node:path'
import { STAGE_DEFS } from './stages.js'
import { collectArtifacts, syncFeatureArtifacts, verifyFeatureJson, findWorktreePath } from './worktree.js'

function bundledSkillsDir() {
  try {
    return fileURLToPath(new URL('../skills/', import.meta.url))
  } catch {
    return null
  }
}

function loadBundledSkill(skillId) {
  const dir = bundledSkillsDir()
  if (!dir) return null
  try {
    return readFileSync(join(dir, skillId, 'SKILL.md'), 'utf8')
  } catch {
    return null
  }
}

export function stateFileFor(workspacePath, instanceId, stageId, attempt) {
  return join(workspacePath, '.dsh', 'speckit-workflow', 'instances', instanceId, 'stages', `${stageId}-${attempt}.state.json`)
}

export class StageThreads {
  /**
   * @param {object} deps
   * @param {import('@deepseek-ai/cordis').Context} deps.ctx plugin context
   * @param {import('./db.js').Ledger} deps.ledger
   * @param {import('./orchestrator.js').Orchestrator} deps.orchestrator
   * @param {object} deps.config { provider?: string } subagent provider (default 'spawn')
   */
  constructor({ ctx, ledger, orchestrator, config = {} }) {
    this.ctx = ctx
    this.ledger = ledger
    this.orchestrator = orchestrator
    this.provider = config.provider || 'spawn'
    this.subagents = ctx.subagents
    // Host contract (`@deepseek-ai/dsh-subagent`) requires a defined AbortSignal:
    // `startContinuable`/`followup` call `spec.signal.throwIfAborted()` without
    // optional chaining, so passing `undefined` throws
    // "Cannot read properties of undefined (reading 'throwIfAborted')".
    // This signal owns admission only until inbox acceptance; it is never
    // aborted during normal operation (a single lifetime-scoped signal is
    // sufficient and gives a real cancellation handle for future teardown).
    this._signal = new AbortController().signal
  }

  bundledSkill(skillId) {
    return loadBundledSkill(skillId)
  }

  /** Project-synced (possibly overridden) skill source, else bundled. */
  async skillSource(workspacePath, skillId) {
    const projectPath = join(workspacePath, '.dsh', 'speckit-workflow', 'skills', skillId, 'SKILL.md')
    try {
      const source = await readFile(projectPath, 'utf8')
      if (source && source.trim().length > 0) return source
    } catch {
      /* fall through to bundled */
    }
    const bundled = this.bundledSkill(skillId)
    if (bundled) return bundled
    throw new Error(`阶段线程缺少技能 ${skillId}（项目与插件内置均未找到 SKILL.md）`)
  }

  // ------------------------------------------------------------ prompt

  /**
   * Compose the stage thread prompt: persona + protocol + structured context.
   * @returns {{ persona: string, prompt: string, skillSha256: string }}
   */
  async composeStage({ instance, stageDef, priorStages }) {
    const skillSource = await this.skillSource(instance.workspace_path, stageDef.skill)
    const skillSha256 = createHash('sha256').update(skillSource).digest('hex')
    const stateFile = stateFileFor(instance.workspace_path, instance.instance_id, stageIdOf(stageDef), stageDef.attempt)

    const persona = [
      `You are the execution thread for stage "${stageDef.stage_id}" of a Speckit feature workbench running inside DeepSeek Harness.`,
      `Stage: ${stageDef.title}（${stageDef.skill}）`,
      `Instance: ${instance.instance_id}`,
      `Workspace: ${instance.workspace_path}`,
      `Execution root: ${instance.execution_root || instance.workspace_path} — ALL of your file work happens inside this directory.`,
      `Mode: ${instance.mode === 'isolated' ? 'isolated worktree（产物与代码在 worktree 中）' : 'inplace（直接在主工作区）'}`,
      '',
      `You follow the vendored Spec Kit skill below. It is the authoritative behavior for this stage.`,
      '',
      `---- SKILL: ${stageDef.skill} ----`,
      skillSource,
      `---- END SKILL ----`
    ].join('\n')

    const context = this.contextBlock(instance, priorStages)
    const protocol = protocolBlock(stateFile, stageDef)
    const prompt = [
      `Now execute the ${stageDef.skill} stage for this feature.`,
      '',
      context,
      '',
      protocol,
      '',
      `Begin working now. Use your file tools inside the execution root. When you reach an interaction or completion point defined by the protocol, write the state file and end your turn.`
    ].join('\n')

    return { persona, prompt, skillSha256 }
  }

  contextBlock(instance, priorStages) {
    const lines = ['## Workflow instance context', `- Feature: ${instance.feature_name}`]
    if (instance.feature_dir) lines.push(`- Feature directory: specs/${instance.feature_dir}`)
    if (instance.branch) lines.push(`- Branch: ${instance.branch}`)
    if (instance.worktree_path) lines.push(`- Worktree: ${instance.worktree_path}`)
    lines.push('')
    lines.push('## Prior stages (structured — do not assume any conversation history)')
    const prior = (priorStages || []).reverse()
    if (prior.length === 0) {
      lines.push('(no prior stages)')
    } else {
      for (const stage of prior) {
        lines.push(`- ${stage.stage_id}#${stage.attempt} [${stage.status}] ${stage.summary || ''}`)
        const artifacts = (stage.artifacts || []).slice(0, 12)
        if (artifacts.length > 0) {
          for (const artifact of artifacts) lines.push(`    artifact: ${artifact.rel}`)
        }
      }
    }
    return lines.join('\n')
  }

  // ------------------------------------------------------------- spawn

  /** Resolve the subagent provider and check capabilities. */
  providerDescriptor() {
    const provider = this.subagents.getProvider(this.provider)
    if (provider === undefined) {
      const names = typeof this.subagents.list === 'function' ? (this.subagents.list() || []) : []
      throw new Error(`dsh-speckit-workflow: no subagent provider "${this.provider}" is registered (available: ${names.join(', ') || 'none'})`)
    }
    if (typeof provider.prepareContinuable !== 'function' || !provider.capabilities?.persona || !provider.capabilities?.toolFilter) {
      throw new Error(`dsh-speckit-workflow: provider "${this.provider}" does not support continuable stage threads (needs persistable sessions + persona + tool filter)`)
    }
    return provider
  }

  /** Resolve the model route for an explicit override, else inherit. */
  async resolveRoute(instance) {
    const cfg = (instance.config || {})
    const provider = typeof cfg.provider === 'string' && cfg.provider.trim() ? cfg.provider.trim() : null
    const model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : null
    if (!provider && !model) return null
    if (!provider || !model) throw new Error('阶段模型必须同时指定 provider 与 model')
    try {
      const llm = this.ctx.get('llm')
      const resolved = await llm.resolveCallConfig({ provider, model, ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}) }, undefined)
      return {
        provider: String(resolved.provider),
        model: String(resolved.model),
        ...(resolved.reasoningEffort !== undefined && resolved.reasoningEffort !== null ? { reasoningEffort: String(resolved.reasoningEffort) } : {})
      }
    } catch (error) {
      throw new Error(`阶段模型解析失败（${provider}/${model}）: ${String((error && error.message) || error)}`)
    }
  }

  /**
   * Spawn the thread for a 'creating' stage row and bind it via activateStage.
   * @param {object} input { instance, parentAgent, stageRow }
   * @returns {Promise<import('./db.js').Ledger>} resolved stage row
   */
  async spawnStage({ instance, parentAgent, stageRow }) {
    const stageDef = { ...STAGE_DEFS[stageRow.stage_id], stage_id: stageRow.stage_id, attempt: stageRow.attempt }
    const prior = this.priorStageRows(instance.instance_id, stageRow.id)
    const composed = await this.composeStage({ instance, stageDef, priorStages: prior })
    const route = await this.resolveRoute(instance)
    this.providerDescriptor()

    const label = `speckit-stage:${instance.instance_id}:${stageRow.stage_id}:${stageRow.attempt}`
    const toolFilter = { deny: [TOOL_NAME_DENY] }
    const stateFile = stateFileFor(instance.workspace_path, instance.instance_id, stageRow.stage_id, stageRow.attempt)
    const request = {
      prompt: [{ type: 'text', text: composed.prompt }],
      parent: parentAgent,
      persona: composed.persona,
      toolFilter,
      agentOptions: route ? { provider: route.provider, model: route.model } : undefined
    }
    const start = await this.subagents.startContinuable({ provider: this.provider, label, request, signal: this._signal })
    const threadId = start.childId
    try {
      this.orchestrator.activateStage(instance.instance_id, stageRow.id, {
        threadId,
        skillId: stageDef.skill,
        skillSha256: composed.skillSha256,
        inputSnapshot: {
          persona: composed.persona,
          prompt: composed.prompt,
          skillId: stageDef.skill,
          skillSha256: composed.skillSha256,
          route,
          stateFile,
          composedAt: new Date().toISOString()
        }
      })
    } catch (error) {
      // Release the just-spawned thread if the ledger refused the bind.
      try { await this.subagents.interrupt(threadId, { kind: 'plugin' }); } catch { /* best effort */ }
      throw error
    }
    return this.orchestrator.currentStageRow(instance.instance_id, stageRow.stage_id)
  }

  /** Prior stage rows (excluding the current row) for prompt context. */
  priorStageRows(instanceId, currentStageRowId) {
    return this.ledger.transaction((tx) => {
      const stages = this.ledger.listStages(tx, instanceId)
      return stages
        .filter((stage) => stage.id !== currentStageRowId && stage.status !== 'stale' && stage.status !== 'skipped')
        .map((stage) => ({
          stage_id: stage.stage_id,
          attempt: stage.attempt,
          status: stage.status,
          summary: stage.summary,
          artifacts: this.ledger.artifactsForStage(tx, stage.id).map((artifact) => ({ rel: artifact.rel, stale: artifact.stale }))
        }))
        .slice(-12)
    })
  }

  // ------------------------------------------------------------- await

  /**
   * Deliver a user answer/decision into an interactive stage thread.
   * @param {object} input { instance, parentAgent, stageRow, text, kind, actionId }
   */
  async answer({ instance, parentAgent, stageRow, text, kind, actionId }) {
    const res = this.orchestrator.answerStage(instance.instance_id, stageRow.id, { actionId: actionId || newActionId(), text, kind })
    if (res.idempotent) return { delivered: false, idempotent: true }
    try {
      await this.followup(parentAgent, stageRow.thread_id, text, 'user-answer')
    } catch (error) {
      this.orchestrator.revertStage(instance.instance_id, stageRow.id, { to: 'awaiting-user' })
      throw error
    }
    return { delivered: true }
  }

  /** Resume a stage thread with a message (must be its parent). */
  async followup(parentAgent, threadId, text, label) {
    if (!parentAgent) throw new Error('阶段线程所在的父会话已不可用，无法投递消息')
    try {
      await this.subagents.followup(parentAgent, threadId, [{ type: 'text', text }], {
        source: { kind: 'plugin', plugin: 'dsh-speckit-workflow', form: 'relay' },
        signal: this._signal
      })
    } catch (error) {
      this.ctx?.logger?.warn(`speckit-workflow: followup ${label} to ${threadId} failed: ${String(error)}`)
      throw error
    }
  }

  /** Best-effort interrupt of a stage thread (mirrors agent-teams usage). */
  async interrupt(threadId, parentAgent) {
    if (!threadId) return
    try {
      if (parentAgent) {
        await this.subagents.interrupt(threadId, { kind: 'ancestor', agent: parentAgent })
      } else {
        await this.subagents.interrupt(threadId, { kind: 'plugin' })
      }
    } catch {
      /* best effort */
    }
  }

  // --------------------------------------------------------- idle edge

  /**
   * One stage thread finished a turn (agent/status idle, or mount recovery).
   * Reads state.json + artifacts and advances the ledger. Public so the
   * index.js agent/status listener and the mount recovery both call it.
   * @param {object} input { instance, stageRow, parentAgent? }
   */
  async processIdle({ instance, stageRow, parentAgent }) {
    if (stageRow.status !== 'running' && stageRow.status !== 'awaiting-user') return { ok: true, ignored: true }
    const stateFile = stateFileFor(instance.workspace_path, instance.instance_id, stageRow.stage_id, stageRow.attempt)
    let state = null
    try {
      state = JSON.parse(await readFile(stateFile, 'utf8'))
    } catch {
      state = null
    }
    const executionRoot = instance.execution_root || instance.workspace_path
    const rels = state && Array.isArray(state.artifacts) ? state.artifacts.map((entry) => (typeof entry === 'string' ? entry : entry && entry.rel)).filter(Boolean) : []
    const artifacts = await collectArtifacts(executionRoot, rels)
    const result = this.orchestrator.processThreadTurn({
      instanceId: instance.instance_id,
      stageRowId: stageRow.id,
      threadState: state,
      artifacts: artifacts.map((artifact) => ({ rel: artifact.rel, root: executionRoot, absPath: artifact.absPath, sha256: artifact.sha256 }))
    })
    if (result.status === 'awaiting-confirmation' && stageRow.stage_id === 'specify') {
      await this.performWorktreeHandoff(instance.instance_id, stageRow.id, parentAgent)
    }
    return { ok: true, status: result.status }
  }

  /**
   * The Specify → worktree artifact handoff (DESIGN-V0.8 §4.2). Runs once the
   * Specify stage has reached awaiting-confirmation. Binds artifactRoot /
   * executionRoot for all downstream stages.
   */
  async performWorktreeHandoff(instanceId, stageRowId, parentAgent) {
    const instance = this.ledger.transaction((tx) => this.ledger.getInstance(tx, instanceId))
    if (!instance) return
    const stage = this.ledger.transaction((tx) => this.ledger.getStage(tx, stageRowId))
    const state = (stage && stage.state_json) || {}
    const config = instance.config || {}

    const useWorktrees = config.useWorktrees !== false && state.worktree !== false
    if (!useWorktrees) {
      this.ledger.transaction((tx) => {
        const fresh = this.ledger.getInstance(tx, instanceId)
        fresh.mode = 'inplace'
        fresh.artifact_root = fresh.workspace_path
        fresh.execution_root = fresh.workspace_path
        fresh.updated_at = new Date().toISOString()
        this.ledger.updateInstance(tx, fresh)
        this.ledger.appendEvents(tx, [this.orchestrator.event(instanceId, 'worktree-inplace', {})])
      })
      return
    }

    const branch = state.branch || null
    let worktreePath = typeof state.worktreePath === 'string' && state.worktreePath.trim() ? state.worktreePath.trim() : null
    if (!worktreePath && branch) worktreePath = await findWorktreePath(instance.workspace_path, branch)
    if (!worktreePath || !isAbsolute(worktreePath) || !existsSync(worktreePath)) {
      this.orchestrator.failStage(instanceId, stageRowId, 'Specify 未创建可用的 worktree（state.worktreePath 缺失或不可用）。请重跑 Specify（或关闭 worktree 走原地模式）。')
      return
    }
    const featureDir = state.featureDir || (state.feature ? String(state.feature).split('/').filter(Boolean).pop() : null)
    try {
      await syncFeatureArtifacts({
        workspaceRoot: instance.workspace_path,
        worktreePath,
        featureDir,
        extraRels: Array.isArray(state.extensionArtifacts) ? state.extensionArtifacts : []
      })
      const issues = await verifyFeatureJson(worktreePath, { featureDir, branch })
      if (issues.length > 0) {
        this.orchestrator.failStage(instanceId, stageRowId, issues.join('；'))
        return
      }
    } catch (error) {
      this.orchestrator.failStage(instanceId, stageRowId, `产物交接失败: ${String((error && error.message) || error)}`)
      return
    }
    this.ledger.transaction((tx) => {
      const fresh = this.ledger.getInstance(tx, instanceId)
      fresh.mode = 'isolated'
      fresh.worktree_path = worktreePath
      fresh.branch = branch || fresh.branch
      fresh.feature_dir = featureDir || fresh.feature_dir
      fresh.artifact_root = worktreePath
      fresh.execution_root = worktreePath
      fresh.updated_at = new Date().toISOString()
      this.ledger.updateInstance(tx, fresh)
      this.ledger.appendEvents(tx, [this.orchestrator.event(instanceId, 'worktree-bound', { worktreePath, branch, featureDir })])
    })
  }

  // ---------------------------------------------------------- recovery

  /**
   * On plugin mount: reconcile dangling ledger state with reality.
   *  - 'creating' rows (crash between confirm and thread bind) → failed.
   *  - running/awaiting-user rows whose thread is idle or gone → re-run the
   *    idle edge so awaiting-interaction completes without losing the queue.
   * Active live threads (status running) are left alone.
   */
  async recover() {
    const rows = this.ledger.transaction((tx) => {
      const instances = this.ledger.listInstances(tx)
      const result = []
      for (const instance of instances) {
        if (instance.status !== 'active') continue
        for (const stage of this.ledger.listStages(tx, instance.instance_id)) {
          if (stage.status === 'creating' || stage.status === 'running' || stage.status === 'awaiting-user') {
            result.push({ instance, stage })
          }
        }
      }
      return result
    })
    for (const { instance, stage } of rows) {
      if (stage.status === 'creating') {
        // no thread was ever bound — the confirm committed but the spawn never
        // happened (process died). Fail it so the board shows a retryable error.
        this.orchestrator.failStage(instance.instance_id, stage.id, '线程创建中断（进程重启于确认之后、线程绑定之前）。点击重试重新执行本阶段。')
        continue
      }
      const live = stage.thread_id ? this.ctx.agents.get(stage.thread_id) : undefined
      if (live && live.status === 'running') continue
      // idle or resumable-but-stopped — process the state file again.
      try {
        await this.processIdle({ instance, stageRow: stage })
      } catch (error) {
        this.ctx?.logger?.warn(`speckit-workflow: recovery idle processing failed for ${stage.id}: ${String(error)}`)
      }
    }
  }

  // ----------------------------------------------------------- projection

  /**
   * Project a stage thread's message history for the workbench UI.
   * Uses the child session event log (message-level only).
   * @returns {Promise<Array<{who:'user'|'assistant', text:string, at:number}>>}
   */
  async threadMessages(threadId) {
    if (!threadId) return []
    const agent = this.ctx.agents.get(threadId)
    if (!agent || !agent.session || !Array.isArray(agent.session.events)) return []
    const out = []
    for (const event of agent.session.events) {
      if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      // user/message 的文本在 data.content；assistant/message 的文本在 data.message.content。
      let content = Array.isArray(data.content) ? data.content : null
      if (!content && data.message && Array.isArray(data.message.content)) content = data.message.content
      if (!Array.isArray(content)) continue
      const text = content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim()
      if (text.length === 0) continue
      out.push({ who: event.type === 'user/message' ? 'user' : 'assistant', text, at: typeof event.time === 'number' ? event.time : 0 })
    }
    return out.slice(-160)
  }
}

function protocolBlock(stateFile, stageDef) {
  const interactive = stageDef.interactive === true
  const lines = [
    '## 阶段线程执行协议（必须遵守）',
    `1. 你的所有文件读写都发生在 execution root 内。`,
    `2. 你必须在本回合结束前，把执行状态以 JSON 写入：`,
    `\`\`\`\n${stateFile}\n\`\`\``,
    `3. state.json 字段与取值：`,
    `   {`,
    `     "status": "done" | "asking" | "findings" | "error",`,
    `     "question": "<仅交互阶段：本回合提出的一个具体问题，一次只问一个>",`,
    `     "findings": [{ "severity":"CRITICAL|HIGH|MEDIUM|LOW", "kind":"missing|partial|contradicts|unrequested", "title":"..", "detail":".." }],`,
    `     "action": "<仅 converge 结束：append | converged>",`,
    `     "summary": "<本阶段完成摘要（给用户确认交接用）>",`,
    `     "artifacts": [ { "rel": "<相对 execution root 的产物路径>" } ]`,
    `   }`
  ]
  if (interactive) {
    lines.push('', `4. 你是交互阶段（${stageDef.stage_id}）：`)
    if (stageDef.stage_id === 'clarify') {
      lines.push(
        `   - 按技能要求扫描 spec.md，每次只问一个最高影响的问题。`,
        `   - 写完（若有）spec 变更并把 {"status":"asking","question":"..."} 写入 state.json 后，结束本回合等待用户回答。`,
        `   - 用户回答会作为你的下一条消息到达。验证答案 → 立即写回 spec.md 的 ## Clarifications 与对应章节 → 继续提问下一个或写 {"status":"done","summary":...}。`,
        `   - 用户回复 "done" / "stop" / "proceed" 时结束交互，写 {"status":"done"}。`,
        `   - 不要用猜测替代用户回答；未回答时保持 questioning。`
      )
    } else {
      lines.push(
        `   - 按技能要求检查实现与 spec/plan/tasks 的差距并分类（missing/partial/contradicts/unrequested）与分级（CRITICAL/HIGH/MEDIUM/LOW）。`,
        `   - 先把 {"status":"findings","findings":[...],"summary":"..."} 写入 state.json 并结束回合，等待用户决策，不要直接改 tasks.md。`,
        `   - 收到用户决策：追加任务 → 把任务写回 tasks.md 并写 {"status":"done","action":"append",...}；用户确认无遗留 → 写 {"status":"done","action":"converged"}。`,
        `   - 绝不修改 spec / plan / 代码；只能追加 tasks.md。`
      )
    }
  } else {
    lines.push('', `4. 完成技能要求的全部工作后，写 {"status":"done","summary":"...","artifacts":[..]} 并结束本回合。`)
    lines.push(`   - 不要自行进入下一阶段，也不要继续执行后续阶段；阶段交接由用户在工作台确认。`)
    if (stageDef.stage_id === 'specify') {
      lines.push(
        `   - 除 preset skill 产物外，若项目启用了 worktree：按 worktrees-create 技能创建/复用 feature worktree，并把 `,
        `   {"worktree":true,"worktreePath":"<绝对路径>","branch":"<branchname>","featureDir":"<NNN-shortname>","extensionArtifacts":[..]} `,
        `   同时写入 state.json；worktree 不可用或用户要求原地时写 {"worktree":false}。`
      )
    }
    if (stageDef.stage_id === 'taskstoissues') {
      lines.push(`   - 该阶段是外部副作用：先确认 git remote 为 GitHub URL 并去重，只为没有对应 issue 的任务建 issue。失败时写 {"status":"error","note":..}，不要伪造成功，也不影响本地 tasks.md。`)
    }
    if (stageDef.stage_id === 'analyze') {
      lines.push(`   - 只读分析，绝不修改任何文件。`)
    }
  }
  lines.push('', '5. 若遇到不可恢复的阻塞，写 {"status":"error","note":"<说明>"}。', '6. state.json 不是聊天内容，只是机器可读的执行状态。')
  return lines.join('\n')
}

function stageIdOf(stageDef) {
  return stageDef.stage_id
}

let actionSeq = 0
function newActionId() {
  actionSeq += 1
  return `a-${Date.now().toString(36)}-${(Math.random() * 46656).toString(36).slice(-4)}-${actionSeq}`
}

const TOOL_NAME_DENY = 'speckit_sdd'

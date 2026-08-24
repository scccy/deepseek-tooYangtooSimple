#!/usr/bin/env node
// dsh-speckit-workflow v0.8 — pure-machine smoke suite (no DSH host needed).
//
// Exercises the SQLite ledger + orchestrator + stage graph + thread prompt
// protocol against BOTH backends (built-in sqlite when available, JSON dev
// backend). Anything depending on @deepseek-ai/* or a live context is out of
// scope; threads.js's prompt/state helpers are tested directly.
//
// Run: node scripts/machine-smoke.mjs

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert'
import { Ledger } from '../lib/db.js'
import { Orchestrator, OrchestratorError } from '../lib/orchestrator.js'
import { STAGE_ORDER, STAGE_DEFS, COLUMNS, nextStage, permittedActions } from '../lib/stages.js'
import { stateFileFor } from '../lib/threads.js'

let passed = 0
let failed = 0
function ok(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n    ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n    ') : error}`)
  }
}

function freshLedger(useJson) {
  const dir = mkdtempSync(join(tmpdir(), 'spkb-smoke-'))
  const path = join(dir, useJson ? 'wf.json' : 'wf.db')
  return new Ledger({ path, forceJson: useJson })
}

function harness(useJson) {
  const ledger = freshLedger(useJson)
  const orchestrator = new Orchestrator({ ledger })
  return { ledger, orchestrator }
}

function advanceTo(orch, ledger, instanceId, stageId, threadId) {
  const row = orch.currentStageRow(instanceId, stageId)
  assert(row, `stage ${stageId} row should exist`)
  orchestratorBind(orch, ledger, instanceId, row.id, threadId)
  orch.processThreadTurn({ instanceId, stageRowId: row.id, threadState: { status: 'done', summary: stageId }, artifacts: [] })
  return row
}

function orchestratorBind(orch, ledger, instanceId, rowId, threadId) {
  assert.doesNotThrow(() => orch.activateStage(instanceId, rowId, { threadId, skillId: 'speckit-x', skillSha256: 'abc' }), 'bind should succeed')
}

function runCommon(useJson) {
  const { ledger, orchestrator: orch } = harness(useJson)
  const label = useJson ? 'json' : 'sqlite'
  console.log(`-- ${label} backend --`)
  ok(`${label}: stage graph is complete and ordered`, () => {
    assert.deepStrictEqual(STAGE_ORDER, ['specify', 'clarify', 'plan', 'checklist', 'tasks', 'analyze', 'taskstoissues', 'implement', 'converge'])
    assert.strictEqual(COLUMNS.length, 4)
    assert.deepStrictEqual(COLUMNS.map((c) => c.id), ['specify', 'clarify', 'implement', 'converge'])
    assert.strictEqual(nextStage('converge'), undefined)
    assert.strictEqual(nextStage('implement'), 'converge')
  })
  ok(`${label}: workspace busy blocks a second concurrent instance`, () => {
    const a = orch.createInstance({ workspacePath: '/ws-busy', feature: 'f1' })
    assert.throws(() => orch.createInstance({ workspacePath: '/ws-busy', feature: 'f2' }), (error) => error.code === 'workspace-busy')
    assert.strictEqual(orch.board('/ws-busy').length, 1, 'failed creation must roll back atomically')
  })
  ok(`${label}: specify -> awaiting-confirmation, no auto-advance`, () => {
    const a = orch.createInstance({ workspacePath: '/ws-spec', feature: 'f1' })
    const row = orch.currentStageRow(a.instanceId, 'specify')
    orchestratorBind(orch, ledger, a.instanceId, row.id, 'th-spec')
    const res = orch.processThreadTurn({ instanceId: a.instanceId, stageRowId: row.id, threadState: { status: 'done', summary: 'spec' }, artifacts: [{ rel: 'specs/001/spec.md', root: '/ws', sha256: 'h' }] })
    assert.strictEqual(res.status, 'awaiting-confirmation')
    const detail = orch.detail(a.instanceId)
    assert.strictEqual(detail.instance.current_stage, 'specify')
    assert.strictEqual(detail.stages[0].artifacts.length, 1)
  })
  ok(`${label}: confirm creates the next stage in one transaction (idempotent)`, () => {
    const a = orch.createInstance({ workspacePath: '/ws-conf', feature: 'f' })
    const row = orch.currentStageRow(a.instanceId, 'specify')
    orchestratorBind(orch, ledger, a.instanceId, row.id, 't1')
    orch.processThreadTurn({ instanceId: a.instanceId, stageRowId: row.id, threadState: { status: 'done' }, artifacts: [] })
    const confirm = orch.confirmStage(a.instanceId, row.id, { actionId: 'cf-c0', next: 'clarify' })
    assert.strictEqual(confirm.result.nextStageId, 'clarify')
    assert.strictEqual(confirm.result.attempt, 1)
    const again = orch.confirmStage(a.instanceId, row.id, { actionId: 'cf-c0' })
    assert.strictEqual(again.idempotent, true)
    assert.strictEqual(again.result.nextStageId, 'clarify')
    const detail = orch.detail(a.instanceId)
    assert.strictEqual(detail.stages.find((s) => s.stage_id === 'specify').status, 'completed')
  })
  ok(`${label}: clarify is interactive — ask -> answer -> done`, () => {
    const a = orch.createInstance({ workspacePath: '/ws-clar', feature: 'f' })
    const row = orch.currentStageRow(a.instanceId, 'specify')
    orchestratorBind(orch, ledger, a.instanceId, row.id, 't1')
    orch.processThreadTurn({ instanceId: a.instanceId, stageRowId: row.id, threadState: { status: 'done' }, artifacts: [] })
    const clar = orch.confirmStage(a.instanceId, row.id, { actionId: 'cl-c0', next: 'clarify' })
    orchestratorBind(orch, ledger, a.instanceId, clar.result.stageRowId, 'th-clar')
    const q = orch.processThreadTurn({ instanceId: a.instanceId, stageRowId: clar.result.stageRowId, threadState: { status: 'asking', question: '登录方式?', answered: 0 }, artifacts: [] })
    assert.strictEqual(q.status, 'awaiting-user')
    const ans = orch.answerStage(a.instanceId, clar.result.stageRowId, { actionId: 'cl-a1', text: '邮箱密码' })
    assert.strictEqual(ans.result.threadId, 'th-clar')
    const d = orch.processThreadTurn({ instanceId: a.instanceId, stageRowId: clar.result.stageRowId, threadState: { status: 'done', summary: 'done', answered: 1 }, artifacts: [] })
    assert.strictEqual(d.status, 'awaiting-confirmation')
  })
  ok(`${label}: interactive stage rejects answers outside awaiting-user`, () => {
    const a = orch.createInstance({ workspacePath: '/ws-reject', feature: 'f' })
    const row = orch.currentStageRow(a.instanceId, 'specify')
    orchestratorBind(orch, ledger, a.instanceId, row.id, 't1')
    assert.throws(() => orch.answerStage(a.instanceId, row.id, { actionId: 'rj-x1', text: 'go' }), (error) => error.code === 'invalid-state')
  })
  ok(`${label}: optional stages are skipped by config with a recorded reason`, () => {
    const a = orch.createInstance({ workspacePath: '/ws-skip', feature: 'f', config: { runChecklist: false, runAnalyze: false } })
    const row = orch.currentStageRow(a.instanceId, 'specify')
    orchestratorBind(orch, ledger, a.instanceId, row.id, 't1')
    orch.processThreadTurn({ instanceId: a.instanceId, stageRowId: row.id, threadState: { status: 'done' }, artifacts: [] })
    const c0 = orch.confirmStage(a.instanceId, row.id, { actionId: 'sk-c0' })
    assert.strictEqual(c0.result.nextStageId, 'clarify')
    const c1 = orch.confirmStage(a.instanceId, c0.result.stageRowId, { actionId: 'sk-c1' })
    assert.strictEqual(c1.result.nextStageId, 'plan')
    const c2 = orch.confirmStage(a.instanceId, c1.result.stageRowId, { actionId: 'sk-c2' })
    assert.strictEqual(c2.result.nextStageId, 'tasks', 'checklist should auto-skip when off')
    const detail = orch.detail(a.instanceId)
    assert.ok(detail.stages.some((s) => s.stage_id === 'checklist' && s.status === 'skipped'))
    assert.ok(detail.decisions.some((d2) => d2.kind === 'skip' && d2.target_stage === 'checklist'))
  })
  ok(`${label}: rerunning a stage creates a new attempt and marks old+downstream stale`, () => {
    const a = orch.createInstance({ workspacePath: '/ws-rerun', feature: 'f' })
    const row = orch.currentStageRow(a.instanceId, 'specify')
    orchestratorBind(orch, ledger, a.instanceId, row.id, 't1')
    orch.processThreadTurn({ instanceId: a.instanceId, stageRowId: row.id, threadState: { status: 'done' }, artifacts: [] })
    const clar = orch.confirmStage(a.instanceId, row.id, { actionId: 'rr-conf' })
    orchestratorBind(orch, ledger, a.instanceId, clar.result.stageRowId, 't2')
    // clarify asks its first question and waits (idle at awaiting-user).
    orch.processThreadTurn({ instanceId: a.instanceId, stageRowId: clar.result.stageRowId, threadState: { status: 'asking', question: 'scope?' }, artifacts: [] })
    const rr = orch.rerunStage(a.instanceId, 'specify', { actionId: 'rr1', reason: '改需求' })
    assert.strictEqual(rr.result.attempt, 2)
    const detail = orch.detail(a.instanceId)
    const oldSpec = detail.stages.find((s) => s.stage_id === 'specify' && s.attempt === 1)
    assert.strictEqual(oldSpec.status, 'stale')
    const clarRow = detail.stages.find((s) => s.stage_id === 'clarify')
    assert.strictEqual(clarRow.status, 'stale')
  })
  ok(`${label}: converge append returns to the implementation loop`, () => {
    const a = orch.createInstance({ workspacePath: '/ws-loop', feature: 'f' })
    const specify = advanceTo(orch, ledger, a.instanceId, 'specify', 't-spec')
    const clar = orch.confirmStage(a.instanceId, specify.id, { actionId: 'la-k1' })
    advanceTo(orch, ledger, a.instanceId, 'clarify', 't-clar')
    const plan = orch.confirmStage(a.instanceId, clar.result.stageRowId, { actionId: 'la-k2' })
    advanceTo(orch, ledger, a.instanceId, 'plan', 't-plan')
    const checklist = orch.confirmStage(a.instanceId, plan.result.stageRowId, { actionId: 'la-k3' })
    advanceTo(orch, ledger, a.instanceId, 'checklist', 't-ck')
    const tasks = orch.confirmStage(a.instanceId, checklist.result.stageRowId, { actionId: 'la-k4' })
    advanceTo(orch, ledger, a.instanceId, 'tasks', 't-tk')
    const analyze = orch.confirmStage(a.instanceId, tasks.result.stageRowId, { actionId: 'la-k5' })
    advanceTo(orch, ledger, a.instanceId, 'analyze', 't-an')
    const imp = orch.confirmStage(a.instanceId, analyze.result.stageRowId, { actionId: 'la-k6' })
    advanceTo(orch, ledger, a.instanceId, 'implement', 't-im')
    const conv = orch.confirmStage(a.instanceId, imp.result.stageRowId, { actionId: 'la-k7' })
    assert.strictEqual(conv.result.nextStageId, 'converge')
    // converge findings -> user decides append -> done(append)
    orchestratorBind(orch, ledger, a.instanceId, conv.result.stageRowId, 't-cv')
    const findings = orch.processThreadTurn({ instanceId: a.instanceId, stageRowId: conv.result.stageRowId, threadState: { status: 'findings', findings: [{ severity: 'HIGH', kind: 'missing', title: 'x' }] }, artifacts: [] })
    assert.strictEqual(findings.status, 'awaiting-user')
    orch.answerStage(a.instanceId, conv.result.stageRowId, { actionId: 'la-k8', text: '追加：做 X' })
    const doneAppend = orch.processThreadTurn({ instanceId: a.instanceId, stageRowId: conv.result.stageRowId, threadState: { status: 'done', action: 'append', summary: 'appended' }, artifacts: [] })
    assert.strictEqual(doneAppend.status, 'awaiting-confirmation')
    const next = orch.confirmStage(a.instanceId, conv.result.stageRowId, { actionId: 'la-k9' })
    assert.strictEqual(next.result.nextStageId, 'implement', 'converge append must return to implement')
  })
  ok(`${label}: converge converged ends the instance`, () => {
    const a = orch.createInstance({ workspacePath: '/ws-done', feature: 'f' })
    const specify = advanceTo(orch, ledger, a.instanceId, 'specify', 't1')
    const clar = orch.confirmStage(a.instanceId, specify.id, { actionId: 'cn-q1' })
    advanceTo(orch, ledger, a.instanceId, 'clarify', 't2')
    const plan = orch.confirmStage(a.instanceId, clar.result.stageRowId, { actionId: 'cn-q2' })
    advanceTo(orch, ledger, a.instanceId, 'plan', 't3')
    const ck = orch.confirmStage(a.instanceId, plan.result.stageRowId, { actionId: 'cn-q3' })
    advanceTo(orch, ledger, a.instanceId, 'checklist', 't4')
    const tasks = orch.confirmStage(a.instanceId, ck.result.stageRowId, { actionId: 'cn-q4' })
    advanceTo(orch, ledger, a.instanceId, 'tasks', 't5')
    const an = orch.confirmStage(a.instanceId, tasks.result.stageRowId, { actionId: 'cn-q5' })
    advanceTo(orch, ledger, a.instanceId, 'analyze', 't6')
    const imp = orch.confirmStage(a.instanceId, an.result.stageRowId, { actionId: 'cn-q6' })
    advanceTo(orch, ledger, a.instanceId, 'implement', 't7')
    const conv = orch.confirmStage(a.instanceId, imp.result.stageRowId, { actionId: 'cn-q7' })
    orchestratorBind(orch, ledger, a.instanceId, conv.result.stageRowId, 't8')
    orch.processThreadTurn({ instanceId: a.instanceId, stageRowId: conv.result.stageRowId, threadState: { status: 'done', action: 'converged', summary: 'ok' }, artifacts: [] })
    const end = orch.confirmStage(a.instanceId, conv.result.stageRowId, { actionId: 'cn-q8' })
    assert.strictEqual(end.result.nextStageId, null)
    assert.strictEqual(end.result.instanceCompleted, true)
    const detail = orch.detail(a.instanceId)
    assert.strictEqual(detail.instance.status, 'completed')
  })
  ok(`${label}: workspace lock releases after cancel`, () => {
    const a = orch.createInstance({ workspacePath: '/ws-cancel', feature: 'f' })
    const row = orch.currentStageRow(a.instanceId, 'specify')
    orchestratorBind(orch, ledger, a.instanceId, row.id, 't1')
    orch.cancelStage(a.instanceId, row.id, { actionId: 'cncl-z1' })
    assert.strictEqual(ledger.transaction((tx) => ledger.lockFor(tx, '/ws-cancel')), null)
    const b = orch.createInstance({ workspacePath: '/ws-cancel', feature: 'f2' })
    assert.ok(b.instanceId)
  })
  ok(`${label}: action contract per status`, () => {
    for (const [status, ids] of [
      ['running', ['thread', 'cancel-current']],
      ['awaiting-user', ['thread', 'answer', 'end-interactive', 'cancel-current']],
      ['awaiting-confirmation', ['artifacts']],
      ['completed', ['artifacts', 'redo']],
      ['failed', ['error', 'redo', 'rollback']],
      ['stale', ['stale-reason', 'redo']]
    ]) {
      const actions = permittedActions({ status, stage_id: 'plan' }, true)
      const has = actions.some((a) => a.id === ids[0])
      assert.ok(has, `${status} should offer ${ids[0]}`)
    }
    const confirmActions = permittedActions({ status: 'awaiting-confirmation', stage_id: 'clarify' }, true)
    assert.ok(confirmActions.some((a) => a.id === 'confirm'))
    const nonCurrent = permittedActions({ status: 'awaiting-confirmation', stage_id: 'clarify' }, false)
    assert.ok(!nonCurrent.some((a) => a.id === 'confirm'), 'confirm only for the current stage')
  })
  ok(`${label}: thread state file path is deterministic`, () => {
    const p = stateFileFor('/ws', 'wf-1', 'clarify', 2)
    assert.ok(p.endsWith('/.dsh/speckit-workflow/instances/wf-1/stages/clarify-2.state.json'))
  })
  ok(`${label}: instance board projection`, () => {
    const a = orch.createInstance({ workspacePath: '/ws-board', feature: 'f' })
    const board = orch.board('/ws-board')
    assert.strictEqual(board.length, 1)
    assert.strictEqual(board[0].currentStage, 'specify')
    assert.strictEqual(board[0].currentStageStatus, 'creating')
  })
}

runCommon(true)
if (Ledger && !(process.env.SPKB_SMOKE_JSON_ONLY === '1')) {
  // sqlite backend when available
  const { hasSqlite } = await import('../lib/db.js')
  if (hasSqlite()) runCommon(false)
}

console.log(`\n[machine-smoke] ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

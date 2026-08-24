// TDD tests for the "delete instance" feature (v0.7-style card delete button).
//
// These cover the two host-side units that the client relies on:
//   1. orchestrator.board() must expose `currentStageRowId` so a card can wire
//      its confirm/delete actions without opening the drawer first.
//   2. orchestrator.cancelInstance() deletes the whole instance (cancels the
//      active stage, releases the workspace lock, marks the instance cancelled)
//      — the host half of the card "删除" button.
//
// The client (lib/client.js) is DOM-bound and is verified by manual board
// refresh; these tests guard the contract it depends on.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { Orchestrator } from './orchestrator.js'
import { Ledger } from './db.js'

function makeOrchestrator() {
  const dir = mkdtempSync(join(os.tmpdir(), 'spk-test-'))
  const ledger = new Ledger({ path: join(dir, 'workflow.db') })
  return { ledger, orchestrator: new Orchestrator({ ledger }) }
}

test('board() exposes currentStageRowId for the active stage', () => {
  const { ledger, orchestrator } = makeOrchestrator()
  const { instanceId, stageRowId } = orchestrator.createInstance({
    workspacePath: '/tmp/ws-a',
    feature: 'demo feature'
  })
  const cards = orchestrator.board('/tmp/ws-a')
  assert.equal(cards.length, 1)
  const card = cards[0]
  assert.equal(card.instanceId, instanceId)
  // The card must carry the active stage row id so the client can wire
  // confirm/delete actions directly from the board (no drawer round-trip).
  assert.equal(card.currentStageRowId, stageRowId)
  assert.equal(card.currentStage, 'specify')
})

test('cancelInstance() cancels the whole instance and frees the workspace lock', () => {
  const { ledger, orchestrator } = makeOrchestrator()
  const { instanceId, stageRowId } = orchestrator.createInstance({
    workspacePath: '/tmp/ws-b',
    feature: 'second feature'
  })
  // Lock is held while the instance is active.
  const lockBefore = ledger.transaction((tx) => ledger.lockFor(tx, '/tmp/ws-b'))
  assert.ok(lockBefore, 'workspace lock should be held while instance is active')

  const res = orchestrator.cancelInstance(instanceId, { actionId: 'act-del-1' })
  assert.equal(res.idempotent, false)
  assert.equal(res.result.cancelInstance, true)

  const instance = ledger.transaction((tx) => ledger.getInstance(tx, instanceId))
  assert.equal(instance.status, 'cancelled')

  const stage = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
  assert.equal(stage.status, 'cancelled')

  const lockAfter = ledger.transaction((tx) => ledger.lockFor(tx, '/tmp/ws-b'))
  assert.equal(lockAfter, null, 'workspace lock must be released after instance cancel')

  // Idempotent on repeat call.
  const again = orchestrator.cancelInstance(instanceId, { actionId: 'act-del-1' })
  assert.equal(again.idempotent, true)
})

// ---- 暂停 / 继续 / 从暂停恢复回合（v0.8+：断电/重启/暂停后无需重开线程） ----

test('pauseStage marks a running stage paused and keeps the workspace lock', () => {
  const { ledger, orchestrator } = makeOrchestrator()
  const { instanceId, stageRowId } = orchestrator.createInstance({ workspacePath: '/tmp/ws-p1', feature: 'pause feature' })
  orchestrator.activateStage(instanceId, stageRowId, { threadId: 'thread-1', skillId: 'speckit-specify' })

  const res = orchestrator.pauseStage(instanceId, stageRowId, { actionId: 'act-pause-1', reason: 'user pause' })
  assert.equal(res.idempotent, false)
  assert.equal(res.result.status, 'paused')

  const stage = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
  assert.equal(stage.status, 'paused')
  // Lock is NOT released: the stage is only held, still the active stage.
  assert.ok(ledger.transaction((tx) => ledger.lockFor(tx, '/tmp/ws-p1')), 'lock must stay held while paused')

  // Idempotent on repeat with the same actionId.
  const again = orchestrator.pauseStage(instanceId, stageRowId, { actionId: 'act-pause-1' })
  assert.equal(again.idempotent, true)
})

test('resumeStage flips paused back to running (same thread, same attempt)', () => {
  const { ledger, orchestrator } = makeOrchestrator()
  const { instanceId, stageRowId } = orchestrator.createInstance({ workspacePath: '/tmp/ws-p2', feature: 'resume feature' })
  orchestrator.activateStage(instanceId, stageRowId, { threadId: 'thread-2' })
  orchestrator.pauseStage(instanceId, stageRowId, { actionId: 'act-p2' })

  const res = orchestrator.resumeStage(instanceId, stageRowId, { actionId: 'act-r2' })
  assert.equal(res.idempotent, false)
  const stage = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
  assert.equal(stage.status, 'running')
  assert.equal(stage.thread_id, 'thread-2', 'resume must keep the SAME thread (no restart)')
  assert.equal(stage.attempt, 1)
})

test('pause requires running; resume requires paused', () => {
  const { orchestrator } = makeOrchestrator()
  const { instanceId, stageRowId } = orchestrator.createInstance({ workspacePath: '/tmp/ws-p3', feature: 'gate feature' })
  // createInstance leaves the row 'creating' → pause must throw invalid-state.
  assert.throws(() => orchestrator.pauseStage(instanceId, stageRowId, { actionId: 'a1' }), /不能暂停/)
  orchestrator.activateStage(instanceId, stageRowId, { threadId: 't' })
  assert.throws(() => orchestrator.resumeStage(instanceId, stageRowId, { actionId: 'a2' }), /不能恢复/)
})

test('a paused stage absorbs a finished turn via processThreadTurn (idle edge)', () => {
  const { ledger, orchestrator } = makeOrchestrator()
  const { instanceId, stageRowId } = orchestrator.createInstance({ workspacePath: '/tmp/ws-p4', feature: 'idle feature' })
  orchestrator.activateStage(instanceId, stageRowId, { threadId: 'thread-4' })
  orchestrator.pauseStage(instanceId, stageRowId, { actionId: 'act-p4' })
  // Thread actually finished while paused (state.json exists) → idle edge must
  // advance it, never leave it stuck.
  const res = orchestrator.processThreadTurn({
    instanceId,
    stageRowId,
    threadState: { status: 'done', summary: 'paused-then-done' },
    artifacts: []
  })
  assert.equal(res.status, 'awaiting-confirmation')
  const stage = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
  assert.equal(stage.status, 'awaiting-confirmation')
})

test('cancel works from paused (lock released)', () => {
  const { ledger, orchestrator } = makeOrchestrator()
  const { instanceId, stageRowId } = orchestrator.createInstance({ workspacePath: '/tmp/ws-p5', feature: 'cancel paused' })
  orchestrator.activateStage(instanceId, stageRowId, { threadId: 'thread-5' })
  orchestrator.pauseStage(instanceId, stageRowId, { actionId: 'act-p5' })
  orchestrator.cancelStage(instanceId, stageRowId, { actionId: 'act-c5' })
  const stage = ledger.transaction((tx) => ledger.getStage(tx, stageRowId))
  assert.equal(stage.status, 'cancelled')
  assert.equal(ledger.transaction((tx) => ledger.lockFor(tx, '/tmp/ws-p5')), null)
})

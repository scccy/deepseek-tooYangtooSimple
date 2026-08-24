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

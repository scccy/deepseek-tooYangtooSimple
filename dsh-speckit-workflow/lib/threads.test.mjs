// TDD regression test for the `Cannot read properties of undefined
// (reading 'throwIfAborted')` crash.
//
// Root cause: lib/threads.js passed `signal: undefined` to
// `subagents.startContinuable(...)` (and omitted `signal` in `followup`).
// The host (`@deepseek-ai/dsh-subagent`) requires a defined `AbortSignal`
// (its `ContinuableStartSpec.signal` is non-optional) and calls
// `spec.signal.throwIfAborted()` with NO optional chaining, so `undefined`
// blows up with exactly that TypeError.
//
// The mock subagents below faithfully reproduce that host contract so the
// test fails before the fix and passes after it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StageThreads } from './threads.js'

// Build a mock `subagents` that mirrors the host's required-signal contract.
function buildMockSubagents(signalSpy) {
  return {
    getProvider: () => ({ prepareContinuable() {}, capabilities: { persona: true, toolFilter: true } }),
    // Faithful reproduction of @deepseek-ai/dsh-subagent/lib/index.js:797
    startContinuable: async (spec) => {
      // Host does NOT use optional chaining here — `undefined` throws.
      spec.signal.throwIfAborted()
      signalSpy.start = spec.signal
      return { childId: 'child-1' }
    },
    // Faithful reproduction of dsh-subagent/lib/index.js:872 / 1150 / 1153
    followup: async (_parent, _threadId, _content, options) => {
      options.signal.throwIfAborted()
      signalSpy.followup = options.signal
      return 'msg-1'
    },
    interrupt: async () => {}
  }
}

// Construct a StageThreads with heavy composition/route/provider logic stubbed.
function buildThreads(subagents) {
  const ledger = { transaction: (fn) => fn({}) }
  const orchestrator = {
    activateStage: () => {},
    currentStageRow: () => ({ status: 'running', thread_id: 'child-1' }),
    event: () => ({}),
    failStage: () => {}
  }
  const ctx = { subagents, logger: { warn() {}, info() {} } }
  const threads = new StageThreads({ ctx, ledger, orchestrator, config: { provider: 'spawn' } })
  threads.composeStage = async () => ({ persona: 'p', prompt: 'x', skillSha256: 'abc' })
  threads.resolveRoute = async () => null
  threads.priorStageRows = async () => []
  threads.providerDescriptor = () => ({})
  return { threads, ledger, orchestrator }
}

test('spawnStage passes a defined AbortSignal to subagents.startContinuable', async () => {
  const signalSpy = {}
  const subagents = buildMockSubagents(signalSpy)
  const { threads } = buildThreads(subagents)
  const instance = { instance_id: 'i1', workspace_path: '/tmp/ws' }
  const stageRow = { id: 's1', stage_id: 'specify', attempt: 1, status: 'creating' }
  const parentAgent = { id: 'parent-1' }

  // Before the fix this rejects with
  // "Cannot read properties of undefined (reading 'throwIfAborted')".
  const result = await threads.spawnStage({ instance, parentAgent, stageRow })

  assert.ok(signalSpy.start !== undefined, 'startContinuable must be called with a signal')
  assert.ok(signalSpy.start instanceof AbortSignal, 'signal passed to startContinuable must be an AbortSignal')
  assert.equal(result.thread_id, 'child-1')
})

test('followup passes a defined AbortSignal to subagents.followup', async () => {
  const signalSpy = {}
  const subagents = buildMockSubagents(signalSpy)
  const { threads } = buildThreads(subagents)
  const parentAgent = { id: 'parent-1' }

  // Before the fix this rejects because options has no `signal`.
  await threads.followup(parentAgent, 'child-1', 'the answer', 'user-answer')

  assert.ok(signalSpy.followup !== undefined, 'followup must be called with a signal')
  assert.ok(signalSpy.followup instanceof AbortSignal, 'signal passed to followup must be an AbortSignal')
})

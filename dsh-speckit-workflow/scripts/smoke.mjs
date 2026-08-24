#!/usr/bin/env node
// dsh-speckit-workflow v0.8 — smoke suite (standalone, no DSH host needed).
//
// v0.8 has no `@dsh-external/workflow` engine dependency at runtime, so the
// smoke suite runs the pure-machine checks (ledger + orchestrator + stage
// graph, both backends) plus filesystem-level tests of the worktree artifact
// handoff and the thread state-files.
//
// Run: node scripts/smoke.mjs

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert'

let passed = 0
let failed = 0
async function ok(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  ✗ ${name}\n    ${error && error.stack ? error.stack.split('\n').slice(0, 5).join('\n    ') : error}`)
  }
}

console.log('[smoke] machine checks (ledger + orchestrator, sqlite + json)')
await import('./machine-smoke.mjs')

console.log('[smoke] worktree artifact handoff + thread protocol files')
const { collectArtifacts, syncFeatureArtifacts, verifyFeatureJson, readFeatureJson } = await import('../lib/worktree.js')
const { stateFileFor } = await import('../lib/threads.js')

const dir = mkdtempSync(join(tmpdir(), 'spkb-fs-'))
const ws = join(dir, 'ws')
const wt = join(dir, 'worktree')
try {
  mkdirSync(join(ws, '.specify', 'templates'), { recursive: true })
  mkdirSync(join(ws, 'specs', '001-user-auth', 'checklists'), { recursive: true })
  writeFileSync(join(ws, '.specify', 'feature.json'), JSON.stringify({ featureNum: '001', branch: '001-user-auth' }))
  writeFileSync(join(ws, 'specs', '001-user-auth', 'spec.md'), '# spec')
  writeFileSync(join(ws, 'specs', '001-user-auth', 'checklists', 'requirements.md'), '- [ ] x')

  await ok('collectArtifacts walks a directory into relative paths', async () => {
    const artifacts = await collectArtifacts(ws, ['specs/001-user-auth'])
    const rels = artifacts.map((a) => a.rel).sort()
    assert.deepStrictEqual(rels, ['specs/001-user-auth/checklists/requirements.md', 'specs/001-user-auth/spec.md'])
    assert.ok(artifacts.every((a) => typeof a.sha256 === 'string' && a.sha256.length === 64))
  })

  await ok('collectArtifacts skips missing files silently', async () => {
    const artifacts = await collectArtifacts(ws, ['specs/does-not-exist'])
    assert.strictEqual(artifacts.length, 0)
  })

  await ok('syncFeatureArtifacts copies feature artifacts into a worktree', async () => {
    const copied = await syncFeatureArtifacts({ workspaceRoot: ws, worktreePath: wt, featureDir: '001-user-auth' })
    assert.ok(copied.includes('specs/001-user-auth'))
    assert.ok(existsSync(join(wt, '.specify', 'feature.json')))
    assert.ok(existsSync(join(wt, 'specs', '001-user-auth', 'spec.md')))
  })

  await ok('verifyFeatureJson passes for a consistent worktree', async () => {
    const issues = await verifyFeatureJson(wt, { featureDir: '001-user-auth' })
    assert.deepStrictEqual(issues, [])
  })

  await ok('verifyFeatureJson flags a mismatched feature number', async () => {
    mkdirSync(join(wt, '.specify'), { recursive: true })
    writeFileSync(join(wt, '.specify', 'feature.json'), JSON.stringify({ featureNum: '999' }))
    const issues = await verifyFeatureJson(wt, { featureDir: '001-user-auth' })
    assert.ok(issues.length > 0)
  })

  await ok('readFeatureJson reads the identity file', async () => {
    const feature = await readFeatureJson(ws)
    assert.strictEqual(feature.featureNum, '001')
  })

  await ok('stateFileFor returns a deterministic absolute path', () => {
    const p = stateFileFor(ws, 'wf-1', 'converge', 3)
    assert.strictEqual(p, join(ws, '.dsh', 'speckit-workflow', 'instances', 'wf-1', 'stages', 'converge-3.state.json'))
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n[smoke] ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)

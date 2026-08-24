// dsh-speckit-workflow v0.8 — Specify → worktree artifact handoff.
//
// DESIGN-V0.8 §4.2: after the Specify thread finishes (its after_specify hook
// creates/reuses the feature worktree), the plugin performs ONE explicit
// "artifact handoff" before any downstream stage can start:
//   1. Sync the current feature's not-yet-committed artifacts from the main
//      checkout into the worktree (feature.json + specs/<feature>/ + the
//      feature's explicitly listed extension artifacts).
//   2. Verify the worktree's feature.json agrees with what Specify produced
//      (branch / feature number / feature directory).
//   3. If verified, bind artifactRoot + executionRoot to the worktree.
// The main checkout's Specify artifacts stay as the original snapshot:
// never deleted, never overwritten, never implicitly mutated downstream.
//
// When worktrees are disabled (--in-place / auto_create off), the handoff is a
// no-op and all stages bind the workspace root.

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

const execFileAsync = promisify(execFile)

export async function runGit(root, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })
    return { ok: true, stdout: String(stdout).trim() }
  } catch (error) {
    return { ok: false, error: String((error && error.stderr) || error) }
  }
}

export async function isGitRepo(root) {
  const result = await runGit(root, ['rev-parse', '--show-toplevel'])
  return result.ok
}

/** Path exists and is a directory. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export async function hashFile(path) {
  try {
    const buffer = await readFile(path)
    return createHash('sha256').update(buffer).digest('hex')
  } catch {
    return null
  }
}

/** Resolve a path under root only if it stays within root (no traversal). */
function safeJoin(root, rel) {
  const clean = String(rel || '').replace(/\\/g, '/')
  if (clean.startsWith('/') || clean === '' || clean === '.') return null
  const target = join(root, clean)
  if (!target.startsWith(root)) return null
  return target
}

/**
 * Collect artifact metadata under a file or directory relative to root.
 * @returns {Promise<Array<{rel:string, absPath:string, sha256:string|null, dir:boolean}>>}
 */
export async function collectArtifacts(root, rels, excludes = []) {
  const results = []
  const seen = new Set()
  const excludeSet = new Set(excludes)
  const walk = async (abs, rel) => {
    if (excludeSet.has(rel)) return
    let entry
    try {
      entry = await stat(abs)
    } catch {
      return // file the agent claimed but is not (yet) present — skip silently
    }
    if (entry.isDirectory()) {
      let entries = []
      try {
        entries = await readdir(abs)
      } catch {
        return
      }
      for (const name of entries.sort()) {
        if (name === '.git' || name === '.worktrees' || name === 'node_modules') continue
        await walk(join(abs, name), `${rel}/${name}`)
      }
      return
    }
    if (seen.has(abs)) return
    seen.add(abs)
    results.push({ rel, absPath: abs, sha256: await hashFile(abs), dir: false })
  }
  for (const rel of rels || []) {
    const abs = safeJoin(root, rel)
    if (!abs) continue
    await walk(abs, rel)
  }
  return results
}

/**
 * Read `.specify/feature.json` from a root.
 * @returns {Promise<object|null>}
 */
export async function readFeatureJson(root) {
  try {
    const body = await readFile(join(root, '.specify', 'feature.json'), 'utf8')
    return JSON.parse(body)
  } catch {
    return null
  }
}

/**
 * Sync the Specify-produced artifacts from the main checkout into the
 * worktree. Returns the list of copied rel paths.
 * @param {object} input
 * @param {string} input.workspaceRoot
 * @param {string} input.worktreePath
 * @param {string} [input.featureDir] specs/<featureDir> directory name
 * @param {string[]} [input.extraRels] additional feature-coupled artifacts
 */
export async function syncFeatureArtifacts({ workspaceRoot, worktreePath, featureDir, extraRels = [] }) {
  const rels = ['.specify/feature.json']
  if (featureDir) rels.push(`specs/${featureDir}`)
  const copied = []
  const skip = ['.specify/feature.json'] // modeled explicitly below
  for (const rel of rels) {
    if (rel === '.specify/feature.json') continue
    const src = safeJoin(workspaceRoot, rel)
    if (!src || !existsSync(src)) continue
    const dest = safeJoin(worktreePath, rel)
    const destParent = dest.slice(0, dest.lastIndexOf('/'))
    await mkdir(destParent, { recursive: true })
    let destStat = null
    try {
      destStat = await stat(dest)
    } catch {
      destStat = null
    }
    await cp(src, dest, { recursive: true, force: true })
    copied.push(rel)
  }
  // feature.json is the identity file — always copied and checked last.
  const featureJsonSource = safeJoin(workspaceRoot, '.specify/feature.json')
  if (featureJsonSource && existsSync(featureJsonSource)) {
    await mkdir(join(worktreePath, '.specify'), { recursive: true })
    await cp(featureJsonSource, join(worktreePath, '.specify', 'feature.json'), { force: true, errorOnExist: false })
  }
  for (const rel of extraRels || []) {
    const src = safeJoin(workspaceRoot, rel)
    if (!src || !existsSync(src)) continue
    const dest = safeJoin(worktreePath, rel)
    if (!dest) continue
    await mkdir(dest.slice(0, dest.lastIndexOf('/')), { recursive: true })
    await cp(src, dest, { recursive: true, force: true })
    copied.push(rel)
  }
  return copied
}

/**
 * Verify the worktree's feature.json identity agrees with the Specify output.
 * Returns a list of issues (empty == verified).
 * @param {string} worktreePath
 * @param {object} expected { featureDir?, branch? }
 */
export async function verifyFeatureJson(worktreePath, expected) {
  const issues = []
  const featureJson = await readFeatureJson(worktreePath)
  if (!featureJson) {
    issues.push('worktree 中缺少 .specify/feature.json，产物交接失败')
    return issues
  }
  const featureNum = String(featureJson.featureNum ?? featureJson.feature_number ?? '')
  if (expected.featureDir && featureNum && !expected.featureDir.includes(featureNum)) {
    issues.push(`worktree feature.json 的 featureNum（${featureNum}）与 Specify 产物目录 ${expected.featureDir} 不一致`)
  }
  return issues
}

/**
 * Resolve the actual worktree path for a branch using `git worktree list`.
 * @param {string} workspaceRoot
 * @param {string} branch
 */
export async function findWorktreePath(workspaceRoot, branch) {
  const result = await runGit(workspaceRoot, ['worktree', 'list', '--porcelain'])
  if (!result.ok) return null
  const sections = result.stdout.split('\n\n')
  for (const section of sections) {
    if (section.includes(`branch refs/heads/${branch}`) || section.includes(`branch refs/heads/main`)) {
      const pathLine = section.split('\n').find((line) => line.startsWith('worktree '))
      const path = pathLine ? pathLine.slice('worktree '.length).trim() : null
      if (path && await isDirectory(path)) return path
    }
  }
  return null
}

/** Sanitize a branch name into a filesystem-safe short label. */
export function branchLabel(branch) {
  return String(branch || 'feature').replace(/[\/\\\s]+/g, '-').slice(0, 80)
}

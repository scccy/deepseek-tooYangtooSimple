// dsh-speckit-workflow v0.8 — local orchestration ledger.
//
// DESIGN-V0.8 §5.1: a profile-level local SQLite database that holds the
// workflow *instance* orchestration state (instances, stages, artifacts,
// decisions, events, idempotent actions). The ledger is NOT the artifact
// repository: spec.md/plan.md/tasks.md bodies stay in the worktree/workspace,
// chat transcripts stay in the thread persistence system, and workflow-engine
// run snapshots (if any) stay the run's own authority.
//
// Storage backend: built-in `node:sqlite` (DatabaseSync) when the running Node
// supports it (Node 22.5+, verified on the DSH profile's Node 24), matching
// the design's preference to avoid a third-party native dependency. When
// `node:sqlite` is unavailable the plugin reports a clear capability failure;
// a JSON-file store is provided only for offline dev/smoke of the pure state
// machine, not as a production substitute for the atomic ledger.

import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

export const DEFAULT_DB_DIR = join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh', 'speckit-workflow')
export const DEFAULT_DB_PATH = process.env.DSH_SPECKIT_DB || join(DEFAULT_DB_DIR, 'workflow.db')

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_instances(
  instance_id TEXT PRIMARY KEY,
  workspace_path TEXT NOT NULL,
  feature_name TEXT NOT NULL,
  feature_dir TEXT,
  branch TEXT,
  worktree_path TEXT,
  mode TEXT NOT NULL DEFAULT 'inplace',
  artifact_root TEXT,
  execution_root TEXT,
  current_stage TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  config TEXT NOT NULL DEFAULT '{}',
  active_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  thread_id TEXT,
  status TEXT NOT NULL DEFAULT 'not-started',
  column TEXT,
  started_at TEXT,
  ended_at TEXT,
  summary TEXT,
  skill_id TEXT,
  skill_sha256 TEXT,
  input_snapshot TEXT,
  state_json TEXT,
  output TEXT,
  error TEXT,
  stale_reason TEXT,
  UNIQUE(instance_id, stage_id, attempt)
);
CREATE INDEX IF NOT EXISTS ix_stages_instance ON stages(instance_id, stage_id, attempt);

CREATE TABLE IF NOT EXISTS artifacts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  stage_row INTEGER NOT NULL,
  rel TEXT NOT NULL,
  root TEXT NOT NULL,
  abs_path TEXT,
  sha256 TEXT,
  stale INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_artifacts_instance ON artifacts(instance_id);

CREATE TABLE IF NOT EXISTS decisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  stage_row INTEGER,
  kind TEXT NOT NULL,
  target_stage TEXT,
  note TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  thread_id TEXT,
  type TEXT NOT NULL,
  time INTEGER NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_instance ON events(instance_id, seq);

CREATE TABLE IF NOT EXISTS actions(
  action_id TEXT PRIMARY KEY,
  instance_id TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_locks(
  workspace_path TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  stage_row INTEGER NOT NULL,
  acquired_at TEXT NOT NULL
);
`

/** Whether the running Node provides built-in `node:sqlite`. */
export function hasSqlite() {
  try {
    require('node:sqlite')
    return true
  } catch {
    return false
  }
}

function dirnameOf(path) {
  const parts = String(path).split(/[\\/]/)
  parts.pop()
  return parts.join('/') || '.'
}

/**
 * Open/initialize a DatabaseSync handle (built-in backend). Synchronous.
 * @param {string} path
 */
export function openSqlite(path) {
  const { DatabaseSync } = require('node:sqlite')
  mkdirSync(dirnameOf(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  return db
}

/** Low-level transactional wrapper over a DatabaseSync handle. */
export function withTransaction(db, fn) {
  db.exec('BEGIN')
  try {
    const result = fn(db)
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* already rolled back */
    }
    throw error
  }
}

/**
 * JSON-file ledger with the interface the orchestrator needs. Exists purely
 * for offline dev/smoke and for Node versions without `node:sqlite`; all
 * tables mirror the sqlite schema.
 */
export class JsonLedger {
  constructor(file) {
    this.file = file
    this.memo = {
      workflow_instances: [],
      stages: [],
      artifacts: [],
      decisions: [],
      events: [],
      actions: [],
      workspace_locks: []
    }
    if (this.file && existsSync(this.file)) {
      try {
        this.memo = JSON.parse(readFileSync(this.file, 'utf8'))
      } catch {
        /* start clean */
      }
    }
    this._seq = (this.memo.events || []).reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0)
    this._stageId = (this.memo.stages || []).reduce((max, s) => Math.max(max, Number(s.id) || 0), 0)
  }
  persist() {
    if (!this.file) return
    mkdirSync(dirnameOf(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.memo, null, 2))
    renameSync(tmp, this.file)
  }
  /** Return the memo object + a persist callback (called after each mutation). */
  begin() {
    return this.memo
  }
}

/**
 * Ledger — the orchestrator's single storage entry point. `db` is a real
 * DatabaseSync handle when the built-in backend is available, otherwise a
 * JsonLedger (dev/smoke only). All mutations that must be atomic go through
 * `transaction()` so the caller can decide commit boundaries.
 */
export class Ledger {
  /**
   * @param {object} [options]
   * @param {string} [options.path]
   * @param {boolean} [options.forceSqlite] require the sqlite backend (throws if unavailable)
   */
  constructor(options = {}) {
    const path = options.path || DEFAULT_DB_PATH
    this.path = path
    this.sqlite = false
    this.db = null
    this.json = null
    if (options.forceJson !== true && hasSqlite()) {
      try {
        this.db = openSqlite(path)
        this.sqlite = true
      } catch (error) {
        this.initError = String((error && error.message) || error)
      }
    }
    if (!this.sqlite) {
      if (options.forceSqlite) throw new Error(`node:sqlite unavailable on this Node: ${String(this.initError || 'missing module')}`)
      this.json = new JsonLedger(options.path.replace(/\.db$/, '.json'))
    }
  }

  get backend() {
    return this.sqlite ? 'sqlite' : 'json'
  }

  /**
   * Run fn(db) inside a transaction. `fn` is synchronous and receives the raw
   * sqlite handle (or the JsonLedger memo for the dev backend). Returns the
   * fn result; commits on success, rolls back on throw.
   */
  transaction(fn) {
    if (this.sqlite) return withTransaction(this.db, fn)
    const json = this.json
    const snapshot = json.memo // shallow copy below; we deep-clone the memo rows
    const backup = JSON.parse(JSON.stringify(json.memo))
    try {
      const result = fn(json.begin())
      json.persist()
      return result
    } catch (error) {
      // Roll back the in-memory memo so a thrown transaction is atomic even on
      // the JSON dev backend.
      json.memo = backup
      json._seq = (json.memo.events || []).reduce((max, e) => Math.max(max, Number(e.seq) || 0), 0)
      json._stageId = (json.memo.stages || []).reduce((max, s) => Math.max(max, Number(s.id) || 0), 0)
      throw error
    }
  }

  // ---- quoted instance helpers -------------------------------------------

  insertInstance(tx, instance) {
    run(tx, this, `INSERT OR ABORT INTO workflow_instances
      (instance_id, workspace_path, feature_name, feature_dir, branch, worktree_path, mode,
       artifact_root, execution_root, current_stage, status, config, active_key, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [instance.instance_id, instance.workspace_path, instance.feature_name, instance.feature_dir ?? null,
      instance.branch ?? null, instance.worktree_path ?? null, instance.mode ?? 'inplace',
      instance.artifact_root ?? null, instance.execution_root ?? null, instance.current_stage ?? null,
      instance.status ?? 'active', JSON.stringify(instance.config ?? {}), instance.active_key ?? null,
      instance.created_at, instance.updated_at])
  }

  updateInstance(tx, instance) {
    run(tx, this, `UPDATE workflow_instances SET feature_name=?, feature_dir=?, branch=?, worktree_path=?,
      mode=?, artifact_root=?, execution_root=?, current_stage=?, status=?, config=?, active_key=?, updated_at=?
      WHERE instance_id=?`,
    [instance.feature_name, instance.feature_dir ?? null, instance.branch ?? null, instance.worktree_path ?? null,
      instance.mode ?? 'inplace', instance.artifact_root ?? null, instance.execution_root ?? null,
      instance.current_stage ?? null, instance.status ?? 'active', jsonValue(instance.config, '{}'),
      instance.active_key ?? null, instance.updated_at, instance.instance_id])
  }

  getInstance(tx, instanceId) {
    const row = one(tx, this, 'SELECT * FROM workflow_instances WHERE instance_id = ?', [instanceId])
    return row ? hydrateInstance(row) : null
  }

  listInstances(tx, workspacePath) {
    const rows = workspacePath
      ? many(tx, this, 'SELECT * FROM workflow_instances WHERE workspace_path=? ORDER BY created_at DESC', [workspacePath])
      : many(tx, this, 'SELECT * FROM workflow_instances ORDER BY created_at DESC', [])
    return rows.map(hydrateInstance)
  }

  insertStage(tx, stage) {
    run(tx, this, `INSERT INTO stages
      (instance_id, stage_id, attempt, thread_id, status, column, started_at, ended_at, summary,
       skill_id, skill_sha256, input_snapshot, state_json, output, error, stale_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [stage.instance_id, stage.stage_id, stage.attempt, stage.thread_id ?? null, stage.status ?? 'not-started',
      stage.column ?? null, stage.started_at ?? null, stage.ended_at ?? null, stage.summary ?? null,
      stage.skill_id ?? null, stage.skill_sha256 ?? null, stage.input_snapshot ?? null, stage.state_json ?? null,
      stage.output ?? null, stage.error ?? null, stage.stale_reason ?? null])
    return lastId(tx, this)
  }

  updateStage(tx, stage) {
    run(tx, this, `UPDATE stages SET thread_id=?, status=?, started_at=?, ended_at=?, summary=?, skill_id=?,
      skill_sha256=?, input_snapshot=?, state_json=?, output=?, error=?, stale_reason=? WHERE id=?`,
    [stage.thread_id ?? null, stage.status ?? 'not-started', stage.started_at ?? null, stage.ended_at ?? null,
      stage.summary ?? null, stage.skill_id ?? null, stage.skill_sha256 ?? null, jsonValue(stage.input_snapshot, null),
      jsonValue(stage.state_json, null), jsonValue(stage.output, null), stage.error ?? null, stage.stale_reason ?? null, stage.id])
  }

  getStage(tx, id) {
    return hydrateStage(rowOrNull(one(tx, this, 'SELECT * FROM stages WHERE id=?', [id])))
  }

  getStageByKey(tx, instanceId, stageId, attempt) {
    return hydrateStage(rowOrNull(one(tx, this, 'SELECT * FROM stages WHERE instance_id=? AND stage_id=? AND attempt=?', [instanceId, stageId, attempt])))
  }

  listStages(tx, instanceId) {
    return many(tx, this, 'SELECT * FROM stages WHERE instance_id=? ORDER BY id', [instanceId]).map(hydrateStage)
  }

  findStageByThread(tx, threadId) {
    return hydrateStage(rowOrNull(one(tx, this, 'SELECT * FROM stages WHERE thread_id=? ORDER BY id DESC LIMIT 1', [threadId])))
  }

  latestAttempt(tx, instanceId, stageId) {
    const row = one(tx, this, 'SELECT MAX(attempt) AS attempt FROM stages WHERE instance_id=? AND stage_id=?', [instanceId, stageId])
    return row ? Number(row.attempt ?? 0) : 0
  }

  insertArtifact(tx, artifact) {
    run(tx, this, 'INSERT INTO artifacts (instance_id, stage_row, rel, root, abs_path, sha256, stale) VALUES (?,?,?,?,?,?,?)',
      [artifact.instance_id, artifact.stage_row, artifact.rel, artifact.root, artifact.abs_path, artifact.sha256 ?? null, artifact.stale ? 1 : 0])
  }

  artifactsForStage(tx, stageRowId) {
    return many(tx, this, 'SELECT * FROM artifacts WHERE stage_row=? ORDER BY id', [stageRowId]).map(hydrateArtifact)
  }

  listArtifacts(tx, instanceId) {
    return many(tx, this, 'SELECT * FROM artifacts WHERE instance_id=? ORDER BY id', [instanceId]).map(hydrateArtifact)
  }

  markArtifactsStale(tx, stageRowIds) {
    if (!stageRowIds || stageRowIds.length === 0) return
    run(tx, this, `UPDATE artifacts SET stale=1 WHERE stage_row IN (${stageRowIds.map(() => '?').join(',')})`, stageRowIds)
  }

  insertDecision(tx, decision) {
    run(tx, this, 'INSERT INTO decisions (instance_id, stage_row, kind, target_stage, note, at) VALUES (?,?,?,?,?,?)',
      [decision.instance_id, decision.stage_row ?? null, decision.kind, decision.target_stage ?? null, decision.note ?? null, decision.at ?? new Date().toISOString()])
  }

  listDecisions(tx, instanceId) {
    return many(tx, this, 'SELECT * FROM decisions WHERE instance_id=? ORDER BY id', [instanceId]).map((row) => ({ ...row }))
  }

  appendEvents(tx, events) {
    for (const event of events) {
      run(tx, this, 'INSERT INTO events (instance_id, thread_id, type, time, data) VALUES (?,?,?,?,?)',
        [event.instance_id, event.thread_id ?? null, event.type, event.time ?? Date.now(),
          event.data === undefined ? null : JSON.stringify(event.data)])
    }
  }

  eventsSince(tx, instanceId, since) {
    return many(tx, this, 'SELECT * FROM events WHERE instance_id=? AND seq>? ORDER BY seq', [instanceId, since ?? -1]).map((row) => ({
      seq: Number(row.seq),
      instance_id: row.instance_id,
      thread_id: row.thread_id,
      type: row.type,
      time: Number(row.time),
      data: row.data ? safeParse(row.data) : null
    }))
  }

  lastEventSeq(tx, instanceId) {
    const row = one(tx, this, 'SELECT MAX(seq) AS seq FROM events WHERE instance_id=?', [instanceId])
    return row ? Number(row.seq ?? -1) : -1
  }

  claimAction(tx, actionId, instanceId) {
    const existing = one(tx, this, 'SELECT * FROM actions WHERE action_id=?', [actionId])
    if (existing) return { fresh: false, result: existing.result ? safeParse(existing.result) : null, done: Number(existing.done) === 1 }
    run(tx, this, 'INSERT INTO actions (action_id, instance_id, done, result, at) VALUES (?,?,0,?,?)', [actionId, instanceId ?? null, null, new Date().toISOString()])
    return { fresh: true, result: null, done: false }
  }

  completeAction(tx, actionId, result) {
    run(tx, this, 'UPDATE actions SET done=1, result=? WHERE action_id=?', [JSON.stringify(result ?? null), actionId])
  }

  tryAcquireLock(tx, instanceId, workspacePath, stageId, stageRow) {
    try {
      run(tx, this, 'INSERT OR ABORT INTO workspace_locks (workspace_path, instance_id, stage_id, stage_row, acquired_at) VALUES (?,?,?,?,?)',
        [workspacePath, instanceId, stageId, stageRow, new Date().toISOString()])
      return true
    } catch (error) {
      if (isConstraintError(error)) return false
      throw error
    }
  }

  releaseLock(tx, workspacePath) {
    run(tx, this, 'DELETE FROM workspace_locks WHERE workspace_path=?', [workspacePath])
  }

  releaseLockForStage(tx, stageRow) {
    run(tx, this, 'DELETE FROM workspace_locks WHERE stage_row=?', [stageRow])
  }

  lockFor(tx, workspacePath) {
    const row = one(tx, this, 'SELECT * FROM workspace_locks WHERE workspace_path=?', [workspacePath])
    return row ? { ...row } : null
  }
}

// ---- backend-agnostic executors --------------------------------------------
function isSqliteHandle(tx, ledger) {
  return ledger.sqlite
}
function run(tx, ledger, sql, params) {
  if (isSqliteHandle(tx, ledger)) return tx.prepare(sql).run(...params)
  return jsonRun(ledger.json, sql, params)
}
function one(tx, ledger, sql, params) {
  if (isSqliteHandle(tx, ledger)) return tx.prepare(sql).get(...params) ?? null
  return jsonOne(ledger.json, sql, params)
}
function many(tx, ledger, sql, params) {
  if (isSqliteHandle(tx, ledger)) return tx.prepare(sql).all(...params)
  return jsonMany(ledger.json, sql, params)
}
function lastId(tx, ledger) {
  if (isSqliteHandle(tx, ledger)) return Number(tx.prepare('SELECT last_insert_rowid() AS id').get().id)
  return jsonLastId(ledger.json)
}

// ---- JsonLedger naive SQL interpreter (dev/smoke only) ----------------------
// Supports the exact SELECT/INSERT/UPDATE/DELETE shapes the Ledger emits.
function jsonTable(json, table) {
  const map = {
    workflow_instances: 'workflow_instances',
    stages: 'stages',
    artifacts: 'artifacts',
    decisions: 'decisions',
    events: 'events',
    actions: 'actions',
    workspace_locks: 'workspace_locks'
  }
  const name = map[table]
  if (!name) throw new Error(`JsonLedger: unknown table ${table}`)
  return json.memo[name] || (json.memo[name] = [])
}
function jsonOne(json, sql, params) {
  const rows = jsonMany(json, sql, params)
  return rows[0] ?? null
}
function jsonMany(json, sql, params) {
  const lower = sql.trim()
  const match = /^SELECT\s+(.*?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.*?))?(?:\s+ORDER\s+BY\s+(.*?))?$/i.exec(lower)
  if (!match) throw new Error(`JsonLedger: unsupported SELECT: ${sql.slice(0, 80)}`)
  const rows = jsonTable(json, match[2])
  let out = rows.map((row) => ({ ...row }))
  if (match[3] !== undefined) {
    const where = whereFn(match[3], params)
    out = out.filter(where.test)
  }
  if (match[4]) {
    const [column, dir] = match[4].trim().split(/\s+/)
    const mult = /desc/i.test(dir || '') ? -1 : 1
    out.sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * mult)
  }
  return out
}
function whereFn(where, params) {
  // Where clauses are generated with positional ?s in a fixed order and two
  // shapes: `col = ?` and `col IN (?, ...)`. JSON backend only (dev/smoke).
  const checks = []
  const re = /(\w+)\s*(?:=\s*\?|IN\s*\((.*?)\))/g
  let text = where
  const maxLoops = 64
  let guards = 0
  while (guards++ < maxLoops) {
    const m = re.exec(text)
    if (!m) break
    const column = m[1]
    if (m[2] !== undefined) {
      const count = (m[2].match(/\?/g) || []).length
      const values = params.splice(0, count)
      checks.push((row) => values.includes(row[column]))
    } else {
      const value = params.shift()
      checks.push((row) => row[column] === value)
    }
  }
  return { test: (row) => checks.every((check) => check(row)) }
}
function jsonRun(json, sql, params) {
  const lower = sql.trim()
  if (/^INSERT\s+OR\s+ABORT\s+INTO/i.test(lower)) return jsonInsert(json, sql, params, true)
  if (/^INSERT\s+INTO/i.test(lower)) return jsonInsert(json, sql, params, false)
  if (/^UPDATE/i.test(lower)) return jsonUpdate(json, sql, params)
  if (/^DELETE\s+FROM/i.test(lower)) return jsonDelete(json, sql, params)
  throw new Error(`JsonLedger: unsupported DML: ${sql.slice(0, 80)}`)
}
function jsonInsert(json, sql, params, abortOnDup) {
  const match = /^INSERT(?:\s+OR\s+ABORT)?\s+INTO\s+(\w+)\s*\((.*?)\)\s*VALUES\s*\((.*?)\)\s*$/is.exec(sql.trim())
  if (!match) throw new Error(`JsonLedger: unsupported INSERT: ${sql.slice(0, 80)}`)
  const table = match[1]
  const columns = match[2].split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
  const markers = match[3].split(',').map((c) => c.trim())
  const row = {}
  for (let i = 0; i < columns.length; i += 1) {
    row[columns[i]] = /^NULL$/i.test(markers[i] || 'NULL') ? null : params.shift()
  }
  if (abortOnDup) {
    if (table === 'workspace_locks') {
      if (jsonTable(json, table).some((existing) => existing.workspace_path === row.workspace_path)) {
        const err = new Error('UNIQUE constraint failed: workspace_locks.workspace_path')
        err.code = 'SQLITE_CONSTRAINT_PRIMARYKEY'
        throw err
      }
    }
    if (table === 'workflow_instances' && row.active_key) {
      if (jsonTable(json, table).some((existing) => existing.active_key === row.active_key)) {
        const err = new Error('UNIQUE constraint failed: workflow_instances.active_key')
        err.code = 'SQLITE_CONSTRAINT'
        throw err
      }
    }
  }
  const rows = jsonTable(json, table)
  if (table === 'stages') row.id = ++json._stageId
  if (table === 'events') row.seq = ++json._seq
  json.memo[table].push(row)
  return { changes: 1 }
}
function jsonUpdate(json, sql, params) {
  const match = /^UPDATE\s+(\w+)\s+SET\s+(.*?)\s+WHERE\s+(.*)$/is.exec(sql.trim())
  if (!match) throw new Error(`JsonLedger: unsupported UPDATE: ${sql.slice(0, 80)}`)
  const table = match[1]
  const assigns = match[2].split(',').map((part) => {
    const splitAt = part.indexOf('=')
    return { column: part.slice(0, splitAt).trim(), value: part.slice(splitAt + 1).trim() }
  })
  // SET parameters bind before WHERE parameters.
  for (const assign of assigns) {
    if (assign.value === '?') assign.value = params.shift()
    else if (/^NULL$/i.test(assign.value)) assign.value = null
  }
  const whereResult = whereFn(match[3], params)
  const rows = jsonTable(json, table)
  let changes = 0
  for (const row of rows) {
    if (!whereResult.test(row)) continue
    for (const assign of assigns) row[assign.column] = assign.value
    changes++
  }
  return { changes }
}
function jsonDelete(json, sql, params) {
  const match = /^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.*?))?$/i.exec(sql.trim())
  if (!match) throw new Error(`JsonLedger: unsupported DELETE: ${sql.slice(0, 80)}`)
  const table = match[1]
  const rows = jsonTable(json, table)
  let changes = 0
  if (match[2] === undefined) {
    changes = rows.length
    json.memo[table] = []
    return { changes }
  }
  const whereResult = whereFn(match[2], params)
  const keep = []
  for (const row of rows) {
    if (whereResult.test(row)) changes++
    else keep.push(row)
  }
  json.memo[table] = keep
  return { changes }
}
function jsonLastId(json) {
  return json._stageId || 0
}

function isConstraintError(error) {
  if (!error) return false
  const code = error.code || ''
  const message = String(error.message || '')
  return /SQLITE_CONSTRAINT/.test(code) || /UNIQUE constraint|PRIMARY KEY/.test(message)
}
function hydrateInstance(row) {
  if (!row) return null
  return { ...row, config: row.config ? safeParse(row.config) : {} }
}
function hydrateStage(row) {
  if (!row) return null
  return {
    ...row,
    input_snapshot: row.input_snapshot ? safeParse(row.input_snapshot) : null,
    state_json: row.state_json ? safeParse(row.state_json) : null,
    output: row.output ? safeParse(row.output) : null
  }
}
function hydrateArtifact(row) {
  return { ...row, stale: Number(row.stale) === 1 }
}
function rowOrNull(row) {
  return row === undefined || row === null ? null : row
}
function jsonValue(value, fallback) {
  if (value === undefined || value === null) return fallback ?? null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return fallback ?? null
  }
}
function safeParse(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export function sha256Of(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

export function newId(prefix = '') {
  return `${prefix}${randomUUID().slice(0, 8)}${Date.now().toString(36).slice(-6)}`
}

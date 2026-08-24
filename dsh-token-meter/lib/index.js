/**
 * dsh-token-meter-scccy host half.
 *
 * Captures real per-call token usage by wrapping the `llm/stream` waterfall
 * and persists it into a local SQLite database (node:sqlite, no external
 * dependency) at ~/.dsh/token-meter/meter.db. The stream's typed
 * `{ type: "usage", usage: TokenUsage }` chunk uses disjoint camelCase counts
 * (`inputTokens` = uncached input only, `cacheReadTokens` = cache hits,
 * `cacheWriteTokens` = cache writes); billed prompt input is their sum.
 * Aggregation is done by the database on read, so the host process holds no
 * growing in-memory copies:
 *
 *   day_model(day, model, input, output, calls, cache_hit, cache_miss)
 *   hour_agg(day, hour, input, output, calls)
 *
 * Legacy JSON month files (usage-YYYYMM.json) are imported once at startup
 * and renamed to *.json.migrated.
 *
 * HTTP routes for the browser half:
 *
 *   POST /api/dsh-tokmeter/summary  { month: "YYYY-MM" }  -> month summary
 *   POST /api/dsh-tokmeter/months   {}                     -> { months: [...] }
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

export const name = 'dsh-token-meter-scccy'
export const inject = ['webServer']

const SUMMARY_ROUTE = '/api/dsh-tokmeter/summary'
const MONTHS_ROUTE = '/api/dsh-tokmeter/months'
const DB_FILE = 'meter.db'
const MAX_BODY_BYTES = 64 * 1024

const pad = (n) => (n < 10 ? '0' + (n | 0) : '' + n)
const monthKeyOf = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1)
const dayKeyOf = (d) => monthKeyOf(d) + '-' + pad(d.getDate())

const UPSERT_DAY = 'INSERT INTO day_model (day, model, input, output, calls, cache_hit, cache_miss) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(day, model) DO UPDATE SET input = input + excluded.input, output = output + excluded.output, ' +
  'calls = calls + excluded.calls, cache_hit = cache_hit + excluded.cache_hit, cache_miss = cache_miss + excluded.cache_miss'
const UPSERT_HOUR = 'INSERT INTO hour_agg (day, hour, input, output, calls) VALUES (?, ?, ?, ?, ?) ' +
  'ON CONFLICT(day, hour) DO UPDATE SET input = input + excluded.input, output = output + excluded.output, calls = calls + excluded.calls'

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && v.length > 0) {
    const n = Number(v)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return 0
}

function readUsage(chunk) {
  if (chunk === null || typeof chunk !== 'object') return null
  const pick = (u, keys) => {
    for (const k of keys) {
      const v = num(u[k])
      if (v > 0) return v
    }
    return 0
  }
  const cacheHitOf = (u) => {
    let hit = pick(u, ['cacheReadTokens', 'prompt_cache_hit_tokens', 'promptCacheHitTokens', 'cache_hit_tokens', 'cacheHitTokens', 'cache_read_input_tokens', 'cacheReadInputTokens', 'cached_tokens', 'cachedTokens'])
    if (!(hit > 0) && u.input_tokens_details && typeof u.input_tokens_details === 'object') hit = num(u.input_tokens_details.cached_tokens)
    if (!(hit > 0) && u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object') hit = num(u.prompt_tokens_details.cached_tokens)
    return hit
  }
  const cacheMissOf = (u) => {
    let miss = pick(u, ['cacheWriteTokens', 'prompt_cache_miss_tokens', 'promptCacheMissTokens', 'cache_miss_tokens', 'cacheMissTokens', 'cache_creation_input_tokens', 'cacheCreationInputTokens'])
    if (!(miss > 0) && u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object') miss = num(u.prompt_tokens_details.cache_write_tokens)
    return miss
  }

  // The DSH `llm/stream` protocol ends each stream with a typed
  // `{ type: "usage", usage: TokenUsage }` chunk. TokenUsage counts are
  // DISJOINT camelCase: `inputTokens` is uncached input only, while cache
  // hits/writes ride `cacheReadTokens`/`cacheWriteTokens`. Billed prompt
  // input is therefore the sum of the three.
  if (chunk.usage && typeof chunk.usage === 'object') {
    const u = chunk.usage
    const output = pick(u, ['outputTokens', 'completion_tokens', 'output_tokens', 'completionTokens', 'output_text_token_count'])
    const hit = cacheHitOf(u)
    const miss = cacheMissOf(u)
    const uncached = pick(u, ['inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'prompt_token_count'])
    const input = uncached + hit + miss
    if (!(input > 0 || output > 0)) return null
    return { input, output, total: input + output, cacheHit: Math.min(hit, input), cacheMiss: miss }
  }

  // Raw provider shapes (non-normalized adapters) nested under choices/message.
  // For these, `input` usually already means the billed prompt total
  // (DeepSeek's prompt_tokens includes cache hits).
  let u = null
  if (Array.isArray(chunk.choices) && chunk.choices[0] && chunk.choices[0].usage && typeof chunk.choices[0].usage === 'object') u = chunk.choices[0].usage
  else if (chunk.message && chunk.message.usage && typeof chunk.message.usage === 'object') u = chunk.message.usage
  if (u === null) return null
  const input = pick(u, ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens', 'prompt_token_count'])
  const output = pick(u, ['completion_tokens', 'output_tokens', 'completionTokens', 'outputTokens', 'output_text_token_count'])
  if (!(input > 0 || output > 0)) return null
  let hit = cacheHitOf(u)
  let miss = cacheMissOf(u)
  if (!(miss > 0) && hit > 0) miss = Math.max(0, input - hit)
  if (hit > input) hit = input
  return { input, output, total: input + output, cacheHit: hit, cacheMiss: miss }
}

function readModel(options, chunk) {
  const m = (options && options.model) || (options && options.config && options.config.model) || (chunk && chunk.model)
  if (typeof m === 'string' && m.length > 0 && m.length < 300) return m
  const p = (options && options.provider) || (options && options.config && options.config.provider)
  if (typeof p === 'string' && p.length > 0 && p.length < 300) return p + '/*'
  return 'unknown'
}

export function apply(ctx) {
  const { webServer } = ctx

  const dataDir = (() => {
    let base = typeof process !== 'undefined' && process.env && process.env.DSH_HOME ? process.env.DSH_HOME : ''
    if (base === '' && typeof homedir === 'function') base = homedir() + '/.dsh'
    return base === '' ? '' : join(base, 'token-meter')
  })()
  const dbPath = join(dataDir, DB_FILE)

  // Bounded diagnostics: when a stream reports usage with NO cache tokens, record
  // the distinct raw usage-shapes (once each, capped) so a missing/renamed cache
  // field is visible without waiting on logs. Written to diag-usage.jsonl.
  const DIAG_FILE = join(dataDir, 'diag-usage.jsonl')
  const DIAG_MAX_SHAPES = 40
  const diagShapes = new Set()
  const captureDiagShape = (model, chunk) => {
    if (chunk === null || typeof chunk !== 'object') return
    let u = (chunk.usage && typeof chunk.usage === 'object') ? chunk.usage : null
    if (u === null && Array.isArray(chunk.choices) && chunk.choices[0] && chunk.choices[0].usage && typeof chunk.choices[0].usage === 'object') u = chunk.choices[0].usage
    else if (u === null && chunk.message && chunk.message.usage && typeof chunk.message.usage === 'object') u = chunk.message.usage
    if (u === null) return
    const shape = JSON.stringify(Object.keys(u).sort())
    const sig = (typeof model === 'string' ? model : '?') + ' :: ' + shape
    if (diagShapes.has(sig) || diagShapes.size >= DIAG_MAX_SHAPES) return
    diagShapes.add(sig)
    try {
      const sample = {}
      for (const k of Object.keys(u)) {
        const v = u[k]
        sample[k] = typeof v === 'number' ? Math.round(v) : (typeof v === 'object' && v !== null ? '<' + Object.keys(v).sort().join(',') + '>' : v)
      }
      appendFileSync(DIAG_FILE, JSON.stringify({ t: new Date().toISOString(), model, shape, sample }) + '\n')
    } catch (error) {
      // diagnostics must never break recording
    }
  }

  let disposed = false
  let db = null
  let stDayModel = null
  let stHourAgg = null
  let stHasDayModel = null
  let stDaysByMonth = null
  let stModelsByMonth = null
  let stHoursByMonth = null
  let stMonths = null

  // ---- database open + schema ----
  mkdirSync(dataDir, { recursive: true })
  db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS day_model (
      day TEXT NOT NULL,
      model TEXT NOT NULL,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      cache_hit INTEGER NOT NULL DEFAULT 0,
      cache_miss INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, model)
    );
    CREATE TABLE IF NOT EXISTS hour_agg (
      day TEXT NOT NULL,
      hour INTEGER NOT NULL,
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, hour)
    );
  `)
  stDayModel = db.prepare(UPSERT_DAY)
  stHourAgg = db.prepare(UPSERT_HOUR)
  stHasDayModel = db.prepare('SELECT 1 AS one FROM day_model WHERE day = ? AND model = ? LIMIT 1')
  stDaysByMonth = db.prepare('SELECT day, SUM(input) AS input, SUM(output) AS output, SUM(calls) AS calls, SUM(cache_hit) AS cacheHit, SUM(cache_miss) AS cacheMiss FROM day_model WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day')
  stModelsByMonth = db.prepare('SELECT model, SUM(input) AS input, SUM(output) AS output, SUM(calls) AS calls, SUM(cache_hit) AS cacheHit, SUM(cache_miss) AS cacheMiss FROM day_model WHERE day >= ? AND day <= ? GROUP BY model')
  stHoursByMonth = db.prepare('SELECT hour, SUM(input) AS input, SUM(output) AS output, SUM(calls) AS calls FROM hour_agg WHERE day >= ? AND day <= ? GROUP BY hour')
  stMonths = db.prepare("SELECT DISTINCT substr(day, 1, 7) AS m FROM day_model UNION SELECT DISTINCT substr(day, 1, 7) AS m FROM hour_agg ORDER BY m")

  // ---- one-time import of legacy JSON month files ----
  const migrateLegacyJson = () => {
    try {
      for (const name of readdirSync(dataDir)) {
        if (!/^usage-(\d{4})(\d{2})\.json$/.test(name)) continue
        const file = join(dataDir, name)
        try {
          const parsed = JSON.parse(readFileSync(file, 'utf8'))
          const rawDays = (parsed && typeof parsed.days === 'object' && parsed.days) || {}
          for (const key of Object.keys(rawDays)) {
            const day = rawDays[key]
            if (!day || typeof day !== 'object') continue
            const models = (day.models && typeof day.models === 'object' && day.models) || {}
            for (const m of Object.keys(models)) {
              const r = models[m]
              if (!r || typeof r !== 'object') continue
              const existing = stHasDayModel.get(key, m)
              if (existing !== undefined) continue
              stDayModel.run(key, m, num(r.input), num(r.output), num(r.calls), num(r.cacheHit), num(r.cacheMiss))
            }
            const hours = (day.hours && typeof day.hours === 'object' && day.hours) || {}
            for (const h of Object.keys(hours)) {
              const r = hours[h]
              if (!r || typeof r !== 'object') continue
              const hour = Number(h)
              if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue
              stHourAgg.run(key, hour, num(r.input), num(r.output), num(r.calls))
            }
          }
        } catch (error) {
          console.error('[token-meter] legacy json parse failed', name, error)
          continue
        }
        try {
          renameSync(file, file + '.migrated')
        } catch (error) {
          console.error('[token-meter] legacy json rename failed', name, error)
        }
      }
    } catch (error) {
      console.error('[token-meter] legacy migration failed', error)
    }
  }
  migrateLegacyJson()

  // ---- capture + persist (direct DB writes, no memory growth) ----
  const record = (ts, model, usage) => {
    if (disposed) return
    try {
      const d = new Date(ts)
      const dayKey = dayKeyOf(d)
      stDayModel.run(dayKey, model, usage.input, usage.output, 1, usage.cacheHit, usage.cacheMiss)
      stHourAgg.run(dayKey, d.getHours(), usage.input, usage.output, 1)
    } catch (error) {
      console.error('[token-meter] record failed', error)
    }
  }

  ctx.on('llm/stream', (options, next) => {
    const startedAt = Date.now()
    return (async function* watched() {
      let lastUsage = null
      let lastChunk = null
      const upstream = await next()
      for await (const chunk of upstream) {
        lastChunk = chunk
        const usage = readUsage(chunk)
        if (usage !== null) {
          lastUsage = usage
          if (usage.cacheHit <= 0 && usage.cacheMiss <= 0 && usage.input > 0) {
            captureDiagShape(readModel(options, chunk), chunk)
          }
        }
        yield chunk
      }
      if (lastUsage !== null) {
        try {
          record(startedAt, readModel(options, lastChunk), lastUsage)
        } catch (error) {
          console.error('[token-meter] record submit failed', error)
        }
      }
    })()
  })

  // ---- queries ----
  // Cache hit rate over the whole billed prompt side: a hit means the token
  // was served from cache, everything else on the prompt side was not.
  const rateOf = (hit, promptInput) => (promptInput > 0 ? hit / promptInput : 0)

  const summarize = (monthKey) => {
    const lo = monthKey + '-01'
    const hi = monthKey + '-31'
    const dayRows = stDaysByMonth.all(lo, hi)
    const modelRows = stModelsByMonth.all(lo, hi)
    const hourRows = stHoursByMonth.all(lo, hi)

    const total = { input: 0, output: 0, total: 0, calls: 0, cacheHit: 0, cacheMiss: 0, cacheRate: 0 }
    const hours = []
    for (let h = 0; h < 24; h++) hours.push({ hour: h, input: 0, output: 0, calls: 0 })
    const daysAll = {}
    for (const row of dayRows) {
      daysAll[String(row.day)] = row
      total.input += num(row.input)
      total.output += num(row.output)
      total.calls += num(row.calls)
      total.cacheHit += num(row.cacheHit)
      total.cacheMiss += num(row.cacheMiss)
    }
    for (const row of hourRows) {
      const idx = Number(row.hour)
      if (Number.isInteger(idx) && idx >= 0 && idx <= 23) {
        hours[idx].input += num(row.input)
        hours[idx].output += num(row.output)
        hours[idx].calls += num(row.calls)
      }
    }
    const parts = /^(\d{4})-(\d{2})$/.exec(monthKey)
    const dim = parts ? new Date(Number(parts[1]), Number(parts[2]), 0).getDate() : 30
    const fullDays = []
    for (let i = 1; i <= dim; i++) {
      const k = monthKey + '-' + pad(i)
      const day = daysAll[k]
      fullDays.push(day
        ? { day: k, input: num(day.input), output: num(day.output), calls: num(day.calls), cacheHit: num(day.cacheHit), cacheMiss: num(day.cacheMiss), cacheRate: rateOf(num(day.cacheHit), num(day.input)) }
        : { day: k, input: 0, output: 0, calls: 0, cacheHit: 0, cacheMiss: 0, cacheRate: 0 })
    }
    const models = modelRows.map((m) => ({
      model: String(m.model),
      input: num(m.input),
      output: num(m.output),
      calls: num(m.calls),
      cacheHit: num(m.cacheHit),
      cacheMiss: num(m.cacheMiss),
      cacheRate: rateOf(num(m.cacheHit), num(m.input)),
    })).sort((a, b) => ((b.input + b.output) - (a.input + a.output)))
    total.total = total.input + total.output
    total.cacheRate = rateOf(total.cacheHit, total.input)
    return { month: monthKey, total, days: fullDays, models, hours }
  }

  const listMonths = () => {
    const found = {}
    found[monthKeyOf(new Date())] = true
    for (const row of stMonths.all()) {
      const m = String(row.m)
      if (/^\d{4}-\d{2}$/.test(m)) found[m] = true
    }
    return Object.keys(found).sort()
  }

  // ---- HTTP ----
  const readJsonBody = async (req) => {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text.length === 0) return {}
    return JSON.parse(text)
  }

  const writeJson = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }

  const handleSummary = async (req, res) => {
    let payload = {}
    try {
      payload = await readJsonBody(req)
    } catch (error) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: '请求体必须是 JSON' })
      return
    }
    let monthKey = payload !== null && typeof payload === 'object' && typeof payload.month === 'string' && /^\d{4}-\d{2}$/.test(payload.month)
      ? payload.month
      : monthKeyOf(new Date())
    try {
      writeJson(res, 200, summarize(monthKey))
    } catch (error) {
      writeJson(res, 500, { ok: false, code: 'summary-failed', message: String(error && error.message ? error.message : error) })
    }
  }

  const handleMonths = async (req, res) => {
    try {
      writeJson(res, 200, { months: listMonths() })
    } catch (error) {
      writeJson(res, 500, { ok: false, code: 'months-failed', message: String(error && error.message ? error.message : error) })
    }
  }

  ctx.effect(() => {
    const disposeSummary = webServer.register({ kind: 'exact', path: SUMMARY_ROUTE, handler: handleSummary })
    const disposeMonths = webServer.register({ kind: 'exact', path: MONTHS_ROUTE, handler: handleMonths })
    return () => {
      disposeSummary()
      disposeMonths()
      disposed = true
      try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        db.close()
      } catch (error) {
        console.error('[token-meter] db close failed', error)
      }
    }
  }, 'dsh-token-meter-scccy: routes & db')
}
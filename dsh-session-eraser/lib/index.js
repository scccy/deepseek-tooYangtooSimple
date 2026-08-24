/**
 * dsh-session-eraser host half.
 *
 * Registers one HTTP route that ends (cancel + settle + flush when live) and
 * then permanently deletes a session: archive-first row hiding, path-validated
 * filesystem removal, workspace-record cleanup.
 *
 * No shell dependency: the host process removes files with node:fs.
 *
 * v0.2 changes:
 *  - Path validation no longer assumes every session id is `session-`-prefixed
 *    (fork/subagent children use bare ids). The session directory must exactly
 *    match the persistence backend's id encoding, derived from `locate()`.
 *  - The live session is settled through `agent.whenIdle()` with a timeout
 *    ceiling instead of a fixed 300 ms sleep.
 *  - Workspace-record cleanup is awaited and defensive; the stale
 *    `session_projcache` storage-domain scrub was dropped (the projection
 *    cache is no longer a storage domain in current DSH).
 */
import { basename, dirname, isAbsolute } from 'node:path'
import { rm } from 'node:fs/promises'

export const name = 'dsh-session-eraser'
export const inject = ['webServer', 'sessions', 'agents', 'sessionPersistence', 'workspaceRegistry', 'storageDomain']

const DELETE_ROUTE = '/api/dsh-sesdel/delete'
const MAX_BODY_BYTES = 64 * 1024
const SETTLE_TIMEOUT_MS = 8000
const ARTIFACT_NAME = /^session\.jsonl(\.zstd)?$/

/**
 * Mirror of the persistence backend's session-id → path-segment escaping
 * (`encodeSegment` in dsh-session-persistence-jsonl). Safe code units stay
 * literal, `~` and the rest become `~XXXX`. This lets us verify the on-disk
 * directory against the id we were handed without importing backend internals.
 */
function encodeSegment(raw) {
  if (raw.length === 0) return ''
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return out
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function apply(ctx) {
  const { sessions, agents, sessionPersistence, workspaceRegistry, storageDomain, webServer } = ctx

  const stopLiveSession = async (sessionId, warnings) => {
    const liveSession = sessions !== undefined ? sessions.get(sessionId) : undefined
    if (liveSession === undefined) return false
    const agent = agents !== undefined ? agents.get(sessionId) : undefined
    if (agent !== undefined && typeof agent.cancel === 'function') {
      try {
        agent.cancel({ kind: 'disposed' })
      } catch (error) {
        warnings.push('中断运行中的会话失败:' + String(error && error.message ? error.message : error))
      }
    }
    // Let the aborted turn converge instead of assuming a fixed 300 ms.
    try {
      if (agent !== undefined && typeof agent.whenIdle === 'function') {
        await Promise.race([agent.whenIdle(), delay(SETTLE_TIMEOUT_MS)])
      } else {
        await delay(300)
      }
    } catch (error) {
      warnings.push('等待会话收敛失败:' + String(error && error.message ? error.message : error))
    }
    try {
      await sessions.flush(liveSession)
    } catch (error) {
      warnings.push('结算日志失败:' + String(error && error.message ? error.message : error))
    }
    return true
  }

  const cleanupWorkspaceRecords = async (sessionId, warnings) => {
    if (storageDomain === undefined) {
      warnings.push('storageDomain 不可用,工作区记录未同步')
      return
    }
    try {
      const wsDomain = storageDomain.get('workspace')
      if (wsDomain === undefined) return
      const wsTable = wsDomain.table('workspaces')
      for (const [key, record] of wsTable.entries()) {
        if (record === null || typeof record !== 'object') continue
        const ids = record.sessionIds
        if (!Array.isArray(ids) || ids.indexOf(sessionId) === -1) continue
        await wsTable.update(key, (current) => {
          const currentIds = Array.isArray(current && current.sessionIds) ? current.sessionIds : []
          if (currentIds.indexOf(sessionId) === -1) return current
          return { ...current, sessionIds: currentIds.filter((id) => id !== sessionId) }
        })
      }
    } catch (error) {
      warnings.push('清理工作区记录失败:' + String(error && error.message ? error.message : error))
    }
  }

  const deleteArtifact = async (sessionId) => {
    const warnings = []
    const terminatedLive = await stopLiveSession(sessionId, warnings)

    const headers = await sessionPersistence.list()
    const header = headers.find((candidate) => String(candidate.id) === sessionId)
    if (header === undefined) {
      return { ok: false, code: 'missing', message: '会话不存在或已被删除。', terminatedLive }
    }

    const location = sessionPersistence.locate(header)
    if (location === undefined || typeof location.path !== 'string' || location.path.length === 0) {
      return { ok: false, code: 'no-artifact', message: '找不到该会话的存储文件。', terminatedLive }
    }
    if (!isAbsolute(location.path)) {
      return { ok: false, code: 'path-mismatch', message: '存储路径不是绝对路径,已中止删除。', terminatedLive }
    }
    const artifactName = basename(location.path)
    if (!ARTIFACT_NAME.test(artifactName)) {
      return { ok: false, code: 'path-mismatch', message: '存储文件名异常,已中止删除。', terminatedLive }
    }
    const dir = dirname(location.path)
    const dirBase = basename(dir)
    if (dirBase === '' || dirBase === '.' || dirBase === '..' || dirBase !== encodeSegment(sessionId)) {
      return { ok: false, code: 'path-mismatch', message: '存储路径与会话 id 不匹配,已中止删除。', terminatedLive }
    }

    let archived = false
    if (workspaceRegistry !== undefined) {
      try {
        await workspaceRegistry.archiveSession(sessionId)
        archived = true
      } catch (error) {
        warnings.push('从界面隐藏该行失败:' + String(error && error.message ? error.message : error))
      }
    }

    try {
      await rm(dir, { recursive: true, force: true })
    } catch (error) {
      return { ok: false, code: 'rm-failed', message: '删除存储文件失败:' + String(error && error.message ? error.message : error), terminatedLive }
    }

    await cleanupWorkspaceRecords(sessionId, warnings)
    return { ok: true, warnings, terminatedLive, archived }
  }

  const readJsonBody = async (req) => {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        throw new Error('请求体过大')
      }
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

  const handleDelete = async (req, res) => {
    let payload = {}
    try {
      payload = await readJsonBody(req)
    } catch (error) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: '请求体必须是 JSON' })
      return
    }
    const sessionId = payload !== null && typeof payload === 'object' && typeof payload.sessionId === 'string' ? payload.sessionId : ''
    if (sessionId.length === 0) {
      writeJson(res, 400, { ok: false, code: 'bad-request', message: '缺少 sessionId' })
      return
    }
    let result
    try {
      result = await deleteArtifact(sessionId)
    } catch (error) {
      result = { ok: false, code: 'delete-failed', message: String(error && error.message ? error.message : error) }
    }
    writeJson(res, 200, result)
  }

  const disposeRoutes = () => {
    const disposer = webServer.register({ kind: 'exact', path: DELETE_ROUTE, handler: handleDelete })
    return () => disposer()
  }

  return ctx.effect(disposeRoutes, 'dsh-session-eraser: route')
}
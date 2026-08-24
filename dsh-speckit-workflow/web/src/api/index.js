// RPC client — same contract as the plugin's client.js `callHost`.
//
// 双通道：
//   1) 默认走 in-memory mock（src/api/mock.js），网站独立预览用；
//   2) 打进 dsh 插件后由 board-bundle 入口调用 useRealHostTransport(getSessionId)
//      切到真实宿主 `/api/dsh-speckit-workflow`，并注入每次变更加所需的 actionId。

import { api as mockApi } from './mock.js'
import { newActionId } from '../lib/format.js'
import { adapt } from './adapt.js'

export const CHANNEL = '/api/dsh-speckit-workflow'

const ENDPOINT_TO_METHOD = {
  install: 'install',
  workspaces: 'workspaces',
  check: 'check',
  models: 'models',
  instances: 'instances',
  'instance-create': 'instanceCreate',
  'instance-get': 'instanceGet',
  'instance-cancel': 'instanceCancel',
  'exec-config': 'execConfig',
  'stage-confirm': 'stageConfirm',
  'stage-skip': 'stageSkip',
  'stage-answer': 'stageAnswer',
  'stage-rerun': 'stageRerun',
  'stage-rollback': 'stageRollback',
  'stage-cancel': 'stageCancel',
  'thread-view': 'threadView',
  'thread-message': 'threadMessage',
  'thread-pause': 'threadPause',
  'thread-resume': 'threadResume',
  'thread-tail': 'threadTail',
  'thread-history': 'threadHistory',
  'artifact-read': 'artifactRead',
  'events-since': 'eventsSince'
}

// ---- 可切换的 transport 状态 ---------------------------------------------
let realHostActive = false
let sessionIdResolver = null

export function useRealHostTransport(resolveSessionId) {
  if (typeof resolveSessionId === 'function') sessionIdResolver = resolveSessionId
  realHostActive = true
}

export function useMockTransport() {
  realHostActive = false
}

// ---- 返回对话（插件环境由外壳关闭看板，web 预览回落为提示）----------------
let exitBoardHandler = null
export function setExitBoardHandler(handler) {
  exitBoardHandler = typeof handler === 'function' ? handler : null
}
export async function requestExitBoard() {
  if (exitBoardHandler) {
    exitBoardHandler()
    return
  }
  throw new Error('（Web 预览）返回对话仅在插件环境中生效')
}

// ---- mock transport --------------------------------------------------------
const mockTransport = async (endpoint, payload) => {
  const method = ENDPOINT_TO_METHOD[endpoint]
  if (!method || typeof mockApi[method] !== 'function') {
    throw new Error(`未知端点：${endpoint}`)
  }
  return mockApi[method](payload || {})
}

// ---- real host transport ---------------------------------------------------
async function realTransport(endpoint, payload = {}) {
  const sessionId = sessionIdResolver ? sessionIdResolver() : null
  if (!sessionId) throw new Error('缺少当前会话 sessionId（请先打开一个会话后重试）')

  const body = { endpoint, sessionId, ...(payload || {}) }
  // 真实宿主的每个变更端点都要求幂等 actionId；未显式给出时自动生成。
  if (body.actionId === undefined || body.actionId === null || body.actionId === '') {
    body.actionId = newActionId()
  }

  const response = await window.fetch(CHANNEL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result || result.ok !== true) {
    throw new Error(
      (result && result.error && result.error.message) || `宿主请求失败（${response.status || '网络错误'}）`
    )
  }
  return adapt(endpoint, result.value)
}

// ---- 线程历史（持久化会话日志兜底）-----------------------------------------
// 线程子会话的重启后 live 会话可能已被回收；从持久化日志恢复对话，保证
// 「进入线程 / 查看对话」始终能看到历史消息。走主通道 /api/dsh-speckit-workflow，
// 不再依赖动态插件（重启后依然可用）。
export async function fetchThreadHistory(threadId) {
  if (!threadId || !realHostActive) return null
  try {
    return await realTransport('thread-history', { threadId })
  } catch {
    return null
  }
}

export function mergeThreadMessages(live, history) {
  const seen = new Set()
  const out = []
  for (const message of [...(live || []), ...(history || [])]) {
    if (!message || typeof message.text !== 'string') continue
    const key = `${message.who || ''}\u0000${message.at || 0}\u0000${message.text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(message)
  }
  out.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
  return out
}

// ---- 线程事件尾（增量折叠：真实流式，而非整页轮询）------------------------
export async function threadTail(threadId, fromSeq) {
  if (!threadId || !realHostActive) return null
  try {
    return await realTransport('thread-tail', { threadId, fromSeq: Number(fromSeq) || 0 })
  } catch {
    return null
  }
}

// ---- public ----------------------------------------------------------------
export async function callHost(endpoint, payload = {}) {
  if (realHostActive) return realTransport(endpoint, payload)
  return mockTransport(endpoint, payload)
}
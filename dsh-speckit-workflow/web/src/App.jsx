import { useCallback, useEffect, useRef, useState } from 'react'
import { callHost, requestExitBoard, threadTail } from './api/index.js'
import { CONFIRM_NEXT, EXEC_MODES, nextStageWithConfig, phaseLabel, previousPhaseStart } from './lib/constants.js'
import TopBar from './components/TopBar.jsx'
import Board from './components/Board.jsx'
import CreateModal from './components/CreateModal.jsx'
import InstanceDrawer from './components/InstanceDrawer.jsx'
import ThreadModal from './components/ThreadModal.jsx'
import ConfirmDialog from './components/ConfirmDialog.jsx'
import Toast from './components/Toast.jsx'
import ContextMenu from './components/ContextMenu.jsx'

const POLL_MS = 2500
const THREAD_TAIL_MS = 400
const THREAD_STATUS_MS = 1500

// ---- 线程事件折叠：把持久化会话的原始事件流折叠成可流式渲染的消息 ---------------------------------
function blocksText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim()
}

function toolCallSummary(block) {
  let argsObj = null
  try { argsObj = JSON.parse(block.arguments || '{}') } catch (err) { argsObj = null }
  const name = typeof block.name === 'string' ? block.name : 'tool'
  const desc = argsObj && typeof argsObj.description === 'string' ? argsObj.description : ''
  return '⟳ ' + name + (desc ? ' · ' + desc : '')
}

function toolCallText(block) {
  if (typeof block.arguments !== 'string') return ''
  let argsObj = null
  try { argsObj = JSON.parse(block.arguments) } catch (err) { argsObj = null }
  if (!argsObj) return block.arguments.slice(0, 900)
  const copy = { ...argsObj }
  delete copy.description
  const json = JSON.stringify(copy)
  return json && json !== '{}' ? json.slice(0, 900) : ''
}

function toolResultView(dataMessage) {
  if (!dataMessage || !Array.isArray(dataMessage.content)) return null
  const texts = []
  for (const block of dataMessage.content) {
    if (!block || !Array.isArray(block.content)) continue
    for (const inner of block.content) {
      if (inner && inner.type === 'text' && typeof inner.text === 'string') texts.push(inner.text)
    }
  }
  const joined = texts.join('\n').trim()
  if (!joined) return null
  const first = joined.split('\n').find((line) => line && line.trim()) || ''
  return { summary: '↳ 输出 · ' + joined.length + ' 字符' + (first ? ' · ' + first.trim().slice(0, 90) : ''), text: joined.slice(0, 4000) }
}

function applyThreadEvents(messages, events) {
  // 去掉上一次在渲染中的“流式气泡”，下面按本次事件重算。
  let out = (Array.isArray(messages) ? messages : []).filter((m) => !m.streaming)
  let draftText = ''
  for (const ev of events) {
    if (!ev) continue
    const at = typeof ev.time === 'number' ? ev.time : Date.now()
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {}
    if (ev.type === 'user/message') {
      const text = blocksText(data.content)
      if (text) {
        const last = out[out.length - 1]
        const isDup = last && last.who === 'user' && !last.streaming && last.text === text
        if (!isDup) out.push({ key: 'u' + ev.seq, who: 'user', text, at })
      }
      draftText = ''
    } else if (ev.type === 'assistant/chunk') {
      const chunk = data.chunk
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') draftText += chunk.text
    } else if (ev.type === 'assistant/message') {
      const blocks = data.message && Array.isArray(data.message.content) ? data.message.content : []
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const text = block.text.trim()
          if (text) out.push({ key: 'a' + ev.seq, who: 'assistant', text, at })
        } else if (block.type === 'tool-call') {
          out.push({ key: 'tc' + ev.seq + '-' + (block.id || Math.random().toString(36).slice(2)), who: 'tool-call', summary: toolCallSummary(block), text: toolCallText(block), at })
        }
      }
      draftText = ''
    } else if (ev.type === 'tool/result') {
      const v = toolResultView(data.message)
      if (v) out.push({ key: 'tr' + ev.seq, who: 'tool-result', summary: v.summary, text: v.text, at })
    } else if (ev.type === 'turn/end') {
      draftText = ''
    }
  }
  if (draftText) {
    out = [...out, { key: 'stream', who: 'assistant', text: draftText, at: Date.now(), streaming: true }]
  }
  return out
}

export default function App({ initialWorkspace = null }) {
  const [board, setBoard] = useState(null)
  const [workspace, setWorkspace] = useState(initialWorkspace || null)
  const [models, setModels] = useState(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [detail, setDetail] = useState(null)
  const [threadOpen, setThreadOpen] = useState(false)
  const [thread, setThread] = useState(null)
  const [toast, setToast] = useState(null)
  const [dlg, setDlg] = useState(null)
  const [ctxPos, setCtxPos] = useState(null)
  const [busy, setBusy] = useState(false)

  const workspaceRef = useRef(initialWorkspace || null)
  const instanceIdRef = useRef(null)
  const threadRef = useRef(null)
  const tailSeqRef = useRef(0)
  const toastTimer = useRef(0)
  const dlgResolve = useRef(null)

  const showToast = useCallback((message) => {
    setToast(message)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }, [])

  // ---- dialog helpers (confirm / prompt) ----------------------------------
  const askConfirm = useCallback((title, text, opts = {}) => {
    return new Promise((resolve) => {
      dlgResolve.current = resolve
      setDlg({ title, text, prompt: false, danger: !!opts.danger, confirmLabel: opts.confirmLabel || null, markdown: !!opts.markdown })
    })
  }, [])
  const askPrompt = useCallback((title, text) => {
    return new Promise((resolve) => {
      dlgResolve.current = resolve
      setDlg({ title, text, prompt: true, danger: false, confirmLabel: '确认' })
    })
  }, [])
  // 进入 Implement 前的确认弹窗：附带 Implement 执行方式（workflow / Team + 并行规模）选择。
  const askConfirmExec = useCallback((title, text, exec) => {
    return new Promise((resolve) => {
      dlgResolve.current = resolve
      setDlg({ title, text, prompt: false, danger: false, confirmLabel: '确认进入 Implement', exec: { ...exec } })
    })
  }, [])
  const resolveDialog = useCallback((value) => {
    setDlg(null)
    if (dlgResolve.current) { const r = dlgResolve.current; dlgResolve.current = null; r(value) }
  }, [])

  // ---- run a mutating host call behind the busy flag ----------------------
  const run = useCallback(async (fn) => {
    setBusy(true)
    try { return await fn() } finally { setBusy(false) }
  }, [])

  // ---- board / detail loading ----------------------------------------------
  const refreshBoard = useCallback(async () => {
    try {
      const value = await callHost('instances', { workspace: workspaceRef.current || undefined })
      setBoard(value)
      if (!workspaceRef.current) {
        const target = value.cwd || (value.projects && value.projects[0] && value.projects[0].path)
        if (target) { workspaceRef.current = target; setWorkspace(target) }
      }
    } catch (error) {
      showToast(`看板刷新失败：${error.message}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showToast])

  const refreshDetail = useCallback(async () => {
    const id = instanceIdRef.current
    if (!id) return
    try {
      const value = await callHost('instance-get', { instanceId: id })
      setDetail(value)
    } catch (error) {
      showToast(`详情刷新失败：${error.message}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showToast])

  const openInstance = useCallback(async (card) => {
    instanceIdRef.current = card.instanceId
    setDrawerOpen(true)
    await refreshDetail()
  }, [refreshDetail])

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false)
    instanceIdRef.current = null
    setDetail(null)
  }, [])

  const openThread = useCallback(async (stageRowId, stageId) => {
    const instanceId = instanceIdRef.current
    if (!instanceId || stageRowId == null) return
    try {
      const value = await callHost('thread-view', { instanceId, stageRowId: Number(stageRowId) })
      const liveMessages = Array.isArray(value.messages) ? value.messages : []
      setThread({ ...value, messages: liveMessages })
      setThreadOpen(true)
      const threadId = value.threadId || null
      if (!threadId) return
      // 从事件尾折叠出完整历史与流式增量，避免 live 消息为空；折叠从空列表开始
      // 以去重（live 消息与持久化事件是同一批内容的两种读法）。
      tailSeqRef.current = 0
      const tail = await threadTail(threadId, 0)
      if (tail) {
        tailSeqRef.current = Number(tail.nextSeq) || 0
        const events = Array.isArray(tail.events) ? tail.events : []
        setThread((current) => {
          if (!current || current.threadId !== threadId) return current
          return { ...current, messages: applyThreadEvents([], events) }
        })
      }
    } catch (error) {
      showToast(error.message)
    }
  }, [showToast])

  const closeThread = useCallback(() => {
    setThreadOpen(false)
  }, [])

  const handleWorkspaceChange = useCallback((value) => {
    workspaceRef.current = value
    setWorkspace(value)
    instanceIdRef.current = null
    setDetail(null)
    setDrawerOpen(false)
    void refreshBoard()
  }, [refreshBoard])

  // ---- boot + polling ------------------------------------------------------
  useEffect(() => {
    void (async () => {
      try { setModels(await callHost('models')) } catch { /* optional */ }
      try { await refreshBoard() } catch { /* noop */ }
    })()
  }, [refreshBoard])

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshBoard()
      if (instanceIdRef.current) void refreshDetail()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshBoard, refreshDetail])

  // 线程弹窗打开期间：threadRef 保持最新，供快速/慢速两个轮询读取。
  useEffect(() => {
    threadRef.current = thread
  }, [thread])

  // 快速尾随事件流：按 seq 增量折叠，token 级流式渲染（threadTail）。
  useEffect(() => {
    if (!threadOpen) return
    let cancelled = false
    let running = false
    const tick = async () => {
      if (running) return
      running = true
      try {
        const current = threadRef.current
        if (!current || !current.threadId) return
        const threadId = current.threadId
        const fromSeq = tailSeqRef.current || 0
        const tail = await threadTail(threadId, fromSeq)
        if (cancelled || !tail) return
        tailSeqRef.current = Number(tail.nextSeq) || fromSeq
        const events = Array.isArray(tail.events) ? tail.events : []
        if (events.length) {
          setThread((prev) => {
            if (!prev || prev.threadId !== threadId) return prev
            return { ...prev, messages: applyThreadEvents(prev.messages || [], events) }
          })
        }
      } catch { /* 单次尾随失败静默 */ }
      finally { running = false }
    }
    tick()
    const timer = window.setInterval(tick, THREAD_TAIL_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [threadOpen])

  // 慢速状态轮询：更新阶段状态（执行中/等待…）与 state 文件（待回答/待决策）。
  useEffect(() => {
    if (!threadOpen) return
    let cancelled = false
    const tick = async () => {
      const instanceId = instanceIdRef.current
      const current = threadRef.current
      if (!instanceId || !current || !current.stageRow) return
      const stageRowId = Number(current.stageRow.id)
      try {
        const value = await callHost('thread-view', { instanceId, stageRowId })
        if (cancelled || !value) return
        setThread((prev) => {
          if (!prev || !prev.stageRow || Number(prev.stageRow.id) !== Number(value.stageRow && value.stageRow.id)) return prev
          return { ...prev, stageRow: value.stageRow, state: value.state }
        })
      } catch { /* 静默 */ }
    }
    tick()
    const timer = window.setInterval(tick, THREAD_STATUS_MS)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [threadOpen])

  // ---- stage actions ---------------------------------------------------------
  const afterMutate = useCallback(async () => {
    await Promise.all([refreshBoard(), refreshDetail()])
  }, [refreshBoard, refreshDetail])

  const runStageAction = useCallback(async (action, row) => {
    const instanceId = instanceIdRef.current
    if (!instanceId || !row) return
    try {
      switch (action.id) {
        case 'confirm': {
          const confirmLabel = CONFIRM_NEXT[row.stageId] || (action.label || '进入下一阶段')
          const nextStage = nextStageWithConfig(row.stageId, (detail && detail.instance && detail.instance.config) || {})
          // 确认后直接进入 Implement：在确认弹窗里带上执行方式（workflow / Team），
          // 并行规模由引擎按任务数自动生成。
          if (nextStage === 'implement') {
            const currentExec = (detail && detail.instance && detail.instance.exec) || { mode: 'workflow' }
            const chosen = await askConfirmExec('确认进入 Implement', `${confirmLabel}？固化当前阶段产物后创建 Implement 线程。请选择 Implement 执行方式（并行规模按任务数自动生成）：`, currentExec)
            if (!chosen || !chosen.ok) return
            if (chosen.mode !== currentExec.mode) {
              await run(() => callHost('exec-config', { instanceId, mode: chosen.mode }))
            }
            await run(() => callHost('stage-confirm', { instanceId, stageRowId: row.id }))
            showToast(`已确认，Implement 线程已启动（${chosen.mode === 'team' ? 'Team' : 'workflow'}）`)
            break
          }
          const ok = await askConfirm('确认阶段交接', `${confirmLabel}？固化当前阶段产物后创建下一阶段线程。`)
          if (!ok) return
          await run(() => callHost('stage-confirm', { instanceId, stageRowId: row.id }))
          showToast('已确认，下一阶段线程已启动')
          break
        }
        case 'skip': {
          const reason = await askPrompt('跳过本阶段', '跳过可选阶段（Checklist / Analyze / Taskstoissues）。跳过会记录原因，不会伪造通过。')
          if (reason === null) return
          await run(() => callHost('stage-skip', { instanceId, stageRowId: row.id, reason: reason || '用户选择跳过' }))
          showToast('已跳过')
          break
        }
        case 'redo': {
          const reason = await askPrompt('重新执行本阶段', `将创建 ${row.stageId} 的新 attempt（保留旧记录为历史），并把下游标记为可能过期。`)
          if (reason === null) return
          await run(() => callHost('stage-rerun', { instanceId, stageId: row.stageId, reason }))
          showToast('已重跑')
          break
        }
        case 'cancel-current':
        case 'cancel': {
          const ok = await askConfirm('取消阶段', '将取消当前阶段并释放工作区锁。确定取消？', { danger: true, confirmLabel: '确认取消' })
          if (!ok) return
          await run(() => callHost('stage-cancel', { instanceId, stageRowId: row.id }))
          showToast('已取消')
          break
        }
        case 'pause': {
          await run(() => callHost('thread-pause', { instanceId, stageRowId: row.id, threadId: row.threadId }))
          showToast('已暂停线程（可继续执行或继续对话）')
          break
        }
        case 'resume': {
          await run(() => callHost('thread-resume', { instanceId, stageRowId: row.id, threadId: row.threadId }))
          showToast('已继续执行（同一线程恢复）')
          break
        }
        case 'rollback': {
          const ok = await askConfirm('返回上阶段', '将重新执行上一阶段并标记后续阶段过期。')
          if (!ok) return
          await run(() => callHost('stage-rollback', { instanceId, stageId: row.stageId }))
          showToast('已返回上阶段')
          break
        }
        case 'end-interactive': {
          const ok = await askConfirm('结束交互', '结束当前交互阶段并生成最终摘要（等待确认交接）。')
          if (!ok) return
          await run(() => callHost('stage-answer', { instanceId, stageRowId: row.id, kind: 'end-interactive', text: 'done' }))
          showToast('已结束交互')
          break
        }
        case 'answer':
        case 'thread':
          await openThread(row.id, row.stageId)
          return
        case 'error':
          await refreshDetail()
          return
        case 'stale-reason':
          showToast(row.staleReason || '下游阶段因上游变更被标记为可能过期')
          await refreshDetail()
          return
        case 'artifacts':
          showToast('阶段产物见上方清单，点击可查看')
          return
        case 'history':
          showToast(`attempt 历史（第 ${row.attempt} 次执行，mock）`)
          return
        default:
          return
      }
      await afterMutate()
    } catch (error) {
      showToast(error.message)
    }
  }, [run, askConfirm, askConfirmExec, askPrompt, openThread, refreshDetail, afterMutate, showToast, detail])

  // ---- card-level actions -----------------------------------------------------
  const confirmStageFromCard = useCallback(async (card) => {
    const ok = await askConfirm('确认阶段交接', '确认进入下一阶段？固化当前阶段产物后创建下一阶段线程。')
    if (!ok || !card.currentStageRowId) return
    await run(() => callHost('stage-confirm', { instanceId: card.instanceId, stageRowId: card.currentStageRowId }))
    showToast('已确认，下一阶段线程已启动')
    await afterMutate()
  }, [run, askConfirm, afterMutate, showToast])

  const deleteInstanceFromCard = useCallback(async (card) => {
    const ok = await askConfirm('删除实例', '将删除该 Feature 工作流实例（取消活动阶段并释放工作区锁）。确定删除？', { danger: true, confirmLabel: '确认删除' })
    if (!ok) return
    await run(() => callHost('instance-cancel', { instanceId: card.instanceId }))
    showToast('实例已删除')
    if (instanceIdRef.current === card.instanceId) closeDrawer()
    await refreshBoard()
  }, [run, askConfirm, closeDrawer, refreshBoard, showToast])

  // 大阶段（看板列）回退：如 Implement → Clarify。复用宿主 phase-rollback。
  const rollbackPhase = useCallback(async (instanceId, stageId) => {
    if (!instanceId || !stageId) return
    const targetStage = previousPhaseStart(stageId)
    if (!targetStage) {
      showToast(`${phaseLabel(stageId)} 已是第一个大阶段，无法回退`)
      return
    }
    const ok = await askConfirm(
      '回退上一大阶段',
      `将 ${phaseLabel(stageId)} 大阶段回退到 ${phaseLabel(targetStage)}（${targetStage}）：取消当前阶段、下游标记过期，并从 ${targetStage} 重新执行。确定？`,
      { confirmLabel: '确认回退' }
    )
    if (!ok) return
    await run(() => callHost('phase-rollback', { instanceId, stageId, reason: '用户选择回退上一大阶段' }))
    showToast(`已回退到 ${targetStage}，线程启动中`)
    await Promise.all([refreshBoard(), refreshDetail()])
  }, [run, askConfirm, refreshBoard, refreshDetail, showToast])

  const rollbackStageFromCard = useCallback(async (card) => {
    if (!card || !card.instanceId) return
    await rollbackPhase(card.instanceId, card.currentStage)
  }, [rollbackPhase])

  // 阶段被取消/中断后（无活动阶段行），从卡片直接重新执行当前阶段以继续。
  const resumeInstanceFromCard = useCallback(async (card) => {
    const isCancel = !card.currentStageRowId
    const ok = await askConfirm('重新执行阶段', `${card.currentStage || '当前'} 阶段之前被取消/中断。重新执行会新建 attempt 并继续工作流。确定继续？`, { confirmLabel: '重新执行' })
    if (!ok) return
    await run(() => callHost('stage-rerun', { instanceId: card.instanceId, stageId: card.currentStage, reason: '用户从卡片恢复执行' }))
    showToast('已重新执行，阶段线程启动中')
    await refreshBoard()
  }, [run, askConfirm, refreshBoard, showToast])

  const deleteInstanceFromDrawer = useCallback(async () => {
    const instanceId = instanceIdRef.current
    if (!instanceId) return
    const ok = await askConfirm('删除实例', '将删除该 Feature 工作流实例（取消活动阶段并释放工作区锁）。确定删除？', { danger: true, confirmLabel: '确认删除' })
    if (!ok) return
    await run(() => callHost('instance-cancel', { instanceId }))
    showToast('实例已删除')
    closeDrawer()
    await refreshBoard()
  }, [run, askConfirm, closeDrawer, refreshBoard, showToast])

  // ---- thread answers ---------------------------------------------------------
  const sendAnswer = useCallback(async (text, kind) => {
    const instanceId = instanceIdRef.current
    const tr = thread
    if (!instanceId || !tr || !tr.stageRow) return
    const stage = tr.stageRow
    const stageRowId = Number(stage.id)
    if (!Number.isFinite(stageRowId)) return
    try {
      // 交互阶段（awaiting-user，clarify/converge）仍走 stage-answer 的问答协议；
      // 其余活跃阶段（running / awaiting-confirmation）走 thread-message：把消息
      // 投递进线程，线程再跑一个回合，待确认会被拉回 running 后重新吸收结果。
      if (kind === 'end-interactive' || stage.status === 'awaiting-user') {
        await run(() => callHost('stage-answer', { instanceId, stageRowId, text, kind: kind || 'answer' }))
      } else {
        await run(() => callHost('thread-message', { instanceId, stageRowId, threadId: tr.threadId, text }))
      }
      showToast('已发送到线程')
      // 自己发的内容立即上屏（事件尾随随后会把它补齐为权威消息）。
      if (kind !== 'end-interactive' && text) {
        setThread((current) => current
          ? { ...current, messages: [...(current.messages || []), { key: 'me-' + Date.now(), who: 'user', text, at: Date.now() }] }
          : current)
      }
      await refreshDetail()
    } catch (error) {
      showToast(error.message)
    }
  }, [run, thread, refreshDetail, showToast])

  // ---- thread pause / resume (same thread, no re-spawn) ----------------------
  const pauseThread = useCallback(async () => {
    const instanceId = instanceIdRef.current
    const tr = threadRef.current
    if (!instanceId || !tr || !tr.stageRow) return
    try {
      await run(() => callHost('thread-pause', { instanceId, stageRowId: Number(tr.stageRow.id), threadId: tr.threadId }))
      showToast('已暂停线程（可继续执行或继续对话）')
      await refreshDetail()
    } catch (error) {
      showToast(error.message)
    }
  }, [run, showToast, refreshDetail])

  const resumeThread = useCallback(async () => {
    const instanceId = instanceIdRef.current
    const tr = threadRef.current
    if (!instanceId || !tr || !tr.stageRow) return
    try {
      await run(() => callHost('thread-resume', { instanceId, stageRowId: Number(tr.stageRow.id), threadId: tr.threadId }))
      showToast('已继续执行（同一线程恢复）')
      await refreshDetail()
    } catch (error) {
      showToast(error.message)
    }
  }, [run, showToast, refreshDetail])

  // ---- artifact ----------------------------------------------------------------
  const readArtifact = useCallback(async (path) => {
    const instanceId = instanceIdRef.current
    if (!instanceId || !path) return
    try {
      const value = await callHost('artifact-read', { instanceId, path, limit: 60000 })
      const text = value.text || ''
      await askConfirm(`产物 · ${path}`, text, { markdown: true })
    } catch (error) {
      showToast(error.message)
    }
  }, [askConfirm, showToast])

  // ---- create -------------------------------------------------------------------
  const submitCreate = useCallback(async (input) => {
    try {
      const result = await run(() => callHost('instance-create', { input }))
      showToast('实例已创建，Specify 线程已启动')
      setCreateOpen(false)
      await refreshBoard()
      if (result && result.instanceId) {
        instanceIdRef.current = result.instanceId
        setDrawerOpen(true)
        await refreshDetail()
      }
    } catch (error) {
      showToast(error.message)
    }
  }, [run, refreshBoard, refreshDetail, showToast])

  // ---- board context menu ---------------------------------------------------------
  const onBoardContextMenu = useCallback((event) => {
    // skip when a card (board action element) was the target
    const card = event.target.closest ? event.target.closest('.cardt') : null
    if (card) return
    event.preventDefault()
    const w = 180
    const h = 130
    setCtxPos({
      x: Math.min(event.clientX, window.innerWidth - w),
      y: Math.min(event.clientY, window.innerHeight - h)
    })
  }, [])

  const onCloseBoard = useCallback(() => {
    void requestExitBoard().catch((error) => showToast(error.message))
  }, [showToast])

  const onCtxAction = useCallback((key) => {
    setCtxPos(null)
    if (key === 'new') setCreateOpen(true)
    else if (key === 'refresh') { void refreshBoard(); showToast('看板已刷新') }
    else if (key === 'back') void onCloseBoard()
  }, [refreshBoard, showToast, onCloseBoard])

  const instances = (board && board.instances) || []
  const projects = (board && board.projects) || []
  const worktreeCount = instances.filter((c) => c.mode === 'isolated').length
  const threadStageId = thread && thread.stageRow ? thread.stageRow.stageId : null

  return (
    <div className="app">
      <TopBar
        cwd={(board && board.cwd) || null}
        workspace={workspace}
        onWorkspaceChange={handleWorkspaceChange}
        projects={projects}
        worktreeCount={worktreeCount}
        instanceCount={instances.length}
        onNewFeature={() => setCreateOpen(true)}
        onCloseBoard={onCloseBoard}
      />
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }} onContextMenu={onBoardContextMenu}>
        <Board
          instances={instances}
          busy={busy}
          onOpenInstance={openInstance}
          onConfirmStage={confirmStageFromCard}
          onDeleteInstance={deleteInstanceFromCard}
          onRollbackStage={rollbackStageFromCard}
          onResumeInstance={resumeInstanceFromCard}
        />
      </div>

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        workspace={workspace}
        projects={projects}
        models={models}
        onSubmit={submitCreate}
        loading={busy}
      />

      <InstanceDrawer
        open={drawerOpen}
        detail={detail}
        busy={busy}
        onClose={closeDrawer}
        onStageAction={runStageAction}
        onOpenThread={openThread}
        onReadArtifact={readArtifact}
        onDeleteInstance={deleteInstanceFromDrawer}
        onPhaseRollback={() => rollbackPhase(instanceIdRef.current, detail && detail.instance ? detail.instance.currentStage : null)}
      />

      <ThreadModal
        open={threadOpen}
        thread={thread}
        busy={busy}
        onClose={closeThread}
        onSendAnswer={sendAnswer}
        onPauseThread={pauseThread}
        onResumeThread={resumeThread}
        onRefresh={() => thread && thread.stageRow && openThread(thread.stageRow.id, threadStageId)}
      />

      <ConfirmDialog dlg={dlg} onCancel={() => resolveDialog(null)} onConfirm={resolveDialog} />
      <Toast message={toast} />
      <ContextMenu pos={ctxPos} onAction={onCtxAction} />
    </div>
  )
}

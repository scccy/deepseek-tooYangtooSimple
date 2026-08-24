import { useEffect, useRef, useState } from 'react'
import { Modal } from 'antd'
import { Icon } from '../lib/icons.jsx'
import { formatTime } from '../lib/format.js'

const STAGE_DOT = {
  running: 'live',
  'awaiting-user': 'ask',
  'awaiting-confirmation': 'hold',
  completed: 'done',
  failed: 'failed',
  cancelled: 'failed',
  stale: 'failed',
  skipped: 'done'
}

const STAGE_TEXT = {
  running: '线程执行中',
  'awaiting-user': '等待你回答',
  'awaiting-confirmation': '等待确认',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  stale: '已过期',
  skipped: '已跳过'
}

export default function ThreadModal({ open, thread, onClose, onSendAnswer, onRefresh, busy }) {
  const [value, setValue] = useState('')
  const [stickBottom, setStickBottom] = useState(true)
  const chatRef = useRef(null)

  const stageRow = thread ? thread.stageRow : null
  const messages = thread && Array.isArray(thread.messages) ? thread.messages : []
  const state = thread ? thread.state : null

  const scrollToBottom = (smooth = false) => {
    const el = chatRef.current
    if (!el) return
    try {
      el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
    } catch {
      el.scrollTop = el.scrollHeight
    }
  }

  // 新消息到来（或重新打开）时，若用户停在底部则自动滚到最新；用户上翻时暂停跟随。
  useEffect(() => {
    if (open && stickBottom) scrollToBottom(false)
  }, [thread, open, stickBottom])

  const handleScroll = () => {
    const el = chatRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const atBottom = distance < 48
    if (atBottom !== stickBottom) setStickBottom(atBottom)
  }

  const send = () => {
    const text = value.trim()
    if (!text) return
    onSendAnswer(text, 'answer')
    setValue('')
    setStickBottom(true)
  }

  if (!thread) return null

  const stageStatus = stageRow ? stageRow.status : null
  const title = `线程 · ${stageRow ? `${stageRow.stageId}#${stageRow.attempt}` : ''}`
  const dotClass = STAGE_DOT[stageStatus] || 'done'
  const statusText = STAGE_TEXT[stageStatus] || (stageStatus || '未知')
  const canInteract = ['running', 'awaiting-user', 'awaiting-confirmation'].includes(stageStatus)
  const interactive = stageRow && (stageRow.stageId === 'clarify' || stageRow.stageId === 'converge')
  const executing = stageStatus === 'running'

  const composerHint = executing
    ? '线程正在执行，回复会自动出现在上方'
    : stageStatus === 'awaiting-user'
      ? '输入回答，Enter 发送'
      : '可以继续追问，线程会再执行一个回合'

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={680}
      centered={false}
      className="spkb-modal thread-modal"
      styles={{
        mask: { background: 'rgba(3,7,10,0.72)' },
        content: { background: 'var(--panel)', padding: 0, overflow: 'hidden' },
        body: { padding: 0, overflow: 'hidden' }
      }}
      style={{ top: 34 }}
    >
      <div className="modal-head">
        <div className="thread-title">
          <span className={`status-dot ${dotClass}`} />
          <strong>{title}</strong>
          <span className="thread-status">{statusText}</span>
        </div>
        <button className="modal-close" onClick={onClose} aria-label="关闭">
          <Icon name="x" />
        </button>
      </div>

      <div className="modal-body">
        <div className="chat" ref={chatRef} onScroll={handleScroll}>
          {messages.length ? (
            messages.map((m, i) => {
              const mkey = m.key || `msg-${i}`
              if (m.who === 'tool-call' || m.who === 'tool-result') {
                return (
                  <div className={`trace-row ${m.who}`} key={mkey}>
                    <details className="trace">
                      <summary>{m.summary || m.text || '工具事件'}</summary>
                      {m.text ? <pre>{m.text}</pre> : null}
                    </details>
                  </div>
                )
              }
              const isUser = m.who === 'user'
              return (
                <div className={`bubble ${isUser ? 'user' : 'agent'}${m.streaming ? ' streaming' : ''}`} key={mkey}>
                  <div className="bubble-meta">{isUser ? '你' : '线程'} · {formatTime(m.at)}</div>
                  <div className="bubble-text">{m.text}{m.streaming ? <span className="caret" /> : null}</div>
                </div>
              )
            })
          ) : (
            <div className="empty">线程暂无消息</div>
          )}

          {stageStatus === 'awaiting-user' && state && state.status === 'asking' && state.question && (
            <div className="pending-q">
              <strong>待你回答</strong>
              <div>{state.question}</div>
            </div>
          )}
          {stageStatus === 'awaiting-user' && state && Array.isArray(state.findings) && state.findings.length > 0 && (
            <div className="pending-q">
              <strong>待你决策</strong>
              <div>{state.findings.length} 个发现</div>
            </div>
          )}
          {stageStatus === 'failed' && stageRow && stageRow.error && (
            <div className="pending-q" style={{ borderColor: '#6e3a3a', background: 'rgba(239,125,125,.07)', color: '#f3a9a9' }}>
              <strong>失败原因</strong>
              <div>{stageRow.error}</div>
            </div>
          )}

          {executing && (
            <div className="typing" aria-label="线程执行中">
              <span /><span /><span />
            </div>
          )}

          {!stickBottom && (
            <button
              className="chat-bottom-btn"
              onClick={() => { scrollToBottom(true); setStickBottom(true) }}
            >
              ↓ 回到底部
            </button>
          )}
        </div>

        {canInteract ? (
          <div className="chat-composer">
            <div className="composer-hint">
              <span className={`status-dot ${dotClass}`} />
              {composerHint}
            </div>
            <div className="chat-input">
              <input
                id="thAnswer"
                placeholder={stageStatus === 'awaiting-user' ? '输入回答…' : '给线程发消息…'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') send() }}
                autoFocus
              />
              <button className="btn btn-primary" onClick={send} disabled={busy || !value.trim()}>
                <Icon name="send" />
                {busy ? '发送中…' : '发送'}
              </button>
            </div>
            <div className="chat-actions">
              <button className="btn" onClick={() => !busy && onRefresh()}>
                <Icon name="refresh" />
                刷新
              </button>
              {stageStatus === 'awaiting-user' && interactive && (
                <button className="btn" onClick={() => !busy && onSendAnswer('done', 'end-interactive')}>
                  <Icon name="check" />
                  结束交互
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="pending-q">
            <strong>线程已结束（只读）</strong>
            <div>该阶段的线程已经关闭；如需要它继续工作，请使用阶段操作里的「重跑 / 重试」创建新线程。</div>
          </div>
        )}
      </div>
    </Modal>
  )
}
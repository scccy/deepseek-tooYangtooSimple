import { Icon } from '../lib/icons.jsx'
import { StatusBadge, Dot, stTone } from './badges.jsx'

function actionClass(action) {
  if (action.danger) return 'ph-btn danger'
  if (action.id === 'confirm') return 'ph-btn primary'
  return 'ph-btn'
}

// Mirrors client.js stageHtml: one phase-item per stage thread row.
// 行内布局固定：头部（状态 + 摘要 + 操作按钮）、产物横滑条、异常备注，
// 对话框内容（待回答/待决策）不在此展开，点进线程弹窗再看。
export default function StageRow({ row, onAction, onReadArtifact, onOpen }) {
  // 显式渲染进入线程按钮后，过滤掉宿主动作里重复的 thread 动作。
  const actions = (row.actions || []).filter((action) => !(onOpen && action.id === 'thread'))
  const isLive = ['running', 'awaiting-user', 'awaiting-confirmation', 'creating', 'paused'].includes(row.status)
  // 终态当前阶段（已完成/失败/取消）现在也能继续对话，标签从“查看对话”升级为“继续对话”。
  const continuable = ['paused', 'completed', 'failed', 'cancelled'].includes(row.status)
  const openLabel = isLive && !continuable ? '进入线程' : continuable ? '继续对话' : '查看对话'

  const artifactChips = (row.artifacts || []).slice(0, 8).map((artifact) => {
    const name = (artifact.rel || '').split('/').filter(Boolean).pop() || artifact.rel
    return (
      <button
        key={name}
        className={`chip${artifact.stale ? ' stale' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          onReadArtifact(artifact.rel)
        }}
        title={artifact.rel}
      >
        <Icon name="text" />
        <span>{name}</span>
      </button>
    )
  })

  let stateNote = null
  if (row.error) {
    stateNote = (
      <div className="pending-q" style={{ borderColor: '#6e3a3a', background: 'rgba(239,125,125,.07)', color: '#f3a9a9' }}>
        <strong>失败原因</strong>
        <div>{row.error}</div>
      </div>
    )
  }
  if (row.staleReason) {
    stateNote = (
      <div className="pending-q" style={{ borderColor: '#4f3b68', background: 'rgba(180,140,232,.07)', color: '#d3baf2' }}>
        <strong>过期原因</strong>
        <div>{row.staleReason}</div>
      </div>
    )
  }

  return (
    <div
      className={`phase-item${onOpen ? ' clickable' : ''}`}
      onClick={() => onOpen && onOpen(row)}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={(e) => {
        if (onOpen && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onOpen(row)
        }
      }}
    >
      <div className="ph-dot">
        <Dot tone={stTone(row.status)} />
      </div>

      <div className="ph-head">
        <div className="ph-name">
          {row.title || row.stageId}
          <span className="round-badge" style={{ marginLeft: 4 }}>attempt {row.attempt}</span>
          <StatusBadge status={row.status} />
        </div>
        <div className="ph-sub">
          <span className="ph-summary" title={row.summary || ''}>{row.summary || '—'}</span>
          {row.skillSha256 && (
            <span className="mono" title="skill sha256">{row.skillSha256.slice(0, 8)}</span>
          )}
        </div>
      </div>

      <div className="phase-actions">
        {onOpen && (
          <button
            className={`ph-open${isLive ? ' live' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              onOpen(row)
            }}
          >
            <Icon name="message" size={12} />
            {openLabel}
            <Icon name="chevron" size={11} className="ph-open-arrow" />
          </button>
        )}
        {actions.map((action) => (
          <button
            key={action.id}
            className={actionClass(action)}
            onClick={(e) => {
              e.stopPropagation()
              onAction(action, row)
            }}
          >
            {action.label}
          </button>
        ))}
      </div>

      <div className="ph-chips">
        {artifactChips.length ? artifactChips : <span className="chip-none">无产物</span>}
      </div>

      {stateNote && <div className="ph-note">{stateNote}</div>}
    </div>
  )
}
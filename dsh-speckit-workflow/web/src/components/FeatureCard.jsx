import { Icon } from '../lib/icons.jsx'
import { execLabel } from '../lib/constants.js'
import { stLabel, stTone } from './badges.jsx'

// Mirrors client.js cardHtml exactly.
export default function FeatureCard({ card, onOpen, onConfirm, onDelete, onRollback, onResume, loading }) {
  const [label, tone] = (() => {
    if (card.currentStageStatus) return [stLabel(card.currentStageStatus), stTone(card.currentStageStatus)]
    if (card.status === 'completed') return ['已完成', 'completed']
    if (card.status === 'cancelled') return ['已取消', 'blocked']
    return ['未开始', 'pending']
  })()
  const modeLabel = card.mode === 'isolated' ? 'worktree' : 'inplace'
  const href = card.worktreePath ? card.worktreePath.split('/').filter(Boolean).pop() : card.branch || ''
  const alert = card.currentStageStatus === 'failed' || card.currentStageStatus === 'cancelled'
  const actions = card.actions || []
  const confirmAction = actions.includes('confirm')
  const isSpecify = card.currentStage === 'specify'
  const hasActiveStage = !!card.currentStageRowId

  const stop = (fn) => (event) => {
    event.stopPropagation()
    if (!loading) fn(event)
  }

  return (
    <div
      className={`cardt${alert ? ' alert' : ''}`}
      role="button"
      tabIndex={0}
      data-instance={card.instanceId}
      onClick={() => !loading && onOpen(card)}
      onKeyDown={(e) => { if (e.key === 'Enter') !loading && onOpen(card) }}
    >
      <div className="cardt-top">
        <span className={`dot ${tone}`} />
        <span className="cardt-name" title={card.feature}>{card.feature}</span>
      </div>
      <div className="cardt-wt">
        <Icon name="folder" />
        <span>{card.workspacePath}</span>
      </div>
      <div className="cardt-sub">
        <span className={`st ${tone}`}>{label}</span>
        <span className="mono">{card.currentStage || ''}</span>
        {card.attempt ? <span className="round-badge">#{card.attempt}</span> : null}
      </div>
      <div className="cardt-foot">
        {href ? <span className="mono" style={{ color: 'var(--subtle)', fontSize: 9 }}>{href}</span> : null}
        <span className="cardt-foot-right">
          {card.currentStage === 'implement' && execLabel(card.exec) ? (
            <span className="exec-badge" title={`Implement 执行方式：${execLabel(card.exec)}`}>{execLabel(card.exec)}</span>
          ) : null}
          <span className="cardt-mode">{modeLabel}</span>
        </span>
      </div>
      <div className="cardt-actions">
        {confirmAction && (
          <button
            className="btn btn-primary cardt-btn"
            onClick={stop(() => onConfirm(card))}
            title="确认阶段交接"
          >
            <Icon name="check" />
            确认
          </button>
        )}
        {!hasActiveStage && card.status === 'active' ? (
          <button
            className="btn btn-primary cardt-btn"
            onClick={stop(() => onResume(card))}
            title="上一阶段被取消/中断，重新执行当前阶段以继续工作流"
          >
            <Icon name="rotate" />
            重新执行
          </button>
        ) : null}
        {isSpecify || !hasActiveStage ? (
          <button
            className="btn btn-danger cardt-btn"
            onClick={stop(() => onDelete(card))}
            title="删除该 Feature 实例"
          >
            <Icon name="trash" />
            删除实例
          </button>
        ) : (
          <button
            className="btn btn-danger cardt-btn"
            onClick={stop(() => onRollback(card))}
            title="回退到上一大阶段（如 Implement → Clarify），从上一大阶段重新执行"
          >
            <Icon name="undo" />
            回退大阶段
          </button>
        )}
      </div>
    </div>
  )
}

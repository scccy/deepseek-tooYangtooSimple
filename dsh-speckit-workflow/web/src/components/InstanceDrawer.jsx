import { Drawer } from 'antd'
import { Icon } from '../lib/icons.jsx'
import { formatTime } from '../lib/format.js'
import Journey from './Journey.jsx'
import StageRow from './StageRow.jsx'

const ACTIVE_STATUSES = ['running', 'awaiting-user', 'awaiting-confirmation', 'creating', 'paused']

export default function InstanceDrawer({
  open,
  detail,
  onClose,
  onStageAction,
  onOpenThread,
  onReadArtifact,
  onDeleteInstance,
  onPhaseRollback,
  busy
}) {
  if (!detail) return null

  const instance = detail.instance
  const active = detail.stages.find((stage) => ACTIVE_STATUSES.includes(stage.status)) || null
  const instanceLabel = instance.status === 'active' ? '活动' : instance.status === 'completed' ? '已完成' : '已取消'

  // 底部动作始终作用于当前活动阶段，驱动流水线推进。
  const footActions = []
  if (active && active.status === 'awaiting-user') {
    footActions.push(
      <button key="end" className="btn" onClick={() => !busy && onStageAction({ id: 'end-interactive' }, active)}>
        <Icon name="check" />
        结束交互
      </button>
    )
  } else if (active && active.status === 'paused') {
    footActions.push(
      <button key="resume" className="btn btn-primary" onClick={() => !busy && onStageAction({ id: 'resume' }, active)}>
        <Icon name="play" />
        继续执行
      </button>
    )
    if (active.threadId) {
      footActions.push(
        <button key="thread" className="btn" onClick={() => !busy && onOpenThread(active.id, active.stageId)}>
          <Icon name="message" />
          继续对话
        </button>
      )
    }
    footActions.push(
      <button key="cancel" className="btn btn-danger" onClick={() => !busy && onStageAction((active.actions || []).find((a) => a.id === 'cancel-current') || { id: 'cancel-current' }, active)}>
        <Icon name="trash" />
        停止阶段
      </button>
    )
  } else if (active && active.status === 'awaiting-confirmation') {
    const confirmAction = (active.actions || []).find((a) => a.id === 'confirm')
    if (confirmAction) {
      footActions.push(
        <button key="confirm" className="btn btn-primary" onClick={() => !busy && onStageAction(confirmAction, active)}>
          <Icon name="check" />
          {confirmAction.label}
        </button>
      )
    }
    if ((active.actions || []).some((a) => a.id === 'skip')) {
      footActions.push(
        <button key="skip" className="btn" onClick={() => !busy && onStageAction(active.actions.find((a) => a.id === 'skip'), active)}>
          跳过
        </button>
      )
    }
    footActions.push(
      <button key="redo" className="btn" onClick={() => !busy && onStageAction(active.actions.find((a) => a.id === 'redo'), active)}>
        重做
      </button>,
      <button key="cancel" className="btn btn-danger" onClick={() => !busy && onStageAction(active.actions.find((a) => a.id === 'cancel-current'), active)}>
        <Icon name="trash" />
        取消
      </button>
    )
  } else if (instance.status === 'active' && instance.currentStage) {
    // 阶段被取消/中断后没有活动行：提供“重新执行”继续工作流
    footActions.push(
      <button key="resume" className="btn btn-primary" onClick={() => !busy && onStageAction({ id: 'redo' }, { stageId: instance.currentStage })}>
        <Icon name="rotate" />
        重新执行 {instance.currentStage}
      </button>
    )
  }
  if (onPhaseRollback && instance.status === 'active') {
    footActions.push(
      <button key="phase-back" className="btn btn-danger" onClick={() => !busy && onPhaseRollback()} title="回退到上一大阶段（如 Implement → Clarify），从上一大阶段重新执行">
        <Icon name="undo" />
        回退大阶段
      </button>
    )
  }

  const header = (
    <div className="drawer-head">
      <div className="t">
        <div className="drawer-title">{instance.feature}</div>
        <div className="drawer-sub">
          <span className="mono">{instance.workspacePath}</span>
          <span className={`st ${instance.status === 'active' ? 'running' : instance.status === 'completed' ? 'completed' : 'blocked'}`}>{instanceLabel}</span>
          {instance.branch && <span className="mono">{instance.branch}</span>}
          <span>{instance.mode === 'isolated' ? `worktree · ${instance.worktreePath || ''}` : 'inplace'}</span>
        </div>
      </div>
    </div>
  )

  const footer = (
    <div className="drawer-foot">
      {footActions}
      {detail.instanceId || onDeleteInstance ? (
        <button
          key="delete"
          className="btn btn-danger"
          style={{ marginRight: 'auto' }}
          onClick={() => !busy && onDeleteInstance(active)}
        >
          <Icon name="trash" />
          删除实例
        </button>
      ) : null}
    </div>
  )

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="right"
      width={Math.min(640, window.innerWidth * 0.94)}
      closable
      closeIcon={<Icon name="x" />}
      className="spkb-drawer"
      mask
      title={header}
      footer={footer}
      styles={{
        mask: { background: 'rgba(3,7,10,0.55)' },
        body: { padding: 0, background: 'var(--panel)' },
        header: { padding: 0, borderBottom: '1px solid var(--line)' },
        footer: { padding: 0, borderTop: '1px solid var(--line)' },
        content: { background: 'var(--panel)' }
      }}
    >
      <div className="drawer-body">
        <section>
          <div className="sec-label"><Icon name="kanban" />阶段旅程</div>
          <Journey stages={detail.stages} />
        </section>

        <section>
          <div className="sec-label"><Icon name="target" />阶段线程</div>
          <div className="phase-line">
            {detail.stages.length ? (
              detail.stages.map((stage) => (
                <StageRow
                  key={stage.id}
                  row={stage}
                  onAction={onStageAction}
                  onReadArtifact={onReadArtifact}
                  onOpen={(row) => onOpenThread(row.id, row.stageId)}
                />
              ))
            ) : (
              <div className="empty">暂无阶段</div>
            )}
          </div>
        </section>

        <details className="audit">
          <summary><Icon name="bookmark" />审计 · 人工决策与事件</summary>
          <div className="audit-body">
            <div>
              <div className="sec-label"><Icon name="bookmark" />人工决策记录</div>
              <div className="ev-list" style={{ maxHeight: 140 }}>
                {(detail.decisions || []).slice(-20).map((decision, i) => (
                  <div className="ev-item" key={i}>
                    <span className="mono">{decision.targetStage || decision.kind}</span>
                    <span>{decision.kind}{decision.note ? ` — ${decision.note}` : ''}</span>
                    <span className="mono" style={{ flex: '0 0 auto' }}>{formatTime(decision.at)}</span>
                  </div>
                ))}
                {(detail.decisions || []).length === 0 && <div className="empty">暂无</div>}
              </div>
            </div>
            <div>
              <div className="sec-label"><Icon name="rotate" />事件流</div>
              <div className="ev-list">
                {(detail.events || []).slice(-40).reverse().map((event, i) => (
                  <div className="ev-item" key={i}>
                    <span className="mono">{event.type}</span>
                    <span className="mono">{formatTime(event.time)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </details>
      </div>
    </Drawer>
  )
}
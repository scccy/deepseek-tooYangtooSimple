import { COLUMNS, STAGE_ORDER, STAGE_COLUMN } from '../lib/constants.js'
import { Icon } from '../lib/icons.jsx'
import FeatureCard from './FeatureCard.jsx'

export default function Board({
  instances = [],
  onOpenInstance,
  onConfirmStage,
  onDeleteInstance,
  onRollbackStage,
  onResumeInstance,
  busy
}) {
  const byColumn = { specify: [], clarify: [], implement: [], converge: [] }
  for (const card of instances) {
    const column = COLUMNS.find((c) => c.id === card.column)
    byColumn[column ? column.id : 'specify'].push(card)
  }

  return (
    <div className="board-wrap">
      <div className="board" onContextMenu={(e) => { /* handled at App level */ }}>
        {COLUMNS.map((column) => {
          const cards = byColumn[column.id] || []
          const flowStages = STAGE_ORDER.filter((s) => STAGE_COLUMN.get(s) === column.id)
          return (
            <section className="col" data-col={column.id} key={column.id}>
              <div className="col-head">
                <div className="col-title">
                  <Icon name={column.icon} />
                  {column.name}
                  <span className="col-count">{cards.length}</span>
                </div>
                <div className="col-hint">{column.hint}</div>
                <div className="col-flow">
                  {flowStages.map((s, i) => (
                    <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {i > 0 && <Icon name="chevron" size={10} />}
                      <span className="mono">{s}</span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="col-body">
                {cards.length ? (
                  cards.map((card) => (
                    <FeatureCard
                      key={card.instanceId}
                      card={card}
                      loading={busy}
                      onOpen={onOpenInstance}
                      onConfirm={onConfirmStage}
                      onDelete={onDeleteInstance}
                      onRollback={onRollbackStage}
                      onResume={onResumeInstance}
                    />
                  ))
                ) : (
                  <div className="col-empty">暂无 Feature 实例</div>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

import { STAGE_ORDER, STAGE_TITLES } from '../lib/constants.js'

// Mirrors client.js journeyHtml: 9-step journey with done/cur/warn/loop tiles.
export default function Journey({ stages = [] }) {
  const last = {}
  for (const stage of stages) last[stage.stageId] = stage

  return (
    <div className="journey">
      {STAGE_ORDER.map((id) => {
        const row = last[id]
        const status = row ? row.status : 'not-started'
        const cls =
          status === 'completed' || status === 'skipped'
            ? 'done'
            : status === 'running' || status === 'awaiting-user' || status === 'creating'
              ? 'cur'
              : status === 'failed'
                ? 'warn'
                : status === 'stale'
                  ? 'loop'
                  : ''
        return (
          <div className={`jstep ${cls}`} key={id}>
            <strong>{STAGE_TITLES[id]}</strong>
            <span>{row ? `${row.attempt}·${status}` : '—'}</span>
          </div>
        )
      })}
    </div>
  )
}
import { statusMeta } from '../lib/constants.js'

export function Dot({ tone, className = '' }) {
  return <span className={`dot ${tone} ${className}`} />
}

// status meta from lib/constants ST_META → [label, tone]
export function StatusBadge({ status }) {
  const [label, tone] = statusMeta(status)
  return <span className={`st ${tone}`}>{label}</span>
}

export function StatusDot({ status }) {
  const [, tone] = statusMeta(status)
  return <Dot tone={tone} />
}

export function stLabel(status) {
  return statusMeta(status)[0]
}

export function stTone(status) {
  return statusMeta(status)[1]
}

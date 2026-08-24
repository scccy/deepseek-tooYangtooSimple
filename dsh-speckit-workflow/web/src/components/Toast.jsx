import { Icon } from '../lib/icons.jsx'

export default function Toast({ message }) {
  return (
    <div className={`toast${message ? ' show' : ''}`}>
      <Icon name="check" />
      <span>{message || ''}</span>
    </div>
  )
}

import { Icon } from '../lib/icons.jsx'

const ITEMS = [
  { key: 'new', label: '新建 Feature', icon: 'plus' },
  { key: 'refresh', label: '刷新看板', icon: 'refresh' },
  { key: 'back', label: '返回对话', icon: 'back' }
]

export default function ContextMenu({ pos, onAction }) {
  if (!pos) return null
  return (
    <div
      className="spkb-ctx open"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {ITEMS.map((item) => (
        <button key={item.key} onClick={() => onAction(item.key)}>
          <Icon name={item.icon} size={14} />
          {item.label}
        </button>
      ))}
    </div>
  )
}

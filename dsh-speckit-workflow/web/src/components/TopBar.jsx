import { Select } from 'antd'
import { Icon } from '../lib/icons.jsx'

export default function TopBar({
  title = 'Spec 流水线看板 · Feature 工作台',
  cwd,
  workspace,
  onWorkspaceChange,
  projects = [],
  worktreeCount,
  instanceCount,
  onNewFeature,
  onCloseBoard
}) {
  const options = projects.map((p) => ({
    value: p.path,
    label: `${p.path}${p.ready ? '' : ' ⚠'}`
  }))
  return (
    <header className="topbar">
      <div>
        <div className="topbar-title">{title}</div>
        <div className="topbar-meta">
          <Icon name="folder" />
          <span className="mono">{workspace || cwd || '…'}</span>
        </div>
      </div>
      <div className="topbar-right">
        <span className="metric-pill">
          <Icon name="git-fork" />
          <span>{worktreeCount}</span>
        </span>
        <span className="metric-pill">
          <Icon name="cpu" />
          <span>{instanceCount}</span> 实例
        </span>
        <span className="metric-pill">
          <Icon name="rotate" />
          v0.8
        </span>
        <Select
          className="spkb-monoselect"
          value={workspace || undefined}
          placeholder="选择工作区"
          onChange={onWorkspaceChange}
          options={options}
          popupMatchSelectWidth={false}
          style={{ minWidth: 200 }}
        />
        <button className="btn" onClick={onCloseBoard} title="返回对话">
          <Icon name="back" />
          返回对话
        </button>
        <button className="btn btn-primary" onClick={onNewFeature}>
          <Icon name="plus" />
          新建 Feature
        </button>
      </div>
    </header>
  )
}

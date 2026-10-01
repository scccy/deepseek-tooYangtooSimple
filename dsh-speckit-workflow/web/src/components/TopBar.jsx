import { Select } from 'antd'
import { Icon } from '../lib/icons.jsx'

export default function TopBar({
  title = 'Spec 流水线看板 · Feature 工作台',
  cwd,
  workspace,
  version,
  onWorkspaceChange,
  onInitWorkspace,
  initializing,
  projects = [],
  worktreeCount,
  instanceCount,
  onNewFeature,
  onCloseBoard,
  view = 'board',
  onViewChange
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
          {version && <span className="mono" style={{ opacity: 0.6, fontSize: 11 }}>· v{version}</span>}
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
        <span className="metric-pill" title="插件版本（宿主动态上报，刷新后即为当前安装版本）">
          <Icon name="rotate" />
          {version ? `v${version}` : 'v0.8'}
        </span>
        {onInitWorkspace && (
          <button
            className="btn"
            onClick={() => onInitWorkspace(workspace)}
            disabled={initializing || !workspace}
            title="初始化当前工作区：拷贝内置 spec-kit 骨架生成 .specify/，并同步内置 skills（幂等，可重复执行）"
          >
            <Icon name="rotate" />
            {initializing ? '初始化中…' : '⚙ 初始化工作区'}
          </button>
        )}
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
        <button
          className={`btn ${view === 'constitution' ? 'btn-active' : ''}`}
          onClick={() => onViewChange && onViewChange(view === 'constitution' ? 'board' : 'constitution')}
          title="管理项目 Constitution（.specify/memory/constitution.md）"
        >
          <Icon name="book" />
          📜 Constitution
        </button>
      </div>
    </header>
  )
}

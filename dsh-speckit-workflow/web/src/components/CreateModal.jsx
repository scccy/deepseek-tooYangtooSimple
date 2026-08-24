import { useState } from 'react'
import { Modal, Select, Switch } from 'antd'
import { Icon } from '../lib/icons.jsx'

const SWITCH_ITEMS = [
  { key: 'sw-worktrees', label: '隔离 worktree', desc: 'Specify 后创建/复用 feature worktree 并同步产物', default: true },
  { key: 'sw-checklist', label: 'Checklist 阶段', desc: '生成需求质量 checklist（可选）', default: true },
  { key: 'sw-analyze', label: 'Analyze 阶段', desc: '只读一致性分析（可选）', default: true },
  { key: 'sw-issues', label: 'Taskstoissues', desc: '转换为 GitHub issues（外部副作用，默认关）', default: false }
]

export default function CreateModal({ open, onClose, workspace, projects = [], models, onSubmit, loading }) {
  const [feature, setFeature] = useState('')
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [switches, setSwitches] = useState(() => Object.fromEntries(SWITCH_ITEMS.map((s) => [s.key, s.default])))
  const [submitting, setSubmitting] = useState(false)

  const entry = projects.find((p) => p.path === workspace)
  const hint = workspace
    ? entry
      ? entry.ready
        ? `✓ speckit 就绪 · ${entry.title}`
        : `✗ 未就绪：${(entry.issues || []).join('；')}`
      : '该工作区未在宿主工作区列表'
    : ''

  const modelOptions = (models && models.providers || []).map((provider) => ({
    label: provider.name,
    options: (provider.models || []).map((m) => ({
      label: `${provider.name} / ${m.name || m.id}`,
      value: `${provider.id}::${m.id}`
    }))
  }))

  const flatModels = []
  for (const provider of (models && models.providers) || []) {
    for (const m of provider.models || []) flatModels.push({ providerId: provider.id, model: m })
  }
  const selectedEntry = flatModels.find((entry) => `${entry.providerId}::${entry.model.id}` === model)
  const effortOptions = (() => {
    if (selectedEntry && Array.isArray(selectedEntry.model.efforts) && selectedEntry.model.efforts.length) {
      return selectedEntry.model.efforts.map((e) => ({ value: String(e.id), label: String(e.name || e.id) }))
    }
    const universal =
      models && Array.isArray(models.universalEfforts) && models.universalEfforts.length
        ? models.universalEfforts
        : ['off', 'low', 'medium', 'high', 'max']
    return universal.map((id) => ({ value: String(id), label: String(id) }))
  })()

  const submit = async () => {
    if (!feature.trim()) return
    setSubmitting(true)
    try {
      const parts = model ? model.split('::') : []
      await onSubmit({
        feature: feature.trim(),
        workspacePath: workspace,
        config: {
          useWorktrees: switches['sw-worktrees'],
          runChecklist: switches['sw-checklist'],
          runAnalyze: switches['sw-analyze'],
          runTaskstoissues: switches['sw-issues'],
          ...(parts.length === 2 ? { provider: parts[0], model: parts[1] } : {}),
          ...(effort ? { reasoningEffort: effort } : {})
        }
      })
      setFeature('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={760}
      centered={false}
      className="spkb-modal wide"
      styles={{ mask: { background: 'rgba(3,7,10,0.72)' }, content: { background: 'var(--panel)', padding: 0 } }}
      style={{ top: 34, paddingBottom: 0 }}
      maskClosable
    >
      <div className="modal-head">
        <strong>新建 Feature · 创建实例并启动 Specify 线程</strong>
        <button className="modal-close" onClick={onClose} aria-label="关闭"><Icon name="x" /></button>
      </div>
      <div className="modal-body">
        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title"><Icon name="target" />Feature Context</div>
              <div className="card-cap">创建工作区里的一个 Feature 工作流实例；首先为您启动 Specify 线程，完成后停在人工确认点。</div>
            </div>
          </div>
          <div className="card-body">
            <div className="form-grid">
              <div className="field full">
                <label htmlFor="fFeature">Feature 描述</label>
                <textarea
                  id="fFeature"
                  placeholder="例如：为 web 端实现多账号会话隔离，支持同时登录并切换账户…"
                  value={feature}
                  onChange={(e) => setFeature(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
                />
              </div>
              <div className="field full">
                <label>目标工作区（并入当前工作区）</label>
                <div className="mono" style={{ border: '1px solid var(--line)', borderRadius: 6, background: 'var(--inset)', color: 'var(--text)', padding: '8px 10px', fontSize: 12 }}>
                  {workspace || '—'}
                </div>
                {hint && <div className="card-cap">{hint}</div>}
              </div>
              <div className="form-grid full">
                <div className="field">
                  <label htmlFor="fModel">阶段线程模型</label>
                  <Select
                    id="fModel"
                    className="spkb-modelselect"
                    style={{ width: '100%' }}
                    placeholder="跟随会话默认"
                    value={model || undefined}
                    onChange={(value) => { setModel(value || ''); setEffort('') }}
                    options={modelOptions}
                    allowClear
                    popupMatchSelectWidth={false}
                  />
                </div>
                <div className="field">
                  <label htmlFor="fEffort">思考强度</label>
                  <Select
                    id="fEffort"
                    style={{ width: '100%' }}
                    placeholder={model ? '跟随模型默认' : '选模型后可选'}
                    value={effort || undefined}
                    onChange={setEffort}
                    options={effortOptions}
                    allowClear
                    disabled={!model}
                    popupMatchSelectWidth={false}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div>
              <div className="card-title"><Icon name="kanban" />流程开关</div>
              <div className="card-cap">只读选项：可选阶段是否纳入后续工作流；Specify 始终执行。</div>
            </div>
          </div>
          <div className="card-body">
            <div className="wf-grid">
              {SWITCH_ITEMS.map((item) => (
                <label className="wf-item" key={item.key}>
                  <div>
                    <strong>{item.label}</strong>
                    <span className="d">{item.desc}</span>
                  </div>
                  <span className="switch" style={{ marginLeft: 'auto' }}>
                    <Switch
                      checked={switches[item.key]}
                      onChange={(checked) => setSwitches((s) => ({ ...s, [item.key]: checked }))}
                      size="small"
                    />
                  </span>
                </label>
              ))}
            </div>
          </div>
        </section>
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>取消</button>
        <button
          className="btn btn-primary"
          onClick={submit}
          disabled={loading || submitting || !feature.trim()}
        >
          <Icon name="plus" />
          创建并启动 Specify
        </button>
      </div>
    </Modal>
  )
}

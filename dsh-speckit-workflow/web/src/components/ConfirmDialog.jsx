import { useEffect, useState } from 'react'
import { Modal } from 'antd'
import { Icon } from '../lib/icons.jsx'
import Markdown from './Markdown.jsx'
import { EXEC_MODES } from '../lib/constants.js'

// Generic confirm / prompt dialog (mirrors client.js askConfirm / askPrompt).
export default function ConfirmDialog({ dlg, onCancel, onConfirm }) {
  const [promptValue, setPromptValue] = useState('')
  const [execMode, setExecMode] = useState('workflow')
  useEffect(() => {
    if (dlg && dlg.exec) setExecMode(dlg.exec.mode || 'workflow')
  }, [dlg])
  if (!dlg) return null
  const promptMode = !!dlg.prompt
  const markdownMode = !!dlg.markdown
  const execModeChooser = !!dlg.exec

  const confirm = () => {
    if (execModeChooser) {
      onConfirm({ ok: true, mode: execMode })
    } else {
      onConfirm(promptMode ? promptValue.trim() || '' : true)
    }
    setPromptValue('')
  }
  const cancel = () => {
    onCancel()
    setPromptValue('')
  }

  return (
    <Modal
      open={!!dlg}
      onCancel={cancel}
      footer={null}
      closable={false}
      width={markdownMode ? 760 : (execModeChooser ? 560 : 420)}
      centered={false}
      className="spkb-modal"
      styles={{ mask: { background: 'rgba(3,7,10,0.72)' }, content: { background: 'var(--panel)', padding: 0 }, body: { padding: 0 } }}
      style={{ top: markdownMode ? 34 : (execModeChooser ? 96 : 120) }}
    >
      <div className="modal-head">
        <strong>{dlg.title || '确认'}</strong>
        <button className="modal-close" onClick={cancel} aria-label="关闭"><Icon name="x" /></button>
      </div>
      <div className="modal-body">
        {markdownMode ? <Markdown source={dlg.text || ''} /> : <div className="doc"><p>{dlg.text}</p></div>}
        {execModeChooser && (
          <div className="exec-choose">
            <div className="exec-inline" style={{ gap: 8 }}>
              {EXEC_MODES.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  className={`exec-option small${execMode === m.id ? ' active' : ''}`}
                  onClick={() => setExecMode(m.id)}
                >
                  <strong>{m.label}</strong>
                  <span className="d">{m.desc}</span>
                </button>
              ))}
            </div>
            <div className="card-cap">并行规模由引擎按任务数量自动生成，无需指定。</div>
          </div>
        )}
        {promptMode && (
          <div className="field">
            <label htmlFor="dlgPrompt">原因（可选）</label>
            <input
              id="dlgPrompt"
              type="text"
              value={promptValue}
              onChange={(e) => setPromptValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirm() }}
              autoFocus
            />
          </div>
        )}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={cancel}>取消</button>
        <button className={`btn ${dlg.danger ? 'btn-danger' : 'btn btn-primary'}`} onClick={confirm}>
          {dlg.confirmLabel || (dlg.danger ? '确认取消' : '确认')}
        </button>
      </div>
    </Modal>
  )
}
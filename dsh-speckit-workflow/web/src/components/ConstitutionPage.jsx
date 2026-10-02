import { useCallback, useEffect, useState } from 'react'
import { Spin } from 'antd'
import { Icon } from '../lib/icons.jsx'
import { callHost } from '../api/index.js'

// 专属 Constitution 管理页（不进流水线）：
//   - 读取/编辑/保存 .specify/memory/constitution.md（宿主专用 endpoint，只认这一个文件）
//   - 调内置 speckit-constitution skill 重新生成（独立 continuable 线程，ThreadModal 续对话）
// 视觉语言与「新建 Feature」弹窗对齐：card / card-head / card-cap / field / btn。
export default function ConstitutionPage({ workspace, onOpenThread, onToast }) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [regening, setRegening] = useState(false)
  const [text, setText] = useState('')
  const [exists, setExists] = useState(true)
  const [dirty, setDirty] = useState(false)
  const [loadedFor, setLoadedFor] = useState(null)

  const load = useCallback(async () => {
    if (!workspace) return
    setLoading(true)
    try {
      const value = await callHost('constitution', { workspacePath: workspace })
      setText(typeof value.text === 'string' ? value.text : '')
      setExists(Boolean(value.exists))
      setLoadedFor(workspace)
      setDirty(false)
    } catch (error) {
      onToast && onToast(String((error && error.message) || error))
    } finally {
      setLoading(false)
    }
  }, [workspace, onToast])

  useEffect(() => {
    if (workspace && workspace !== loadedFor) load()
  }, [workspace, loadedFor, load])

  const save = useCallback(async () => {
    if (!workspace) return
    setSaving(true)
    try {
      const value = await callHost('constitution-save', { workspacePath: workspace, text })
      setExists(Boolean(value.exists))
      setDirty(false)
      onToast && onToast('Constitution 已保存')
    } catch (error) {
      onToast && onToast(String((error && error.message) || error))
    } finally {
      setSaving(false)
    }
  }, [workspace, text, onToast])

  const regen = useCallback(async () => {
    if (!workspace) return
    setRegening(true)
    try {
      const value = await callHost('constitution-regen', { workspacePath: workspace, args: '' })
      onToast && onToast('已派生 speckit-constitution 线程，可在对话窗口继续')
      if (value && value.threadId && onOpenThread) onOpenThread(value.threadId)
    } catch (error) {
      onToast && onToast(String((error && error.message) || error))
    } finally {
      setRegening(false)
    }
  }, [workspace, onToast, onOpenThread])

  const resetTemplate = useCallback(async () => {
    try {
      const value = await callHost('constitution', { workspacePath: workspace })
      if (value && value.template) {
        setText(value.template)
        setDirty(true)
      }
    } catch (error) {
      onToast && onToast(String((error && error.message) || error))
    }
  }, [workspace, onToast])

  return (
    <div className="constitution-page">
      <div className="constitution-head">
        <div>
          <div className="constitution-title">
            <Icon name="book" />
            Constitution 管理
          </div>
          <div className="constitution-sub">
            项目治理约束文件 · <span className="mono">.specify/memory/constitution.md</span>
            {exists ? '' : '（尚未创建，保存即生成）'}
            {dirty && <span className="constitution-dirty"> · 未保存</span>}
          </div>
        </div>
      </div>

      <section className="card constitution-card">
        <div className="card-head">
          <div>
            <div className="card-title"><Icon name="text" />编辑器</div>
            <div className="card-cap">直接编辑并保存 Markdown；或交给内置 speckit-constitution 线程重新生成（可在弹出的对话窗口继续指导）。</div>
          </div>
        </div>
        <div className="card-body">
          {loading ? (
            <div className="constitution-loading"><Spin /><span>读取中…</span></div>
          ) : (
            <textarea
              className="constitution-editor"
              value={text}
              spellCheck={false}
              onChange={(e) => { setText(e.target.value); setDirty(true) }}
              placeholder="# [PROJECT_NAME] Constitution&#10;&#10;## Core Principles&#10;..."
            />
          )}
        </div>
        <div className="constitution-foot">
          <button className="btn" onClick={resetTemplate} disabled={loading || saving || regening}>
            <Icon name="refresh" /> 重置为模板
          </button>
          <button className="btn" onClick={regen} disabled={loading || saving || regening}>
            <Icon name="bulb" /> {regening ? '生成中…' : '用 speckit-constitution 重新生成'}
          </button>
          <button className="btn btn-primary" onClick={save} disabled={loading || saving || !dirty}>
            <Icon name="check" /> {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </section>
    </div>
  )
}

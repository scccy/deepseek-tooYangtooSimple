// dsh-speckit-workflow — Spec 流水线看板 / Feature 工作台 (v0.8)
//
// Redeveloped per DESIGN-V0.8.md: one Feature = one workbench instance with
// per-stage threads and explicit human handoffs. The visual language (colors,
// typography, panels, cards, drawers, dialogs) is preserved verbatim from the
// confirmed v0.7 prototype (design/spec-board-prototype.html) — only the data
// flow, state model and interactions were rebuilt for the v0.8 instance model.
//
// The panel is DOM-based inside a Shadow DOM; the middle-column takeover,
// Escape layering and inline clamping follow the proven ssh/board pattern.

window.__ModuleLoader__.load({
  id: 'dsh-speckit-workflow',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const CHANNEL = '/api/dsh-speckit-workflow'
    const POLL_MS = 2500

    // ----------------------------------------------------------------- state
    const S = {
      sessionId: null,
      board: null,
      projects: [],
      detail: null,       // current instance detail (drawer)
      detailInstanceId: null,
      thread: null,       // thread view payload
      view: 'board',
      createOpen: false,
      drawerOpen: false,
      threadOpen: false,
      models: null,
      cwd: null,
      workspaceTarget: null, // the workspace this board is scoped to (workbench isolate)
      workspaces: [],        // { path, title, ready, issues } from host
      lastEventSeq: null,
      toastTimer: 0,
      pollTimer: 0,
      timer2: 0,
      eventCursor: null
    }

    const COLUMNS = [
      { id: 'specify', name: 'Specify', hint: '需求已经生成，等待确认', icon: 'file' },
      { id: 'clarify', name: 'Clarify', hint: '需求已经澄清，设计文件等待确认', icon: 'message' },
      { id: 'implement', name: 'Implement', hint: '任务和代码逐步生成', icon: 'hammer' },
      { id: 'converge', name: 'Converge', hint: '收敛结论，或回到实现循环', icon: 'merge' }
    ]
    const STAGES = [
      'specify', 'clarify', 'plan', 'checklist', 'tasks', 'analyze', 'taskstoissues', 'implement', 'converge'
    ]
    const STAGE_TITLES = {
      specify: 'Specify', clarify: 'Clarify', plan: 'Plan', checklist: 'Checklist',
      tasks: 'Tasks', analyze: 'Analyze', taskstoissues: '任务转 Issue', implement: 'Implement', converge: 'Converge'
    }
    const ST_META = {
      'not-started': ['未开始', 'pending'],
      creating: ['创建中', 'running'],
      running: ['进行中', 'running'],
      'awaiting-user': ['等待你回答', 'review'],
      'awaiting-confirmation': ['等待确认', 'review'],
      completed: ['已完成', 'completed'],
      skipped: ['已跳过', 'pending'],
      cancelled: ['已取消', 'blocked'],
      failed: ['失败', 'failed'],
      stale: ['已过期', 'looping']
    }
    const statusMeta = (status) => ST_META[status] || ['未知', 'pending']

    const formatTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
    const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    const newActionId = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    async function callHost(endpoint, payload) {
      const response = await window.fetch(CHANNEL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, sessionId: S.sessionId, ...(payload || {}) })
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || !result || result.ok !== true) {
        throw new Error((result && result.error && result.error.message) || `宿主请求失败（${response.status}）`)
      }
      return result.value
    }

    // ---- session acquisition ------------------------------------------------
    // The plugin needs a valid session id to talk to the Host (every RPC looks
    // up the parent agent by session id). The session-scoped header slot is the
    // documented delivery path, but it is not mounted in every app build, so we
    // read the current session from the `sessions` service's reactive stores
    // (available from apply()) and subscribe so it stays live across switches.
    let sessionsService = null
    let sessionSyncWired = false
    function readSessionIdFromServices() {
      if (!sessionsService) return null
      try {
        const list = sessionsService.list
        if (list && typeof list.getSnapshot === 'function') {
          const snap = list.getSnapshot() || {}
          const cur = snap.current
          const curId = typeof cur === 'string' ? cur : (cur && typeof cur === 'object' && cur.id) || null
          if (curId) return curId
        }
      } catch (e) { /* best effort */ }
      try {
        const sel = sessionsService.selection
        if (sel && typeof sel.getSnapshot === 'function') {
          const snap = sel.getSnapshot()
          if (Array.isArray(snap) && snap.length) {
            const first = snap[0]
            return typeof first === 'string' ? first : (first && first.id) || null
          }
          if (typeof snap === 'string' && snap) return snap
        }
      } catch (e) { /* best effort */ }
      return null
    }
    function wireSessionSync() {
      if (sessionSyncWired || !sessionsService) return
      sessionSyncWired = true
      const handler = () => {
        const id = readSessionIdFromServices()
        if (!id || id === S.sessionId) return
        S.sessionId = id
        if (open) void refreshBoard()
      }
      try { if (sessionsService.list && typeof sessionsService.list.subscribe === 'function') sessionsService.list.subscribe(handler) } catch (e) { /* noop */ }
      try { if (sessionsService.selection && typeof sessionsService.selection.subscribe === 'function') sessionsService.selection.subscribe(handler) } catch (e) { /* noop */ }
    }

    // ------------------------------------------------------------------ icons
    const SVG = {
      file: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9h10M7 13h10M7 17h6"/>',
      message: '<path d="M21 12a8 8 0 0 1-8 8H6l-3 2v-5a8 8 0 0 1 10-16 8 8 0 0 1 8 8z"/><path d="M10 10a2 2 0 1 1 3 1.7c-.7.6-1 1.1-1 2.3"/><path d="M12 17h.01"/>',
      hammer: '<path d="M14 4l6 6-3.5 1L13 7.5z"/><path d="M9 9l-5 5a2.1 2.1 0 0 0 3 3l5-5"/><path d="M14 14l5 5"/>',
      merge: '<circle cx="6" cy="5" r="2.5"/><circle cx="18" cy="5" r="2.5"/><circle cx="13" cy="19" r="2.5"/><path d="M6 7.5v2a4 4 0 0 0 4 4h3"/>',
      kanban: '<rect x="3" y="4" width="5" height="16" rx="1"/><rect x="9.5" y="4" width="5" height="10" rx="1"/><rect x="16" y="4" width="5" height="13" rx="1"/>',
      plus: '<path d="M12 5v14M5 12h14"/>',
      chevron: '<path d="M9 6l6 6-6 6"/>',
      'git-fork': '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M6 8.5v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3v-2"/>',
      cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
      folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      x: '<path d="M6 6l12 12M18 6L6 18"/>',
      target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
      check: '<path d="M5 12l5 5L20 7"/>',
      undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
      send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
      text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
      alert: '<path d="M12 3 2 21h20z"/><path d="M12 9v5M12 17.5h.01"/>',
      trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
      back: '<path d="M15 6l-6 6 6 6"/>',
      rotate: '<path d="M20 11a8 8 0 1 0-2.3 6.2"/><path d="M20 4v7h-7"/>',
      archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9"/><path d="M10 13h4"/>',
      bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
      play: '<path d="M7 4v16l13-8z"/>',
      bulb: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.8.7 1 1.5 1 2.5h6c0-1 .2-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
      refresh: '<path d="M20 11a8 8 0 1 0-2.3 6.2"/><path d="M20 4v7h-7"/>',
      link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19"/>'
    }
    function icon(name, size = 15) {
      const body = SVG[name] || SVG.file
      return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`
    }

    // -------------------------------------------------------------------- CSS
    // Confirmed style/colors from design/spec-board-prototype.html, verbatim.
    const CSS = `
:host{--bg:#0e1115;--panel:#151a20;--panel-2:#1b222a;--panel-3:#222b34;--inset:#11161b;--line:#2b353f;--line-soft:#202930;--text:#edf1f4;--muted:#96a3ad;--subtle:#66737d;--teal:#49c7b5;--teal-dk:#318879;--blue:#5aa8ff;--blue-soft:rgba(90,168,255,.13);--green:#6bd18b;--amber:#e8b45d;--red:#ef7d7d;--purple:#b48ce8;--shadow:0 18px 44px rgba(0,0,0,.28);--radius:8px;display:block;width:100%;height:100%;overflow:hidden}
*{box-sizing:border-box}html,body{margin:0;min-height:100%}button,input,select,textarea{font:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--blue);outline-offset:2px}::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:#2c3842;border-radius:5px}::-webkit-scrollbar-track{background:transparent}
.app{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg);color:var(--text);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.btn{display:inline-flex;align-items:center;gap:7px;border-radius:6px;padding:8px 12px;border:1px solid var(--line);background:transparent;color:var(--muted)}.btn:hover{border-color:#46606d;color:var(--text)}.btn svg{width:15px;height:15px}
.btn-primary{border:1px solid #3f9d91;background:var(--teal);color:#071411;font-weight:700}.btn-primary:hover{background:#70d7c7;color:#071411}
.btn-danger{border-color:#6e3a3a;color:#f0a3a3}.btn-danger:hover{border-color:#a35050;color:#ffd4d4}
.btn-approve{border-color:#2b6a58;color:#8de2be}.btn-approve:hover{border-color:#3f9d7e;color:#c8ffe9}
.dot{width:8px;height:8px;border-radius:50%;flex:0 0 8px}.dot.pending{background:#4a5661}.dot.running{background:var(--teal);animation:pulse 1.4s infinite}.dot.review{background:var(--amber)}.dot.completed{background:var(--green)}.dot.blocked,.dot.failed{background:var(--red)}.dot.looping{background:var(--purple)}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(73,199,181,.45)}70%{box-shadow:0 0 0 7px rgba(73,199,181,0)}100%{box-shadow:0 0 0 0 rgba(73,199,181,0)}}
.st{display:inline-flex;align-items:center;gap:5px;font-size:10px;padding:2px 7px;border-radius:4px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}.st.running{color:#9ff0e2;border-color:#2f6a60}.st.review{color:#f0cd8d;border-color:#66552e}.st.completed{color:#9fe0b6;border-color:#2f5c40}.st.failed,.st.blocked{color:#f3a9a9;border-color:#6e3a3a}.st.looping{color:#d3baf2;border-color:#4f3b68}.st.pending{color:#8b98a3}
.toast{position:fixed;right:24px;bottom:23px;background:#122a28;color:#bdf5e8;border:1px solid #2d7669;border-radius:6px;box-shadow:var(--shadow);padding:10px 13px;display:flex;align-items:center;gap:8px;transform:translateY(18px);opacity:0;pointer-events:none;transition:.2s;z-index:90}.toast.show{transform:translateY(0);opacity:1}.toast svg{width:15px}
.topbar{border-bottom:1px solid var(--line-soft);background:var(--panel);padding:12px 22px;display:flex;align-items:center;gap:14px;flex-wrap:wrap;position:relative;z-index:5}
.topbar-title{font-weight:700;font-size:14px}.topbar-meta{color:var(--subtle);font-size:11px;display:flex;align-items:center;gap:6px}.topbar-meta svg{width:13px;height:13px}
.topbar-right{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:flex-end;row-gap:8px;max-width:100%}
.metric-pill{display:inline-flex;align-items:center;gap:7px;padding:5px 11px;border:1px solid var(--line);border-radius:20px;font-size:11px;color:var(--muted)}.metric-pill svg{width:13px;height:13px;color:var(--teal)}
.metric-pill select{background:transparent;border:0;color:var(--text);font-size:11px;max-width:220px}
.board-wrap{flex:1;min-height:0;overflow:auto;display:flex}
.board{flex:1;display:grid;grid-template-columns:repeat(4,minmax(240px,1fr));gap:12px;padding:16px 18px 24px;align-items:start}
.col{border:1px solid var(--line-soft);background:#101419;border-radius:10px;min-height:420px;display:flex;flex-direction:column}
.col-head{padding:12px 13px 10px;border-bottom:1px solid var(--line-soft)}
.col-title{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px}.col-title svg{width:15px;height:15px;color:var(--teal)}
.col-count{margin-left:auto;font-size:10px;color:var(--subtle);border:1px solid var(--line);border-radius:10px;padding:1px 8px}
.col-hint{color:var(--subtle);font-size:10px;margin-top:3px}
.col-flow{display:flex;align-items:center;gap:5px;margin-top:7px;color:var(--subtle);font-size:9px;flex-wrap:wrap}
.col-flow .mono{font-size:9px;color:#54646f}.col-flow svg{width:10px;height:10px}
.col-body{padding:10px;display:grid;gap:9px;align-content:start;flex:1}
.col-empty{border:1px dashed #2b3842;border-radius:8px;color:var(--subtle);font-size:11px;text-align:center;padding:22px 10px}
.cardt{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:11px 12px;display:grid;gap:7px;text-align:left;width:100%;color:var(--text);transition:border-color .15s}
.cardt:hover{border-color:#3d8b84}
.cardt.alert{border-color:#6e3a3a}
.cardt-top{display:flex;align-items:center;gap:8px}.cardt-name{font-weight:700;font-size:12px;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.err-dot{position:relative;width:8px;height:8px;flex:0 0 8px}.err-dot::before{content:"";position:absolute;inset:0;border-radius:50%;background:var(--red)}.err-dot::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:1px solid var(--red);animation:pulse 1.4s infinite}
.cardt-wt{display:flex;align-items:center;gap:6px;color:var(--subtle);font-size:10px}.cardt-wt svg{width:12px;height:12px;color:var(--teal)}
.cardt-sub{display:flex;align-items:center;gap:7px;font-size:10px;color:var(--muted)}
.round-badge{font-size:9px;color:var(--purple);border:1px solid #4f3b68;border-radius:3px;padding:1px 5px}
.cardt-foot{display:flex;align-items:center;gap:7px}
.cardt-mode{font-size:9px;color:var(--subtle)}
.cardt-actions{display:flex;gap:7px;margin-top:3px}
.cardt-btn{font-size:10px;padding:5px 9px;line-height:1}
.modal-backdrop{position:fixed;inset:0;background:rgba(3,7,10,.72);display:none;align-items:flex-start;justify-content:center;padding:34px 20px;z-index:50;overflow-y:auto}
.modal-backdrop.open{display:flex}
.modal{width:min(760px,100%);border:1px solid var(--line);border-radius:10px;background:var(--panel);box-shadow:var(--shadow)}
.modal-head{padding:15px 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:var(--panel);z-index:2;border-radius:10px 10px 0 0}
.modal-head strong{font-size:14px}.modal-close{border:0;background:transparent;color:var(--muted);padding:4px}.modal-close:hover{color:var(--text)}
.modal-body{padding:16px 18px;display:grid;gap:14px}
.modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:13px 18px;border-top:1px solid var(--line);position:sticky;bottom:0;background:var(--panel);border-radius:0 0 10px 10px}
.card{border:1px solid var(--line);background:var(--panel-2);border-radius:var(--radius);overflow:hidden}
.card-head{padding:11px 14px 9px;border-bottom:1px solid var(--line-soft);display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.card-title{display:flex;align-items:center;gap:9px;font-weight:700;font-size:12px}.card-title svg{width:15px;height:15px;color:var(--teal)}
.card-cap{color:var(--muted);font-size:10px;margin-top:2px}
.card-body{padding:13px 14px}
.field{display:grid;gap:6px}.field label{color:var(--muted);font-size:11px}.field input[type=text],.field select,.field textarea{border:1px solid var(--line);border-radius:6px;background:var(--inset);color:var(--text);padding:8px 10px;width:100%}.field textarea{min-height:64px;resize:vertical}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px}.form-grid .full{grid-column:1/-1}
.wf-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.wf-item{border:1px solid var(--line);border-radius:6px;background:var(--inset);padding:9px 11px;display:flex;align-items:flex-start;gap:9px}
.wf-item strong{font-size:11px;display:block}.wf-item span.d{color:var(--subtle);font-size:9px;display:block;margin-top:2px}
.switch{position:relative;width:31px;height:18px;flex:0 0 31px;margin-left:auto}.switch input{opacity:0;width:0;height:0}.switch-track{position:absolute;inset:0;border-radius:10px;background:#34404a;transition:.18s;cursor:pointer}.switch-track::after{content:"";position:absolute;width:12px;height:12px;top:3px;left:3px;border-radius:50%;background:#9aa6ad;transition:.18s}.switch input:checked+.switch-track{background:var(--teal-dk)}.switch input:checked+.switch-track::after{transform:translateX(13px);background:#f4fffc}
.note-line{display:flex;gap:8px;align-items:flex-start;border:1px solid #2f6a60;background:rgba(73,199,181,.06);border-radius:6px;padding:9px 11px;color:#9ff0e2;font-size:11px;margin-top:10px}.note-line svg{width:14px;height:14px;flex:0 0 14px;margin-top:1px}
.drawer-backdrop{position:absolute;inset:0;z-index:55;background:transparent;display:none}
.drawer-backdrop.open{display:block}
.drawer{position:fixed;top:0;right:0;bottom:0;width:min(640px,94vw);background:var(--panel);border-left:1px solid var(--line);box-shadow:var(--shadow);transform:translateX(103%);transition:transform .22s ease;z-index:60;display:flex;flex-direction:column}
.drawer.open{transform:translateX(0)}
.drawer-head{padding:14px 16px;border-bottom:1px solid var(--line);display:flex;align-items:flex-start;gap:10px}
.drawer-head .t{flex:1;min-width:0}.drawer-title{font-size:14px;font-weight:700}.drawer-sub{color:var(--subtle);font-size:10px;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap}
.drawer-body{overflow-y:auto;padding:14px 16px 20px;flex:1;display:grid;gap:13px;align-content:start}
.drawer-foot{border-top:1px solid var(--line);padding:12px 16px;display:flex;gap:8px;justify-content:flex-end}
.sec-label{color:var(--subtle);font-size:10px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:7px;display:flex;align-items:center;gap:7px}.sec-label svg{width:12px;height:12px;color:var(--teal)}
.journey{display:grid;grid-template-columns:repeat(9,1fr);gap:5px}
.jstep{border:1px solid var(--line);border-radius:6px;padding:7px 3px;text-align:center;background:var(--inset)}
.jstep strong{display:block;font-size:9px;color:var(--muted)}.jstep span{font-size:8px;color:var(--subtle);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jstep.cur{border-color:#3d8b84;background:rgba(73,199,181,.08)}.jstep.cur strong{color:var(--text)}
.jstep.done{border-color:#2f5c40}.jstep.done strong{color:#9fe0b6}
.jstep.warn{border-color:#6e3a3a}.jstep.warn strong{color:#f3a9a9}
.jstep.loop{border-color:#4f3b68}.jstep.loop strong{color:#d3baf2}
.phase-line{display:grid;gap:6px}
.phase-item{display:grid;grid-template-columns:14px 1fr auto;gap:9px;align-items:center;border:1px solid var(--line);border-radius:6px;background:var(--inset);padding:8px 10px;font-size:11px;color:var(--muted)}
.phase-item .ph-main{min-width:0}.ph-name{font-weight:600;color:var(--text);font-size:11px}.ph-sub{color:var(--subtle);font-size:9px;margin-top:2px;display:flex;gap:6px;flex-wrap:wrap}
.phase-actions{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.ph-btn{font-size:10px;padding:4px 9px;border:1px solid var(--line);border-radius:5px;background:transparent;color:var(--muted)}.ph-btn:hover{border-color:#46606d;color:var(--text)}
.ph-btn.primary{border-color:#3f9d91;color:#071411;background:var(--teal);font-weight:600}.ph-btn.primary:hover{background:#70d7c7}
.ph-btn.danger{border-color:#6e3a3a;color:#f0a3a3}.ph-btn.danger:hover{background:rgba(239,125,125,.1);color:#ffd4d4}
.ph-open{display:inline-flex;align-items:center;gap:5px;font-size:10px;padding:4px 6px 4px 8px;border:1px solid transparent;border-radius:5px;background:transparent;color:var(--teal)}
.ph-open:hover{background:rgba(73,199,181,.1);border-color:rgba(73,199,181,.25)}
.ph-open.live{border-color:#3f9d91;color:#9ff0e2;background:rgba(73,199,181,.08)}
.ph-open.live:hover{background:rgba(73,199,181,.16)}
.artifacts{display:flex;flex-wrap:wrap;gap:6px}
.chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--inset);border-radius:5px;padding:5px 9px;font-size:10px;color:var(--muted);max-width:240px}.chip svg{width:12px;height:12px;color:var(--teal);flex:0 0 12px}.chip.stale{opacity:.5;border-style:dashed}
.chat{display:grid;gap:8px;padding:2px}
.msg{max-width:94%;border-radius:8px;padding:8px 11px;font-size:11px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.msg.agent{background:var(--inset);border:1px solid var(--line);color:var(--muted);justify-self:start}
.msg.user{background:#1d3038;border:1px solid #2c4a56;color:#cfe8ef;justify-self:end}
.msg .who{display:block;font-size:9px;color:var(--subtle);margin-bottom:3px}
.chat-input{display:flex;gap:8px;margin-top:9px}
.chat-input input{flex:1;border:1px solid var(--line);border-radius:6px;background:var(--inset);color:var(--text);padding:8px 10px;font-size:12px}
.pending-q{border:1px solid #66552e;background:rgba(232,180,93,.07);border-radius:8px;padding:10px 12px;font-size:11px;color:#e8c98d}
.pending-q strong{display:block;font-size:11px;color:#f0cd8d;margin-bottom:4px}
.kv{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:11px}.kv strong{color:var(--text);text-align:right}
.ev-list{display:grid;gap:5px;max-height:220px;overflow:auto}
.ev-item{border:1px solid var(--line);border-radius:6px;background:var(--inset);padding:7px 10px;font-size:10px;color:var(--muted);display:flex;gap:8px}.ev-item .mono{color:#7e94a5;font-size:9px;flex:1;min-width:0}
.doc p,.doc li{color:var(--muted);font-size:12px}.doc code{background:#0b0f13;border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:10px;color:#a8d8f0}
.empty{color:var(--subtle);font-size:11px;text-align:center;padding:20px 8px;border:1px dashed #2b3842;border-radius:8px}
@media(max-width:1200px){.board{grid-template-columns:repeat(2,minmax(240px,1fr))}}
.monospace{font-family:ui-monospace,Menlo,monospace}
`
    const MODAL_EXTRA_CSS = `.field select.required{border-color:#3d8b84}`
    const INPUT_CSS = `.field input,.field select,.field textarea{border:1px solid var(--line);border-radius:6px;background:var(--inset);color:var(--text);padding:8px 10px;width:100%;font-size:12px}
.field textarea{min-height:64px;resize:vertical;font:12px/1.5 ui-monospace,Menlo,monospace}`

    // ------------------------------------------------------------- DOM shell
    let shadowRoot = null
    let els = {}

    function toast(message) {
      if (!els.toast) return
      els.toast.innerHTML = `${icon('check')}<span>${esc(message)}</span>`
      els.toast.classList.add('show')
      window.clearTimeout(S.toastTimer)
      S.toastTimer = window.setTimeout(() => els.toast && els.toast.classList.remove('show'), 2600)
    }

    function buildShell() {
      const shell = document.createElement('div')
      shell.className = 'app'
      shell.innerHTML = `
        <header class="topbar">
          <div>
            <div class="topbar-title" id="topbarTitle">Spec 流水线看板 · Feature 工作台</div>
            <div class="topbar-meta" id="topbarMeta"><i data-i="folder"></i><span class="mono" id="topCwd">…</span></div>
          </div>
          <div class="topbar-right">
            <span class="metric-pill"><i data-i="git-fork"></i><span id="mWorktree">0</span></span>
            <span class="metric-pill"><i data-i="cpu"></i><span id="mInstances">0</span> 实例</span>
            <span class="metric-pill"><i data-i="rotate"></i>v0.8</span>
            <select id="projectSelect" class="mono" style="max-width:260px;background:var(--panel);border:1px solid var(--line);color:var(--text);border-radius:6px;padding:6px 8px;font-size:11px"></select>
            <button class="btn" data-act="close-board" title="返回对话"><i data-i="back"></i>返回对话</button>
            <button class="btn btn-primary" data-act="new-feature"><i data-i="plus"></i>新建 Feature</button>
          </div>
        </header>
        <div class="board-wrap"><div class="board" id="board"></div></div>
      `
      shell.querySelectorAll('[data-i]').forEach((node) => { node.outerHTML = icon(node.dataset.i) })
      return shell
    }

    function buildCreateModal() {
      const box = document.createElement('div')
      box.className = 'modal-backdrop'
      box.id = 'createModal'
      box.innerHTML = `
        <div class="modal">
          <div class="modal-head"><strong>新建 Feature · 创建实例并启动 Specify 线程</strong><button class="modal-close" data-close="createModal"><i data-i="x"></i></button></div>
          <div class="modal-body">
            <section class="card">
              <div class="card-head"><div><div class="card-title"><i data-i="target"></i>Feature Context</div><div class="card-cap">创建工作区里的一个 Feature 工作流实例；先将为您启动 Specify 线程，完成后停在人工确认点。</div></div></div>
              <div class="card-body"><div class="form-grid">
                <div class="field full"><label for="fFeature">Feature 描述</label><textarea id="fFeature" placeholder="例如：为 web 端实现多账号会话隔离，支持同时登录并切换账户…"></textarea></div>
                <div class="field full"><label>目标工作区（并入当前工作区）</label><div class="mono" id="fProjectTarget" style="border:1px solid var(--line);border-radius:6px;background:var(--inset);color:var(--text);padding:8px 10px;font-size:12px">—</div><div class="card-cap" id="fProjectHint"></div></div>
                <div class="field full"><label for="fModel">阶段线程模型</label><select id="fModel"><option value="">跟随会话默认</option></select></div>
              </div></div>
            </section>
            <section class="card">
              <div class="card-head"><div><div class="card-title"><i data-i="kanban"></i>流程开关</div><div class="card-cap">只读选项：可选阶段是否纳入后续工作流；Specify 始终执行。</div></div></div>
              <div class="card-body"><div class="wf-grid">
                <label class="wf-item"><div><strong>隔离 worktree</strong><span class="d">Specify 后创建/复用 feature worktree 并同步产物</span></div><span class="switch"><input type="checkbox" id="sw-worktrees" checked><span class="switch-track"></span></span></label>
                <label class="wf-item"><div><strong>Checklist 阶段</strong><span class="d">生成需求质量 checklist（可选）</span></div><span class="switch"><input type="checkbox" id="sw-checklist" checked><span class="switch-track"></span></span></label>
                <label class="wf-item"><div><strong>Analyze 阶段</strong><span class="d">只读一致性分析（可选）</span></div><span class="switch"><input type="checkbox" id="sw-analyze" checked><span class="switch-track"></span></span></label>
                <label class="wf-item"><div><strong>Taskstoissues</strong><span class="d">转换为 GitHub issues（外部副作用，默认关）</span></div><span class="switch"><input type="checkbox" id="sw-issues"><span class="switch-track"></span></span></label>
              </div></div>
            </section>
          </div>
          <div class="modal-foot"><button class="btn" data-close="createModal">取消</button><button class="btn btn-primary" data-act="create-submit"><i data-i="plus"></i>创建并启动 Specify</button></div>
        </div>
      `
      box.querySelectorAll('[data-i]').forEach((node) => { node.outerHTML = icon(node.dataset.i) })
      return box
    }

    function buildDrawer() {
      const backdrop = document.createElement('div')
      backdrop.className = 'drawer-backdrop'
      backdrop.id = 'drawerBackdrop'
      const drawer = document.createElement('aside')
      drawer.className = 'drawer'
      drawer.id = 'drawer'
      drawer.setAttribute('role', 'dialog')
      drawer.setAttribute('aria-label', '实例详情')
      drawer.innerHTML = `
        <div class="drawer-head">
          <div class="t">
            <div class="drawer-title" id="dTitle">—</div>
            <div class="drawer-sub" id="dSub"></div>
          </div>
          <button class="modal-close" data-close="drawer"><i data-i="x"></i></button>
        </div>
        <div class="drawer-body" id="dBody"></div>
        <div class="drawer-foot" id="dFoot"></div>
      `
      drawer.querySelectorAll('[data-i]').forEach((node) => { node.outerHTML = icon(node.dataset.i) })
      return { backdrop, drawer }
    }

    function buildThreadModal() {
      const box = document.createElement('div')
      box.className = 'modal-backdrop'
      box.id = 'threadModal'
      box.innerHTML = `
        <div class="modal" style="width:min(680px,100%)">
          <div class="modal-head"><strong id="thTitle">阶段线程</strong><button class="modal-close" data-close="threadModal"><i data-i="x"></i></button></div>
          <div class="modal-body">
            <div id="thBody"></div>
            <div class="chat-input"><input id="thAnswer" placeholder="输入回答…（Enter 发送；交互阶段人工回答）"><button class="btn btn-primary" data-act="thread-send"><i data-i="send"></i>发送</button></div>
            <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" data-act="thread-refresh"><i data-i="refresh"></i>刷新</button><button class="btn" data-act="thread-end"><i data-i="check"></i>结束交互</button></div>
          </div>
        </div>
      `
      box.querySelectorAll('[data-i]').forEach((node) => { node.outerHTML = icon(node.dataset.i) })
      return box
    }

    function buildToast() {
      const box = document.createElement('div')
      box.className = 'toast'
      box.id = 'toast'
      return box
    }

    function buildDialog() {
      const box = document.createElement('div')
      box.className = 'modal-backdrop'
      box.id = 'dialogBackdrop'
      box.innerHTML = `
        <div class="modal" style="width:min(420px,100%)">
          <div class="modal-head"><strong id="dlgTitle">确认</strong><button class="modal-close" data-close="dialog"><i data-i="x"></i></button></div>
          <div class="modal-body"><div class="doc" id="dlgText"></div><div class="field" id="dlgPromptRow" style="display:none"><label for="dlgPrompt">原因（可选）</label><input type="text" id="dlgPrompt"></div></div>
          <div class="modal-foot"><button class="btn" data-act="dlg-cancel">取消</button><button class="btn btn-primary" id="dlgOk">确认</button></div>
        </div>
      `
      box.querySelectorAll('[data-i]').forEach((node) => { node.outerHTML = icon(node.dataset.i) })
      return box
    }

    // ------------------------------------------------------------- rendering
    function cardHtml(card) {
      const [label, tone] = statusMeta(card.currentStageStatus || (card.status === 'completed' ? 'completed' : 'pending'))
      const modeLabel = card.mode === 'isolated' ? 'worktree' : 'inplace'
      const href = card.worktreePath ? card.worktreePath.split('/').filter(Boolean).pop() : card.branch || ''
      const alert = card.currentStageStatus === 'failed' || card.currentStageStatus === 'cancelled'
      // Card-level actions (v0.7 parity): confirm-to-next-stage + delete instance.
      // The host already computes `card.actions` (boardActionsFor) and now also
      // sends `currentStageRowId`, so the card can wire these without opening the drawer.
      const actions = (card.actions || [])
      const confirmAction = actions.includes('confirm')
        ? `<button class="btn btn-primary cardt-btn" data-card-act="confirm" data-instance="${esc(card.instanceId)}" data-stage-row="${card.currentStageRowId ?? ''}" data-stage-id="${esc(card.currentStage || '')}">${icon('check')}确认</button>`
        : ''
      // Agreed logic (v0.7 parity): at the Specify (first) stage the card delete
      // tears down the WHOLE Feature instance; at any other active stage it ROLLS
      // BACK the current stage (instance stays). A failed/non-active instance
      // with no active stage row falls back to delete-instance — there is nothing
      // to roll back, so deleting the instance is the only sensible action.
      const isSpecify = card.currentStage === 'specify'
      const hasActiveStage = !!card.currentStageRowId
      const deleteBtn = (isSpecify || !hasActiveStage)
        ? `<button class="btn btn-danger cardt-btn" data-card-act="delete-instance" data-instance="${esc(card.instanceId)}" title="删除该 Feature 实例">${icon('trash')}删除实例</button>`
        : `<button class="btn btn-danger cardt-btn" data-card-act="rollback-stage" data-instance="${esc(card.instanceId)}" data-stage-row="${card.currentStageRowId ?? ''}" data-stage-id="${esc(card.currentStage || '')}" title="回推当前阶段（Feature 实例保留）">${icon('undo')}回推</button>`
      return `<div class="cardt${alert ? ' alert' : ''}" data-act="open-instance" data-instance="${esc(card.instanceId)}">
        <div class="cardt-top"><span class="dot ${tone}"></span><span class="cardt-name" title="${esc(card.feature)}">${esc(card.feature)}</span></div>
        <div class="cardt-wt">${icon('folder')}<span>${esc(card.workspacePath)}</span></div>
        <div class="cardt-sub"><span class="st ${tone}">${esc(label)}</span><span class="mono">${esc(card.currentStage || '')}</span>${card.attempt ? `<span class="round-badge">#${card.attempt}</span>` : ''}</div>
        <div class="cardt-foot">${href ? `<span class="mono" style="color:var(--subtle);font-size:9px">${esc(href)}</span>` : ''}<span class="cardt-mode" style="margin-left:auto">${modeLabel}</span></div>
        <div class="cardt-actions">${confirmAction}${deleteBtn}</div>
      </div>`
    }

    function renderBoard() {
      const board = els.board
      if (!board || !S.board) return
      const instances = S.board.instances || []
      const byColumn = { specify: [], clarify: [], implement: [], converge: [] }
      for (const card of instances) {
        const column = COLUMNS.find((c) => c.id === card.column)
        byColumn[column ? column.id : 'specify'].push(card)
      }
      // metrics
      if (els.mWorktree) els.mWorktree.textContent = instances.filter((c) => c.mode === 'isolated').length
      if (els.mInstances) els.mInstances.textContent = instances.length
      if (els.topCwd) els.topCwd.textContent = S.workspaceTarget || S.board.cwd || S.cwd || '…'
      populateProjects()
      board.innerHTML = COLUMNS.map((column) => {
        const cards = byColumn[column.id] || []
        return `<section class="col" data-col="${column.id}">
          <div class="col-head">
            <div class="col-title">${icon(column.icon)}${column.name}<span class="col-count">${cards.length}</span></div>
            <div class="col-hint">${column.hint}</div>
            <div class="col-flow">${STAGES.filter((s) => ({ specify: ['specify'], clarify: ['clarify', 'plan'], implement: ['checklist', 'tasks', 'analyze', 'taskstoissues', 'implement'], converge: ['converge'] })[column.id].includes(s)).map((s) => `<span class="mono">${s}</span>`).join(icon('chevron', 10))}</div>
          </div>
          <div class="col-body">${cards.length ? cards.map(cardHtml).join('') : '<div class="col-empty">暂无 Feature 实例</div>'}</div>
        </section>`
      }).join('')
    }

    // The workspace the current board isolates on (entry = workspace row
    // button per DESIGN direction "工作区行按钮 → 进隔离看板"; each workspace
    // has independent instances and can run concurrently).
    function setWorkspaceTarget(path) {
      S.workspaceTarget = path || S.cwd || null
      S.detailInstanceId = null
      S.detail = null
      closeDrawer()
      void refreshBoard()
    }

    function populateProjects() {
      const projects = (S.board && S.board.projects) || S.projects || []
      S.workspaces = projects
      const select = els.projectSelect
      if (select) {
        const selected = S.workspaceTarget || S.cwd || ''
        const options = projects.map((entry) => `<option value="${esc(entry.path)}" ${entry.path === selected ? 'selected' : ''}>${esc(entry.path)}${entry.ready ? '' : ' ⚠'}</option>`).join('') || '<option value="">—</option>'
        select.innerHTML = options
      }
      const targetNode = els.fProjectTarget
      if (targetNode) {
        targetNode.textContent = S.workspaceTarget || '—'
        const entry = (projects || []).find((p) => p.path === S.workspaceTarget)
        if (els.fProjectHint) els.fProjectHint.textContent = S.workspaceTarget ? (entry ? (entry.ready ? `✓ speckit 就绪 · ${entry.title}` : `✗ 未就绪：${(entry.issues || []).join('；')}`) : '该工作区未在宿主工作区列表') : ''
      }
    }

    // ---- workspace-row entry (primary entry point) -------------------------
    // Injects a small "看板" button into each workspace row of the app's
    // workspace browser (projectRow), so the user enters THIS workspace's
    // isolated board from the workspace side — not from a session header.
    const WS_ROW_SELECTOR = '[class*="projectRow"],[class*="workspaceItem"],[class*="workspace-row"],[class*="workspaceRow"]'
    function workspacePathFromLabel(label) {
      const text = String(label == null ? '' : label).trim().replace(/\/+$/, '')
      const tail = text.split('/').pop()
      const workspaces = (S.workspaces && S.workspaces.length ? S.workspaces : (S.board && S.board.projects)) || []
      if (workspaces.length === 0 || !tail) return null
      const byTail = workspaces.find((w) => String(w.path || '').replace(/\/+$/, '').split('/').pop() === tail)
      if (byTail) return byTail.path
      const byExact = workspaces.find((w) => w.path === text || w.title === text)
      return byExact ? byExact.path : null
    }
    function installWorkspaceRowButtons() {
      const rows = Array.from(document.querySelectorAll(WS_ROW_SELECTOR))
      for (const row of rows) {
        // Skip small rows that look like session rows nested in a workspace row.
        if (row.__spkbWsDone === true) continue
        row.__spkbWsDone = true
        const titleEl = row.querySelector('[class*="title"], [class*="projectText"]')
        const label = (titleEl ? titleEl.textContent : row.textContent || '').trim()
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('data-spkb-ws', '')
        button.title = '进入该工作区的 Spec 流水线看板'
        button.textContent = '看板'
        button.style.cssText =
          'flex:none;height:20px;padding:0 7px;margin-left:2px;font-size:10px;white-space:nowrap;cursor:pointer;' +
          'color:var(--dsw-alias-state-business-primary,#49c7b5);background:transparent;' +
          'border:1px solid var(--dsw-alias-border-l2,rgba(73,199,181,.4));border-radius:6px'
        button.addEventListener('click', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const sid = readSessionIdFromServices()
          if (sid) S.sessionId = sid
          const path = workspacePathFromLabel(label) || S.cwd || null
          S.workspaceTarget = path
          setOpen(true)
          void refreshBoard()
        })
        const actions = row.querySelector('[class*="rowActions"]') || null
        if (actions) actions.appendChild(button)
        else row.appendChild(button)
      }
    }
    let wsObserver = null
    let wsScanTimer = 0
    function installWorkspaceRowObserver() {
      if (wsObserver) return
      wsObserver = new MutationObserver(() => {
        window.clearTimeout(wsObserver.__t)
        wsObserver.__t = window.setTimeout(installWorkspaceRowButtons, 200)
      })
      wsObserver.observe(document.documentElement || document.body, { childList: true, subtree: true })
      installWorkspaceRowButtons()
      ensureSidebarEntry()
      // Periodic fallback: the workspace list can re-mount on heavy re-renders
      // or restart; keep re-scanning cheaply so the entry always reappears.
      window.clearInterval(wsScanTimer)
      wsScanTimer = window.setInterval(() => {
        installWorkspaceRowButtons()
        ensureSidebarEntry()
      }, 3000)
    }
    function disposeWorkspaceRowObserver() {
      if (wsObserver) { wsObserver.disconnect(); wsObserver = null }
      window.clearInterval(wsScanTimer)
      document.querySelectorAll('[data-spkb-ws]').forEach((node) => node.remove())
      if (sidebarEntryBtn) { try { sidebarEntryBtn.remove() } catch { /* noop */ } sidebarEntryBtn = null }
    }

    // ---- guaranteed sidebar fallback entry --------------------------------
    // A single "Spec 看板" row at the bottom of the sidebar, so there is always
    // an entry even if the per-workspace-row injection finds no rows.
    let sidebarEntryBtn = null
    function ensureSidebarEntry() {
      if (sidebarEntryBtn && sidebarEntryBtn.isConnected) return
      const sidebar = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
      if (!sidebar) return
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('data-spkb-sidebar-entry', '')
      btn.textContent = '📋 Spec 看板'
      btn.style.cssText =
        'display:flex;align-items:center;gap:8px;width:calc(100% - 16px);margin:4px 8px;padding:0 10px;height:34px;' +
        'font-size:12.5px;color:var(--dsw-alias-label-secondary,#96a3ad);background:transparent;' +
        'border:1px solid var(--dsw-alias-border-l2,#2b353f);border-radius:8px;cursor:pointer;white-space:nowrap'
      btn.addEventListener('click', () => {
        const sid = readSessionIdFromServices()
        if (sid) S.sessionId = sid
        if (!S.workspaceTarget) S.workspaceTarget = S.cwd || null
        setOpen(true)
        void refreshBoard()
      })
      sidebar.appendChild(btn)
      sidebarEntryBtn = btn
    }

    function journeyHtml(detail) {
      const stages = detail.stages
      const last = {}
      for (const stage of stages) last[stage.stageId] = stage
      const tiles = STAGES.map((id) => {
        const row = last[id]
        const status = row ? row.status : 'not-started'
        const cls = status === 'completed' || status === 'skipped' ? 'done' : status === 'running' || status === 'awaiting-user' || status === 'creating' ? 'cur' : status === 'failed' ? 'warn' : status === 'stale' ? 'loop' : ''
        return `<div class="jstep ${cls}"><strong>${STAGE_TITLES[id]}</strong><span>${row ? `${row.attempt}·${status}` : '—'}</span></div>`
      }).join('')
      return `<div class="journey">${tiles}</div>`
    }

    function stageHtml(stage, instance) {
      const [label, tone] = statusMeta(stage.status)
      const defAction = (action) => {
        const cls = action.danger ? 'ph-btn danger' : action.id === 'confirm' ? 'ph-btn primary' : 'ph-btn'
        const labelText = action.label
        return `<button class="${cls}" data-stage-act="${action.id}" data-stage-row="${stage.id}" data-stage-id="${stage.stageId}">${esc(labelText)}</button>`
      }
      const threadAction = (stage.actions || []).find((a) => a.id === 'thread')
      const actions = (stage.actions || []).filter((a) => a.id !== 'thread').map(defAction).join('')
      // 线程入口单独渲染为幽灵样式（ph-open），进行中阶段描边强调，避免与普通动作按钮混排
      const isLive = ['running', 'awaiting-user', 'awaiting-confirmation', 'creating'].includes(stage.status)
      const openBtn = threadAction
        ? `<button class="ph-open${isLive ? ' live' : ''}" data-stage-act="thread" data-stage-row="${stage.id}" data-stage-id="${stage.stageId}">${icon('message', 12)}${esc(threadAction.label)}${icon('chevron', 11)}</button>`
        : ''
      const artifactChips = (stage.artifacts || []).slice(0, 6).map((artifact) => {
        const name = artifact.rel.split('/').filter(Boolean).pop() || artifact.rel
        return `<button class="chip${artifact.stale ? ' stale' : ''}" data-act="read-artifact" data-stage-row="${stage.id}" data-path="${esc(artifact.rel)}">${icon('text')}<span>${esc(name)}</span></button>`
      }).join('')
      const state = stage.state
      const pendingQuestion = state && state.status === 'asking' ? state.question : null
      const findings = state && Array.isArray(state.findings) ? state.findings : null
      let stateNote = ''
      if (pendingQuestion) stateNote = `<div class="pending-q"><strong>待你回答</strong><div>${esc(pendingQuestion)}</div></div>`
      if (findings && findings.length) {
        stateNote = `<div class="pending-q"><strong>待你决策 · ${findings.length} 个发现</strong><div style="font-size:10px;margin-top:4px">${findings.slice(0, 6).map((f) => `[${f.severity}/${f.kind}] ${esc(f.title)}`).join('<br>')}</div></div>`
      }
      if (stage.error) stateNote = `<div class="pending-q" style="border-color:#6e3a3a;background:rgba(239,125,125,.07);color:#f3a9a9"><strong>失败原因</strong><div>${esc(stage.error)}</div></div>`
      if (stage.staleReason) stateNote = `<div class="pending-q" style="border-color:#4f3b68;background:rgba(180,140,232,.07);color:#d3baf2"><strong>过期原因</strong><div>${esc(stage.staleReason)}</div></div>`
      const skill = stage.skillId ? `<span class="mono">${esc(stage.skillId)}</span>${stage.skillSha256 ? `<span class="mono" title="skill sha256">${esc(stage.skillSha256.slice(0, 8))}</span>` : ''}` : ''
      return `<div class="phase-item">
        <span class="dot ${tone}"></span>
        <div class="ph-main">
          <div class="ph-name">${esc(stage.title || stage.stageId)} <span class="round-badge" style="margin-left:4px">attempt ${stage.attempt}</span></div>
          <div class="ph-sub"><span class="st ${tone}">${esc(label)}</span>${skill}${stage.summary ? `<span>${esc(stage.summary)}</span>` : ''}</div>
          ${artifactChips ? `<div class="artifacts" style="margin-top:6px">${artifactChips}</div>` : ''}
          ${stateNote ? `<div style="margin-top:8px">${stateNote}</div>` : ''}
        </div>
        <div class="phase-actions">${openBtn}${actions}</div>
      </div>`
    }

    function renderDetail() {
      const detail = S.detail
      if (!detail) return
      const instance = detail.instance
      els.dTitle.textContent = instance.feature
      els.dSub.innerHTML = [
        `<span class="mono">${esc(instance.workspacePath)}</span>`,
        `<span class="st ${instance.status === 'active' ? 'running' : 'completed'}">${instance.status === 'active' ? '活动' : (instance.status === 'completed' ? '已完成' : '已取消')}</span>`,
        instance.branch ? `<span class="mono">${esc(instance.branch)}</span>` : '',
        `<span>${instance.mode === 'isolated' ? 'worktree · ' + esc(instance.worktreePath || '') : 'inplace'}</span>`
      ].filter(Boolean).join('')
      const body = els.dBody
      const active = detail.stages.find((stage) => ['running', 'awaiting-user', 'awaiting-confirmation', 'creating'].includes(stage.status))
      body.innerHTML = `
        <div class="sec-label">${icon('kanban')}阶段旅程</div>
        ${journeyHtml(detail)}
        <div class="sec-label">${icon('target')}阶段线程</div>
        <div class="phase-line">${(detail.stages || []).map((stage) => stageHtml(stage, instance)).join('') || '<div class="empty">暂无阶段</div>'}</div>
        ${detail.thread ? `<div class="sec-label">${icon('message')}当前线程</div><div class="chat" id="drawerChat">${(detail.thread.messages || []).map(messageHtml).join('') || '<div class="empty">线程尚无可见消息</div>'}</div>${interactiveBroker(active)}` : ''}
        <div class="sec-label">${icon('bookmark')}人工决策记录</div>
        <div class="ev-list" style="max-height:150px">${(detail.decisions || []).slice(-20).map((decision) => `<div class="ev-item"><span class="mono">${esc(decision.targetStage || decision.kind)}</span><span>${esc(decision.kind)}${decision.note ? ' — ' + esc(decision.note) : ''}</span><span class="mono" style="flex:0 0 auto">${formatTime(decision.at)}</span></div>`).join('') || '<div class="empty">暂无</div>'}</div>
        <div class="sec-label">${icon('rotate')}事件流</div>
        <div class="ev-list">${(detail.events || []).slice(-40).reverse().map((event) => `<div class="ev-item"><span class="mono">${esc(event.type)}</span><span class="mono">${formatTime(event.time)}</span></div>`).join('')}</div>
      `
      setDrawerActions(active)
    }

    function interactiveBroker(active) {
      if (!active || !['awaiting-user', 'running'].includes(active.status)) return ''
      if (active.status === 'running') return ''
      if (active.stageId !== 'clarify' && active.stageId !== 'converge') return ''
      return `
        <div class="chat-input" style="margin-top:4px">
          <input id="drawerAnswer" placeholder="${active.stageId === 'converge' ? '输入决策：追加任务请回复任务内容；无遗留请回复 none' : '输入你的回答…'}" data-stage-row="${active.id}" data-stage-id="${active.stageId}">
          <button class="btn btn-primary" data-act="drawer-send" data-stage-row="${active.id}">${icon('send')}发送</button>
        </div>
      `
    }

    function setDrawerActions(active) {
      const foot = els.dFoot
      const buttons = []
      if (active && active.status === 'awaiting-user') {
        buttons.push(`<button class="btn" data-stage-act="end-interactive" data-stage-row="${active.id}">${icon('check')}结束交互</button>`)
      } else if (active && active.status === 'awaiting-confirmation') {
        const confirm = (active.actions || []).find((a) => a.id === 'confirm')
        if (confirm) buttons.push(`<button class="btn btn-primary" data-stage-act="confirm" data-stage-row="${active.id}" data-stage-id="${active.stageId}">${icon('check')}${esc(confirm.label)}</button>`)
        if ((active.actions || []).some((a) => a.id === 'skip')) buttons.push(`<button class="btn" data-stage-act="skip" data-stage-row="${active.id}" data-stage-id="${active.stageId}">跳过</button>`)
        buttons.push(`<button class="btn" data-stage-act="redo" data-stage-row="${active.id}" data-stage-id="${active.stageId}">重做</button>`)
        buttons.push(`<button class="btn btn-danger" data-stage-act="cancel" data-stage-row="${active.id}" data-stage-id="${active.stageId}">${icon('trash')}取消</button>`)
      }
      // Always offer "删除实例" from the drawer (left side), independent of the
      // active stage — mirrors the card-level delete so users can tear down a
      // whole instance from either place. cancel-stage (取消) is different: it
      // only rolls the current stage back, not the entire instance.
      if (S.detailInstanceId) {
        buttons.push(`<button class="btn btn-danger" data-stage-act="delete-instance" data-stage-row="${active ? active.id : ''}" data-stage-id="${active ? active.stageId : ''}" style="margin-right:auto">${icon('trash')}删除实例</button>`)
      }
      foot.innerHTML = buttons.join('')
    }

    function messageHtml(message) {
      const who = message.who === 'user' ? '用户' : '线程'
      return `<div class="msg ${message.who === 'user' ? 'user' : 'agent'}"><span class="who">${esc(who)} · ${formatTime(message.at)}</span>${esc(message.text)}</div>`
    }

    // ------------------------------------------------------------- dialogs
    let dlgResolve = null
    function askConfirm(title, text, { danger = false, confirmLabel = null } = {}) {
      return new Promise((resolve) => {
        dlgResolve = resolve
        els.dlgTitle.textContent = title
        els.dlgText.innerHTML = `<p>${esc(text)}</p>`
        els.dlgPromptRow.style.display = 'none'
        // The confirm button must name the actual action — a generic "确认取消"
        // is indistinguishable from the cancel-stage dialog and misleads users
        // on the delete-instance flow. Callers pass confirmLabel explicitly.
        els.dlgOk.textContent = confirmLabel || (danger ? '确认取消' : '确认')
        els.dialogBackdrop.classList.add('open')
      })
    }
    function askPrompt(title, text) {
      return new Promise((resolve) => {
        dlgResolve = resolve
        els.dlgTitle.textContent = title
        els.dlgText.innerHTML = `<p>${esc(text)}</p>`
        els.dlgPromptRow.style.display = 'grid'
        els.dlgPrompt.value = ''
        els.dlgOk.textContent = '确认'
        els.dialogBackdrop.classList.add('open')
        window.setTimeout(() => els.dlgPrompt && els.dlgPrompt.focus(), 60)
      })
    }
    function resolveDialog(value) {
      if (els.dialogBackdrop) els.dialogBackdrop.classList.remove('open')
      if (dlgResolve) { const r = dlgResolve; dlgResolve = null; r(value) }
    }

    // ------------------------------------------------------------- data
    async function refreshBoard() {
      if (!S.sessionId) {
        const sid = readSessionIdFromServices()
        if (sid) S.sessionId = sid
      }
      if (!S.sessionId) return
      if (!S.workspaceTarget && S.board && S.board.cwd) S.workspaceTarget = S.board.cwd
      try {
        const value = await callHost('instances', { workspace: S.workspaceTarget || undefined })
        S.board = value
        S.cwd = value.cwd || null
        S.projects = value.projects || []
        if (!S.workspaceTarget) {
          // cwd may be absent (e.g. the session has no absolute project path);
          // fall back to the first registry workspace so creation is still possible.
          S.workspaceTarget = (value.cwd || (S.projects[0] && S.projects[0].path)) || null
        }
        renderBoard()
        populateProjects()
        if (S.detailInstanceId) void refreshDetail()
      } catch (error) {
        if (S.timer2 === 0) toast(`看板刷新失败：${error.message}`)
      }
    }

    async function refreshDetail() {
      if (!S.detailInstanceId) return
      try {
        const value = await callHost('instance-get', { instanceId: S.detailInstanceId })
        S.detail = value
        renderDetail()
      } catch (error) {
        toast(`详情刷新失败：${error.message}`)
      }
    }

    async function openInstance(instanceId) {
      S.detailInstanceId = instanceId
      els.drawer.classList.add('open')
      els.drawerBackdrop.classList.add('open')
      await refreshDetail()
    }
    function closeDrawer() {
      els.drawer.classList.remove('open')
      els.drawerBackdrop.classList.remove('open')
      S.detailInstanceId = null
      S.detail = null
    }

    async function openThread(stageRow, stageId) {
      const instanceId = S.detailInstanceId
      if (!instanceId) return
      try {
        const value = await callHost('thread-view', { instanceId, stageRowId: stageRow })
        S.thread = value
        els.thTitle.textContent = `线程 · ${STAGE_TITLES[stageId] || stageId}#${value.stageRow.attempt}`
        els.thBody.innerHTML = `
          ${(value.messages || []).map(messageHtml).join('') || '<div class="empty">线程暂无消息</div>'}
          ${value.state && value.state.status === 'asking' ? `<div class="pending-q" style="margin-top:8px"><strong>待你回答</strong><div>${esc(value.state.question)}</div></div>` : ''}
          ${value.state && Array.isArray(value.state.findings) && value.state.findings.length ? `<div class="pending-q" style="margin-top:8px"><strong>待你决策</strong><div>${value.state.findings.length} 个发现</div></div>` : ''}
        `
        els.threadModal.classList.add('open')
        const input = els.thAnswer
        input.dataset.stageRow = String(stageRow)
        input.dataset.stageId = stageId
        input.focus()
      } catch (error) {
        toast(error.message)
      }
    }
    function closeThread() {
      els.threadModal.classList.remove('open')
      S.thread = null
    }

    // ------------------------------------------------------------- actions
    function wireEvents(root) {
      ;['createModal', 'drawer', 'threadModal', 'dialog'].forEach((id) => {
        const backdrop = root.querySelector(`#${id}`)
        const closeBtn = backdrop && backdrop.querySelector(`[data-close="${id}"]`)
        if (closeBtn) closeBtn.addEventListener('click', () => resolveClose(id))
      })
      root.querySelector('#createModal')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) resolveClose('createModal')
      })
      root.querySelector('#threadModal')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) closeThread()
      })
      root.querySelector('#dialogBackdrop')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) resolveDialog(null)
      })
      // The instance-detail drawer's backdrop is bounded to the board host
      // (position:absolute), so it only dims/closes over the board area — the
      // rest of the app (sidebar, top bar, other conversations) stays clickable
      // while the drawer is open. Clicking the backdrop closes the drawer.
      root.querySelector('#drawerBackdrop')?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) closeDrawer()
      })

      // ---- board click dispatch (dual-path: shadow root + document) --------
      // Primary path is a document-level listener using composedPath() so the
      // REAL clicked element inside our shadow host is resolved even through
      // retargeting — this survives whatever swallows shadow-root delegation in
      // a specific app build. A shadow-root listener remains as the second
      // path; the first one to run marks the event and the other skips.
      const dispatchBoardClick = async (event, origin) => {
        try {
          try { hideCtxMenu() } catch (e) { /* not defined yet on first mount */ }
          const target = origin && origin.closest ? origin.closest('[data-act],[data-close],[data-stage-act],[data-card-act]') : null
          if (!target) return
          const act = target.dataset.act
          const stageAct = target.dataset.stageAct

          if (target.dataset.close === 'drawer') { closeDrawer(); return }
          if (target.dataset.close === 'threadModal') { closeThread(); return }
          if (target.dataset.close === 'createModal') { S.createOpen = false; resolveClose('createModal'); return }
          if (target.dataset.close === 'dialog') { resolveDialog(null); return }

          if (act === 'close-board') { setOpen(false); return }
          if (act === 'new-feature') { S.createOpen = true; els.createModal.classList.add('open'); window.setTimeout(() => els.fFeature && els.fFeature.focus(), 60); return }
          if (act === 'create-submit') { await submitCreate(); return }
          if (act === 'open-instance') { await openInstance(target.dataset.instance); return }

          // Card-level quick actions (confirm-to-next-stage / delete instance)
          // live on the card itself — handle them before any fallback so they
          // never bubble into opening the drawer.
          const cardAct = target.dataset.cardAct
          if (cardAct) { await handleCardAction(cardAct, target); return }
          if (act === 'read-artifact') {
            await readArtifact(target.dataset.path)
            return
          }
          if (act === 'drawer-send') {
            const input = els.dBody ? els.dBody.querySelector('#drawerAnswer') : null
            const text = input ? input.value.trim() : ''
            if (!text) return
            await sendAnswer(Number(input.dataset.stageRow), text, 'answer')
            input.value = ''
            return
          }
          if (act === 'thread-send') {
            const input = els.thAnswer
            const text = input ? input.value.trim() : ''
            if (!text) return
            await sendAnswer(Number(input.dataset.stageRow), text, 'answer')
            return
          }
          if (act === 'thread-refresh') {
            const row = els.thAnswer ? Number(els.thAnswer.dataset.stageRow) : null
            if (row != null && !Number.isNaN(row)) await openThread(row, els.thAnswer.dataset.stageId)
            return
          }
          if (act === 'thread-end') {
            const row = els.thAnswer ? Number(els.thAnswer.dataset.stageRow) : null
            if (row != null && !Number.isNaN(row)) await sendAnswer(row, 'done', 'end-interactive')
            return
          }

          if (stageAct) await handleStageAction(stageAct, target)
        } catch (error) {
          console.error('[speckit-workflow] click handler', error)
          try { toast(`操作失败：${(error && error.message) || error}`) } catch (e) { /* noop */ }
        }
      }
      const onShadowClick = (event) => {
        if (event.__spkbHandled) return
        event.__spkbHandled = true
        void dispatchBoardClick(event, event.target)
      }
      const onDocumentClick = (event) => {
        if (event.__spkbHandled) return
        const path = event.composedPath ? event.composedPath() : null
        const origin = (path && path.length ? path[0] : null) || event.target
        if (!origin || typeof origin.closest !== 'function') return
        if (!origin.closest('[data-spkb-host]')) return // ignore clicks outside the board
        event.__spkbHandled = true
        void dispatchBoardClick(event, origin)
      }
      root.addEventListener('click', onShadowClick)
      document.addEventListener('click', onDocumentClick)
      // dispose returns these so unmount never leaks
      window.__spkbBoardClickCleanup = () => {
        root.removeEventListener('click', onShadowClick)
        document.removeEventListener('click', onDocumentClick)
        window.__spkbBoardClickCleanup = null
      }

      // Right-click context menu (v0.7 parity): 新建 Feature / 刷新看板 / 返回对话
      root.addEventListener('contextmenu', (event) => {
        const card = event.target.closest ? event.target.closest('[data-act="open-instance"]') : null
        if (card) return // let the default card menu (if any) win on cards
        event.preventDefault()
        showCtxMenu(event.clientX, event.clientY)
      })
      const ctxMenu = document.createElement('div')
      ctxMenu.id = 'spkbCtxMenu'
      ctxMenu.style.cssText =
        'position:fixed;z-index:96;min-width:170px;display:none;padding:5px;border-radius:8px;' +
        'background:var(--panel-2,#1b222a);border:1px solid var(--line,#2b353f);box-shadow:var(--shadow,0 18px 44px rgba(0,0,0,.28));' +
        'font:12px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--muted,#96a3ad);' +
        'flex-direction:column;gap:2px'
      ctxMenu.innerHTML = [
        `<button type="button" data-m="new">${icon('plus', 14)} 新建 Feature</button>`,
        `<button type="button" data-m="refresh">${icon('refresh', 14)} 刷新看板</button>`,
        `<button type="button" data-m="back">${icon('back', 14)} 返回对话</button>`
      ].join('')
      root.appendChild(ctxMenu)
      ctxMenu.querySelectorAll('button').forEach((btn) => {
        btn.style.cssText =
          'width:100%;display:flex;align-items:center;gap:8px;padding:7px 10px;border:0;border-radius:6px;' +
          'background:transparent;color:var(--muted,#96a3ad);cursor:pointer;text-align:left;font:inherit'
        btn.addEventListener('mouseover', () => { btn.style.background = 'rgba(255,255,255,.06)' })
        btn.addEventListener('mouseout', () => { btn.style.background = 'transparent' })
      })
      function showCtxMenu(x, y) {
        ctxMenu.style.display = 'flex'
        const r = document.documentElement.getBoundingClientRect()
        ctxMenu.style.left = `${Math.min(x, r.width - 180)}px`
        ctxMenu.style.top = `${Math.min(y, r.height - 130)}px`
      }
      function hideCtxMenu() { ctxMenu.style.display = 'none' }
      ctxMenu.addEventListener('click', (event) => {
        const m = event.target.closest('[data-m]')
        hideCtxMenu()
        if (!m) return
        if (m.dataset.m === 'new') { S.createOpen = true; els.createModal.classList.add('open'); window.setTimeout(() => els.fFeature && els.fFeature.focus(), 60) }
        else if (m.dataset.m === 'refresh') { void refreshBoard() }
        else if (m.dataset.m === 'back') { setOpen(false) }
      })
      root.addEventListener('click', () => hideCtxMenu())
      root.addEventListener('scroll', () => hideCtxMenu(), true)

      // Belt-and-suspenders: bind the two reported topbar actions DIRECTLY so
      // they respond even if the delegated handler is shadowed by an overlay or
      // a z-order quirk in a specific app build.
      const topClose = root.querySelector('[data-act="close-board"]')
      if (topClose) topClose.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        console.log('[speckit-workflow] close-board direct click')
        setOpen(false)
      })
      const topNew = root.querySelector('[data-act="new-feature"]')
      if (topNew) topNew.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        console.log('[speckit-workflow] new-feature direct click')
        S.createOpen = true
        els.createModal.classList.add('open')
        window.setTimeout(() => els.fFeature && els.fFeature.focus(), 60)
      })
      // Belt-and-suspenders: bind the create-submit action directly, exactly
      // like close-board / new-feature, so the delegated handler being swallowed
      // by an overlay or z-order quirk in a specific app build cannot block
      // instance creation (reported as "创建并启动 Specify 点击不生效").
      const topSubmit = root.querySelector('[data-act="create-submit"]')
      if (topSubmit) topSubmit.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        console.log('[speckit-workflow] create-submit direct click')
        void submitCreate()
      })

      // ---- keyboard (dual-path like clicks) --------------------------------
      const handleKey = (event, origin) => {
        if (event.key === 'Enter' && origin && origin.id === 'fFeature') { event.preventDefault(); void submitCreate(); return }
        if (event.key === 'Enter' && origin && origin.id === 'thAnswer' && S.thread) {
          event.preventDefault()
          const input = els.thAnswer
          const text = input ? input.value.trim() : ''
          if (text) void sendAnswer(Number(input.dataset.stageRow), text, 'answer').then(() => { input.value = '' })
          return
        }
        if (event.key === 'Enter' && origin && origin.id === 'drawerAnswer') {
          event.preventDefault()
          const input = els.dBody ? els.dBody.querySelector('#drawerAnswer') : null
          const text = input ? input.value.trim() : ''
          if (text) void sendAnswer(Number(input.dataset.stageRow), text, 'answer').then(() => { input.value = '' })
          return
        }
        if (event.key === 'Enter' && origin && origin.id === 'dlgPrompt') {
          event.preventDefault()
          resolveDialog(els.dlgPrompt.value.trim() || '')
          return
        }
        if (event.key === 'Escape') {
          if (els.threadModal && els.threadModal.classList.contains('open')) { closeThread(); return }
          if (els.createModal && els.createModal.classList.contains('open')) { resolveClose('createModal'); return }
          if (els.drawer && els.drawer.classList.contains('open')) { closeDrawer(); return }
          // Last layer: close the whole board back to the conversation.
          if (open) setOpen(false)
        }
      }
      const onShadowKey = (event) => {
        if (event.__spkbKeyHandled) return
        event.__spkbKeyHandled = true
        handleKey(event, event.target)
      }
      const onDocumentKey = (event) => {
        if (event.__spkbKeyHandled) return
        const path = event.composedPath ? event.composedPath() : null
        const origin = (path && path.length ? path[0] : null) || event.target
        if (event.key === 'Escape' && !open) return // ignore Escape when board fully closed
        event.__spkbKeyHandled = true
        handleKey(event, origin)
      }
      root.addEventListener('keydown', onShadowKey)
      document.addEventListener('keydown', onDocumentKey)

      root.querySelector('[data-act="dlg-cancel"]')?.addEventListener('click', () => resolveDialog(null))
      root.querySelector('#dlgOk')?.addEventListener('click', () => resolveDialog(els.dlgPrompt && els.dlgPrompt.style.display !== 'none' ? els.dlgPrompt.value.trim() || '' : true))
      root.querySelector('#projectSelect')?.addEventListener('change', (event) => {
        if (event.target.value) setWorkspaceTarget(event.target.value)
      })

      // Unmount cleanup for every listener attached at document level.
      return () => {
        document.removeEventListener('click', onDocumentClick)
        document.removeEventListener('keydown', onDocumentKey)
        root.removeEventListener('click', onShadowClick)
        root.removeEventListener('keydown', onShadowKey)
        if (window.__spkbBoardClickCleanup) { window.__spkbBoardClickCleanup() }
      }
    }

    async function submitCreate() {
      const feature = els.fFeature.value.trim()
      if (!feature) { toast('请填写 Feature 描述'); els.fFeature.focus(); return }
      // Resolve the target workspace from every available source: the board's
      // scoped target, the resolved session cwd, then the workspace registry.
      // Previously a missing/absent session cwd left this null and the create
      // silently failed with "当前工作区不可用".
      const workspacePath =
        S.workspaceTarget ||
        S.cwd ||
        (S.board && S.board.projects && S.board.projects[0] && S.board.projects[0].path) ||
        (S.workspaces && S.workspaces[0] && S.workspaces[0].path) ||
        null
      if (!workspacePath) { toast('请先在上方选择目标工作区'); return }
      const entry = (S.board?.projects || S.workspaces || []).find((p) => p.path === workspacePath)
      if (entry && !entry.ready) { toast(`目标工作区未就绪：${(entry.issues || []).join('；')}`); return }
      const modelValue = els.fModel.value
      const gather = (id) => { const node = els[id]; return node ? node.checked : true }
      const modelParts = modelValue ? modelValue.split('::') : []
      const [provider, model] = modelParts
      await callHost('instance-create', {
        input: {
          workspacePath,
          feature,
          config: {
            useWorktrees: gather('sw-worktrees'),
            runChecklist: gather('sw-checklist'),
            runAnalyze: gather('sw-analyze'),
            runTaskstoissues: gather('sw-issues'),
            ...(provider && model ? { provider, model } : {})
          }
        }
      })
      toast('实例已创建，Specify 线程已启动')
      resolveClose('createModal')
      els.fFeature.value = ''
      await refreshBoard()
    }

    async function handleStageAction(stageAct, target) {
      const stageRow = Number(target.dataset.stageRow)
      const stageId = target.dataset.stageId
      const instanceId = S.detailInstanceId
      if (!instanceId || Number.isNaN(stageRow)) return
      const actionId = newActionId()
      try {
        switch (stageAct) {
          case 'confirm': {
            const confirm = S.detail.stages.find((s) => s.id === stageRow)
            const label = (confirm.actions || []).find((a) => a.id === 'confirm')
            const ok = await askConfirm('确认阶段交接', (label ? label.label : '进入下一阶段') + '？固化当前阶段产物后创建下一阶段线程。')
            if (!ok) return
            await callHost('stage-confirm', { instanceId, stageRowId: stageRow, actionId })
            toast('已确认，下一阶段线程已启动')
            break
          }
          case 'skip': {
            const reason = await askPrompt('跳过本阶段', '跳过可选阶段（Checklist / Analyze / Taskstoissues）。跳过会记录原因，不会伪造通过。')
            if (reason === null) return
            await callHost('stage-skip', { instanceId, stageRowId: stageRow, actionId, reason: reason || '用户选择跳过' })
            toast('已跳过')
            break
          }
          case 'redo': {
            const reason = await askPrompt('重新执行本阶段', `将创建 ${stageId} 的新 attempt（保留旧记录为历史），并把下游标记为可能过期。`)
            if (reason === null) return
            await callHost('stage-rerun', { instanceId, stageId, actionId, reason })
            toast('已重跑')
            break
          }
          case 'cancel': {
            const ok = await askConfirm('取消阶段', '将取消当前阶段并释放工作区锁。确定取消？', { danger: true, confirmLabel: '确认取消' })
            if (!ok) return
            await callHost('stage-cancel', { instanceId, stageRowId: stageRow, actionId })
            toast('已取消')
            break
          }
          case 'answer':
            await openThread(stageRow, stageId)
            break
          case 'thread':
            await openThread(stageRow, stageId)
            break
          case 'error':
            await refreshDetail()
            break
          case 'delete-instance': {
            // Tear down the whole Feature instance: cancel active stage + free
            // the workspace lock (host `instance-cancel` / `cancelInstance`).
            const ok = await askConfirm('删除实例', '将删除该 Feature 工作流实例（取消活动阶段并释放工作区锁）。确定删除？', { danger: true, confirmLabel: '确认删除' })
            if (!ok) return
            await callHost('instance-cancel', { instanceId, actionId })
            toast('实例已删除')
            break
          }
          case 'end-interactive': {
            const ok = await askConfirm('结束交互', '结束当前交互阶段并生成最终摘要（等待确认交接）。')
            if (!ok) return
            await callHost('stage-answer', { instanceId, stageRowId: stageRow, actionId, kind: 'end-interactive', text: 'done' })
            toast('已结束交互')
            break
          }
          case 'rollback': {
            const ok = await askConfirm('返回上阶段', '将重新执行上一阶段并标记后续阶段过期。')
            if (!ok) return
            await callHost('stage-rollback', { instanceId, stageId, actionId })
            toast('已返回上阶段')
            break
          }
          case 'stale-reason':
            await refreshDetail()
            break
          default:
            break
        }
      } catch (error) {
        toast(error.message)
      }
      await Promise.all([refreshDetail(), refreshBoard()])
    }

    async function handleCardAction(cardAct, target) {
      const instanceId = target.dataset.instance
      const stageRow = Number(target.dataset.stageRow)
      const stageId = target.dataset.stageId
      const actionId = newActionId()
      try {
        if (cardAct === 'confirm') {
          const ok = await askConfirm('确认阶段交接', '确认进入下一阶段？固化当前阶段产物后创建下一阶段线程。')
          if (!ok) return
          await callHost('stage-confirm', { instanceId, stageRowId: stageRow, actionId })
          toast('已确认，下一阶段线程已启动')
        } else if (cardAct === 'delete-instance') {
          const ok = await askConfirm('删除实例', '将删除该 Feature 工作流实例（取消活动阶段并释放工作区锁）。确定删除？', { danger: true, confirmLabel: '确认删除' })
          if (!ok) return
          await callHost('instance-cancel', { instanceId, actionId })
          toast('实例已删除')
        } else if (cardAct === 'rollback-stage') {
          const ok = await askConfirm('回推当前阶段', `将取消 ${stageId || '当前'} 阶段并释放工作区锁，Feature 实例保留。确定回推？`, { confirmLabel: '确认回推' })
          if (!ok) return
          await callHost('stage-cancel', { instanceId, stageRowId: stageRow, actionId })
          toast('已回推当前阶段')
        } else {
          return
        }
        await Promise.all([refreshDetail(), refreshBoard()])
      } catch (error) {
        toast(error.message)
      }
    }

    async function sendAnswer(stageRow, text, kind) {
      const instanceId = S.detailInstanceId
      if (!instanceId || Number.isNaN(stageRow)) return
      const actionId = newActionId()
      try {
        await callHost('stage-answer', { instanceId, stageRowId: stageRow, actionId, text, kind })
        toast('已发送到线程')
        closeThread()
        await refreshDetail()
      } catch (error) {
        toast(error.message)
      }
    }

    async function readArtifact(path) {
      const instanceId = S.detailInstanceId
      if (!instanceId || !path) return
      try {
        const value = await callHost('artifact-read', { instanceId, path, limit: 30000 })
        const text = value.text || ''
        await askConfirm(`产物 · ${path}`, text.length > 2600 ? `${text.slice(0, 2600)}\n…（已截断）` : text)
      } catch (error) {
        toast(error.message)
      }
    }

    async function loadModels() {
      try {
        const value = await callHost('models', {})
        S.models = value
        const fModel = els.fModel
        if (!fModel) return
        const options = ['<option value="">跟随会话默认</option>']
        const current = value && value.current
        for (const provider of (value && value.providers) || []) {
          for (const model of provider.models || []) {
            const label = `${provider.name} / ${model.name || model.id}`
            const val = `${provider.id}::${model.id}`
            const sel = current && current.provider === provider.id && current.model === model.id ? ' selected' : ''
            options.push(`<option value="${esc(val)}"${sel}>${esc(label)}</option>`)
          }
        }
        fModel.innerHTML = options.join('')
      } catch {
        /* models optional */
      }
    }

    function resolveClose(id) {
      const backdrop = els[id]
      if (backdrop) backdrop.classList.remove('open')
      if (id === 'createModal') S.createOpen = false
    }

    // --------------------------------------------------------------- mount
    function mountStudio({ shadow, sessionId, onSessionChange }) {
      shadowRoot = shadow
      S.sessionId = sessionId || null

      const style = document.createElement('style')
      style.textContent = CSS
      shadow.appendChild(style)
      shadow.appendChild(buildShell())
      shadow.appendChild(buildCreateModal())
      const { backdrop, drawer } = buildDrawer()
      shadow.appendChild(drawer) // backdrop handled separately
      shadow.appendChild(backdrop)
      shadow.appendChild(buildThreadModal())
      shadow.appendChild(buildDialog())
      shadow.appendChild(buildToast())

      els = {
        board: shadow.getElementById('board'),
        topCwd: shadow.getElementById('topCwd'),
        mWorktree: shadow.getElementById('mWorktree'),
        mInstances: shadow.getElementById('mInstances'),
        projectSelect: shadow.getElementById('projectSelect'),
        createModal: shadow.getElementById('createModal'),
        fFeature: shadow.getElementById('fFeature'),
        fProjectTarget: shadow.getElementById('fProjectTarget'),
        fProjectHint: shadow.getElementById('fProjectHint'),
        fModel: shadow.getElementById('fModel'),
        'sw-worktrees': shadow.getElementById('sw-worktrees'),
        'sw-checklist': shadow.getElementById('sw-checklist'),
        'sw-analyze': shadow.getElementById('sw-analyze'),
        'sw-issues': shadow.getElementById('sw-issues'),
        drawer: drawer,
        drawerBackdrop: backdrop,
        dTitle: shadow.getElementById('dTitle'),
        dSub: shadow.getElementById('dSub'),
        dBody: shadow.getElementById('dBody'),
        dFoot: shadow.getElementById('dFoot'),
        threadModal: shadow.getElementById('threadModal'),
        thTitle: shadow.getElementById('thTitle'),
        thBody: shadow.getElementById('thBody'),
        thAnswer: shadow.getElementById('thAnswer'),
        dialogBackdrop: shadow.getElementById('dialogBackdrop'),
        dlgTitle: shadow.getElementById('dlgTitle'),
        dlgText: shadow.getElementById('dlgText'),
        dlgPromptRow: shadow.getElementById('dlgPromptRow'),
        dlgPrompt: shadow.getElementById('dlgPrompt'),
        dlgOk: shadow.getElementById('dlgOk'),
        toast: shadow.querySelector('.toast')
      }
      els.driverOpenCheck = () => {
        if (els.createModal && els.createModal.classList.contains('open')) { resolveClose('createModal'); return true }
        if (els.drawer && els.drawer.classList.contains('open')) { closeDrawer(); return true }
        return false
      }

      const disposeEvents = wireEvents(shadow)

      // Global error surface: any uncaught error while the board is mounted is
      // shown as a toast so the user can report it without DevTools.
      const onWinError = (event) => {
        const message = (event && event.error && event.error.message) || (event && event.message) || String(event || '')
        console.error('[speckit-workflow] uncaught', message)
        try { toast(`看板运行错误：${message.slice(0, 300)}`) } catch (e) { /* noop */ }
      }
      window.addEventListener('error', onWinError)

      void loadModels()
      void refreshBoard()
      S.pollTimer = window.setInterval(() => { if (S.sessionId && S.detailInstanceId) void refreshDetail() }, POLL_MS)
      S.timer2 = window.setInterval(() => {
        if (S.sessionId) void refreshBoard()
      }, POLL_MS * 2)

      if (els.topCwd) els.topCwd.textContent = S.board && S.board.cwd ? S.board.cwd : '…'
      return () => {
        window.clearInterval(S.pollTimer)
        window.clearInterval(S.timer2)
        window.clearTimeout(S.toastTimer)
        window.removeEventListener('error', onWinError)
        if (typeof disposeEvents === 'function') disposeEvents()
      }
    }

    // ------------------------------------------------------------ panel entry
    let open = false
    const openListeners = new Set()
    const setOpen = (value) => {
      open = typeof value === 'boolean' ? value : !open
      openListeners.forEach((listener) => listener(open))
    }

    const COLUMN_CANDIDATES = [
      '[data-slot="conversation"]',
      '[data-pane="conversation"]',
      '[class*="centerCol"]',
      '[class*="conversation"]'
    ]
    const SIDEBAR_CANDIDATES = ['[data-slot="sidebar"]', '[class*="sidebar"]']
    const ACTIVE_ATTR = 'data-spkb-active'
    const OTHER_ACTIVE_ATTRS = ['data-dsh-ssh-active', 'data-dsh-taskboard-active']
    const ACTIVATE_EVENT = 'dsh-panel-activate'
    const PANEL_NAME = 'speckit'
    // When the board is active it takes over the conversation column; hide the
    // column's original children so they don't show through behind the board.
    const HIDE_CSS = `html[data-spkb-active] [data-slot="conversation"]>:not([data-spkb-host]),html[data-spkb-active] [data-pane="conversation"]>:not([data-spkb-host]),html[data-spkb-active] [class*="centerCol"]>:not([data-spkb-host]){display:none!important}`

    function rectOf(selector) {
      const node = document.querySelector(selector)
      if (!node) return null
      const r = node.getBoundingClientRect()
      return (r.width > 80 && r.height > 80) ? r : null
    }
    function columnBox() {
      // 1) Explicit conversation-column candidates — but skip a match that
      //    already spans the whole viewport (that would block the sidebar).
      for (const selector of COLUMN_CANDIDATES) {
        const r = rectOf(selector)
        if (r && r.width < window.innerWidth * 0.98) return { top: r.top, left: r.left, width: r.width, height: r.height }
      }
      // 2) Derive the conversation column from the conversation input's
      //    container. Robust when the app build uses different column class
      //    names — the board still takes over the MAIN DIALOG only, never the
      //    whole window (which would make the sidebar / top bar unclickable).
      const input = document.querySelector('textarea, [contenteditable="true"]')
      if (input) {
        let el = input.parentElement
        while (el && el !== document.body) {
          const r = el.getBoundingClientRect()
          const cls = (typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '')
          const looksLikeColumn = /conversation|center|chat|main|dialog|thread|message/i.test(cls) || r.width > 360
          if (r.width > 360 && r.width < window.innerWidth * 0.98 && r.height > 240 && looksLikeColumn) {
            return { top: r.top, left: r.left, width: r.width, height: r.height }
          }
          el = el.parentElement
        }
      }
      // 3) Fall back to "right of the sidebar" so the sidebar stays usable.
      for (const selector of SIDEBAR_CANDIDATES) {
        const r = rectOf(selector)
        if (r) return { top: 0, left: r.right, width: Math.max(0, window.innerWidth - r.right), height: window.innerHeight }
      }
      // 4) Last resort only: full viewport (no sidebar / conversation column found).
      return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight }
    }
    // The board takes over the conversation column (the "main dialog") — the
    // original full-takeover mode. It must NOT cover the sidebar / top bar, so
    // columnBox() resolves only the conversation column (never the full window).
    function clampHost(host) {
      const box = columnBox()
      const s = host.style
      s.position = 'fixed'
      s.top = box.top + 'px'
      s.left = box.left + 'px'
      s.width = box.width + 'px'
      s.height = box.height + 'px'
      s.right = 'auto'
      s.bottom = 'auto'
      s.transform = 'none'
      s.margin = '0'
      s.borderRadius = '0'
      s.border = 'none'
      s.boxShadow = 'none'
      s.zIndex = '1000'
      s.pointerEvents = 'auto'
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      // Authoritative session source. The conversation header slot (secondary
      // fallback below) is not mounted in every app build, so we read the
      // current session directly from the `sessions` service and keep it live
      // via its reactive stores. Without a session id every Host RPC no-ops.
      sessionsService = ctx.get('sessions') || null
      wireSessionSync()
      const inject = (name, options, render) => slots.inject(name, () => slots.register(options, render))
      return ctx.effect(() => {
        let styleEl = null
        let host = null
        let lastSessionId = null

        const ensureStyle = () => {
          if (styleEl) return
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-spkb-takeover', '')
          styleEl.textContent = HIDE_CSS
          ;(document.head || document.documentElement).appendChild(styleEl)
        }

        const ensureHost = () => {
          // Re-mount if the previous mount threw (otherwise the panel would be
          // permanently dead after one failed first open).
          if (host && host.isConnected && host.__spkbMountFailed !== true) return host
          if (host) { try { host.remove() } catch (e) { /* noop */ } host = null }
          host = document.createElement('div')
          host.setAttribute('data-spkb-host', '')
          host.setAttribute('data-spkb-plugin', PANEL_NAME)
          host.style.pointerEvents = 'auto'
          host.style.display = 'none'
          const shadowNode = host.attachShadow({ mode: 'open' })
          try {
            host.__spkbDispose = mountStudio({ shadow: shadowNode, sessionId: lastSessionId })
            host.__spkbMountFailed = false
          } catch (error) {
            host.__spkbMountFailed = true
            // Surface the failure INSIDE the panel so it's visible without DevTools.
            try {
              const errBox = document.createElement('div')
              errBox.style.cssText = 'overflow:auto;height:100%;padding:18px;color:#f3a9a9;font:12px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap;background:#151a20'
              errBox.textContent = `[speckit-workflow] 看板初始化失败:\n${(error && error.stack) || error}\n\n再次打开看板会重新挂载。`
              shadowNode.appendChild(errBox)
              document.body.appendChild(host)
              clampHost(host)
            } catch (e) { /* noop */ }
            console.error('[speckit-workflow] board mount failed', error)
          }
          if (!host.__spkbMountFailed) document.body.appendChild(host)
          clampHost(host)
          return host
        }

        const applyActive = (value) => {
          const root = document.documentElement
          if (value) {
            for (const other of OTHER_ACTIVE_ATTRS) root.removeAttribute(other)
            root.setAttribute(ACTIVE_ATTR, '')
            document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
          } else {
            root.removeAttribute(ACTIVE_ATTR)
          }
        }

        const setBoardVisible = (value) => {
          if (value) {
            const h = ensureHost()
            if (h) { clampHost(h); h.style.display = 'block' }
          } else if (host && host.isConnected) {
            host.style.display = 'none'
          }
        }

        const onResize = () => { if (host && host.isConnected) clampHost(host) }
        window.addEventListener('resize', onResize)
        const onOtherActivate = (event) => {
          if (event.detail !== PANEL_NAME && open) setOpen(false)
        }
        const onClickSidebarRow = (event) => {
          if (!open) return
          // The injected per-workspace "看板" button is the ENTRY — never close
          // the board because that button was clicked.
          if (event.target && event.target.closest('[data-spkb-ws]')) return
          const target = event.target
          if (target && target.closest('[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]')) setOpen(false)
        }

        const onOpenChange = (value) => {
          ensureStyle()
          applyActive(value)
          setBoardVisible(value)
          if (value) {
            const sid = readSessionIdFromServices()
            if (sid) S.sessionId = sid
            else if (lastSessionId) S.sessionId = lastSessionId
            if (S.sessionId) void loadModels()
          }
        }
        openListeners.add(onOpenChange)
        document.addEventListener('click', onClickSidebarRow, true)
        document.addEventListener(ACTIVATE_EVENT, onOtherActivate)

        // The session-header slot now ONLY feeds the session id to this client
        // (entry moved to the workspace rows / sidebar fallback) — render nothing.
        const disposeHeader = inject('conversation.session.header.actions', { name: 'conversation.session.header.actions', id: 'speckit-board-header', order: 20, label: () => 'Spec 流水线看板' }, (props) => {
          // Best-effort: some app builds deliver the session id through this
          // slot's props. The authoritative source is the `sessions` service
          // (see wireSessionSync); this remains a secondary fallback.
          const sid = props && (props.sessionId || (props.useSession && props.useSession((s) => (s && s.id) || undefined)))
          if (sid) { lastSessionId = sid; S.sessionId = sid }
          return null
        })

        installWorkspaceRowObserver()

        return () => {
          openListeners.delete(onOpenChange)
          document.removeEventListener('click', onClickSidebarRow, true)
          document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
          window.removeEventListener('resize', onResize)
          document.documentElement.removeAttribute(ACTIVE_ATTR)
          if (host) {
            if (typeof host.__spkbDispose === 'function') host.__spkbDispose()
            host.remove()
            host = null
          }
          if (styleEl) { styleEl.remove(); styleEl = null }
          if (typeof disposeHeader === 'function') disposeHeader()
          disposeWorkspaceRowObserver()
        }
      }, 'dsh-speckit-workflow: dispose')
    }

    exports.apply = apply
    exports.inject = ['slots', 'sessions']
    return module.exports
  }
})

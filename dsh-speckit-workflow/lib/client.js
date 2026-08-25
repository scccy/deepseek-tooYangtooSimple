// dsh-speckit-workflow — Feature 工作台 (v0.8) durable client.
//
// 正式版客户端：不再内嵌阴影 DOM 看板。入口注入（工作区行「看板」按钮 + 侧栏
// 兜底入口）保持不变；打开时从主通道 /api/dsh-speckit-workflow/board.js 加载
// React 工作台 bundle（window.__SPKB_BOARD__）并挂载到会话列覆盖层。
// 这样重启后工作台 UI 不再依赖临时动态插件（spkbw-1 之类），持久可用。
//
// 会话列接管、Escape 分层、clamp 规则沿用已验证的 ssh/board 模式。

window.__ModuleLoader__.load({
  id: 'dsh-speckit-workflow',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const PANEL_NAME = 'speckit'
    const BOARD_URL = '/api/dsh-speckit-workflow/board.js'
    const ACTIVE_ATTR = 'data-spkb-active'
    const OTHER_ACTIVE_ATTRS = ['data-dsh-ssh-active', 'data-dsh-taskboard-active']
    const ACTIVATE_EVENT = 'dsh-panel-activate'

    // 工作台激活时隐藏会话列原始内容，避免透出到 React 覆盖层后面。
    const HIDE_CSS = `html[data-spkb-active] [data-slot="conversation"]>:not([data-spkb-host]),html[data-spkb-active] [data-pane="conversation"]>:not([data-spkb-host]),html[data-spkb-active] [class*="centerCol"]>:not([data-spkb-host]){display:none!important}`

    const COLUMN_CANDIDATES = [
      '[data-slot="conversation"]',
      '[data-pane="conversation"]',
      '[class*="centerCol"]',
      '[class*="conversation"]'
    ]
    const SIDEBAR_CANDIDATES = ['[data-slot="sidebar"]', '[class*="sidebar"]']
    const WS_ROW_SELECTOR = '[class*="projectRow"],[class*="workspaceItem"],[class*="workspace-row"],[class*="workspaceRow"]'

    // ------------------------------------------------------------------ state
    const S = { sessionId: null, workspaceTarget: null, workspaces: [] }
    let open = false
    const openListeners = new Set()
    const setOpen = (value) => {
      open = typeof value === 'boolean' ? value : !open
      openListeners.forEach((listener) => listener(open))
    }

    // --------------------------------------------------------- session 获取
    // 权威 session 来源是 `sessions` 服务的响应式 store；头插槽是次要兜底。
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
      }
      try { if (sessionsService.list && typeof sessionsService.list.subscribe === 'function') sessionsService.list.subscribe(handler) } catch (e) { /* noop */ }
      try { if (sessionsService.selection && typeof sessionsService.selection.subscribe === 'function') sessionsService.selection.subscribe(handler) } catch (e) { /* noop */ }
    }

    // ------------------------------------------- 入口：工作区行按钮 + 侧栏兜底
    function workspacePathFromLabel(label) {
      const text = String(label == null ? '' : label).trim().replace(/\/+$/, '')
      if (!text) return null
      if (text.startsWith('/')) return text
      const workspaces = S.workspaces || []
      const tail = text.split('/').pop()
      const byTail = workspaces.find((w) => String(w.path || '').replace(/\/+$/, '').split('/').pop() === tail)
      if (byTail) return byTail.path
      const byExact = workspaces.find((w) => w.path === text || w.title === text)
      return byExact ? byExact.path : null
    }
    function installWorkspaceRowButtons() {
      const rows = Array.from(document.querySelectorAll(WS_ROW_SELECTOR))
      for (const row of rows) {
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
          const path = workspacePathFromLabel(label)
          if (path) S.workspaceTarget = path
          setOpen(true)
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
        setOpen(true)
      })
      sidebar.appendChild(btn)
      sidebarEntryBtn = btn
    }

    // -------------------------------------------------- 会话列覆盖层 clamp
    function rectOf(selector) {
      const node = document.querySelector(selector)
      if (!node) return null
      const r = node.getBoundingClientRect()
      return (r.width > 80 && r.height > 80) ? r : null
    }
    function columnBox() {
      for (const selector of COLUMN_CANDIDATES) {
        const r = rectOf(selector)
        if (r && r.width < window.innerWidth * 0.98) return { top: r.top, left: r.left, width: r.width, height: r.height }
      }
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
      for (const selector of SIDEBAR_CANDIDATES) {
        const r = rectOf(selector)
        if (r) return { top: 0, left: r.right, width: Math.max(0, window.innerWidth - r.right), height: window.innerHeight }
      }
      return { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight }
    }
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

    // ------------------------------------------------------------------ apply
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      sessionsService = ctx.get('sessions') || null
      wireSessionSync()
      const inject = (name, options, render) => slots.inject(name, () => slots.register(options, render))
      return ctx.effect(() => {
        let styleEl = null
        let host = null
        let lastSessionId = null
        let boardMounted = false
        let disposeBoard = null

        const ensureStyle = () => {
          if (styleEl) return
          styleEl = document.createElement('style')
          styleEl.setAttribute('data-spkb-takeover', '')
          styleEl.textContent = HIDE_CSS
          ;(document.head || document.documentElement).appendChild(styleEl)
        }

        const ensureHost = () => {
          if (host && host.isConnected) return host
          host = document.createElement('div')
          host.setAttribute('data-spkb-host', '')
          host.setAttribute('data-spkb-plugin', PANEL_NAME)
          host.style.pointerEvents = 'auto'
          host.style.display = 'none'
          document.body.appendChild(host)
          clampHost(host)
          return host
        }

        // 从主通道加载 React 工作台 bundle（持久化路由，不依赖动态插件）。
        const loadBoardBundle = async () => {
          if (window.__SPKB_BOARD__ && typeof window.__SPKB_BOARD__.mount === 'function') return
          const response = await window.fetch(BOARD_URL)
          if (!response.ok) throw new Error(`工作台 bundle 加载失败（HTTP ${response.status}）`)
          const code = await response.text()
          const script = document.createElement('script')
          script.textContent = code
          ;(document.head || document.documentElement).appendChild(script)
          script.remove()
          if (!window.__SPKB_BOARD__ || typeof window.__SPKB_BOARD__.mount !== 'function') {
            throw new Error('工作台 bundle 未暴露 __SPKB_BOARD__.mount')
          }
        }

        const showBoard = async () => {
          const h = ensureHost()
          h.style.display = 'block'
          clampHost(h)
          try {
            await loadBoardBundle()
            if (!boardMounted) {
              const sid = S.sessionId || lastSessionId || readSessionIdFromServices()
              S.sessionId = sid
              boardMounted = true
              disposeBoard = window.__SPKB_BOARD__.mount(h, {
                getSessionId: () => S.sessionId || lastSessionId || readSessionIdFromServices(),
                requestExit: () => setOpen(false),
                initialWorkspace: S.workspaceTarget || null
              })
            }
          } catch (error) {
            // 在面板内展示错误，无需 DevTools。
            try {
              h.innerHTML = ''
              const box = document.createElement('div')
              box.style.cssText = 'height:100%;overflow:auto;padding:18px;color:#f3a9a9;font:12px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap;background:#151a20'
              box.textContent = `[speckit-workflow] 工作台初始化失败:\n${(error && error.stack) || error}`
              h.appendChild(box)
            } catch (e) { /* noop */ }
            console.error('[speckit-workflow] board mount failed', error)
          }
        }

        const hideBoard = () => { if (host && host.isConnected) host.style.display = 'none' }

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

        const setBoardVisible = (value) => { if (value) void showBoard(); else hideBoard() }

        const onResize = () => { if (host && host.isConnected) clampHost(host) }
        window.addEventListener('resize', onResize)
        const onOtherActivate = (event) => { if (event.detail !== PANEL_NAME && open) setOpen(false) }
        const onClickSidebarRow = (event) => {
          if (!open) return
          // 工作区行注入的「看板」按钮是入口，不关闭看板。
          if (event.target && event.target.closest('[data-spkb-ws]')) return
          const target = event.target
          if (target && target.closest('[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]')) setOpen(false)
        }

        const onOpenChange = (value) => {
          ensureStyle()
          applyActive(value)
          if (value) {
            const sid = readSessionIdFromServices()
            if (sid) S.sessionId = sid
            else if (lastSessionId) S.sessionId = lastSessionId
          }
          setBoardVisible(value)
        }
        openListeners.add(onOpenChange)
        document.addEventListener('click', onClickSidebarRow, true)
        document.addEventListener(ACTIVATE_EVENT, onOtherActivate)

        // 会话头插槽只喂 sessionId（入口在工作区行/侧栏），不渲染任何内容。
        const disposeHeader = inject(
          'conversation.session.header.actions',
          { name: 'conversation.session.header.actions', id: 'speckit-board-header', order: 20, label: () => 'Spec 流水线看板' },
          (props) => {
            const sid = props && (props.sessionId || (props.useSession && props.useSession((s) => (s && s.id) || undefined)))
            if (sid) { lastSessionId = sid; S.sessionId = sid }
            return null
          }
        )

        installWorkspaceRowObserver()

        return () => {
          openListeners.delete(onOpenChange)
          document.removeEventListener('click', onClickSidebarRow, true)
          document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
          window.removeEventListener('resize', onResize)
          document.documentElement.removeAttribute(ACTIVE_ATTR)
          if (disposeBoard) { try { disposeBoard() } catch (e) { /* noop */ } disposeBoard = null }
          if (host) { host.remove(); host = null }
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
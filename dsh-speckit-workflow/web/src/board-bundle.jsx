// dsh 插件专用入口（iife bundle）。
// 由动态 Cordis 插件 / 最终发布的插件 client 加载，暴露：
//   window.__SPKB_BOARD__.mount(container, { getSessionId, requestExit })
// 组件树 1:1 使用 App.jsx（照 web 原型复刻），RPC 切到真实宿主。

import React from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { antdConfig } from './theme/antd.js'
import App from './App.jsx'
import { useRealHostTransport, setExitBoardHandler } from './api/index.js'
import boardsCss from './styles/boards.scoped.css?inline'

let cssTag = null
function ensureCss() {
  if (cssTag) return
  cssTag = document.createElement('style')
  cssTag.setAttribute('data-spkb-board-css', '')
  cssTag.textContent = boardsCss
  document.head.appendChild(cssTag)
}

let root = null

export function mount(container, deps = {}) {
  if (!container) throw new Error('mount 需要容器元素')
  ensureCss()
  if (typeof deps.getSessionId === 'function') useRealHostTransport(deps.getSessionId)
  setExitBoardHandler(typeof deps.requestExit === 'function' ? deps.requestExit : null)

  if (!root) root = createRoot(container)
  root.render(
    <ConfigProvider theme={antdConfig} getPopupContainer={() => container}>
      <App initialWorkspace={(deps && deps.initialWorkspace) || null} />
    </ConfigProvider>
  )

  return () => {
    if (root) {
      root.unmount()
      root = null
    }
  }
}

if (typeof window !== 'undefined') {
  window.__SPKB_BOARD__ = { mount }
}
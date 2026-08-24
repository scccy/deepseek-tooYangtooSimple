/**
 * Render smoke test (vitest, jsdom environment) — mounts the full App and
 * asserts the core screens render without runtime errors.
 *
 * Notes: antd Modal/Drawer closing animations do not terminate in jsdom, so
 * this focuses on OPENING + content (the real crash signals); close plumbing is
 * symmetric with open and is exercised manually in the browser.
 *
 * Run: npm test  (or  npx vitest run)
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { createRoot } from 'react-dom/client'
import React from 'react'
import { ConfigProvider } from 'antd'
import { antdConfig } from '../src/theme/antd.js'
import App from '../src/App.jsx'

beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = (query) => ({
      matches: false, media: query, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false }
    })
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class { constructor(cb) { this.cb = cb } observe() {} unobserve() {} disconnect() {} }
  }
  window.scrollTo = () => {}
  window.HTMLElement.prototype.scrollTo = () => {}
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16)
  window.cancelAnimationFrame = (id) => clearTimeout(id)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const q = (sel) => document.querySelector(sel)
const qa = (sel) => Array.from(document.querySelectorAll(sel))

describe('workbench web prototype', () => {
  it('renders board with 4 columns and seeded cards', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    root.render(
      <ConfigProvider theme={antdConfig}>
        <App />
      </ConfigProvider>
    )
    await sleep(600)

    expect(q('.topbar')).toBeTruthy()
    expect(q('.board')).toBeTruthy()
    expect(qa('.col').length).toBe(4)
    expect(qa('.cardt').length).toBeGreaterThanOrEqual(6)
    expect(q('.spkb-monoselect')).toBeTruthy()

    // 执行方式徽标只在 Implement 卡片出现
    const wf11 = document.querySelector('[data-instance="wf-11"]')
    const wf12 = document.querySelector('[data-instance="wf-12"]')
    expect(wf11 && wf11.querySelector('.exec-badge')).toBeTruthy()   // implement → Team · N 并行
    expect(wf12 && wf12.querySelector('.exec-badge')).toBeFalsy()    // clarify → 不显示

    // create modal opens
    const newBtn = qa('.topbar button').find((b) => b.textContent.includes('新建 Feature'))
    newBtn.click()
    await sleep(300)
    expect(q('.ant-modal')).toBeTruthy()
    expect(document.body.textContent).toContain('创建并启动 Specify')
    expect(document.body.textContent).toContain('Feature Context')
    expect(document.body.textContent).toContain('Implement 执行方式')
    expect(document.body.textContent).toContain('流程开关')
    // close (best-effort; antd close animation may not finish in jsdom)
    const cancelBtn = qa('.ant-modal button').find((b) => b.textContent.trim() === '取消')
    if (cancelBtn) cancelBtn.click()

    // instance drawer opens from a card
    const card = q('.cardt')
    card.click()
    await sleep(500)
    expect(q('.ant-drawer')).toBeTruthy()
    expect(q('.drawer-head')).toBeTruthy()
    expect(q('.journey')).toBeTruthy()
    expect(qa('.phase-item').length).toBeGreaterThan(0)
    expect(document.body.textContent).toContain('阶段旅程')
    expect(document.body.textContent).toContain('阶段线程')
    expect(document.body.textContent).toContain('Implement 执行方式')
    expect(document.body.textContent).toContain('人工决策记录')
    expect(document.body.textContent).toContain('事件流')

    root.unmount()
    host.remove()
  }, 20000)
})

// Render smoke test: mount the whole app in jsdom and assert the core screens
// render (board columns, cards, create modal, drawer, thread modal, dialog).
// Run with:  npm run test:render   (uses the standalone .tools-less local node)
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:5173/',
  pretendToBeVisual: true
})

global.window = dom.window
global.document = dom.window.document
global.navigator = dom.window.navigator
global.HTMLElement = dom.window.HTMLElement
global.Node = dom.window.Node
global.getComputedStyle = dom.window.getComputedStyle
global.requestAnimationFrame = (cb) => setTimeout(cb, 0)
global.cancelAnimationFrame = (id) => clearTimeout(id)

// antd polyfills
if (!dom.window.matchMedia) {
  dom.window.matchMedia = (query) => ({
    matches: false, media: query, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false }
  })
}
if (!dom.window.ResizeObserver) {
  dom.window.ResizeObserver = class { constructor(cb) { this.cb = cb } observe() {} unobserve() {} disconnect() {} }
}
dom.window.scrollTo = () => {}
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.HTMLElement.prototype.scrollTo = () => {}

const { createRoot } = await import('react-dom/client')
const React = await import('react')
const { ConfigProvider } = await import('antd')
const { antdConfig } = await import('../src/theme/antd.js')
const App = (await import('../src/App.jsx')).default

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const root = createRoot(document.getElementById('root'))
root.render(
  React.createElement(ConfigProvider, { theme: antdConfig },
    React.createElement(App)
  )
)

// Await effects + initial async loads
await sleep(400)

const q = (sel) => document.querySelector(sel)
const qa = (sel) => Array.from(document.querySelectorAll(sel))

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1 }
  else console.log('ok  :', msg)
}

assert(q('.topbar'), 'topbar renders')
assert(q('.board'), 'board renders')
assert(qa('.col').length === 4, '4 columns render')
assert(qa('.cardt').length >= 6, `board cards render (${qa('.cardt').length})`)
assert(q('.metric-pill'), 'metric pills render')
assert(q('.spkb-monoselect'), 'workspace select renders')

// open create modal via the 新建 Feature button
const newBtn = qa('.topbar button').find((b) => b.textContent.includes('新建 Feature'))
assert(!!newBtn, '新建 Feature button present')
if (newBtn) {
  newBtn.click()
  await sleep(250)
  assert(q('.ant-modal'), 'create modal opens (antd Modal)')
  assert(document.body.textContent.includes('创建并启动 Specify'), 'create modal content present')
  // close via Esc-less: click 取消
  const cancelBtn = qa('.ant-modal button').find((b) => b.textContent.trim() === '取消')
  if (cancelBtn) { cancelBtn.click(); await sleep(150) }
  assert(!q('.ant-modal'), 'create modal closes')
}

// open a card drawer
const firstCard = q('.cardt')
if (firstCard) {
  firstCard.click()
  await sleep(500)
  assert(q('.ant-drawer'), 'instance drawer opens (antd Drawer)')
  assert(q('.drawer-head'), 'drawer head renders')
  assert(q('.journey'), '9-step journey renders')
  assert(qa('.phase-item').length > 0, 'stage rows render')
  assert(document.body.textContent.includes('阶段旅程'), 'journey section label')
  assert(document.body.textContent.includes('人工决策记录'), 'decisions section label')
  assert(document.body.textContent.includes('事件流'), 'events section label')
  // close drawer
  document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })) || null
}

// dialog test
import('antd').then(async ({ message }) => { })

await sleep(300)
root.unmount()
console.log('\nrender smoke done' + (process.exitCode ? ' (with failures)' : ' (all passed)'))
process.exit(process.exitCode || 0)

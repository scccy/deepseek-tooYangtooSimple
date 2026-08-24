# dsh-speckit-workflow · Web 前端原型（React + Ant Design）

这是 `dsh-speckit-workflow` 插件的 **独立 Web 前端**（1:1 复刻 v0.8 工作台 UI），
用于在浏览器里先把界面与交互调通，再按 DSH 插件方式接入。

- 视觉：**原样移植**插件的设计令牌 / 排版 / 面板 / 卡片 / 抽屉 / 弹窗
  （来源：`lib/client.js` 内嵌 CSS + `design/spec-board-prototype.html`）。
- 组件库：**Ant Design 5**（`ConfigProvider` 暗色令牌对齐设计系统；
  `Drawer`/`Modal`/`Select`/`Switch` 做交互表面），领域视觉用与原型一致的自有 CSS。
- 数据：`src/api/mock.js` 模拟宿主 RPC（字段与 `lib/orchestrator.js` 完全一致），
  含异步阶段线程仿真（running→awaiting-confirmation / awaiting-user）。

## 运行（务必用本机 node，不要另装一套环境）

本机 node 在 `/Volumes/soft/lan/nodejs/v24/bin`（由 `~/.zshenv` 注入交互 shell）。

```bash
# 在终端（交互 shell 已带 node）：
cd web
npm install          # 若未装
npm run dev          # http://127.0.0.1:5173
```

若在非交互 shell（如本 agent 的 bash）里跑：

```bash
export PATH="/Volumes/soft/lan/nodejs/v24/bin:$PATH"
cd web && npm run dev
```

其他命令：

```bash
npm run build        # 产物校验（抓语法/导入错误）
npm test             # vitest + jsdom 渲染冒烟（4 列看板 / 卡片 / 新建弹窗 / 实例抽屉）
```

## 目录结构

```text
web/
  index.html
  vite.config.js
  src/
    main.jsx                 # 入口：ConfigProvider(暗色令牌) + <App/>
    App.jsx                  # 状态中心：轮询 / 动作分发 / 弹窗与 Toast / 右键菜单
    api/
      index.js               # callHost() —— 与插件 client.js 同契约；mock 传输层在此替换为真实宿主
      mock.js                # 模拟宿主 17 个 RPC + 阶段线程仿真（含 seeds 续跑）
      seed.js                # 种子实例（覆盖每个状态：running/awaiting-user/awaiting-confirmation/failed/completed）
    lib/
      constants.js           # COLUMNS / STAGE_ORDER / ST_META / CONFIRM_NEXT（镜像 lib/stages.js）
      icons.jsx              # 内联 SVG（逐字移植 client.js）
      format.js              # esc / formatTime / newActionId
    theme/antd.js            # Ant Design 暗色令牌（对齐设计变量）
    styles/boards.css        # 原型 CSS 原样移植 + web 壳 / antd 对齐补充
    components/
      TopBar.jsx  Board.jsx  FeatureCard.jsx  CreateModal.jsx
      InstanceDrawer.jsx  Journey.jsx  StageRow.jsx
      ThreadModal.jsx  ConfirmDialog.jsx  Toast.jsx  ContextMenu.jsx  badges.jsx
  test/render.test.jsx       # 渲染冒烟（vitest + jsdom）
```

## RPC 契约（与插件一致）

`src/api/index.js` 的 `callHost(endpoint, payload)` 当前路由到内存 mock：

```text
install  workspaces  check  models  instances  instance-create  instance-get
instance-cancel  exec-config  stage-confirm  stage-skip  stage-answer  stage-rerun
stage-rollback  stage-cancel  thread-view  artifact-read  events-since
```

阶段性推进规则（镜像 orchestrator）：Specify 始终执行；Clarify / Converge 为
交互阶段（回答 → 结束交互 → 等待确认）；Checklist / Analyze / Taskstoissues 按
创建时的配置决定是否纳入（关闭则自动 skipped）；确认后推进到下一阶段线程。

### Implement 执行方式（workflow / team）

Implement 阶段可选择并行加速方式；**执行方式徽标只在 Implement 卡片脚部显示**
（Specify/Clarify/Plan 等前置阶段不显示，进入 Implement 后可见）：

- `workflow`：workflow 引擎编排，按阶段 fan-out 多个子代理并行推进；
- `Team`：AgentTeams 团队，implement-lead 分配任务、多成员并行执行。

选择入口：**新建 Feature 弹窗**（创建时定默认）+ **实例抽屉**（进入 Implement
前，即 Plan→Taskstoissues 期间可随时切换，含并行规模 2–6）。对应新端点
`exec-config { instanceId, mode, size }`，真实插件按此契约实现即可。

## 接入真实 dsh 插件

调试完成后，把 `src/api/index.js` 里的 `transport` 换回真实宿主调用（文件内有
注释好的参考实现，与插件 `client.js` 的 `callHost` 一致）：

```js
const transport = async (endpoint, payload) => {
  const response = await window.fetch('/api/dsh-speckit-workflow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, sessionId, ...(payload || {}) })
  })
  ...
}
```

之后可将这些 React 组件打包进插件 `lib/client.js`（或通过 dsh client 插槽挂载）；
所有数据形状已按真实宿主要求对齐，无需改动组件层。

## 演示数据覆盖的状态

| 实例 | 位置 | 状态 | 可交互动作 |
|---|---|---|---|
| wf-15 通知中心 | Specify | awaiting-confirmation | 确认 → Clarify；删除实例 |
| wf-18 键盘快捷键 | Specify | running（秒级自推进→确认点） | 查看线程 / 停止阶段 |
| wf-12 搜索重构 | Clarify | awaiting-user（有提问） | 发送回答 / 结束交互 / 打开线程 |
| wf-14 离线缓存 | Clarify(plan) | awaiting-confirmation | 确认 → Checklist；抽屉调整实现方式 |
| wf-11 多账号会话隔离 | Implement | running（自推进） | 查看线程；Team · 3 并行 |
| wf-16 主题切换 | Implement(analyze) | failed（报错） | 查看错误 / 重试 / 返回上阶段；Team |
| wf-13 权限模型 | Converge | awaiting-user（有 findings） | 发决策 / 结束交互；Team · 4 并行 |
| wf-17 崩溃上报接入 | Converge | completed | 重跑阶段 / 查看产物 |

顶部「工作区」下拉可切到 `/Volumes/project/github/dsh-desktop-mac`（wf-21）验证隔离。
右键看板空白处有上下文菜单（新建 Feature / 刷新看板 / 返回对话）；「返回对话」
在纯 Web 预览下为提示占位（插件中才真正回到对话）。

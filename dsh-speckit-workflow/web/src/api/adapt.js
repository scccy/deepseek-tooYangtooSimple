// dsh-speckit-workflow web → 真实宿主适配层。
//
// mock（src/api/mock.js）忠实复刻了「已确认」的看板数据形状；真实宿主
// lib/index.js 的投影有一个小差异集（exec 字段、已删除实例过滤、thread-view
// 的 snake_case stageRow）。这里把真实宿主响应归一化回 web 期望的形状，
// 让所有组件保持「照 web 原型 1:1」不动。

const EXEC_FALLBACK = Object.freeze({ mode: 'workflow', size: 3 })

// stageId → 看板列，与 mock projectCard / lib/stages.js COLUMNS 一致。
const STAGE_COLUMN = {
  specify: 'specify',
  clarify: 'clarify',
  plan: 'clarify',
  checklist: 'implement',
  tasks: 'implement',
  analyze: 'implement',
  taskstoissues: 'implement',
  implement: 'implement',
  converge: 'converge'
}

function withExec(card) {
  if (card && card.exec && typeof card.exec === 'object') return card
  return { ...(card || {}), exec: { ...EXEC_FALLBACK } }
}

// 真实宿主 board() 对无活动阶段的实例固定返回 column='specify'；
// 这里照 mock 的 columnOf 语义，用 currentStage（最远推进阶段）反推列。
function withColumn(card) {
  const column = STAGE_COLUMN[card.currentStage] || card.column
  return card.column === column ? card : { ...card, column }
}

export function adapt(endpoint, value) {
  if (value == null || typeof value !== 'object') return value
  switch (endpoint) {
    case 'instances': {
      const next = { ...value }
      if (Array.isArray(next.instances)) {
        // 「删除实例」＝卡片移除（确认过的交互）；cancelled 记录仅留作审计。
        next.instances = next.instances
          .filter((card) => card && card.status !== 'cancelled')
          .map(withExec)
          .map(withColumn)
      }
      return next
    }

    case 'instance-create': {
      // result 只含 instanceId/stageRowId/...；补 exec 默认值供紧随其后的
      // openInstance → refreshDetail 渲染（detail 走 instance-get 的适配）。
      return value
    }

    case 'instance-get': {
      const next = { ...value }
      if (next.instance) next.instance = withExec(next.instance)
      return next
    }

    case 'thread-view': {
      const next = { ...value }
      // 真实宿主 stageRow 为 sanitizeStage 的 snake_case（stage_id 等）；
      // web ThreadModal 读 stageRow.stageId。
      if (next.stageRow && !next.stageRow.stageId && next.stageRow.stage_id) {
        next.stageRow = { ...next.stageRow, stageId: next.stageRow.stage_id }
      }
      return next
    }

    default:
      return value
  }
}
/**
 * Mock host regression tests — guard "删除实例" at Specify (and any stage):
 * after instance-cancel the card must disappear from the board projection.
 * Run: npm test
 */
import { describe, expect, it } from 'vitest'
import { api as mock } from '../src/api/mock.js'

describe('mock host — 删除实例', () => {
  it('Specify 阶段的删除实例：卡片从看板移除', async () => {
    const ws = '/Volumes/project/github/dsh'
    const before = await mock.instances({ workspace: ws })
    const wf15 = before.instances.find((c) => c.instanceId === 'wf-15')
    expect(wf15).toBeTruthy()
    // wf-15 = Specify 列、awaiting-confirmation、有确认动作
    expect(wf15.column).toBe('specify')
    expect(wf15.currentStage).toBe('specify')
    expect(wf15.currentStageStatus).toBe('awaiting-confirmation')

    await mock.instanceCancel({ instanceId: 'wf-15' })

    const after = await mock.instances({ workspace: ws })
    expect(after.instances.find((c) => c.instanceId === 'wf-15')).toBeUndefined()

    // 实例本体保留（软删除），instance-get 仍可查、状态为 cancelled
    const detail = await mock.instanceGet({ instanceId: 'wf-15' })
    expect(detail.instance.status).toBe('cancelled')
  })

  it('running 阶段的删除实例（Specify 运行中）：卡片移除，工作区锁释放不影响其他卡片', async () => {
    const ws = '/Volumes/project/github/dsh'
    const before = await mock.instances({ workspace: ws })
    // wf-18 初始为 running；若被种子仿真推到了确认点也能删除（active 由查询求值）
    const wf18 = before.instances.find((c) => c.instanceId === 'wf-18')
    expect(wf18).toBeTruthy()

    await mock.instanceCancel({ instanceId: 'wf-18' })

    const after = await mock.instances({ workspace: ws })
    expect(after.instances.find((c) => c.instanceId === 'wf-18')).toBeUndefined()
    // 其余卡片仍在
    expect(after.instances.some((c) => c.instanceId === 'wf-12')).toBe(true)
  })

  it('Implement 执行方式：卡片投影与实例详情反映 workflow/team 及并行规模', async () => {
    const ws = '/Volumes/project/github/dsh'
    const before = await mock.instances({ workspace: ws })

    // 种子：wf-11 已配 team；其余未显式配置的默认 workflow
    expect(before.instances.find((c) => c.instanceId === 'wf-11').exec).toEqual({ mode: 'team', size: 3 })
    const wf14 = before.instances.find((c) => c.instanceId === 'wf-14')
    expect(wf14.exec).toEqual({ mode: 'workflow', size: 3 })

    const r = await mock.execConfig({ instanceId: 'wf-14', mode: 'team', size: 4 })
    expect(r.exec).toEqual({ mode: 'team', size: 4 })

    const after = await mock.instances({ workspace: ws })
    expect(after.instances.find((c) => c.instanceId === 'wf-14').exec).toEqual({ mode: 'team', size: 4 })

    const detail = await mock.instanceGet({ instanceId: 'wf-14' })
    expect(detail.instance.exec).toEqual({ mode: 'team', size: 4 })

    // 非法模式被拒绝
    await expect(mock.execConfig({ instanceId: 'wf-14', mode: 'solo', size: 3 })).rejects.toThrow()
  })
})

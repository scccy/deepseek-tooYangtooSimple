// Seed data — hand-authored initial instances for the mock host.
// Shapes mirror the real orchestrator projection (lib/orchestrator.js) and the
// stage rows produced by the plugin ledger, so swapping mock→real host is a drop-in.

const MIN = 60 * 1000
const ago = (m) => Date.now() - Math.round(m * MIN)

const sha = () =>
  Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')

// stage(id, stageId, attempt, status, extra) → stage row like the ledger
function stg({ id, stageId, attempt = 1, status, title, summary = '', skill = true, artifacts = [], state = null, error = null, staleReason = null, thread = [], at = 0 }) {
  return {
    id,
    stageId,
    attempt,
    status,
    title: title || stageId,
    summary,
    ...(skill ? { skillId: `speckit-${stageId}`, skillSha256: sha() } : { skillId: null, skillSha256: null }),
    artifacts,
    state,
    error,
    staleReason,
    thread,
    createdAt: at || ago(60),
    updatedAt: at || ago(40)
  }
}

const CLI = (name) => ({
  feature: name,
  featureDir: name,
  branch: null,
  worktreePath: null,
  mode: 'inplace',
  status: 'active'
})

function buildInstances() {
  const instances = []

  // ---------------------------------------------------------------- wf-11
  instances.push({
    instanceId: 'wf-11',
    workspacePath: '/Volumes/project/github/dsh',
    feature: '多账号会话隔离',
    featureDir: 'account-session-isolation',
    branch: 'feat/account-isolation',
    worktreePath: '/Volumes/project/github/dsh/.worktrees/account-isolation',
    mode: 'isolated',
    exec: { mode: 'team', size: 3 },
    status: 'active',
    currentStage: 'implement',
    config: { useWorktrees: true, runChecklist: true, runAnalyze: true, runTaskstoissues: false },
    createdAt: ago(420),
    updatedAt: ago(2),
    stageRows: [
      stg({ id: 1, stageId: 'specify', status: 'completed', attempt: 1, summary: 'spec.md 已生成并通过需求门禁', artifacts: [{ rel: 'specs/account-session-isolation/spec.md', stale: false }], at: ago(410) }),
      stg({ id: 2, stageId: 'clarify', status: 'completed', attempt: 1, summary: '澄清完成：会话隔离按用户维度，秒级生效', artifacts: [{ rel: 'specs/account-session-isolation/spec.md', stale: false }], at: ago(360) }),
      stg({ id: 3, stageId: 'plan', status: 'completed', attempt: 1, summary: 'plan.md 已生成，设计门禁通过', artifacts: [{ rel: 'plan.md', stale: false }, { rel: 'quickstart.md', stale: false }], at: ago(300) }),
      stg({ id: 4, stageId: 'checklist', status: 'completed', attempt: 1, summary: 'UX / 安全清单已生成', artifacts: [{ rel: 'checklists/DESIGN.md', stale: false }], at: ago(280) }),
      stg({ id: 5, stageId: 'tasks', status: 'completed', attempt: 1, summary: '按 P1/P2/P3 拆解 8 个任务', artifacts: [{ rel: 'tasks.md', stale: false }], at: ago(240) }),
      stg({ id: 6, stageId: 'analyze', status: 'completed', attempt: 1, summary: '一致性检查通过，无阻塞', at: ago(220) }),
      stg({ id: 7, stageId: 'taskstoissues', status: 'skipped', attempt: 1, summary: '配置未启用', at: ago(210) }),
      stg({
        id: 8, stageId: 'implement', status: 'running', attempt: 1,
        summary: '按 tasks.md 依赖顺序实现中',
        thread: [
          { who: 'agent', at: ago(2), text: '已读取 tasks.md，按 Setup → Tests → Core → Integration → Polish 顺序推进。' },
          { who: 'agent', at: ago(1.5), text: 'T002 存储层完成，switch_account 命令实现中…' }
        ],
        at: ago(8)
      })
    ],
    decisions: [
      { kind: 'created', targetStage: null, note: 'account-session-isolation', at: ago(420) },
      { kind: 'confirm', targetStage: 'clarify', note: null, at: ago(410) },
      { kind: 'end-interactive', targetStage: 'clarify', note: '多轮澄清完成', at: ago(362) },
      { kind: 'confirm', targetStage: 'plan', note: null, at: ago(360) },
      { kind: 'confirm', targetStage: 'checklist', note: null, at: ago(300) },
      { kind: 'confirm', targetStage: 'analyze', note: null, at: ago(280) },
      { kind: 'skip', targetStage: 'taskstoissues', note: '外部副作用关闭', at: ago(240) },
      { kind: 'confirm', targetStage: 'implement', note: null, at: ago(220) }
    ],
    events: [
      { seq: 1, type: 'instance-created', time: ago(420), data: { workspacePath: '/Volumes/project/github/dsh' } },
      { seq: 2, type: 'stage-awaiting-confirmation', time: ago(410), data: { stageId: 'specify' } },
      { seq: 3, type: 'stage-confirmed', time: ago(410), data: { stageId: 'specify' } },
      { seq: 4, type: 'stage-awaiting-user', time: ago(365), data: { stageId: 'clarify' } },
      { seq: 5, type: 'stage-awaiting-confirmation', time: ago(362), data: { stageId: 'clarify' } },
      { seq: 6, type: 'stage-confirmed', time: ago(360), data: { stageId: 'clarify' } },
      { seq: 7, type: 'stage-awaiting-confirmation', time: ago(300), data: { stageId: 'plan' } },
      { seq: 8, type: 'stage-confirmed', time: ago(300), data: { stageId: 'plan' } },
      { seq: 9, type: 'stage-confirmed', time: ago(280), data: { stageId: 'checklist' } },
      { seq: 10, type: 'stage-skipped', time: ago(240), data: { stageId: 'taskstoissues' } },
      { seq: 11, type: 'stage-confirmed', time: ago(220), data: { stageId: 'tasks' } },
      { seq: 12, type: 'stage-running', time: ago(8), data: { stageId: 'implement', attempt: 1 } }
    ]
  })

  // ---------------------------------------------------------------- wf-12
  const wf12Clarify = ['agent', 'user', 'agent']
  instances.push({
    instanceId: 'wf-12',
    workspacePath: '/Volumes/project/github/dsh',
    feature: '搜索重构',
    featureDir: 'search-refactor',
    branch: null,
    worktreePath: null,
    mode: 'inplace',
    exec: { mode: 'team', size: 3 },
    status: 'active',
    currentStage: 'clarify',
    config: { useWorktrees: false, runChecklist: true, runAnalyze: true, runTaskstoissues: false },
    createdAt: ago(300),
    updatedAt: ago(4),
    stageRows: [
      stg({ id: 1, stageId: 'specify', status: 'completed', attempt: 1, summary: 'spec.md 已生成并通过需求门禁', artifacts: [{ rel: 'specs/search-refactor/spec.md', stale: false }], at: ago(290) }),
      stg({
        id: 2, stageId: 'clarify', status: 'awaiting-user', attempt: 1,
        summary: '等待你回答',
        state: { status: 'asking', question: 'FR-「拼音首字母搜索」需要支持吗？默认忽略还是加入首字母索引？', assumptions: ['会话隔离按用户维度，秒级生效'] },
        thread: [
          { who: 'agent', at: ago(6), text: '已拆解出 3 条功能需求。FR-202「输入联想」有歧义：是仅前缀匹配还是包含子串匹配？' },
          { who: 'user', at: ago(5), text: '前缀匹配即可，子串匹配代价过高。' },
          { who: 'agent', at: ago(4.5), text: '已记录假设：前缀匹配 + 拼音首字母。还有两点待确认：1) 是否保留旧的模糊匹配？2) 搜索结果分页大小？' }
        ],
        at: ago(8)
      })
    ],
    decisions: [
      { kind: 'created', targetStage: null, note: 'search-refactor', at: ago(300) },
      { kind: 'confirm', targetStage: 'clarify', note: null, at: ago(290) }
    ],
    events: [
      { seq: 1, type: 'instance-created', time: ago(300), data: {} },
      { seq: 2, type: 'stage-confirmed', time: ago(290), data: { stageId: 'specify' } },
      { seq: 3, type: 'stage-awaiting-user', time: ago(6), data: { stageId: 'clarify' } }
    ]
  })

  // ---------------------------------------------------------------- wf-13
  instances.push({
    instanceId: 'wf-13',
    workspacePath: '/Volumes/project/github/dsh',
    feature: '权限模型',
    featureDir: 'permission-model',
    branch: 'feat/permissions',
    worktreePath: '/Volumes/project/github/dsh/.worktrees/permissions',
    mode: 'isolated',
    exec: { mode: 'team', size: 4 },
    status: 'active',
    currentStage: 'converge',
    config: { useWorktrees: true, runChecklist: true, runAnalyze: true, runTaskstoissues: false },
    createdAt: ago(1200),
    updatedAt: ago(3),
    stageRows: [
      stg({ id: 1, stageId: 'specify', status: 'completed', attempt: 1, summary: '通过', artifacts: [{ rel: 'specs/permission-model/spec.md', stale: false }], at: ago(1190) }),
      stg({ id: 2, stageId: 'clarify', status: 'completed', attempt: 1, summary: 'deny-by-default 已澄清', at: ago(1130) }),
      stg({ id: 3, stageId: 'plan', status: 'completed', attempt: 1, summary: '通过', artifacts: [{ rel: 'plan.md', stale: false }], at: ago(1070) }),
      stg({ id: 4, stageId: 'checklist', status: 'completed', attempt: 1, summary: '包含安全清单', artifacts: [{ rel: 'checklists/DESIGN.md', stale: false }], at: ago(1050) }),
      stg({ id: 5, stageId: 'tasks', status: 'completed', attempt: 1, summary: '12 个任务', artifacts: [{ rel: 'tasks.md', stale: false }], at: ago(1020) }),
      stg({ id: 6, stageId: 'analyze', status: 'completed', attempt: 1, summary: '通过', at: ago(1000) }),
      stg({ id: 7, stageId: 'taskstoissues', status: 'skipped', attempt: 1, summary: '配置未启用', at: ago(990) }),
      stg({ id: 8, stageId: 'implement', status: 'completed', attempt: 1, summary: '实现完成，合并后待收敛', artifacts: [{ rel: 'src/auth/roles.ts', stale: false }, { rel: 'tests/isolation.test.ts', stale: false }], at: ago(30) }),
      stg({
        id: 9, stageId: 'converge', status: 'awaiting-user', attempt: 1,
        summary: '待你决策',
        state: {
          status: 'findings',
          findings: [
            { severity: 'critical', kind: 'missing', title: 'spec SC-402「角色变更审计日志」未在代码中发现对应实现' },
            { severity: 'major', kind: 'partial', title: 'SC-411「多角色并存」只覆盖了角色 A，B/C 待补' }
          ]
        },
        thread: [
          { who: 'agent', at: ago(5), text: '对照 spec / plan / tasks 检查实现：' },
          { who: 'agent', at: ago(4.5), text: '发现 2 个缺口：[critical/missing] SC-402 审计日志缺失；[major/partial] SC-411 多角色并存未完整覆盖。' },
          { who: 'agent', at: ago(4), text: '输入决策：追加任务请回复任务内容；无遗留请回复 none。' }
        ],
        at: ago(6)
      })
    ],
    decisions: [
      { kind: 'created', targetStage: null, note: 'permission-model', at: ago(1200) },
      { kind: 'confirm', targetStage: 'clarify', note: null, at: ago(1190) },
      { kind: 'confirm', targetStage: 'plan', note: null, at: ago(1130) },
      { kind: 'confirm', targetStage: 'checklist', note: null, at: ago(1070) },
      { kind: 'confirm', targetStage: 'analyze', note: null, at: ago(1050) },
      { kind: 'confirm', targetStage: 'implement', note: null, at: ago(1020) },
      { kind: 'confirm', targetStage: 'converge', note: null, at: ago(1000) }
    ],
    events: [
      { seq: 1, type: 'instance-created', time: ago(1200), data: {} },
      { seq: 2, type: 'stage-confirmed', time: ago(1190), data: { stageId: 'specify' } },
      { seq: 3, type: 'stage-awaiting-user', time: ago(6), data: { stageId: 'converge', findings: 2 } }
    ]
  })

  // ---------------------------------------------------------------- wf-14
  instances.push({
    instanceId: 'wf-14',
    workspacePath: '/Volumes/project/github/dsh',
    feature: '离线缓存',
    featureDir: 'offline-cache',
    branch: null,
    worktreePath: null,
    mode: 'inplace',
    status: 'active',
    currentStage: 'plan',
    config: { useWorktrees: false, runChecklist: true, runAnalyze: true, runTaskstoissues: false },
    createdAt: ago(200),
    updatedAt: ago(3),
    stageRows: [
      stg({ id: 1, stageId: 'specify', status: 'completed', attempt: 1, summary: '通过', artifacts: [{ rel: 'specs/offline-cache/spec.md', stale: false }], at: ago(190) }),
      stg({ id: 2, stageId: 'clarify', status: 'completed', attempt: 1, summary: '离线窗口 7 天已澄清', at: ago(160) }),
      stg({
        id: 3, stageId: 'plan', status: 'awaiting-confirmation', attempt: 1,
        summary: '设计完成，等待确认进入 Checklist',
        artifacts: [{ rel: 'plan.md', stale: false }, { rel: 'quickstart.md', stale: false }],
        at: ago(6)
      })
    ],
    decisions: [
      { kind: 'created', targetStage: null, note: 'offline-cache', at: ago(200) },
      { kind: 'confirm', targetStage: 'clarify', note: null, at: ago(190) },
      { kind: 'end-interactive', targetStage: 'clarify', note: '澄清完成', at: ago(162) },
      { kind: 'confirm', targetStage: 'plan', note: null, at: ago(160) }
    ],
    events: [
      { seq: 1, type: 'instance-created', time: ago(200), data: {} },
      { seq: 2, type: 'stage-confirmed', time: ago(190), data: { stageId: 'specify' } },
      { seq: 3, type: 'stage-awaiting-confirmation', time: ago(6), data: { stageId: 'plan' } }
    ]
  })

  // ---------------------------------------------------------------- wf-15
  instances.push({
    instanceId: 'wf-15',
    workspacePath: '/Volumes/project/github/dsh',
    feature: '通知中心',
    featureDir: 'notification-center',
    branch: null,
    worktreePath: null,
    mode: 'inplace',
    status: 'active',
    currentStage: 'specify',
    config: { useWorktrees: false, runChecklist: true, runAnalyze: true, runTaskstoissues: false },
    createdAt: ago(40),
    updatedAt: ago(5),
    stageRows: [
      stg({
        id: 1, stageId: 'specify', status: 'awaiting-confirmation', attempt: 1,
        summary: '需求已生成，等待确认进入 Clarify',
        artifacts: [{ rel: 'specs/notification-center/spec.md', stale: false }],
        thread: [
          { who: 'agent', at: ago(6), text: '读取 feature 描述，生成短名称并创建 feature 目录。' },
          { who: 'agent', at: ago(5.5), text: '填充用户场景、功能需求、成功标准，写入 spec.md。' },
          { who: 'agent', at: ago(5), text: '内置 requirements.md 校验：14/15 通过，1 项待澄清。' }
        ],
        at: ago(8)
      })
    ],
    decisions: [{ kind: 'created', targetStage: null, note: 'notification-center', at: ago(40) }],
    events: [
      { seq: 1, type: 'instance-created', time: ago(40), data: {} },
      { seq: 2, type: 'stage-awaiting-confirmation', time: ago(5), data: { stageId: 'specify' } }
    ]
  })

  // ---------------------------------------------------------------- wf-16 (failed analyze)
  instances.push({
    instanceId: 'wf-16',
    workspacePath: '/Volumes/project/github/dsh',
    feature: '主题切换',
    featureDir: 'theme-switching',
    branch: null,
    worktreePath: null,
    mode: 'inplace',
    exec: { mode: 'team', size: 3 },
    status: 'active',
    currentStage: 'analyze',
    config: { useWorktrees: true, runChecklist: true, runAnalyze: true, runTaskstoissues: false },
    createdAt: ago(80),
    updatedAt: ago(2),
    stageRows: [
      stg({ id: 1, stageId: 'specify', status: 'completed', attempt: 1, summary: '通过', artifacts: [{ rel: 'specs/theme-switching/spec.md', stale: false }], at: ago(75) }),
      stg({ id: 2, stageId: 'clarify', status: 'completed', attempt: 1, summary: '通过', at: ago(60) }),
      stg({ id: 3, stageId: 'plan', status: 'completed', attempt: 1, summary: '通过', at: ago(45) }),
      stg({ id: 4, stageId: 'checklist', status: 'completed', attempt: 1, summary: '含可访问性清单', artifacts: [{ rel: 'checklists/DESIGN.md', stale: false }], at: ago(40) }),
      stg({ id: 5, stageId: 'tasks', status: 'completed', attempt: 1, summary: '6 个任务', artifacts: [{ rel: 'tasks.md', stale: false }], at: ago(30) }),
      stg({
        id: 6, stageId: 'analyze', status: 'failed', attempt: 1,
        summary: '一致性检查失败',
        error: 'tasks.md 未覆盖 spec FR-007「缓存失效后回源」的验证任务；SC-300 暗色对比度无对应用例',
        thread: [
          { who: 'agent', at: ago(2.5), text: '只读检查 spec × plan × tasks 的重复、矛盾、遗漏…' },
          { who: 'agent', at: ago(2), text: '发现 2 个阻塞问题，标记 analyze 失败。' }
        ],
        at: ago(3)
      })
    ],
    decisions: [
      { kind: 'created', targetStage: null, note: 'theme-switching', at: ago(80) },
      { kind: 'confirm', targetStage: 'clarify', note: null, at: ago(75) },
      { kind: 'confirm', targetStage: 'plan', note: null, at: ago(60) },
      { kind: 'confirm', targetStage: 'analyze', note: null, at: ago(45) }
    ],
    events: [
      { seq: 1, type: 'instance-created', time: ago(80), data: {} },
      { seq: 2, type: 'stage-failed', time: ago(2), data: { stageId: 'analyze', error: true } }
    ]
  })

  // ---------------------------------------------------------------- wf-17 (completed)
  instances.push({
    instanceId: 'wf-17',
    workspacePath: '/Volumes/project/github/dsh',
    feature: '崩溃上报接入',
    featureDir: 'crash-reporting',
    branch: 'feat/crash-reporting',
    worktreePath: '/Volumes/project/github/dsh/.worktrees/crash-reporting',
    mode: 'isolated',
    status: 'completed',
    currentStage: 'converge',
    config: { useWorktrees: true, runChecklist: true, runAnalyze: true, runTaskstoissues: false },
    createdAt: ago(6000),
    updatedAt: ago(1200),
    stageRows: [
      stg({ id: 1, stageId: 'specify', status: 'completed', attempt: 2, summary: '首次驳回后重做通过', artifacts: [{ rel: 'specs/crash-reporting/spec.md', stale: false }], at: ago(5000) }),
      stg({ id: 2, stageId: 'clarify', status: 'completed', attempt: 1, summary: '通过', at: ago(4800) }),
      stg({ id: 3, stageId: 'plan', status: 'completed', attempt: 1, summary: '通过', at: ago(4600) }),
      stg({ id: 4, stageId: 'checklist', status: 'completed', attempt: 1, summary: '通过', at: ago(4400) }),
      stg({ id: 5, stageId: 'tasks', status: 'completed', attempt: 1, summary: '通过', at: ago(4200) }),
      stg({ id: 6, stageId: 'analyze', status: 'completed', attempt: 1, summary: '通过', at: ago(4000) }),
      stg({ id: 7, stageId: 'taskstoissues', status: 'skipped', attempt: 1, summary: '外部副作用关闭', at: ago(3800) }),
      stg({ id: 8, stageId: 'implement', status: 'completed', attempt: 1, summary: '实现完成', at: ago(2000) }),
      stg({ id: 9, stageId: 'converge', status: 'completed', attempt: 1, summary: '收敛无遗留，已确认结束', artifacts: [{ rel: 'converge-report.md', stale: false }], at: ago(1200) })
    ],
    decisions: [
      { kind: 'created', targetStage: null, note: 'crash-reporting', at: ago(6000) },
      { kind: 'reject', targetStage: 'specify', note: '成功标准不完整，驳回重做', at: ago(5200) },
      { kind: 'confirm', targetStage: 'clarify', note: null, at: ago(5000) },
      { kind: 'converged', targetStage: 'converge', note: '确认收敛并结束', at: ago(1200) }
    ],
    events: [
      { seq: 1, type: 'instance-created', time: ago(6000), data: {} },
      { seq: 2, type: 'stage-rerun', time: ago(5200), data: { stageId: 'specify', attempt: 2 } },
      { seq: 3, type: 'instance-completed', time: ago(1200), data: {} }
    ]
  })

  // ---------------------------------------------------------------- wf-18 (running specify)
  instances.push({
    instanceId: 'wf-18',
    workspacePath: '/Volumes/project/github/dsh',
    feature: '键盘快捷键',
    featureDir: 'keyboard-shortcuts',
    branch: null,
    worktreePath: null,
    mode: 'inplace',
    status: 'active',
    currentStage: 'specify',
    config: { useWorktrees: false, runChecklist: true, runAnalyze: true, runTaskstoissues: false },
    createdAt: ago(1),
    updatedAt: ago(0.2),
    stageRows: [
      stg({
        id: 1, stageId: 'specify', status: 'running', attempt: 1,
        summary: 'Specify 线程执行中',
        thread: [
          { who: 'agent', at: ago(0.5), text: '读取 feature 描述「为工作台增加键盘快捷键导航」，创建 feature 目录…' },
          { who: 'agent', at: ago(0.2), text: '正在填充用户场景与功能需求…' }
        ],
        at: ago(1)
      })
    ],
    decisions: [{ kind: 'created', targetStage: null, note: 'keyboard-shortcuts', at: ago(1) }],
    events: [
      { seq: 1, type: 'instance-created', time: ago(1), data: {} },
      { seq: 2, type: 'stage-running', time: ago(0.5), data: { stageId: 'specify', attempt: 1 } }
    ]
  })

  // ---------------------------------------------------------------- wf-21 (other workspace)
  instances.push({
    instanceId: 'wf-21',
    workspacePath: '/Volumes/project/github/dsh-desktop-mac',
    feature: '桌面端多账户切换',
    featureDir: 'desktop-multi-account',
    branch: null,
    worktreePath: null,
    mode: 'inplace',
    exec: { mode: 'team', size: 3 },
    status: 'active',
    currentStage: 'clarify',
    config: { useWorktrees: true, runChecklist: true, runAnalyze: true, runTaskstoissues: false },
    createdAt: ago(90),
    updatedAt: ago(3),
    stageRows: [
      stg({ id: 1, stageId: 'specify', status: 'completed', attempt: 1, summary: '通过', artifacts: [{ rel: 'specs/desktop-multi-account/spec.md', stale: false }], at: ago(80) }),
      stg({
        id: 2, stageId: 'clarify', status: 'awaiting-user', attempt: 1,
        summary: '等待你回答',
        state: { status: 'asking', question: '切换账户时，会话与未提交草稿如何处理？保留在各自账户还是统一丢弃？' },
        thread: [
          { who: 'agent', at: ago(4), text: '已拆解出 2 条功能需求。FR-1「安全退出」与 FR-2「账户数据隔离」需要确认边界。' },
          { who: 'agent', at: ago(3.5), text: '问题：切换账户时，会话与未提交草稿如何处理？' }
        ],
        at: ago(5)
      })
    ],
    decisions: [
      { kind: 'created', targetStage: null, note: 'desktop-multi-account', at: ago(90) },
      { kind: 'confirm', targetStage: 'clarify', note: null, at: ago(80) }
    ],
    events: [
      { seq: 1, type: 'instance-created', time: ago(90), data: {} },
      { seq: 2, type: 'stage-awaiting-user', time: ago(4), data: { stageId: 'clarify' } }
    ]
  })

  return instances
}

export const PROJECTS = [
  { path: '/Volumes/project/github/dsh', title: 'dsh', ready: true, issues: [] },
  { path: '/Volumes/project/github/dsh-desktop-mac', title: 'dsh-desktop-mac', ready: true, issues: [] },
  { path: '/Volumes/project/github/dsh-openai-codex-oauth', title: 'dsh-openai-codex-oauth', ready: false, issues: ['缺少 .specify 骨架'] }
]

export const CWD = '/Volumes/project/github/dsh'

export { buildInstances, ago }

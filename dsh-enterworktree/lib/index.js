// dsh-enterworktree v0.1 — DSH 版 /enterworktree。
//
// Claude Code 的 EnterWorktree 会：创建（或复用）一个 git worktree，并把 agent
// "切换" 进去。DSH 的 session.cwd 是只读的，不能原地改当前 session 的工作目录，
// 所以本插件用等价做法：在 worktree 路径开一个全新的隔离 session，并把 sessionId
// 返回给你，让你在 Web GUI 里打开它（或在终端 cd 进去）。
//
// 工具在 Host 进程里通过 ctx.tools.register(defineTool(...)) 注册——与
// dsh-speckit-workflow 的注册方式一致。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve, basename, dirname } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)

const TOOL_NAME = 'enter_worktree'

// ---- git helpers -----------------------------------------------------------

async function runGit(root, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      maxBuffer: 16 * 1024 * 1024,
    })
    return { ok: true, stdout: String(stdout).trim() }
  } catch (error) {
    return {
      ok: false,
      error: String((error && error.stderr) || error.message || error),
    }
  }
}

async function isGitRepo(root) {
  const result = await runGit(root, ['rev-parse', '--show-toplevel'])
  return result.ok
}

async function listWorktrees(root) {
  const result = await runGit(root, ['worktree', 'list', '--porcelain'])
  if (!result.ok) return []
  const paths = []
  let current = null
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim()
    else if (line === '') {
      if (current) paths.push(current)
      current = null
    }
  }
  if (current) paths.push(current)
  return paths
}

async function branchExists(root, branch) {
  const result = await runGit(root, ['show-ref', '--verify', `refs/heads/${branch}`])
  return result.ok
}

async function ensureGitignore(root, dirName) {
  const gitignore = join(root, '.gitignore')
  let content = ''
  try {
    content = await readFile(gitignore, 'utf8')
  } catch {
    content = ''
  }
  if (content.split('\n').some((l) => l.trim() === dirName)) return
  const entry = content.length === 0 || content.endsWith('\n') ? `${dirName}\n` : `\n${dirName}\n`
  await appendFile(gitignore, entry)
}

// ---- session open ----------------------------------------------------------

async function openSessionAt(ctx, cwd) {
  const remote = ctx.remote && ctx.remote.session
  if (!remote || typeof remote.create !== 'function') {
    return { opened: false, reason: 'ctx.remote.session 不可用（需 dsh-api-remotes 提供）' }
  }
  try {
    const value = await remote.create({ cwd })
    return { opened: true, sessionId: value.sessionId, agentPreset: value.agentPreset }
  } catch (error) {
    return { opened: false, reason: String((error && error.message) || error) }
  }
}

// ---- main plugin -----------------------------------------------------------

export function apply(ctx) {
  const config = {
    layout: ctx.config && ctx.config.layout === 'sibling' ? 'sibling' : 'nested',
    dotworktreesDir: (ctx.config && ctx.config.dotworktreesDir) || '.worktrees',
    autoOpenSession: ctx.config ? ctx.config.autoOpenSession !== false : true,
  }

  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description:
        'DSH 版 /enterworktree：创建（或复用）一个 git worktree，并在该 worktree 路径开一个隔离 session，' +
        '让你在隔离目录里改代码而不碰主 checkout。DSH 的 session 工作目录只读，无法原地切换，' +
        '所以"进入"等价于开一个指向 worktree 的新 session——返回 sessionId 与路径供你在 Web GUI 打开。',
      parameters: {
        branch: {
          type: 'string',
          description:
            '新 worktree 的分支名。省略则自动生成 wt/<timestamp>。已存在的本地分支会直接 attach 到它。',
        },
        base: {
          type: 'string',
          description: '从该 ref 切出新分支的基点，默认 HEAD。',
        },
        path: {
          type: 'string',
          description: '显式指定 worktree 绝对路径；提供后忽略 layout 配置。',
        },
        layout: {
          type: 'string',
          description: "'nested'（仓库内 .worktrees/<branch>）或 'sibling'（../<repo>--<branch>）；缺省用插件配置。",
        },
        openSession: {
          type: 'boolean',
          description: '是否在 worktree 路径开一个隔离 session，默认 true（可由插件配置关闭）。',
        },
        inPlace: {
          type: 'boolean',
          description: '为 true 时不创建 worktree，直接返回当前仓库根目录（用作"留在主树"的安全阀）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            branch: { type: 'string' },
            worktreePath: { type: 'string' },
            created: { type: 'boolean' },
            sessionId: { type: 'string' },
            sessionOpened: { type: 'boolean' },
            message: { type: 'string' },
          },
        },
        render: (_args, value) => [
          { type: 'text', text: JSON.stringify(value, null, 2) },
        ],
      },
      async execute(args, exec) {
        const agent = exec && exec.agent
        const cwd =
          agent && agent.session && agent.session.header
            ? agent.session.header.cwd
            : undefined
        if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
          throw new Error('enter_worktree 需要一个父 session 的绝对 cwd')
        }

        if (!(await isGitRepo(cwd))) {
          return {
            ok: false,
            message: `当前目录不是 git 仓库：${cwd}`,
          }
        }

        // 安全阀：inPlace 时直接返回仓库根目录
        if (args.inPlace === true) {
          const rootResult = await runGit(cwd, ['rev-parse', '--show-toplevel'])
          const root = rootResult.ok ? rootResult.stdout : cwd
          return {
            ok: true,
            branch: undefined,
            worktreePath: root,
            created: false,
            message: 'inPlace=true：未创建 worktree，使用仓库根目录。',
          }
        }

        // 确定 worktree 路径与分支
        const rootResult = await runGit(cwd, ['rev-parse', '--show-toplevel'])
        const repoRoot = rootResult.ok ? rootResult.stdout : cwd
        const base = typeof args.base === 'string' && args.base.length > 0 ? args.base : 'HEAD'

        const requestedLayout =
          args.layout === 'sibling' ? 'sibling' : args.layout === 'nested' ? 'nested' : config.layout
        const dotDir = config.dotworktreesDir

        let branch =
          typeof args.branch === 'string' && args.branch.length > 0
            ? args.branch
            : `wt/${Date.now()}`

        let worktreePath
        if (typeof args.path === 'string' && args.path.length > 0) {
          worktreePath = resolve(args.path)
        } else if (requestedLayout === 'sibling') {
          const repoName = basename(repoRoot)
          worktreePath = join(dirname(repoRoot), `${repoName}--${branch}`)
        } else {
          worktreePath = join(repoRoot, dotDir, branch)
        }

        // 复用：路径已是现有 worktree
        const existing = await listWorktrees(repoRoot)
        if (existing.includes(worktreePath)) {
          const openSession =
            args.openSession === false ? false : args.openSession === true ? true : config.autoOpenSession
          const session = openSession ? await openSessionAt(ctx, worktreePath) : { opened: false }
          return {
            ok: true,
            branch,
            worktreePath,
            created: false,
            sessionId: session.opened ? session.sessionId : undefined,
            sessionOpened: session.opened,
            message: '复用了已存在的 worktree。',
          }
        }

        // 创建 worktree
        if (!(await branchExists(repoRoot, branch))) {
          const create = await runGit(repoRoot, [
            'worktree',
            'add',
            '-b',
            branch,
            worktreePath,
            base,
          ])
          if (!create.ok) {
            return {
              ok: false,
              branch,
              worktreePath,
              created: false,
              message: `git worktree add 失败：${create.error}`,
            }
          }
        } else {
          const create = await runGit(repoRoot, ['worktree', 'add', worktreePath, branch])
          if (!create.ok) {
            return {
              ok: false,
              branch,
              worktreePath,
              created: false,
              message: `git worktree add（attach 已有分支）失败：${create.error}`,
            }
          }
        }

        // nested 布局写 .gitignore
        if (requestedLayout === 'nested') {
          await ensureGitignore(repoRoot, dotDir)
        }

        // 开隔离 session
        const openSession =
          args.openSession === false ? false : args.openSession === true ? true : config.autoOpenSession
        const session = openSession ? await openSessionAt(ctx, worktreePath) : { opened: false }

        return {
          ok: true,
          branch,
          worktreePath,
          created: true,
          sessionId: session.opened ? session.sessionId : undefined,
          sessionOpened: session.opened,
          message: session.opened
            ? `已创建 worktree 并开隔离 session ${session.sessionId}；在 Web GUI 打开该 session 即可进入。`
            : `已创建 worktree（未开 session：${session.reason || '已禁用'}）；可在 GUI 打开或 cd 进去。`,
        }
      },
    })
  )
}

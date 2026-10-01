# dsh-enterworktree

DSH 版的 Claude Code `/enterworktree`。

## 它做什么

Claude Code 的 `EnterWorktree` 会创建一个 git worktree，并把 agent 切换进去并行工作。
DSH 里每个 session 的工作目录（`session.header.cwd`）是**只读**的，无法原地改当前
session 的目录，所以"进入 worktree"在 DSH 下的等价做法是：

1. 在 `.worktrees/<branch>/`（嵌套布局）或 `../<repo>--<branch>`（兄弟布局）创建一个 git worktree；
2. 用 `ctx.remote.session.create({ cwd })` 在该 worktree 路径开一个全新的隔离 session；
3. 把 `sessionId` + 路径返回给你，你在 Web GUI 打开该 session 即等于"进入"。

工具在 Host 进程里通过 `ctx.tools.register(defineTool(...))` 注册，与
`dsh-speckit-workflow` 的注册方式一致。

## 工具参数（`enter_worktree`）

| 参数 | 说明 |
| --- | --- |
| `branch` | 新分支名；省略自动生成 `wt/<timestamp>`；已存在本地分支则直接 attach。 |
| `base` | 切新分支的基点，默认 `HEAD`。 |
| `path` | 显式绝对路径，提供后忽略 `layout`。 |
| `layout` | `nested`（默认）或 `sibling`。 |
| `openSession` | 是否开隔离 session，默认 true。 |
| `inPlace` | `true` 时不开 worktree，直接返回仓库根目录（安全阀）。 |

## 输出

```json
{
  "ok": true,
  "branch": "wt/...",
  "worktreePath": "/abs/path/.worktrees/wt/...",
  "created": true,
  "sessionId": "session-xxxxx",
  "sessionOpened": true,
  "message": "已创建 worktree 并开隔离 session ..."
}
```

## 安装

```bash
# 在 web profile 安装（需要 danger-full-access 或审批）
plugin_manager action=install_bundle target=/home/shici/github/deepseek-tooYangtooSimple/dsh-enterworktree
```

安装后 `enter_worktree` 即在会话里可用；改 lib 后重启 dsh-desktop 让宿主重载。

## 限制

- 当前 session 不会被移动；它仍指向原目录。所有后续改动在你打开的那个 worktree session 里发生。
- 仅当 profile 提供 `dsh-api-remotes`（即 `ctx.remote.session`）时才能自动开 session；否则只创建 worktree 并返回路径。

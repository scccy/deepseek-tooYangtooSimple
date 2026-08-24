# dsh-session-eraser

DSH Web 会话管理插件:在工作区/侧边栏**一键结束并永久删除会话**。DSH 原生只提供重命名、分叉、归档(非破坏);本插件补上真正的「删除」，删除按钮会自动完成「结束会话 + 删除会话」两步，无需先手动关闭。

## 功能

- 宿主路由 `POST /api/dsh-sesdel/delete`:`{ "sessionId": "session-xxx" }` → 完整删除链路
  1. 会话仍在运行?→ 自动 `agent.cancel({ kind: "disposed" })` 中断回合,`whenIdle()` 等待收敛(带 8s 上限),再 `flush` 结算落盘
  2. `archiveSession` 隐藏侧边栏行(UI 即时消失)
  3. 按 `sessionPersistence.locate()` 的权威落盘路径校验(不再假设 id 一定带 `session-` 前缀),原生 `fs` 递归删除会话目录
  4. 清理工作区记录(`sessionIds`);投影缓存已不再是 storage domain,改由会话文件删除后自然失效
- 客户端双入口(走官方槽位,升级不失效):
  - 侧边栏底部「🗑 删除会话」面板(点行一下标记,再点一次执行)
  - 当前会话头部「删除会话」按钮(两下确认)
- 会话行三点菜单**没有官方槽位**(菜单在 `dsh-client-ui-workspace` 内硬编码),要把它也放进三点菜单只能打下方补丁
- 桥接/队列:菜单删除在宿主未就绪时自动排队,插件加载后补执行

## 目录

```
dsh-session-eraser/
├── package.json          # dsh.双面插件声明 (host + dsh.client)
├── cordis.patch.yml      # 挂载补丁: insert 一条插件行
├── lib/
│   ├── index.js          # 宿主半: HTTP 路由 + 删除引擎
│   └── client.js         # 浏览器半: 面板 + 桥 + 队列排水
└── README.md
```

## 安装(以 web profile 为例)

1. 将本包放入 web profile 依赖,并把 bundle 加入 profile 的 `dsh.profile.bundles`:

```json
{
  "dsh": { "profile": { "bundles": [ "...", "dsh-session-eraser" ] } },
  "dependencies": { "dsh-session-eraser": "file:../dsh-session-eraser" }
}
```

2. 安装。`file:` 依赖在 pnpm 下是**一次性实拷贝**,改源码不会自动同步;任选其一:

   - 重装(改动后执行一次):

     ```bash
     cd ~/.dsh/profiles/web
     pnpm install --force
     ```

   - 或直接软链(推荐,以后改源码即可):

     ```bash
     cd ~/.dsh/profiles/web
     rm -rf node_modules/dsh-session-eraser
     ln -sfn /绝对路径/dsh-session-eraser node_modules/dsh-session-eraser
     ```

   也可把 profile 依赖里的 `file:` 改成 `link:` 让 pnpm 长期保持软链。

3. 重启 DSH。宿主自动注册 `/api/dsh-sesdel/delete`,浏览器半自动挂到侧边栏。

卸载:移除 bundles 条目与 symlink,重启即可。

## 行菜单补丁(可选)

原生三点菜单(重命名/分叉/归档)在 `dsh-client-ui-workspace` 内部硬编码,没有插入槽。如需菜单入口,为该包打下面两处补丁(升级即覆盖,需重打):

1. `SessionNodeItem` 的 `sessionMenuItems` 数组追加:

```js
{
  id: "delete",
  label: "删除会话",
  icon: jsx(IconTrashOutline16, {})
}
```

2. 菜单 `onSelect` 追加分支(globalThis 桥上已由宿主插件提供):

```js
if (id === "delete") {
  if (row.running === true) { toast("该会话正在运行,无法删除。"); return; }
  globalThis.__SesdelBridge.requestDelete(node.id)
    .then((r) => { if (!r || r.ok !== true) toast(r?.message ?? "删除失败"); });
}
```

不打补丁也不影响侧边栏底部面板入口。

## 发布

```bash
cd dsh-session-eraser
npm publish                 # 或发布到私有 registry
```

安装方随后可用包名替换 `file:` 依赖并 `pnpm install`。

## 注意事项

- 删除**不可恢复**;请在自己的回溯/备份策略下使用。
- 运行中的会话删除即“结束”:中断进行中的回合并先落盘日志。
- 升级 DSH 部署不会影响本插件本体;若打过 UI 菜单补丁,升级后需重打。
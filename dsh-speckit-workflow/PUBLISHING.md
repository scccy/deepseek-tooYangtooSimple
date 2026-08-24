# Publishing checklist (deferred)

> 发布暂时搁置（本地尚未调完）。调完后按本清单执行,一次到位。

## Before publishing

完成本地验证(见下方 Local verification),然后:

### 1. Decide the final npm name (currently undecided)

| Option | Notes |
|---|---|
| `@linxin666/dsh-speckit-workflow` | 与 `@linxin666/dsh-ssh` 同一生态(推荐) |
| `dsh-speckit-workflow` | npm 上当前未被占用,但无命名空间保护 |

选定后需要改动的文件(5 处):

- `package.json` → `name`
- `cordis.patch.yml` → insert 行的 `name`(id 可保持 `dsh-speckit-workflow` 不变)
- `README.md` → 安装章节的包名与 `dsh.profile.bundles` 示例
- 本地 web profile 的 `package.json`(`dependencies` + `dsh.profile.bundles`)以及
  `node_modules/` 下同步目录名(`scripts/sync-to-profile.sh` 的 `TARGET` 名字)
- `scripts/smoke.mjs` 的 `DSH_SPECKIT_PACKAGE` 默认值

### 2. Fill publisher metadata in `package.json`

- `author`: e.g. `"linxin666 <linxin@linux.do>"` (当前缺失)
- `repository`: 并入 `https://github.com/zhu1090093659/dsh-web-ui.git`(与 dsh-ssh 一致)
  或独立仓库(未定)。
- 建议补 `homepage` / `bugs`。

### 3. Version

- 当前版本为 **0.7.0**，与 UI 定版 v0.7（`design/spec-board-prototype.html`）对齐。
- 正式发布即 `npm publish`（`0.7.0`）；如有预发布，用 `0.7.1-pre` + `--tag pre`。

### 4. Release verification (每次 publish 前跑)

```bash
cd dsh-speckit-workflow
bash scripts/check.sh                                  # 语法 + capsule/skills 断言 + 引擎三重契约校验(安装了 engine 时)
bash scripts/sync-to-profile.sh                        # 同步到本地 profile
DSH_PROFILE_DIR=~/.dsh/profiles/web node scripts/smoke.mjs   # 宿主侧冒烟(schema/护栏/team 编排 mock 全量)
npm pack --dry-run                                     # 确认 23 文件、skills/NOTICE 在内
npm publish --dry-run --access public                  # 元数据终检
```

## Publishing

```bash
npm login            # 一次性;或把 access token 写入 ~/.npmrc
cd dsh-speckit-workflow
npm publish --access public
```

发布后从 registry 安装自检:

```jsonc
// 干净的测试 profile 里:
{
  "dependencies": { "<新包名>": "^0.7.0" },
  "dsh": { "profile": { "bundles": ["<新包名>"] } }
}
```

然后重启 DSH:侧边栏「SpecKit SDD」入口出现、`speckit_sdd` 工具注册、
`workflow_list` 出现 `speckit-sdd`。

## Local verification (发布前的本地调完清单)

- [ ] 重启 DSH,确认 `Spec 流水线看板`(v0.7)宿主 RPC/「📋 看板」入口真实加载(当前代码已 sync 到 profile)
- [ ] 在**临时 scratch 项目**跑一次 SpecKit 兼容 e2e(不要污染本仓库):
      1. `specify init --here --script py`(不需要 `--skills`)
      2. 面板启动一个简单 feature,观察 12 阶段推进 / 评审 / 审计区
      3. 验证 `.dsh/speckit-workflow/skills/` 被同步、`.dsh/workflows/` 出现 capsule
      4. 跑完后 `workflow_manage show <runId>` 与面板历史一致
- [ ] 面板控制按钮:运行中点「⏸ 暂停」→「▶ 继续」→「■ 停止」各验一次
- [ ] 五区版式、rail 折叠态、入口文案按真机观感微调(见 PROGRESS 第 6 节)
- [ ] 明确 `dsh-speckit-workflow/skills/` 与 spec-kit 上游的更新策略(手动跟随
      `specify` CLI 出新版时重新 vendor + 更新 NOTICE)
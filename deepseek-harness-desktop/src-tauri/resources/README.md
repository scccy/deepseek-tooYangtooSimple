# Resources

This directory is bundled into the installer as `resources/**`.

At runtime, the application downloads everything it needs into the OS user-data
directory (the Tauri app-data dir for identifier
`io.github.hairyf.deepseek-harness-desktop`, e.g. `%APPDATA%/io.github.hairyf.deepseek-harness-desktop/` on Windows):

- `runtime/` — the bundled Node.js runtime (downloaded on first run)
- `dependencies/dsh/` — the packaged DeepSeek Harness distribution (downloaded from the
  `hairyf/deepseek-harness-pkg` release feed)
- `data/dsh/` — the isolated `$DSH_HOME` used by the running `dsh` process
- `logs/` — application and `dsh` service logs
- `.store.dat` — desktop settings (port, auto-start, language, etc.)

No manual Node.js or pnpm installation is required.

## Preset plugins — `preset-plugins.json`

The first-run wizard / sidebar preset list is driven by `preset-plugins.json`
(loaded at runtime by `src-tauri/src/service/plugin/mod.rs` — **no Rust code
change needed to add a preset**). To propose a new preset plugin, open a PR
that adds one entry to the JSON array:

> **Note on "new preset" detection**: the file ships with the installer and is
> force-overwritten on every install, so the app records a fingerprint of its
> content into the user-data settings after the wizard ends (install or skip)
> and re-opens the wizard on the next launch when the content differs. No extra
> action is needed when adding an entry.

```json
{
  "id": "npm-package-name",
  "spec": "npm-package-name | github:owner/repo",
  "name": "Display name",
  "description": "English description. · 中文描述",
  "repoUrl": "https://github.com/owner/repo",
  "recommended": true,
  "fix": false,
  "winOnly": false
}
```

| Field         | Required | Meaning                                                                 |
| ------------- | -------- | ----------------------------------------------------------------------- |
| `id`          | yes      | Unique front-end key; must be a legal npm dependency name               |
| `spec`        | yes      | Dependency form passed to `dsh plugin add` (npm name or `github:owner/repo`) |
| `name`        | yes      | Display name                                                            |
| `description` | yes      | Shown in the wizard; bilingual (`en. · 中文`) is encouraged             |
| `repoUrl`     | yes      | Repository page, opened via the "open repo" button                      |
| `recommended` | no       | Green "recommended" chip, checked by default (defaults to `false`)      |
| `fix`         | no       | Yellow "fix" chip, checked by default — reserved for Windows minimal-mode fixes (defaults to `false`) |
| `winOnly`     | no       | Only listed on Windows (defaults to `false`)                            |

`id` must be unique across the file. The plugin itself is **not** vendored into
this repository — it is installed on the user's machine from `spec` at setup
time, so the PR only needs to add the JSON entry.
# Vendored Speckit Skills

These 11 `SKILL.md` files are vendored from
[github.com/github/spec-kit](https://github.com/github/spec-kit) (MIT License,
© GitHub, Inc.).

| Skill directory | Workflow phase |
|---|---|
| `speckit-specify` | specify |
| `speckit-worktrees-create` | worktrees |
| `speckit-clarify` | clarify |
| `speckit-plan` | plan |
| `speckit-checklist` | checklist |
| `speckit-tasks` | tasks |
| `speckit-analyze` | analyze |
| `speckit-taskstoissues` | taskstoissues (optional) |
| `speckit-implement` | implement |
| `speckit-converge` | converge |
| `speckit-constitution` | constitution (out of chain) |

Ten of them are upstream base skills and are kept **byte-identical** to the
pinned spec-kit release (`SPECIFY_CLI_VERSION` in `lib/index.js`, currently
**v1.0.13**). They are that version's `specify init --here --integration codex`
output for `.agents/skills/`. To regenerate:

```bash
uvx --from specify-cli==1.0.13 specify init /tmp/ref --script py --integration codex
# then copy /tmp/ref/.agents/skills/<skill>/SKILL.md over skills/<skill>/SKILL.md
```

`speckit-constitution` backs the standalone Constitution page (outside the stage
chain) and belongs to the same upstream set.

`speckit-worktrees-create` is the one deviation: it is the **worktrees extension**
command `speckit.worktrees.create` promoted to a skill, because the plugin has a
dedicated `worktrees` stage. Upstream ships it as an extension rather than a base
skill.

Its body is kept **byte-identical to extension v1.3.2** (verified); only the YAML
frontmatter is ours. That extension is `discovery-only` in the community catalog,
so `specify extension add worktrees` refuses it — refresh from the tagged archive
instead:

```bash
curl -sSL -o /tmp/wt.zip \
  https://github.com/dango85/spec-kit-worktree-parallel/archive/refs/tags/v1.3.2.zip
# then diff commands/speckit.worktrees.create.md in that zip against the body of
# skills/speckit-worktrees-create/SKILL.md
```

Extension metadata: id `worktrees`, author `dango85`, MIT, requires spec-kit
>= 0.4.0. The community page also advertises a `speckit.worktrees.specify`
command that is **not** in the v1.3.2 archive — it comes from the repository's
main branch and has no tagged release, so it is intentionally not vendored here.

`speckit-worktrees-clean` and `speckit-worktrees-list` are intentionally not
vendored: they are interactive maintenance tools, not pipeline phases.

## Workspace `.specify/` is not vendored

The plugin no longer ships a skeleton copy of `.specify/`. Workspace
initialization runs the official `specify init` at the pinned version, because
only the official flow writes `workflows/`, `integration.json`, `integrations/`,
`init-options.json` and `.specify/.gitignore` — without them spec-kit does not
recognize the project's SDD workflow (`specify workflow list` reports
`No workflows installed.`).

The previous vendored skeleton failed in two ways that pinning-and-running
removes: it omitted that metadata, and its templates/scripts had a hand-edited
`/speckit-*` command prefix that disagreed with the `$speckit-*` used upstream
**and by these skills**. The "reset to template" default for the constitution now
reads the project's own `.specify/templates/constitution-template.md`.

At run start the plugin materializes the skills under the target project's
`.dsh/speckit-workflow/skills/` (hash-verified, re-synced on plugin upgrade), so
phase agents read them from a stable project-relative path — never from the
package's install location. Official `specify init` additionally writes a
byte-identical copy into the project's `.agents/skills/`; the plugin never reads
from there.

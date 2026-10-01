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

`speckit-worktrees-create` is the one deviation: it is upstream's **worktrees
extension** command (`worktrees:commands/speckit.worktrees.create.md`, as
recorded in its frontmatter), promoted to a skill because the plugin has a
dedicated `worktrees` stage. Upstream ships it as an extension rather than a base
skill, and that extension is `discovery-only` in the community catalog (not
installable via `specify extension add`), so it cannot be auto-refreshed.
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

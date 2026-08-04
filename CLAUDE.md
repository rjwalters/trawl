<!-- BEGIN LOOM ORCHESTRATION -->
This repository uses [Loom](https://github.com/rjwalters/loom) for AI-powered development orchestration — see the Loom repository for the full guide (roles, labels, worktrees, configuration). When installed, Loom also writes a locally-substituted copy of that guide to `.loom/CLAUDE.md`.
<!-- END LOOM ORCHESTRATION -->
<!-- BEGIN REPO-SKILLS -->
This repository has [Repo Skills](https://github.com/rjwalters/repo) v0.7.0 installed —
general repository hygiene and environment commands invoked as `/repo:<command>`. Run
`/repo:help` for the command list, or see `.claude/skills/repo/SKILL.md` for the full
guide. Hygiene commands apply safe, reversible fixes by default and report each
change; run with `--ask` to review first, and `--prune` to allow irreversible
removals. Managed by `install.sh` — edit outside the markers only.
<!-- END REPO-SKILLS -->

## Project conventions

Small codebase, few rules — but these were each learned from a shipped bug.

**`FORMATS` in `src/render.mjs` is the single source of truth for output
formats.** Never hand-write the format list anywhere else. The MCP JSON schema
had an `enum: [...FORMATS]` sitting directly above a hand-written `description`
listing the same formats; adding `markdown` updated the enum and silently left
the prose denying it. Derive from `FORMATS` (`FORMATS.join(", ")`) or import it.
The README's usage block and MCP tool table are the remaining hand-maintained
copies — check them against `node src/cli.mjs --help` when flags change.

**Detect "am I the entry point?" by real path, never by an `argv[1]` filename
suffix.** A suffix test (`argv[1].endsWith("cli.mjs")`) fails for every
symlinked launcher, which is exactly how npm installs a `bin`. The result is
the worst failure shape available: the CLI loads, matches nothing, and exits 0
having done nothing. Compare resolved real paths instead.

**`src/cli.mjs` must stay mode `100755`.** It is the `bin.trawl` target and has
a shebang. A registry install would chmod it, but the dev install here is an
`npm link` into the working tree, so the bin inherits the repo's mode — at
`100644` the command dies with `permission denied` before Node starts. If git
reports it mode-dirty, `100755` is the correct resolution.

**Verify runtime changes through the `PATH` binary**, not `node src/cli.mjs`.
The direct-node invocation is precisely the shape that hid both bugs above: it
bypasses the bin symlink and never consults the exec bit.

**Tests are `node --test`, no framework.** `npm test` runs `tests/*.test.mjs`.
Tests that need a browser skip cleanly when none is present, so a green local
run does not always mean the render path was exercised — CI installs Chromium
to keep them meaningful.

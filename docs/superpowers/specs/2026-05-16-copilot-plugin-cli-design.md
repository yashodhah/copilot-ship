# copilot-plugin CLI — Design Spec

**Date:** 2026-05-16
**Status:** Draft — pending implementation plan

---

## Problem

GitHub Copilot customizations (skills, agents, hooks, prompts, instructions) can be shared via VS Code's native agent plugin system — but that leaves users on other IDEs and environments behind. There is no cross-IDE, cross-environment way to distribute the full set of Copilot artifacts today.

The `npx skills` CLI (Vercel) covers skills only. Nothing covers the full plugin format.

---

## Goal

A consumer-facing CLI tool — `npx copilot-plugin` — that installs any GitHub Copilot plugin into a project's `.github/` directory, regardless of IDE.

Not a producer tool. Not a registry. Not a skill-only tool.

---

## Non-Goals (MVP1)

- Authoring / scaffolding new plugins (`init`)
- Removing installed plugins (`remove`)
- Updating installed plugins (`update`)
- Searching a registry (`find`)
- MCP servers (definitions or executables — VS Code discovery path conflict, deferred)
- Convention-based single plugin repos (no marketplace manifest) — deferred to MVP2
- Merging into existing files (fail on conflict for now)
- IntelliJ native plugin marketplace support (waiting on Microsoft)

---

## Design Decisions

### D1 — Purpose-built CLI, GitHub Copilot only

Build a new TypeScript package in `copilot-shipping/`. Written clean from scratch — GitHub Copilot is the only target. No multi-agent matrix, no lock file complexity, no inherited telemetry.

`vercel/skills` is a reference only — for CLI UX patterns and command-line conventions. No code copied from it.

**Rejected:** Fork `skills` CLI (too much inherited complexity). Wrapper over `skills` (couples to its internals).

### D2 — Canonical install targets

Project install: artifacts extracted to `.github/` using standard Copilot paths.
Global install (`-g`): same artifact-type subdirectories, rooted at `~/.copilot/`.

| Artifact | Project path | Global path |
|---|---|---|
| Instructions (repo-wide) | `.github/copilot-instructions.md` | `~/.copilot/copilot-instructions.md` |
| Instructions (path-specific) | `.github/instructions/*.instructions.md` | `~/.copilot/instructions/` |
| Prompt files | `.github/prompts/*.prompt.md` | `~/.copilot/prompts/` |
| Custom agents | `.github/agents/<name>.md` | `~/.copilot/agents/` |
| Skills | `.github/skills/<name>/SKILL.md` | `~/.copilot/skills/` |
| Hooks | `.github/hooks/*.json` | `~/.copilot/hooks/` |

The `~/.copilot/` global location is CLI-defined, independent of any IDE's native plugin discovery.

Reference: https://docs.github.com/en/copilot/reference/customization-cheat-sheet

### D3 — Convention-based artifact discovery

No manifest required inside a plugin directory. The installer discovers artifacts by path convention within the plugin root:

```
plugin-root/
  skills/          → .github/skills/
  agents/          → .github/agents/
  hooks/           → .github/hooks/
  prompts/         → .github/prompts/
  instructions/    → .github/instructions/
  copilot-instructions.md → .github/copilot-instructions.md
```

### D4 — Marketplace support

The installer checks for `.claude-plugin/marketplace.json` at the source root. If found, it treats the source as a marketplace. Format is confirmed from `github/copilot-plugins`:

```json
{
  "name": "marketplace-name",
  "plugins": [
    { "name": "my-plugin", "source": "./plugins/my-plugin", "description": "..." },
    { "name": "external", "source": { "source": "github", "repo": "owner/repo", "path": "plugins/x" } }
  ]
}
```

If no marketplace manifest is found, the entire source is treated as a single plugin.

**MVP1 scope:** String `source` values only (local paths within the cloned repo). Object `source` values (external GitHub repos) are skipped with a warning — deferred to MVP2.

### D5 — Fail on conflict

If a target file already exists, the installer exits with an error and reports which file blocked the install. No overwriting, no merging. User resolves manually.

**Rejected for MVP1:** Merging (complex, risky). Overwriting (destructive).
**Future:** Merge strategy with `<!-- copilot-plugin: name -->` fences for markdown, deep-merge for JSON.

---

---

## CLI Interface

```bash
npx copilot-plugin add <source>                       # install from marketplace (prompt to select)
npx copilot-plugin add <source> --plugin my-plugin    # specific plugin from marketplace
npx copilot-plugin add <source> --all                 # all plugins from marketplace, no prompt
npx copilot-plugin add <source> -g                    # install globally (~/.copilot/)
npx copilot-plugin add <source> -y                    # skip confirmation prompts
npx copilot-plugin list                               # show installed artifacts in .github/
npx copilot-plugin list -g                            # show globally installed artifacts
```

### Source formats

```bash
npx copilot-plugin add owner/repo                          # GitHub shorthand
npx copilot-plugin add https://github.com/owner/repo
npx copilot-plugin add https://github.com/owner/repo/tree/main/plugins/my-plugin
npx copilot-plugin add git@github.com:owner/repo.git
npx copilot-plugin add ./local-plugin
```

### Install flow

1. Resolve source → clone/read repo
2. Read `.claude-plugin/marketplace.json` — error if not found (MVP1 requires marketplace)
3. List plugins, prompt user to select (or use `--plugin`/`--all` to skip prompt)
4. For each selected plugin, discover artifacts by D3 convention
5. Check all target paths for conflicts — fail early if any exist (D5)
6. Extract artifacts to `.github/` (project) or `~/.copilot/` (global `-g`)
7. Report what was installed

### List behavior

Scans `.github/skills/`, `.github/agents/`, `.github/hooks/`, `.github/prompts/`, `.github/instructions/`, `.github/copilot-instructions.md` and reports what's present. No lock file needed — reads the filesystem directly.

---

## Source Package Structure

A marketplace repo (required for MVP1):

```
marketplace-repo/
  .claude-plugin/
    marketplace.json          # required — lists plugins and their local sources
  plugins/
    my-plugin/
      skills/
        my-skill/
          SKILL.md
      agents/
        my-agent.md
      hooks/
        pre-commit.json
      prompts/
        standup.prompt.md
      instructions/
        frontend.instructions.md
      copilot-instructions.md
```

---

## Repos

One new repo to create: **`copilot-plugin`** — the consumer-facing npx tool.

Marketplace test target: clone `https://github.com/github/copilot-plugins` locally to validate marketplace detection and install flow.

---

## Implementation

- **Location:** `/Users/yashodhah/ai_scout/copilot-shipping/`
- **Language:** TypeScript + Node.js
- **Reference:** `vercel/skills` for CLI UX patterns only , no need to support for multi agents
- **Key dependencies:** `@clack/prompts` (interactive UI)
- **npm package name:** `copilot-plugin`

---

## References

- GitHub Copilot customization paths: https://docs.github.com/en/copilot/reference/customization-cheat-sheet
- VS Code agent plugins: https://code.visualstudio.com/docs/copilot/customization/agent-plugins
- Cross-tool compatibility: https://code.visualstudio.com/docs/copilot/customization/agent-plugins#_crosstool-compatibility
- IntelliJ gap: https://github.com/microsoft/copilot-intellij-feedback/issues/1539
- Marketplace test target (MVP2): https://github.com/github/copilot-plugins
- Reference implementation (`skills` CLI): https://github.com/vercel-labs/skills

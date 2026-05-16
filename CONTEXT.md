# Copilot Plugin Shipping — Reference

## GitHub Copilot Customization Paths

Source: https://docs.github.com/en/copilot/reference/customization-cheat-sheet

| Artifact | Workspace path | Global path | IDE support |
|---|---|---|---|
| Instructions (repo-wide) | `.github/copilot-instructions.md` | Personal/org via UI | VS Code, GitHub.com, CLI, JetBrains (preview) |
| Instructions (path-specific) | `.github/instructions/*.instructions.md` | — | VS Code, GitHub.com |
| Prompt files | `.github/prompts/*.prompt.md` | — | VS Code, Visual Studio, JetBrains (preview) |
| Custom agents | `.github/agents/<name>.md` | `.github-private` repo (org/enterprise) | VS Code, GitHub.com |
| Agent skills | `.github/skills/<name>/SKILL.md` | `~/.copilot/skills/` or `~/.agents/skills/` | VS Code, CLI, JetBrains (preview) |
| Hooks | `.github/hooks/*.json` | — | VS Code, CLI |
| MCP servers | `.mcp.json` inside plugin dir | — | VS Code (see plugin format below) |

## VS Code Agent Plugin Format

Source: https://code.visualstudio.com/docs/copilot/customization/agent-plugins

Plugin manifest discovery order (VS Code checks these):
1. `.plugin/plugin.json`
2. `plugin.json` (root)
3. `.github/plugin/plugin.json`
4. `.claude-plugin/plugin.json`

A single plugin can bundle: skills, agents, hooks, MCP servers, slash commands.

## MCP Servers in Plugins

Source: https://code.visualstudio.com/docs/copilot/customization/agent-plugins#_mcp-servers-in-plugins

MCP servers are defined in `.mcp.json` at the plugin root. VS Code discovers this automatically when it loads the plugin.

```
my-plugin/
  .mcp.json              # MCP server definitions
  servers/
    db-server            # Server executable
  config.json            # Server configuration
```

`.mcp.json` format — note top-level key is `mcpServers`, NOT `servers` (differs from workspace `mcp.json`):

```json
{
  "mcpServers": {
    "plugin-database": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/db-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": {
        "DB_PATH": "${CLAUDE_PLUGIN_ROOT}/data"
      }
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin directory. Supported in: `command`, `args`, `cwd`, `env`, `envFile`, `url`, `headers`.

VS Code starts plugin MCP servers automatically and they appear alongside workspace and user-level MCP servers.

## NPX Skills CLI (Vercel) — Reference Implementation

Source: https://github.com/vercel-labs/skills (local copy: `/Users/yashodhah/ai_scout/skills/`)

Command pattern:
```bash
npx skills add owner/repo           # GitHub shorthand
npx skills add https://github.com/owner/repo
npx skills add ./local-path
npx skills add owner/repo -g        # global scope
npx skills add owner/repo -a claude-code  # target specific agent
```

Scope:
- Project (default): installs to `./<agent>/skills/`
- Global (`-g`): installs to `~/<agent>/skills/`

The CLI already reads `.claude-plugin/marketplace.json` for plugin-grouped skills.

## Update Flow — Design Decisions

### Lockfile approach (follows Vercel skills pattern)

Two separate lockfiles, different scopes:

**Project lockfile** (`copilot-plugin-lock.json` at repo root):
- Committed to git
- No timestamps (avoids merge conflicts — two branches adding different plugins auto-merge)
- Keys sorted alphabetically for deterministic diffs
- `update` = re-fetch marketplace manifest from `source`, version-compare, overwrite files if newer

**Global lockfile** (`~/.copilot/copilot-plugin-lock.json`):
- Never committed — user-state only
- Includes `installedAt` / `updatedAt` timestamps
- Same update flow

### Version-based update detection

`marketplace.json` plugin entries carry a `version` field (already present in `awesome-copilot`). At install time, record installed version in lockfile. At update time, re-fetch manifest, compare `version` strings. If newer → re-clone + overwrite.

Future upgrade path: replace with GitHub tree SHA approach (like Vercel global) so plugin authors don't need to manually bump versions.

### Lockfile schema (Vercel-inspired)

Vercel stores NO per-skill version field and NO installed file list — uses hashes for change detection and derives delete paths from skill name + known dirs.

For `copilot-plugin`, plugins install scattered files across `.github/` (unlike Vercel's per-skill directories). Schema deviation: we add `pluginVersion` for update detection, and `installedFiles` may be needed for future `remove` command since there is no single plugin directory to `rm -rf`.

### Lockfile schema (final — minimal)

```typescript
// Project: copilot-plugin-lock.json (committed to git, no timestamps)
interface PluginLockEntry {
  source: string;         // "github/awesome-copilot", "./local-path"
  pluginVersion?: string; // from marketplace.json plugin entry — optional, may be absent
}
interface PluginLockFile {
  version: number;        // schema version, currently 1
  plugins: Record<string, PluginLockEntry>; // keyed by plugin name, sorted alphabetically
}

// Global: ~/.copilot/copilot-plugin-lock.json (never committed)
// Same as above + installedAt/updatedAt ISO timestamps
```

`add` always writes a lockfile entry, even when `pluginVersion` is absent.

### Missing version field behavior (follows Vercel pattern)

`update` skips plugins with no `pluginVersion` in lockfile, prints:
```
  • spark  (no version tracked)
    To update: copilot-plugin add <source> --plugin spark -y
```

### Key code change required

`installer.ts:328` `ensureNoConflicts` throws if any target file already exists. `update` command needs an `allowOverwrite: boolean` flag on `installFromMarketplace` — when `true`, skip the file-exists check (still throw on cross-plugin conflicts within same run).

### Command shape

Mirrors existing `-g` pattern:
- `copilot-plugin update` → project scope (reads `copilot-plugin-lock.json`)
- `copilot-plugin update -g` → global scope (reads `~/.copilot/copilot-plugin-lock.json`)

## IntelliJ / JetBrains Gap

Source: https://github.com/microsoft/copilot-intellij-feedback/issues/1539

Plugin marketplace support in JetBrains is **not implemented** and marked **low priority**. JetBrains Copilot currently supports:
- `.github/copilot-instructions.md` (preview)
- Agent skills (preview)

Does NOT support: hooks, plugin marketplace, MCP servers (via plugin format).

Design decision: write all artifacts to canonical `.github/` paths now; JetBrains support activates automatically when Microsoft ships it.

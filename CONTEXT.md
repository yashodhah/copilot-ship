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

## IntelliJ / JetBrains Gap

Source: https://github.com/microsoft/copilot-intellij-feedback/issues/1539

Plugin marketplace support in JetBrains is **not implemented** and marked **low priority**. JetBrains Copilot currently supports:
- `.github/copilot-instructions.md` (preview)
- Agent skills (preview)

Does NOT support: hooks, plugin marketplace, MCP servers (via plugin format).

Design decision: write all artifacts to canonical `.github/` paths now; JetBrains support activates automatically when Microsoft ships it.

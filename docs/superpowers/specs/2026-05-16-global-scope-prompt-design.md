# Design: Interactive Scope Selection for `copilot-plugin add`

**Date:** 2026-05-16  
**Status:** Approved

## Problem

Running `copilot-plugin add <source>` silently defaults to project scope (`.github/`). Users who want global installation must remember the `-g` flag. There is no discovery path for global install in the interactive flow.

## Goal

When a user runs `copilot-plugin add` interactively (TTY, no `-y`), prompt them to choose between Project and Global scope before the install begins — mirroring the UX of the Vercel skills CLI reference implementation.

## Decision

**Option A — Scope prompt in `add` only.**

The `list` command keeps its current `-g` opt-in behavior. It is a fast, read-only query; adding a prompt there would be heavyweight.

## Design

### Trigger condition

Show the prompt when **all three** are true:
- `flags.yes` is `false` (no `-y`)
- `process.stdin.isTTY` is `true`
- `process.stdout.isTTY` is `true`

When `-g` is explicitly passed, `flags.scope` is already `"global"` and the prompt is skipped.  
When `-y` or a non-TTY pipe is detected, the prompt is skipped and the existing scope (project by default) is used silently.

### Prompt

```
? Installation scope
  ● Project  Install into .github/ (committed with your repo)
  ○ Global   Install into ~/.copilot/ (available across all projects)
```

Uses `p.select` from `@clack/prompts` (already imported). Cancel follows the existing pattern: `isCancel` → `cancel("Installation cancelled.")` → `process.exit(0)`.

### Placement

Inside `runAdd` in `src/index.ts`, **before** the spinner starts. This locks the scope in before any network/disk work begins.

```
runAdd:
  1. Validate source present
  2. [NEW] If interactive: show scope p.select → update flags.scope
  3. Start spinner
  4. installFromMarketplace (uses flags.scope → getInstallRoot)
  5. Plugin multiselect
  6. Confirmation (already shows correct target via resultTargetDescription)
  7. Install & report
```

### No changes to

- `src/installer.ts` — `getInstallRoot`, `installFromMarketplace` unchanged
- `src/constants.ts` — `GLOBAL_INSTALL_ROOT`, `PROJECT_INSTALL_ROOT` unchanged
- `list` command — keeps `-g` flag
- All non-interactive / scripted paths

## Files Touched

| File | Change |
|---|---|
| `src/index.ts` | Add `p.select` scope prompt in `runAdd` before spinner |

## Reference

Vercel skills CLI scope prompt: `../skills/src/add.ts` lines 1332–1356.

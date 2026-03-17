# Dry-Run Mode — Design Spec

**Date**: 2026-03-17
**Scope**: `lossless-claude install --dry-run` and `lossless-claude uninstall --dry-run`

---

## Problem

The installer has no safe way to preview what it would do before committing. `setup.sh` has a `XGH_DRY_RUN=1` guard but it silently exits — no preview. `install.ts` and `uninstall.ts` have no dry-run concept at all.

---

## Approach

Leverage the existing `ServiceDeps` / `TeardownDeps` injection pattern. Create a `DryRunServiceDeps` class that intercepts side-effectful calls and prints `[dry-run] would …` lines instead of executing them. Read-only calls (`readFileSync`, `existsSync`) delegate to the real filesystem so the preview reflects actual current state.

---

## Components

### 1. `installer/dry-run-deps.ts` (new)

Implements both `ServiceDeps` and `TeardownDeps`.

**Intercepted (print, no side effect):**

| Method | Output |
|--------|--------|
| `writeFileSync(path, data)` | `[dry-run] would write: <path>` |
| `mkdirSync(path)` | `[dry-run] would create: <path>` — only if dir doesn't already exist |
| `spawnSync(cmd, args)` | `[dry-run] would run: <cmd> <args>` — returns fake zero-exit result |
| `rmSync(path)` | `[dry-run] would remove: <path>` |

**Pass-through (real fs):**

| Method | Reason |
|--------|--------|
| `readFileSync` | Needed to read current settings for accurate preview |
| `existsSync` | Needed to check what already exists |

### 2. `installer/setup.sh` — structured preview

Replace the silent early-exit with a proper preview pass when `XGH_DRY_RUN=1`:
- Run backend auto-detection logic
- Print `[dry-run] backend: <backend> (<reason>)`
- Print `[dry-run] would install: <package> via <method>` for each package that would be installed
- Print `[dry-run] would write: ~/.cipher/cipher.yml`
- Exit 0 without writing anything

### 3. `bin/lossless-claude.ts` — flag parsing

Parse `--dry-run` from `argv` for the `install` and `uninstall` cases:
- If set: instantiate `DryRunServiceDeps`, pass to `install()`/`uninstall()`; also inject `XGH_DRY_RUN=1` into the env so `setup.sh` gets the preview signal
- If not set: existing behavior unchanged

---

## Output Format

```
  lossless-claude dry-run install

  ─── setup.sh (infrastructure)

  [dry-run] backend: vllm-mlx (auto-detected, Apple Silicon)
  [dry-run] would install: qdrant via brew
  [dry-run] would install: vllm-mlx via pip
  [dry-run] would write: ~/.cipher/cipher.yml

  ─── install (Claude Code integration)

  [dry-run] would create: ~/.lossless-claude/
  [dry-run] would write: ~/.lossless-claude/config.json
  [dry-run] would write: ~/.claude/settings.json
  [dry-run] would run: launchctl load ~/Library/LaunchAgents/com.lossless-claude.daemon.plist

  No changes written.
```

For uninstall:

```
  lossless-claude dry-run uninstall

  [dry-run] would run: launchctl unload ~/Library/LaunchAgents/com.lossless-claude.daemon.plist
  [dry-run] would remove: ~/Library/LaunchAgents/com.lossless-claude.daemon.plist
  [dry-run] would write: ~/.claude/settings.json

  No changes written.
```

---

## Testing

- **`DryRunServiceDeps` unit tests** — verify each intercepted method prints the correct `[dry-run]` line and returns safe fakes; verify `readFileSync`/`existsSync` delegate to real fs
- **`install --dry-run` integration** — call `install(new DryRunServiceDeps())`, capture stdout, assert expected `[dry-run] would write:` lines appear; assert no real files are touched
- **`uninstall --dry-run` integration** — same pattern
- **`setup.sh` preview** — run `XGH_DRY_RUN=1 bash setup.sh` in a subshell, assert `[dry-run]` lines in stdout, assert no files written and no packages installed

---

## Out of Scope

- Diff output (plain lines only)
- `--dry-run` for `daemon start/stop` or `mcp`
- Persisting or replaying a dry-run plan

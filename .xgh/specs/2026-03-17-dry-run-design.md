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

## Prerequisites

`TeardownDeps` (in `uninstall.ts`) currently only has `spawnSync`, `existsSync`, and `rmSync`, and `uninstall()` takes no arguments. The `uninstall()` function calls `readFileSync`, `writeFileSync`, and `existsSync` directly from `node:fs` rather than through deps.

Two prerequisite changes are included in the implementation plan:

1. Extend `TeardownDeps` with `readFileSync` and `writeFileSync`
2. Change `uninstall()` signature to `uninstall(deps: TeardownDeps = defaultDeps)` and route all fs calls through `deps`

The CLI (`bin/lossless-claude.ts`) then wires it up the same way `install` already does:
```typescript
case "uninstall": {
  const dryRun = argv.includes("--dry-run");
  const { uninstall } = await import("../installer/uninstall.js");
  if (dryRun) {
    const { DryRunServiceDeps } = await import("../installer/dry-run-deps.js");
    await uninstall(new DryRunServiceDeps());
  } else {
    await uninstall();
  }
  break;
}
```

---

## Components

### 1. `installer/dry-run-deps.ts` (new)

Implements both `ServiceDeps` and `TeardownDeps` (after the prerequisite extension above).

**Intercepted (print, no side effect):**

| Method | Output |
|--------|--------|
| `writeFileSync(path, data)` | `[dry-run] would write: <path>` |
| `mkdirSync(path)` | `[dry-run] would create: <path>` — only if dir doesn't already exist |
| `spawnSync(cmd, args)` | Special-cases two calls: (1) `bash setup.sh` — actually executes with `XGH_DRY_RUN=1` injected into env so `setup.sh` runs its preview pass; (2) `sh -c "command -v lossless-claude"` — returns `stdout: "lossless-claude"` so `resolveBinaryPath` produces a meaningful path. All other spawns print `[dry-run] would run: <cmd> <args>` and return a fake zero-exit result (`status: 0`, `stdout: ""`). |
| `rmSync(path)` | `[dry-run] would remove: <path>` |

**Pass-through (real fs):**

| Method | Reason |
|--------|--------|
| `readFileSync` | Needed to read current settings for accurate preview |
| `existsSync` | Needed to check what already exists |

**Note on `loadDaemonConfig`:** `install()` dynamically imports `loadDaemonConfig` to generate config defaults. This import has no side effects — it only reads env vars and returns a plain object. The subsequent `writeFileSync` call is what `DryRunServiceDeps` intercepts. This dynamic import requires the build artifacts to exist (`dist/`); running `--dry-run` without a prior build will fail with a module-not-found error. This is acceptable — `--dry-run` is a post-install preview tool, not a pre-build bootstrap.

**Output mechanism:** `DryRunServiceDeps` writes all `[dry-run]` lines via `console.log`. Tests capture output with `vi.spyOn(console, 'log')`; assertions match on the `[dry-run]` prefix to distinguish dry-run lines from `install()`'s own progress messages.

### 2. `installer/setup.sh` — structured preview

Replace the silent early-exit with a proper preview pass when `XGH_DRY_RUN=1`:
- Skip the interactive backend picker entirely; use the auto-detected value
- Print `[dry-run] backend: <backend> (<reason>)` (e.g. `vllm-mlx (auto-detected, Apple Silicon)`)
- Print `[dry-run] would install: <package> via <method>` for each package that would be installed (conditioned on the same checks as the real install — e.g. only if not already installed)
- Print `[dry-run] would write: ~/.cipher/cipher.yml`
- Exit 0 without writing anything

### 3. `bin/lossless-claude.ts` — flag parsing

Parse `--dry-run` from `argv` for the `install` and `uninstall` cases:
- If set: instantiate `DryRunServiceDeps`, pass to `install()`/`uninstall()`; also inject `XGH_DRY_RUN=1` into the env so `setup.sh` gets the preview signal
- If not set: existing behavior unchanged

---

## Output Format

Invoked as `lossless-claude install --dry-run` and `lossless-claude uninstall --dry-run`.

```
  lossless-claude install --dry-run

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
  lossless-claude uninstall --dry-run

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
- **`setup.sh` preview** — run `XGH_DRY_RUN=1 XGH_BACKEND=ollama bash setup.sh` in a subshell (env var forces a fixed backend, avoiding machine-specific auto-detection), assert `[dry-run]` lines appear in stdout, assert no files written and no packages installed. This test is marked as integration-only and skipped in CI environments where `bash` or the script's dependencies are unavailable.

---

## Out of Scope

- Diff output (plain lines only)
- `--dry-run` for `daemon start/stop` or `mcp`
- Persisting or replaying a dry-run plan

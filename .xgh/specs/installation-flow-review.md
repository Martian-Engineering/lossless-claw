# Installation Flow Code Review

**Reviewer**: Senior Code Review (Claude Opus 4.6)
**Date**: 2026-03-17
**Scope**: `installer/setup.sh`, `installer/install.ts`, `installer/uninstall.ts`, `package.json`, `src/daemon/config.ts`, `src/daemon/client.ts`, `bin/lossless-claude.ts`

---

## Critical Issues

### C1. `install()` hard-exits on missing ANTHROPIC_API_KEY (install.ts:181-183)

```typescript
if (!process.env.ANTHROPIC_API_KEY) {
  console.error(`ERROR: ANTHROPIC_API_KEY environment variable is not set.`);
  process.exit(1);
}
```

This runs **after** `setup.sh` has already executed (potentially installing Qdrant, models, writing cipher.yml). If the user forgot to export the key, they get a half-installed state: infrastructure is set up, but hooks/daemon/settings are not. On re-run the installer is mostly idempotent, but cipher.yml already exists so it takes the "sync" path instead of "create" path -- which is fine, but the user experience is confusing.

**Recommendation**: Check `ANTHROPIC_API_KEY` **before** running `setup.sh`, or make it non-fatal (warn and continue, since the key can be set later in the environment and the daemon reads it at runtime from `process.env`).

### C2. `removeClaudeSettings` filters on wrong shape (uninstall.ts:14)

```typescript
settings.hooks[event] = settings.hooks[event].filter((h: any) => !LC_COMMANDS.has(h.command));
```

Hook entries have the shape `{ matcher: "", hooks: [{ type: "command", command: "..." }] }`. The filter checks `h.command` on the **outer** entry object, but `command` lives inside `h.hooks[].command`. This means **uninstall never actually removes the hooks** -- the filter condition is always false because `h.command` is `undefined`.

**Fix**: Match the same shape used in `hasHookCommand`:
```typescript
settings.hooks[event] = settings.hooks[event].filter(
  (entry: any) => !(Array.isArray(entry.hooks) && entry.hooks.some((h: any) => LC_COMMANDS.has(h.command)))
);
```

### C3. `claude.plugin.json` referenced in `files` array but does not exist

`package.json` line 27 lists `"claude.plugin.json"` in the `files` array, but the file does not exist in the repo root. `npm pack` will silently skip it, but anyone relying on plugin discovery via that file will get nothing.

**Recommendation**: Either create the file or remove it from `files`.

---

## Major Issues

### M1. Security: `XGH_REMOTE_URL` injected unsanitized into Python code (setup.sh:386)

```python
print('yes' if '${1}' in ids else 'no')
```

The `$1` here is a bash positional parameter from `_model_available()`, which is a model ID, not directly user-controlled URL. However, the `XGH_REMOTE_URL` is used in `curl` calls and also interpolated into `cipher.yml` via heredoc. If a user provides a URL containing YAML metacharacters (e.g., backticks, quotes), it could corrupt `cipher.yml`. The Python sync script at line 689 receives it as `sys.argv[6]` which is safe from injection, but the heredoc generation at lines 629-655 does no escaping.

**Recommendation**: Validate `XGH_REMOTE_URL` more strictly (e.g., reject URLs with special characters beyond `://`, `-`, `.`, digits, `/`).

### M2. Non-interactive terminal silently produces empty model selection (setup.sh)

When `[ -t 0 ]` is false (piped/CI), `read` is skipped but `llm_choice` / `embed_choice` / `_backend_choice` default to their numeric defaults. This works. However, if the user enters "c" for custom in a non-interactive context, `XGH_LLM_MODEL` stays empty because the inner `read` is also guarded by `[ -t 0 ]`. Line 540 catches this with the fallback `${XGH_LLM_MODEL:-$DEFAULT_LLM}`, so it is not fatal, but it is confusing.

### M3. Daemon port is hardcoded in `bin/lossless-claude.ts` hooks (lines 35, 44)

```typescript
new DaemonClient("http://127.0.0.1:3737")
```

But the config allows `daemon.port` to be customized. If a user changes the port in `config.json`, the compact/restore hooks will still try port 3737.

**Recommendation**: Load the config to resolve the port, or read it from an env var.

### M4. `installer/setup.sh` not included in npm `files` explicitly

The `files` array includes `"dist/"` which contains `dist/installer/setup.sh` (copied by the build script). This works, but the build script (`tsc && cp installer/setup.sh dist/installer/setup.sh`) assumes `dist/installer/` exists after `tsc`. Since `tsconfig.json` includes `installer/**/*.ts` and `rootDir` is `.`, tsc will create `dist/installer/`. This is correct but fragile -- if no `.ts` files existed under `installer/`, the directory wouldn't be created, and the `cp` would fail.

### M5. `loadDaemonConfig` called with `/nonexistent` during install (install.ts:189)

```typescript
const defaults = loadDaemonConfig("/nonexistent");
```

This deliberately triggers the `try/catch` in `loadDaemonConfig` to get defaults. It works, but `loadDaemonConfig` also reads `process.env.ANTHROPIC_API_KEY` and writes it into `defaults.llm.apiKey`. The resulting `config.json` will contain the user's raw API key on disk in plaintext. This is a security concern -- the key is persisted to a file that might be backed up or shared.

**Recommendation**: Do not persist the API key to config.json. Store a placeholder like `"${ANTHROPIC_API_KEY}"` and resolve at runtime (which the template substitution on line 50 already supports).

---

## Minor Issues

### m1. `setup.sh` plist patching is brittle (lines 166-180)

The Python script does string replacement on XML (`</dict>\n</plist>`) to inject environment variables. If Qdrant's plist already has an `EnvironmentVariables` dict, this will create a duplicate key. A proper plist editor (`/usr/libexec/PlistBuddy` or `plutil`) would be more robust and is available on all macOS installations.

### m2. Qdrant WAL lock cleanup uses `find` with `-delete` (setup.sh:189)

```bash
find "${_QDRANT_STORAGE}" -path "*/wal/open-*" -delete 2>/dev/null || true
```

This deletes lock files while Qdrant might be starting up (the script starts Qdrant on the very next lines). There is a potential race condition if Qdrant creates a lock between the delete and the health check.

### m3. `uninstall()` does not clean up `~/.lossless-claude/` directory

The uninstall removes the daemon service and Claude settings entries, but leaves `~/.lossless-claude/` (config.json, daemon.log, daemon.sock, logs/) and `~/.cipher/cipher.yml` behind. This is arguably correct (preserving user data), but should be documented or offered as an option.

### m4. `resolveBinaryPath` uses `which` (install.ts:55)

On some systems (notably minimal Docker containers), `which` may not be installed. `command -v` is the POSIX-standard alternative, but since this is Node.js, the `spawnSync("which", ...)` approach is fine for macOS/Linux desktop targets. Just worth noting.

### m5. Ollama backend on Linux: piping install script to `sh` (setup.sh:247)

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

This is the official Ollama install method, but it runs an arbitrary script from the internet as the current user (or root if sudoed). Standard practice for this tool, but worth a comment noting the trust assumption.

### m6. `_model_available` for ollama (setup.sh:408) may false-negative

```bash
ollama list 2>/dev/null | grep -q "^${1}[[:space:]]"
```

If Ollama's service is not running yet (it was just installed), `ollama list` will fail or return nothing. The sort-installed-first logic would then put all models in the "not installed" bucket even if they are pulled.

### m7. Error swallowed silently in uninstall settings cleanup (uninstall.ts:79)

```typescript
} catch {}
```

If `settings.json` contains invalid JSON, the error is silently swallowed and the file is left as-is. A warning would be helpful.

---

## LGTM Sections

- **Idempotency of install.ts**: The `mergeClaudeSettings` function correctly checks for existing hooks before adding, and `mkdirSync` uses `{ recursive: true }`. Re-running install is safe.

- **Idempotency of setup.sh**: cipher.yml creation vs update paths are well-separated. Service starts are guarded by health checks. Backend detection with `_ORIGINAL_XGH_BACKEND` preserving user intent is thoughtful.

- **Dependency injection in install.ts/uninstall.ts**: The `ServiceDeps`/`TeardownDeps` pattern makes these functions testable without hitting the filesystem or spawning processes.

- **Daemon service setup**: Both launchd and systemd paths are well-structured, with proper unload-before-load idempotency on macOS and daemon-reload on Linux.

- **Build pipeline**: `tsc && cp installer/setup.sh dist/installer/setup.sh` correctly handles the bash file that tsc cannot compile. The `prepare` script ensures builds run on `npm install -g`.

- **Model selection UX**: The interactive picker with auto-detection, installed-first sorting, and current-config highlighting is a good user experience. The fallback to env vars for CI is well-handled.

- **DaemonClient**: Clean, minimal HTTP client with proper error handling. No issues.

- **deepMerge in config.ts**: Correctly handles nested objects without mutating originals. Array override (not merge) is the right default for config.

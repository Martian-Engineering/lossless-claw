# Installation Flow Fixes — Implementation Plan

**Source review**: `.xgh/specs/installation-flow-review.md`
**Date**: 2026-03-17

Files are grouped so agents can work on each file concurrently. Within each file, fixes are ordered critical → major → minor.

---

## File 1: `installer/uninstall.ts`

### Fix C1 — `removeClaudeSettings` filters on wrong hook shape

The current filter checks `h.command` on the outer entry, but the actual shape is `{ matcher: "", hooks: [{ type: "command", command: "..." }] }`. The filter never matches, so uninstall silently leaves hooks behind.

**Old code** (line 13):
```typescript
    settings.hooks[event] = settings.hooks[event].filter((h: any) => !LC_COMMANDS.has(h.command));
```

**New code**:
```typescript
    settings.hooks[event] = settings.hooks[event].filter(
      (entry: any) => !(Array.isArray(entry.hooks) && entry.hooks.some((h: any) => LC_COMMANDS.has(h.command)))
    );
```

### Fix m7 — Silent catch in `uninstall()` swallows JSON parse errors

**Old code** (line 79):
```typescript
    } catch {}
```

**New code**:
```typescript
    } catch (err) {
      console.warn(`Warning: could not update ${settingsPath}: ${err instanceof Error ? err.message : err}`);
    }
```

### Test changes: `test/installer/uninstall.test.ts`

The existing `removeClaudeSettings` test at line 29-41 uses flat-shaped hook entries (`{ type: "command", command: "..." }`) which match the **buggy** code. Update to use the real nested shape that `mergeClaudeSettings` produces:

**Old test** (lines 29-41):
```typescript
  it("removes lossless-claude hooks and mcpServer", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [{ type: "command", command: "other" }, { type: "command", command: "lossless-claude compact" }],
        SessionStart: [{ type: "command", command: "lossless-claude restore" }],
      },
      mcpServers: { "lossless-claude": {}, "other": {} },
    });
    expect(r.hooks.PreCompact).toHaveLength(1);
    expect(r.hooks.PreCompact[0].command).toBe("other");
    expect(r.hooks.SessionStart).toHaveLength(0);
    expect(r.mcpServers["lossless-claude"]).toBeUndefined();
    expect(r.mcpServers["other"]).toBeDefined();
  });
```

**New test**:
```typescript
  it("removes lossless-claude hooks and mcpServer", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: "other" }] },
          { matcher: "", hooks: [{ type: "command", command: "lossless-claude compact" }] },
        ],
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "lossless-claude restore" }] },
        ],
      },
      mcpServers: { "lossless-claude": {}, "other": {} },
    });
    expect(r.hooks.PreCompact).toHaveLength(1);
    expect(r.hooks.PreCompact[0].hooks[0].command).toBe("other");
    expect(r.hooks.SessionStart).toHaveLength(0);
    expect(r.mcpServers["lossless-claude"]).toBeUndefined();
    expect(r.mcpServers["other"]).toBeDefined();
  });

  it("removes entry when any sub-hook matches a lossless-claude command", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: "something-else" }, { type: "command", command: "lossless-claude compact" }] },
        ],
      },
      mcpServers: {},
    });
    expect(r.hooks.PreCompact).toHaveLength(0);
  });
```

---

## File 2: `installer/install.ts`

### Fix C2 — Hard exit on missing `ANTHROPIC_API_KEY`

The API key is only needed at daemon runtime (it reads from `process.env`). A hard exit after `setup.sh` already ran leaves a confusing half-installed state.

**Old code** (lines 179-183):
```typescript
  // 2. Check ANTHROPIC_API_KEY
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(`ERROR: ANTHROPIC_API_KEY environment variable is not set.`);
    process.exit(1);
  }
```

**New code**:
```typescript
  // 2. Check ANTHROPIC_API_KEY
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. The daemon will need it at runtime — export it in your shell profile.");
  }
```

### Fix M1 — API key written to disk in plaintext

`loadDaemonConfig("/nonexistent")` reads `process.env.ANTHROPIC_API_KEY` and bakes it into the returned config, which then gets written to `config.json`.

**Old code** (lines 185-192):
```typescript
  // 3. Create config.json if not present
  const configPath = join(lcDir, "config.json");
  if (!deps.existsSync(configPath)) {
    const { loadDaemonConfig } = await import("../src/daemon/config.js");
    const defaults = loadDaemonConfig("/nonexistent");
    deps.writeFileSync(configPath, JSON.stringify(defaults, null, 2));
    console.log(`Created ${configPath}`);
  }
```

**New code**:
```typescript
  // 3. Create config.json if not present
  const configPath = join(lcDir, "config.json");
  if (!deps.existsSync(configPath)) {
    const { loadDaemonConfig } = await import("../src/daemon/config.js");
    const defaults = loadDaemonConfig("/nonexistent");
    // Never persist the API key to disk — the daemon reads it from env at runtime
    defaults.llm.apiKey = "";
    deps.writeFileSync(configPath, JSON.stringify(defaults, null, 2));
    console.log(`Created ${configPath}`);
  }
```

### Fix m4 — `which` vs `command -v` in `resolveBinaryPath`

**Old code** (line 55):
```typescript
  const result = deps.spawnSync("which", ["lossless-claude"], { encoding: "utf-8" });
```

**New code**:
```typescript
  const result = deps.spawnSync("command", ["-v", "lossless-claude"], { encoding: "utf-8" });
```

> Note: `command -v` is a shell built-in, so it must be invoked through a shell. If the `spawnSync` approach doesn't work with `command -v` directly, wrap it:

**Alternative new code** (if direct invocation fails):
```typescript
  const result = deps.spawnSync("sh", ["-c", "command -v lossless-claude"], { encoding: "utf-8" });
```

### Test changes: `test/installer/install.test.ts`

1. **Update the `install` test to NOT require `ANTHROPIC_API_KEY`** — since the fix changes it from a hard exit to a warning, tests should verify the warning is emitted without the key:

Add a new test after the existing `install` describe block (around line 211):
```typescript
  it("warns but continues when ANTHROPIC_API_KEY is not set", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const deps = makeDeps({ existsSync: vi.fn().mockReturnValue(false) });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(install(deps)).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("ANTHROPIC_API_KEY"));
    warnSpy.mockRestore();
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  });
```

2. **Update `resolveBinaryPath` tests** — the test at line 62 checks `which` via `makeSpawn`. If switching to `sh -c "command -v ..."`, update accordingly:

**Old** (line 63):
```typescript
      spawnSync: makeSpawn(0, "/usr/local/bin/lossless-claude\n"),
```

No change needed to mock values, but verify the first arg is now `"sh"` if using the alternative approach. If using `command -v` directly, verify first arg is `"command"`.

---

## File 3: `bin/lossless-claude.ts`

### Fix M2 — Daemon port hardcoded to 3737

Both `compact` and `restore` cases create `new DaemonClient("http://127.0.0.1:3737")` but the config allows `daemon.port` to be customized.

**Old code** (lines 31-48):
```typescript
    case "compact": {
      const { handlePreCompact } = await import("../src/hooks/compact.js");
      const { DaemonClient } = await import("../src/daemon/client.js");
      const input = await readStdin();
      const r = await handlePreCompact(input, new DaemonClient("http://127.0.0.1:3737"));
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
      break;
    }
    case "restore": {
      const { handleSessionStart } = await import("../src/hooks/restore.js");
      const { DaemonClient } = await import("../src/daemon/client.js");
      const input = await readStdin();
      const r = await handleSessionStart(input, new DaemonClient("http://127.0.0.1:3737"));
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
      break;
    }
```

**New code**:
```typescript
    case "compact": {
      const { handlePreCompact } = await import("../src/hooks/compact.js");
      const { DaemonClient } = await import("../src/daemon/client.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const port = config.daemon?.port ?? 3737;
      const input = await readStdin();
      const r = await handlePreCompact(input, new DaemonClient(`http://127.0.0.1:${port}`));
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
      break;
    }
    case "restore": {
      const { handleSessionStart } = await import("../src/hooks/restore.js");
      const { DaemonClient } = await import("../src/daemon/client.js");
      const { loadDaemonConfig } = await import("../src/daemon/config.js");
      const { join } = await import("node:path");
      const { homedir } = await import("node:os");
      const config = loadDaemonConfig(join(homedir(), ".lossless-claude", "config.json"));
      const port = config.daemon?.port ?? 3737;
      const input = await readStdin();
      const r = await handleSessionStart(input, new DaemonClient(`http://127.0.0.1:${port}`));
      if (r.stdout) stdout.write(r.stdout);
      exit(r.exitCode);
      break;
    }
```

**Refactoring note**: The `daemon` case (lines 17-29) already does this exact import pattern. Consider extracting a helper to reduce duplication, but that is optional and can be a follow-up.

---

## File 4: `package.json`

### Fix C3 — `claude.plugin.json` in `files` array but does not exist

The file `claude.plugin.json` does not exist in the repo. Remove it from the `files` array.

**Old code** (lines 24-30):
```json
  "files": [
    "dist/",
    "claude.plugin.json",
    "docs/",
    "README.md",
    "LICENSE"
  ],
```

**New code**:
```json
  "files": [
    "dist/",
    "docs/",
    "README.md",
    "LICENSE"
  ],
```

### Test changes: `test/package-config.test.ts`

Consider adding a test that asserts all entries in `files` actually exist. This is optional but prevents regressions:

```typescript
  it("all files entries exist or are directories", async () => {
    const { existsSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    for (const entry of pkg.files) {
      expect(existsSync(join(root, entry)), `${entry} should exist`).toBe(true);
    }
  });
```

---

## File 5: `installer/setup.sh`

### Fix M3 — `XGH_REMOTE_URL` not sanitized before YAML heredoc

The URL is interpolated directly into `cipher.yml` heredocs at lines 637 and 643. A URL with YAML metacharacters could corrupt the file.

**Add validation after the existing `https?://` check** (after line 99, before line 100):

**Old code** (lines 96-99):
```bash
  if [[ ! "$XGH_REMOTE_URL" =~ ^https?:// ]]; then
    error "XGH_REMOTE_URL must start with http:// or https://"
    exit 1
  fi
```

**New code**:
```bash
  if [[ ! "$XGH_REMOTE_URL" =~ ^https?:// ]]; then
    error "XGH_REMOTE_URL must start with http:// or https://"
    exit 1
  fi
  # Reject URLs with characters that could corrupt YAML or enable injection
  if [[ "$XGH_REMOTE_URL" =~ [^a-zA-Z0-9:/._@~%-] ]]; then
    error "XGH_REMOTE_URL contains invalid characters — only alphanumerics, :, /, ., _, @, ~, and - are allowed"
    exit 1
  fi
```

### Fix m1 — Plist patching is brittle (string replacement on XML)

Replace the Python-based XML string replacement with `/usr/libexec/PlistBuddy` which is available on all macOS systems.

**Old code** (lines 163-185):
```bash
    if [ -f "$_QDRANT_PLIST" ]; then
      # Inject MALLOC_CONF if not already present
      if ! grep -q "MALLOC_CONF" "$_QDRANT_PLIST" 2>/dev/null; then
        if command -v python3 &>/dev/null; then
          python3 - "$_QDRANT_PLIST" <<'PYEOF'
import sys, re
path = sys.argv[1]
content = open(path).read()
if '<key>MALLOC_CONF</key>' not in content:
    inject = '''    <key>EnvironmentVariables</key>
    <dict>
        <key>MALLOC_CONF</key>
        <string>background_thread:false</string>
    </dict>
'''
    content = content.replace('</dict>\n</plist>', inject + '</dict>\n</plist>')
    open(path, 'w').write(content)
    print('Patched MALLOC_CONF into', path)
PYEOF
          info "Qdrant plist: injected MALLOC_CONF=background_thread:false"
        else
          warn "python3 not found — skipping Qdrant plist MALLOC_CONF patch (memory performance may be affected)"
        fi
      fi
    fi
```

**New code**:
```bash
    if [ -f "$_QDRANT_PLIST" ]; then
      # Inject MALLOC_CONF if not already present (using PlistBuddy for safe XML manipulation)
      if ! /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:MALLOC_CONF" "$_QDRANT_PLIST" &>/dev/null; then
        /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables dict" "$_QDRANT_PLIST" 2>/dev/null || true
        /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:MALLOC_CONF string background_thread:false" "$_QDRANT_PLIST" \
          && info "Qdrant plist: injected MALLOC_CONF=background_thread:false" \
          || warn "Could not patch Qdrant plist — add MALLOC_CONF=background_thread:false manually"
      fi
    fi
```

### Fix m2 — WAL lock race (delete before service stop, not before start)

The `find -delete` runs at line 189, then Qdrant is started at lines 192-203. There is a race if Qdrant from a previous run is still shutting down. Move the lock deletion **before** the Qdrant health check/start block, and stop any running Qdrant first.

**Old code** (lines 188-203):
```bash
    # Clear stale WAL locks before starting (harmless if clean)
    find "${_QDRANT_STORAGE}" -path "*/wal/open-*" -delete 2>/dev/null || true

    # Start Qdrant as a background service if not already running
    if ! curl -sf http://localhost:6333/healthz >/dev/null 2>&1; then
      info "Starting Qdrant background service..."
      if [ -f "$_QDRANT_PLIST" ]; then
        launchctl unload "$_QDRANT_PLIST" 2>/dev/null || true
        launchctl load "$_QDRANT_PLIST" 2>/dev/null \
          || warn "Could not load Qdrant plist — start manually: launchctl load ${_QDRANT_PLIST}"
      else
        brew services start qdrant 2>/dev/null || warn "Could not start Qdrant service — start manually: brew services start qdrant"
      fi
    else
      info "Qdrant is already running"
    fi
```

**New code**:
```bash
    # Start Qdrant as a background service if not already running
    if ! curl -sf http://localhost:6333/healthz >/dev/null 2>&1; then
      info "Starting Qdrant background service..."
      # Stop any lingering Qdrant process before cleaning WAL locks
      if [ -f "$_QDRANT_PLIST" ]; then
        launchctl unload "$_QDRANT_PLIST" 2>/dev/null || true
      fi
      # Clear stale WAL locks after service is stopped (harmless if clean)
      find "${_QDRANT_STORAGE}" -path "*/wal/open-*" -delete 2>/dev/null || true
      # Now start fresh
      if [ -f "$_QDRANT_PLIST" ]; then
        launchctl load "$_QDRANT_PLIST" 2>/dev/null \
          || warn "Could not load Qdrant plist — start manually: launchctl load ${_QDRANT_PLIST}"
      else
        brew services start qdrant 2>/dev/null || warn "Could not start Qdrant service — start manually: brew services start qdrant"
      fi
    else
      info "Qdrant is already running"
    fi
```

### Fix m5 — Ollama pipe to `sh` trust comment

**Old code** (line 247):
```bash
        curl -fsSL https://ollama.com/install.sh | sh
```

**New code**:
```bash
        # Trust: official Ollama install script — https://github.com/ollama/ollama#install
        curl -fsSL https://ollama.com/install.sh | sh
```

### Fix m6 — Ollama list false-negative after fresh install

After installing Ollama, the service may not be running yet, so `ollama list` returns nothing. Add a startup wait before model availability checks.

**Old code** (line 408):
```bash
    _model_available() { ollama list 2>/dev/null | grep -q "^${1}[[:space:]]"; }
```

**New code**:
```bash
    _model_available() {
      # Ensure Ollama service is reachable before listing models
      if ! curl -sf --max-time 2 http://localhost:11434 >/dev/null 2>&1; then
        return 1
      fi
      ollama list 2>/dev/null | grep -q "^${1}[[:space:]]"
    }
```

---

## File 6: (no file change) — `src/daemon/config.ts`

No changes needed. The `loadDaemonConfig` function correctly reads `process.env.ANTHROPIC_API_KEY` at runtime. The M1 fix in `install.ts` prevents the key from being persisted.

---

## Implementation Order

For **sequential** execution (single agent):

| Step | File | Fixes | Priority |
|------|------|-------|----------|
| 1 | `installer/uninstall.ts` + test | C1, m7 | Critical + Minor |
| 2 | `installer/install.ts` + test | C2, M1, m4 | Critical + Major + Minor |
| 3 | `package.json` | C3 | Critical |
| 4 | `bin/lossless-claude.ts` | M2 | Major |
| 5 | `installer/setup.sh` | M3, m1, m2, m5, m6 | Major + Minor |

For **parallel** execution (multiple agents), all 5 steps can run concurrently since they touch different files.

---

## Verification

After all fixes are applied, run:

```bash
npm run build && npm test
```

Specific test files to watch:
- `test/installer/uninstall.test.ts` — verifies C1 fix (hook shape)
- `test/installer/install.test.ts` — verifies C2 fix (no hard exit) and M1 fix (no API key on disk)
- `test/package-config.test.ts` — verifies C3 fix (optional new test)
- `test/daemon/config.test.ts` — should pass unchanged (M1 fix is in install.ts, not config.ts)

Manual smoke tests:
- `ANTHROPIC_API_KEY= npx lossless-claude install` — should warn but complete (C2)
- Inspect `~/.lossless-claude/config.json` — `llm.apiKey` should be `""` (M1)
- Change `daemon.port` in config.json to `4000`, run `lossless-claude compact` — should connect to port 4000 (M2)
- `npx lossless-claude uninstall` then check `~/.claude/settings.json` — hooks should be gone (C1)

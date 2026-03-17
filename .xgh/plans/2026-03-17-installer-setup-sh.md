# lossless-claude: Installer setup.sh Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `installer/setup.sh` so that `lossless-claude install` self-sufficiently sets up the full memory stack (backend, models, Qdrant, cipher.yml) before wiring Claude Code integration.

**Architecture:** A bash script (`installer/setup.sh`) is a near-verbatim copy of the relevant sections of xgh's `install.sh`. `install.ts` invokes it as step 0 (non-fatal) before its existing TypeScript steps. The build script copies the shell script to `dist/` so it ships with the npm package. All work is done on a branch and submitted as a PR.

**Tech Stack:** Bash, TypeScript/ESM, `node:child_process` (`spawnSync`), `node:url` (`fileURLToPath`), Vitest.

---

## File Map

| File | Change |
|---|---|
| `installer/setup.sh` | **Create** — bash script copied from xgh's install.sh |
| `installer/install.ts` | **Modify** — thread `deps` into `install()`, add step 0, soften cipher guard |
| `package.json` | **Modify** — build script copies setup.sh to dist/ |
| `test/installer/install.test.ts` | **Modify** — add tests for deps threading, softened guard, setup.sh invocation |

---

## Task 0: Create branch

- [ ] **Step 1: Create and check out branch**

```bash
cd /Users/pedro/Developer/lossless-claude
git checkout -b feat/installer-setup-sh
```

---

## Task 1: Update build script to ship setup.sh

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update build script**

Open `package.json`. Change:
```json
"build": "tsc",
```
to:
```json
"build": "tsc && cp installer/setup.sh dist/installer/setup.sh",
```

- [ ] **Step 2: Commit**

```bash
git add package.json
git commit -m "build: copy setup.sh to dist during tsc build"
```

---

## Task 2: Thread `deps` into `install()` and soften cipher guard

`install()` currently calls module-level `existsSync`/`mkdirSync`/`writeFileSync` directly. Tasks 3 and 4 need `deps` injection so tests can mock `existsSync` and `spawnSync`. Do this first.

**Files:**
- Modify: `installer/install.ts`
- Modify: `test/installer/install.test.ts`

- [ ] **Step 1: Write failing tests**

In `test/installer/install.test.ts`, add a new `describe("install()", ...)` block (or append to the existing one — check what's already there):

```typescript
it("accepts deps parameter and warns when cipher.yml is missing", async () => {
  const deps = makeDeps({ existsSync: vi.fn().mockReturnValue(false) });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(install(deps)).resolves.not.toThrow();
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cipher.yml"));
  warnSpy.mockRestore();
});
```

Make sure `install` is imported from `../../installer/install.js` in the test file.

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/installer/install.test.ts
```
Expected: TypeScript compile error or runtime failure — `install` doesn't accept `deps` yet.

- [ ] **Step 3: Update `install()` signature and internals**

In `installer/install.ts`:

1. Add `install` to the `ServiceDeps` usage — update the function signature:
```typescript
export async function install(deps: ServiceDeps = defaultDeps): Promise<void> {
```

2. Replace all bare `existsSync(...)` calls inside `install()` with `deps.existsSync(...)`.

3. Replace all bare `mkdirSync(...)` calls inside `install()` with `deps.mkdirSync(...)`.

4. Replace all bare `writeFileSync(...)` calls inside `install()` with `deps.writeFileSync(...)`.

5. Replace the `process.exit(1)` cipher guard with a warning:
```typescript
// Before:
if (!existsSync(cipherConfig)) {
  console.error(`ERROR: ~/.cipher/cipher.yml not found. Install Cipher first.`);
  process.exit(1);
}

// After:
if (!deps.existsSync(cipherConfig)) {
  console.warn("Warning: ~/.cipher/cipher.yml not found — semantic search will be unavailable until setup completes");
}
```

Note: `setupDaemonService(deps)` is already called with `deps` — no change needed there.

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- test/installer/install.test.ts
```
Expected: PASS.

- [ ] **Step 5: Run full suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add installer/install.ts test/installer/install.test.ts
git commit -m "refactor: thread deps into install(), soften cipher.yml guard to warn-and-continue"
```

---

## Task 3: Create `installer/setup.sh`

**Files:**
- Create: `installer/setup.sh`

This script is a near-verbatim extraction from xgh's `install.sh` at `/Users/pedro/Developer/xgh/install.sh`. Copy these sections **in order**. Use the comment strings below as exact grep anchors to find section boundaries.

**Sections to copy:**

| Anchor (grep for this string) | End boundary | What to include |
|---|---|---|
| Top of file through `# ── 0. Backend` | First line of `# ── 0. Backend / remote URL picker` | Color/formatting vars (`BOLD`, `NC`, `DIM`, `GREEN`, `CYAN`, `RED`), `info`/`warn`/`lane` functions |
| `# ── 0. Backend / remote URL picker` | `# ── 1. Dependencies` | Full backend detection block (vllm-mlx / Ollama / remote picker) |
| `# ── Backend-specific dependencies` inside `§1` | First line of `# ── 2. Model Selection` | Backend-specific installs only: vllm-mlx path (`uv`, vllm-mlx, Qdrant brew + launchd), Ollama path (Ollama install, Qdrant binary + systemd), remote path (Qdrant local). **Exclude** the Node.js and Python3 checks at the top of `§1` — those are xgh-specific. |
| `# ── 2. Model Selection` | `# ── 3. Fetch xgh pack` | Full model selection block including HF cache detection, pickers, model pulling |
| `# -- cipher.yml (cipher agent config` | `[ -f "${HOME}/.cipher/cipher.yml" ] && _cipher_checks` | The `CIPHER_YML` write/sync block only. **Stop before** `_cipher_checks` line. Do **not** copy cipher npm install, cipher-mcp wrapper, fix-openai-embeddings.js, or qdrant-store.js. |

**Script structure:**

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Colors / helpers ──────────────────────────────────────────────────────────
# (copy from xgh install.sh top)

# ── Dry run guard ─────────────────────────────────────────────────────────────
XGH_DRY_RUN="${XGH_DRY_RUN:-0}"
if [ "$XGH_DRY_RUN" -eq 1 ]; then
  echo "lossless-claude setup.sh: DRY_RUN=1, skipping all installs"
  exit 0
fi

# ── 0. Backend picker ─────────────────────────────────────────────────────────
# (copy §0 from xgh install.sh)

# ── 1. Backend-specific dependencies ──────────────────────────────────────────
# (copy backend-specific block from §1 of xgh install.sh)

# ── 2. Model selection ────────────────────────────────────────────────────────
# (copy §2 from xgh install.sh)

# ── 3. cipher.yml generation ──────────────────────────────────────────────────
# (copy CIPHER_YML block from §3b of xgh install.sh)
```

- [ ] **Step 1: Create `installer/setup.sh`**

Copy exactly as described. Make executable:
```bash
chmod +x installer/setup.sh
```

- [ ] **Step 2: Smoke-test dry run**

```bash
XGH_DRY_RUN=1 bash installer/setup.sh
```
Expected: prints "DRY_RUN=1, skipping all installs" and exits 0 with no errors.

- [ ] **Step 3: Run build and verify setup.sh lands in dist**

```bash
npm run build
ls dist/installer/setup.sh
```
Expected: file present.

- [ ] **Step 4: Commit**

```bash
git add installer/setup.sh
git commit -m "feat: add installer/setup.sh — backend, model, Qdrant, cipher.yml setup"
```

---

## Task 4: Invoke `setup.sh` as step 0 in `install()`

**Files:**
- Modify: `installer/install.ts`
- Modify: `test/installer/install.test.ts`

- [ ] **Step 1: Write failing tests**

In `test/installer/install.test.ts`, add to the `install()` describe block:

```typescript
it("invokes setup.sh as step 0 before other steps", async () => {
  const spawnMock = makeSpawn(0);
  const deps = makeDeps({ spawnSync: spawnMock, existsSync: vi.fn().mockReturnValue(false) });
  await install(deps);
  const firstCall = spawnMock.mock.calls[0];
  expect(firstCall[0]).toBe("bash");
  expect(firstCall[1][0]).toContain("setup.sh");
});

it("continues when setup.sh exits non-zero", async () => {
  const deps = makeDeps({
    spawnSync: makeSpawn(1),
    existsSync: vi.fn().mockReturnValue(false),
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await expect(install(deps)).resolves.not.toThrow();
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("setup.sh"));
  warnSpy.mockRestore();
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- test/installer/install.test.ts
```
Expected: FAIL — setup.sh not yet invoked.

- [ ] **Step 3: Add step 0 to `install()`**

In `installer/install.ts`, add imports at the top if not already present:
```typescript
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
```

At the very start of `install()` body (before `deps.mkdirSync(lcDir)`), add:
```typescript
// Step 0: infrastructure setup (backend, models, Qdrant, cipher.yml)
const setupScript = join(dirname(fileURLToPath(import.meta.url)), "setup.sh");
const setupResult = deps.spawnSync("bash", [setupScript], { stdio: "inherit", env: process.env });
if (setupResult.status !== 0) {
  console.warn(`Warning: setup.sh exited with code ${setupResult.status} — continuing`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test -- test/installer/install.test.ts
```
Expected: PASS.

- [ ] **Step 5: Run full test suite**

```bash
npm test
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add installer/install.ts test/installer/install.test.ts
git commit -m "feat: invoke setup.sh as step 0 in lossless-claude install()"
```

---

## Task 5: End-to-end verification and PR

- [ ] **Step 1: Full build**

```bash
npm run build
ls dist/installer/setup.sh
```
Expected: no errors; file present.

- [ ] **Step 2: Dry-run install**

`XGH_DRY_RUN=1` causes `setup.sh` to exit immediately. The TypeScript steps still run (config.json write, settings.json merge, daemon service). `ANTHROPIC_API_KEY` must be set for the TypeScript steps to complete without error.

```bash
XGH_DRY_RUN=1 ANTHROPIC_API_KEY=test node dist/bin/lossless-claude.js install
```
Expected: "DRY_RUN=1, skipping all installs" from setup.sh, then TypeScript steps proceed, warning about missing cipher.yml (since we skipped setup), no hard exit.

- [ ] **Step 3: All tests pass**

```bash
npm test
```
Expected: all tests green.

- [ ] **Step 4: Push branch and open PR**

```bash
git push -u origin feat/installer-setup-sh
gh pr create \
  --title "feat: add installer/setup.sh — self-contained memory stack setup" \
  --body "$(cat <<'EOF'
## Summary

- Adds `installer/setup.sh`: near-verbatim copy of backend detection, model selection, Qdrant setup, and cipher.yml generation from xgh's installer
- `lossless-claude install` now runs `setup.sh` as step 0 before the TypeScript Claude Code integration steps
- Build script copies `setup.sh` to `dist/installer/` so it ships with the npm package
- Softens `~/.cipher/cipher.yml` hard-exit guard to warn-and-continue (setup.sh now owns cipher.yml creation)
- `install()` now accepts a `deps` parameter for full testability

## Test plan
- [ ] `XGH_DRY_RUN=1 bash installer/setup.sh` exits 0 with skip message
- [ ] `npm run build && ls dist/installer/setup.sh` — file present
- [ ] `npm test` — all tests pass
- [ ] `XGH_DRY_RUN=1 ANTHROPIC_API_KEY=test node dist/bin/lossless-claude.js install` — no hard exit

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

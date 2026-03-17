# lossless-claude: Installer setup.sh Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `installer/setup.sh` so that `lossless-claude install` self-sufficiently sets up the full memory stack (backend, models, Qdrant, cipher.yml) before wiring Claude Code integration.

**Architecture:** A bash script (`installer/setup.sh`) is a near-verbatim copy of the relevant sections of xgh's `install.sh`. `install.ts` invokes it as step 0 (non-fatal) before its existing TypeScript steps. The build script copies the shell script to `dist/` so it ships with the npm package.

**Tech Stack:** Bash, TypeScript/ESM, `node:child_process` (`spawnSync`), `node:url` (`fileURLToPath`), Vitest.

---

## File Map

| File | Change |
|---|---|
| `installer/setup.sh` | **Create** — bash script copied from xgh's install.sh |
| `installer/install.ts` | **Modify** — add step 0 (invoke setup.sh), soften cipher guard |
| `package.json` | **Modify** — build script copies setup.sh to dist/ |
| `test/installer/install.test.ts` | **Modify** — add test for setup.sh invocation |

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

- [ ] **Step 2: Run build to verify setup.sh lands in dist**

```bash
npm run build
ls dist/installer/setup.sh
```
Expected: file exists at `dist/installer/setup.sh`.

Note: `setup.sh` doesn't exist yet — this step will fail until Task 2 completes. That's expected. Come back and verify after Task 2.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build: copy setup.sh to dist during tsc build"
```

---

## Task 2: Create `installer/setup.sh`

**Files:**
- Create: `installer/setup.sh`

This script is a near-verbatim extraction from xgh's `install.sh`. Copy these sections **exactly**, in order, into a single standalone script. Do NOT copy cipher-specific parts (cipher npm install, cipher-mcp wrapper, fix-openai-embeddings.js, qdrant-store.js).

**Sections to copy from `/Users/pedro/Developer/xgh/install.sh`:**

| Lines | Content |
|---|---|
| Top of file → line ~45 | Color/formatting helpers (`BOLD`, `NC`, `DIM`, `GREEN`, etc.), `info`/`warn`/`lane` functions |
| Lines ~46–100 | `§0` Backend picker (detects vllm-mlx/Ollama/remote; reads `XGH_BACKEND`) |
| Lines ~101–281 | `§1` Dependencies — backend-specific only: vllm-mlx (`uv`, vllm-mlx, Qdrant via brew + launchd), Ollama (install, Qdrant binary + systemd), remote (Qdrant local). **Exclude** the Node.js/Python3 checks (those are xgh-specific). |
| Lines ~282–583 | `§2` Model selection — full interactive picker, HF cache detection, model pulling |
| Lines ~862–1028 | cipher.yml generation block from `§3b` — the `CIPHER_YML` write/sync logic only. **Exclude** lines ~584–861 (cipher npm, cipher-mcp wrapper, fix-openai-embeddings.js, qdrant-store.js). |

**Script structure:**

```bash
#!/usr/bin/env bash
set -euo pipefail

# ── Colors / helpers ─────────────────────────────────────────────────────────
# (copy from xgh install.sh)

# ── Dry run guard ─────────────────────────────────────────────────────────────
XGH_DRY_RUN="${XGH_DRY_RUN:-0}"
if [ "$XGH_DRY_RUN" -eq 1 ]; then
  echo "lossless-claude setup.sh: DRY_RUN=1, skipping all installs"
  exit 0
fi

# ── 0. Backend picker ─────────────────────────────────────────────────────────
# (copy §0 from xgh install.sh)

# ── 1. Backend-specific dependencies ─────────────────────────────────────────
# (copy §1 backend-specific block from xgh install.sh)

# ── 2. Model selection ────────────────────────────────────────────────────────
# (copy §2 from xgh install.sh)

# ── 3. cipher.yml generation ──────────────────────────────────────────────────
# (copy CIPHER_YML block from §3b of xgh install.sh)
```

- [ ] **Step 1: Create `installer/setup.sh`**

Copy exactly as described above. Make it executable:
```bash
chmod +x installer/setup.sh
```

- [ ] **Step 2: Run build and verify**

```bash
npm run build
ls -la dist/installer/setup.sh
```
Expected: file present and executable bit preserved is NOT required (npm won't execute it directly; `spawnSync("bash", [...])` handles execution).

- [ ] **Step 3: Smoke-test dry run**

```bash
XGH_DRY_RUN=1 bash installer/setup.sh
```
Expected: prints "DRY_RUN=1, skipping all installs" and exits 0.

- [ ] **Step 4: Commit**

```bash
git add installer/setup.sh
git commit -m "feat: add installer/setup.sh — backend, model, Qdrant, cipher.yml setup"
```

---

## Task 3: Soften cipher guard in `install.ts`

**Files:**
- Modify: `installer/install.ts`

- [ ] **Step 1: Write the failing test**

In `test/installer/install.test.ts`, add to the `install()` describe block:

```typescript
it("warns but continues when cipher.yml is missing", async () => {
  const deps = makeDeps({
    existsSync: vi.fn().mockReturnValue(false), // cipher.yml absent
    spawnSync: makeSpawn(0),
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // Should not throw
  await expect(install(deps)).resolves.not.toThrow();
  expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cipher.yml"));
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/installer/install.test.ts
```
Expected: FAIL — currently `process.exit(1)` is called.

- [ ] **Step 3: Soften the cipher guard**

In `installer/install.ts`, find:
```typescript
if (!existsSync(cipherConfig)) {
  console.error(`ERROR: ~/.cipher/cipher.yml not found. Install Cipher first.`);
  process.exit(1);
}
```

Replace with:
```typescript
if (!existsSync(cipherConfig)) {
  console.warn("Warning: ~/.cipher/cipher.yml not found — semantic search will be unavailable until setup completes");
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- test/installer/install.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add installer/install.ts test/installer/install.test.ts
git commit -m "fix: soften cipher.yml guard to warn-and-continue in install()"
```

---

## Task 4: Invoke `setup.sh` as step 0 in `install.ts`

**Files:**
- Modify: `installer/install.ts`
- Modify: `test/installer/install.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/installer/install.test.ts`, add to the `install()` describe block:

```typescript
it("invokes setup.sh as step 0 before creating config", async () => {
  const spawnMock = makeSpawn(0);
  const deps = makeDeps({ spawnSync: spawnMock, existsSync: vi.fn().mockReturnValue(false) });
  await install(deps);
  // First spawnSync call should be "bash" with setup.sh path
  const firstCall = spawnMock.mock.calls[0];
  expect(firstCall[0]).toBe("bash");
  expect(firstCall[1][0]).toContain("setup.sh");
});

it("continues when setup.sh exits non-zero", async () => {
  const deps = makeDeps({
    spawnSync: makeSpawn(1), // setup.sh fails
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

In `installer/install.ts`, add imports at the top:
```typescript
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
```

At the start of the `install()` function body (before `mkdirSync(lcDir)`), add:
```typescript
// Step 0: infrastructure setup (backend, models, Qdrant, cipher.yml)
const setupScript = join(dirname(fileURLToPath(import.meta.url)), "setup.sh");
const setupResult = spawnSync("bash", [setupScript], { stdio: "inherit", env: process.env });
if (setupResult.status !== 0) {
  console.warn(`Warning: setup.sh exited with code ${setupResult.status} — continuing`);
}
```

Note: `install()` currently takes no arguments but the tests use `deps` injection. Check whether `install.ts` already accepts a `deps` parameter for `spawnSync`. If it does not, add a `deps` parameter with `defaultDeps` fallback — same pattern as `setupDaemonService`.

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

## Task 5: End-to-end verification

- [ ] **Step 1: Full build**

```bash
npm run build
```
Expected: no errors; `dist/installer/setup.sh` exists.

- [ ] **Step 2: Dry-run install**

```bash
XGH_DRY_RUN=1 node dist/bin/lossless-claude.js install
```
Expected: prints "DRY_RUN=1, skipping all installs", then proceeds with TypeScript steps (config.json, settings.json merge, daemon service) — no cipher.yml hard-exit.

- [ ] **Step 3: All tests pass**

```bash
npm test
```
Expected: all tests green.

- [ ] **Step 4: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: e2e verification fixes for installer setup.sh"
```

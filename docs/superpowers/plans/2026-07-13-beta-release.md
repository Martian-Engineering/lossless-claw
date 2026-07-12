# Lossless Claw Beta Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish canonical `main` as `@martian-engineering/lossless-claw@0.14.0-beta.0` while keeping npm `latest` on `0.13.2`.

**Architecture:** A dependency-free Node helper classifies stable and beta SemVer versions and emits GitHub Actions outputs. The publish workflow consumes those outputs to select the npm dist-tag and GitHub prerelease flag; Changesets remains the source of package version and changelog truth.

**Tech Stack:** Node.js 22, Vitest, Changesets, npm, GitHub Actions, GitHub CLI.

## Global Constraints

- Canonical repository: `Martian-Engineering/lossless-claw`.
- Target version: `0.14.0-beta.0`; target Git tag: `v0.14.0-beta.0`.
- npm must end with `beta=0.14.0-beta.0` and `latest=0.13.2`.
- Unsupported prerelease identifiers such as `rc` must fail closed.
- Do not manually create or move tags if npm publication fails.
- Do not manually repair npm dist-tags in the normal path.
- The `npm-publish` protected environment remains the publication approval gate.
- Do not change OpenClaw compatibility declarations in this release lane.

## Adversarial Hardening Amendment

- Checkout must use immutable `${{ github.sha }}` and verify it equals `HEAD`
  after the protected-environment approval wait.
- npm publication is serialized with `concurrency.group: npm-publish`.
- Before an unpublished version can move `beta` or `latest`, its SemVer must be
  strictly newer than the current version on that same channel.
- Retries may skip npm, tag, or GitHub Release creation only after exact source
  identity and release-kind checks pass; identity mismatches fail closed.
- Beta rollback notes pin the current stable version. Stable rollback notes pin
  the exact previous `latest` version through a source-bound changelog marker
  validated before first publication and reused on retries.
- Stable promotion requires `npx changeset pre exit`, version generation,
  lockfile refresh, exact version checks, and a separately reviewed publish.

---

### Task 1: Add tested release-channel classification

**Files:**
- Create: `scripts/release-channel.mjs`
- Create: `test/release-channel.test.ts`
- Modify: `.github/workflows/publish.yml`

**Interfaces:**
- Consumes: package version string from `package.json`.
- Produces: CLI outputs `npm_tag=<tag>` plus `prerelease=<true|false>` for GitHub Actions. This CLI is the public test seam; its internal classification structure is not part of the contract.

- [ ] **Step 1: Write the failing classifier tests**

```js
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/release-channel.mjs", import.meta.url));

function classify(version) {
  return spawnSync(process.execPath, [script, version], { encoding: "utf8" });
}

describe("release-channel CLI", () => {
  it("routes stable versions to latest", () => {
    const result = classify("0.13.2");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("npm_tag=latest\nprerelease=false\n");
  });

  it("routes beta versions to beta and GitHub prerelease", () => {
    const result = classify("0.14.0-beta.0");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("npm_tag=beta\nprerelease=true\n");
  });

  it.each(["0.14.0-rc.0", "0.14.0-alpha.1", "banana", "1.2"])(
    "rejects unsupported version %s",
    (version) => {
      const result = classify(version);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Unsupported release version: ${version}`);
    },
  );
});
```

- [ ] **Step 2: Run the focused test and confirm it fails because the helper is absent**

Run: `npx vitest run test/release-channel.test.ts`

Expected: FAIL resolving `../scripts/release-channel.mjs`.

- [ ] **Step 3: Implement the dependency-free classifier and CLI**

```js
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;

function classifyReleaseVersion(version) {
  if (STABLE_VERSION.test(version)) {
    return { npmTag: "latest", prerelease: false };
  }
  if (BETA_VERSION.test(version)) {
    return { npmTag: "beta", prerelease: true };
  }
  throw new Error(`Unsupported release version: ${version}`);
}

try {
  const version = process.argv[2];
  const channel = classifyReleaseVersion(version);
  process.stdout.write(`npm_tag=${channel.npmTag}\nprerelease=${channel.prerelease}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
```

- [ ] **Step 4: Wire classifier outputs into publishing and GitHub Release creation**

Replace the package-version step with:

```yaml
      - name: Read package version and release channel
        id: package
        run: |
          version="$(node -p "require('./package.json').version")"
          printf 'version=%s\n' "$version" >> "$GITHUB_OUTPUT"
          node scripts/release-channel.mjs "$version" >> "$GITHUB_OUTPUT"
```

Replace `npm publish` with:

```yaml
        run: npm publish --tag "${{ steps.package.outputs.npm_tag }}"
```

Create the GitHub Release with:

```bash
release_args=(
  --generate-notes
  --notes "$(cat release-notes.md)"
  --verify-tag
)
if [ "${{ steps.package.outputs.prerelease }}" = "true" ]; then
  release_args+=(--prerelease)
fi
gh release create "$tag" "${release_args[@]}"
```

- [ ] **Step 5: Run focused tests and direct CLI checks**

Run:

```bash
npx vitest run test/release-channel.test.ts
node scripts/release-channel.mjs 0.14.0-beta.0
node scripts/release-channel.mjs 0.13.2
! node scripts/release-channel.mjs 0.14.0-rc.0
```

Expected: test PASS; beta emits `npm_tag=beta` and `prerelease=true`; stable emits `npm_tag=latest` and `prerelease=false`; `rc` exits nonzero.

- [ ] **Step 6: Commit the beta-safe publish behavior**

```bash
git add scripts/release-channel.mjs test/release-channel.test.ts .github/workflows/publish.yml
git commit -m "ci: make package publishing beta-safe"
```

### Task 2: Repair release metadata and document the beta lane

**Files:**
- Modify: `.changeset/blue-signs-swim.md`
- Modify: `.changeset/qwen-fresh-tail-overrides.md`
- Modify: `RELEASING.md`

**Interfaces:**
- Consumes: Changesets package key `@martian-engineering/lossless-claw`.
- Produces: a valid release plan and operator instructions for stable versus beta publication.

- [ ] **Step 1: Reproduce the malformed Changesets failure**

Run: `npx changeset status --output /tmp/lossless-claw-release-status.json`

Expected: nonzero with `package lossless-claw which is not in the workspace`.

- [ ] **Step 2: Replace both obsolete package keys**

In each affected changeset, replace:

```yaml
"lossless-claw": patch
```

with:

```yaml
"@martian-engineering/lossless-claw": patch
```

- [ ] **Step 3: Document the beta release flow**

Add a `## Beta releases` section to `RELEASING.md` that requires:

```markdown
## Beta releases

Use a Changesets prerelease when `main` needs broader testing before a stable release:

1. Run `npx changeset pre enter beta` on the reviewed release branch.
2. Run `npm run version-packages` and refresh `package-lock.json`.
3. Review and merge the generated prerelease version and changelog.
4. Dispatch `Publish Package` on the exact merged commit.

The publish workflow maps `X.Y.Z-beta.N` to npm's `beta` dist-tag and marks the GitHub Release as a prerelease. Stable `X.Y.Z` versions map to npm's `latest` dist-tag. Other prerelease identifiers fail closed.

Never use a beta publication to move or repair `latest` manually.
```

- [ ] **Step 4: Verify Changesets accepts all pending metadata**

Run: `npx changeset status --output /tmp/lossless-claw-release-status.json && node -e 'const s=require("/tmp/lossless-claw-release-status.json"); if (!s.releases.some((r)=>r.name==="@martian-engineering/lossless-claw"&&r.type==="minor")) process.exit(1)'`

Expected: exit 0 with a minor release plan.

- [ ] **Step 5: Commit the metadata repair and documentation**

```bash
git add .changeset/blue-signs-swim.md .changeset/qwen-fresh-tail-overrides.md RELEASING.md
git commit -m "fix: restore changesets release planning"
```

### Task 3: Generate the first 0.14 beta

**Files:**
- Create: `.changeset/pre.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Delete: consumed `.changeset/*.md` files as selected by Changesets.

**Interfaces:**
- Consumes: valid pending changesets with a highest bump of `minor`.
- Produces: package and changelog identity `0.14.0-beta.0` in Changesets beta mode.

- [ ] **Step 1: Enter beta prerelease mode**

Run: `npx changeset pre enter beta`

Expected: `.changeset/pre.json` records mode `pre`, tag `beta`, initial version `0.13.2`, and pending changeset names.

- [ ] **Step 2: Generate prerelease versions and changelog**

Run: `npm run version-packages`

Expected: `package.json` becomes `0.14.0-beta.0` and `CHANGELOG.md` gains `## 0.14.0-beta.0`.

- [ ] **Step 3: Refresh and verify lock metadata**

Run:

```bash
npm install --package-lock-only
npm ci --package-lock-only --ignore-scripts
node -e 'const p=require("./package.json"); const l=require("./package-lock.json"); if (p.version!=="0.14.0-beta.0" || l.version!==p.version || l.packages[""].version!==p.version) process.exit(1)'
```

Expected: all three version fields equal `0.14.0-beta.0` and commands exit 0.

- [ ] **Step 4: Verify generated release notes exist**

Run: `awk '$0 == "## 0.14.0-beta.0" { found=1 } END { exit !found }' CHANGELOG.md`

Expected: exit 0.

- [ ] **Step 5: Commit the generated beta release metadata**

```bash
git add .changeset package.json package-lock.json CHANGELOG.md
git commit -m "chore: version packages for 0.14.0-beta.0"
```

### Task 4: Run the complete local release gate

**Files:**
- Verify only; no expected source edits.

**Interfaces:**
- Consumes: the complete beta release branch.
- Produces: clean local release evidence suitable for PR publication.

- [ ] **Step 1: Verify workspace and install exact dependencies**

Run: `pwd && npm ci`

Expected: path is the isolated beta worktree and install exits 0.

- [ ] **Step 2: Run the repository release gate**

Run: `npm run release:verify`

Expected: typecheck, build, all tests, and package dry-run exit 0.

- [ ] **Step 3: Inspect package contents and release-channel identity**

Run:

```bash
npm pack --dry-run --json > /tmp/lossless-claw-beta-pack.json
node -e 'const p=require("/tmp/lossless-claw-beta-pack.json")[0]; if (p.id!=="@martian-engineering/lossless-claw@0.14.0-beta.0") process.exit(1)'
node scripts/release-channel.mjs "$(node -p "require('./package.json').version")"
git diff --check martian/main...HEAD
git status --short
```

Expected: package id is exact, classifier emits beta/prerelease, diff check exits 0, worktree is clean.

### Task 5: Publish, review, and merge the release PR

**Files:**
- External state: branch and pull request in `Martian-Engineering/lossless-claw`.

**Interfaces:**
- Consumes: locally validated branch head.
- Produces: reviewed, exact-head green commit merged to canonical `main`.

- [ ] **Step 1: Re-fetch canonical state and stop on drift**

Run:

```bash
git fetch martian main
test "$(git rev-parse martian/main)" = "421e7cb0606600991edc2feec4b85b22487a974a"
```

Expected: exit 0. If it fails, rebase or merge only after reviewing the new commits and rerunning Task 4.

- [ ] **Step 2: Push the branch and open the PR**

Run:

```bash
git push -u martian release/v0.14.0-beta.0
gh pr create --repo Martian-Engineering/lossless-claw --base main --head release/v0.14.0-beta.0 --title "chore: cut v0.14.0-beta.0" --body-file /tmp/lossless-claw-beta-pr.md
```

Expected: a new non-draft PR URL.

- [ ] **Step 3: Wait for and hydrate exact-head review state**

Run `gh pr checks <PR> --repo Martian-Engineering/lossless-claw --watch`, then inspect PR reviews, review threads, top-level comments, check runs, and annotations for the exact head SHA.

Expected: required CI successful, no unresolved actionable review thread, no release/beta blocker.

- [ ] **Step 4: Re-fetch live PR state immediately before merge**

Expected: same head SHA, non-draft, mergeable/clean, checks successful, and no new blocker.

- [ ] **Step 5: Merge through GitHub**

Run: `gh pr merge <PR> --repo Martian-Engineering/lossless-claw --squash --delete-branch --match-head-commit <HEAD_SHA>`

Expected: PR merged and canonical `main` points to the resulting release commit.

### Task 6: Dispatch and verify the protected beta publication

**Files:**
- External state: GitHub Actions, npm registry, Git tag, and GitHub Release.

**Interfaces:**
- Consumes: exact merged release commit.
- Produces: verified npm beta and GitHub prerelease without stable-channel drift.

- [ ] **Step 1: Rehydrate merged-main and public preconditions**

Confirm package version `0.14.0-beta.0`, no existing tag or npm version, `latest=0.13.2`, and exact merged SHA.

- [ ] **Step 2: Dispatch the protected publish workflow**

Run: `gh workflow run publish.yml --repo Martian-Engineering/lossless-claw --ref main`

Expected: a new workflow run enters queued or waiting state for `npm-publish` approval.

- [ ] **Step 3: Respect the environment approval gate**

If the run is waiting, report the run URL and required `jalehman` approval. Do not bypass, replace, or manually publish.

- [ ] **Step 4: Watch the approved run to completion**

Run: `gh run watch <RUN_ID> --repo Martian-Engineering/lossless-claw --exit-status`

Expected: exit 0 after npm publication, tag push, and GitHub Release creation.

- [ ] **Step 5: Verify public release truth**

Run:

```bash
npm view @martian-engineering/lossless-claw@0.14.0-beta.0 version gitHead dist.integrity --json
npm view @martian-engineering/lossless-claw dist-tags --json
gh release view v0.14.0-beta.0 --repo Martian-Engineering/lossless-claw --json tagName,isPrerelease,isDraft,targetCommitish,url
gh api repos/Martian-Engineering/lossless-claw/git/ref/tags/v0.14.0-beta.0
```

Expected: version exists at the merged SHA, `beta=0.14.0-beta.0`, `latest=0.13.2`, GitHub Release is a non-draft prerelease, and the tag resolves to the published commit.

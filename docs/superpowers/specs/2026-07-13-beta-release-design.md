# Lossless Claw Beta Release Design

## Goal

Publish the current canonical `main` line as an installable prerelease without
moving npm's stable `latest` channel, while preserving the repository's normal
Changesets, CI, protected-environment, tag, and GitHub Release controls.

The target version is `0.14.0-beta.0`. The minor bump is required by the
existing `agent-oriented-cli.md` changeset; the beta suffix identifies this as
the first prerelease for that line.

## Considered Approaches

1. **Raw Git tag from `main`.** Fast, but the package would still declare
   `0.13.2`, which is already published. It would not create an installable npm
   beta and would misalign source, package, and tag identities.
2. **Direct prerelease publish outside the repository workflow.** Technically
   possible for an npm owner, but it bypasses protected-environment approval,
   exact-head CI, release-note generation, and established release provenance.
3. **Changesets prerelease through a beta-safe publish workflow.** Repair the
   pending release metadata, generate a reviewed prerelease version, publish
   with the npm `beta` dist-tag, and create a GitHub prerelease. This is the
   selected approach.

## Release Flow

1. Start from the current canonical `Martian-Engineering/lossless-claw` `main`.
2. Repair changesets that reference the obsolete unscoped package name.
3. Teach `publish.yml` to classify SemVer prereleases before publication:
   - stable versions publish with npm's existing `latest` behavior;
   - prerelease versions publish with `npm publish --tag beta`;
   - prerelease versions create GitHub Releases with `--prerelease`.
4. Update `RELEASING.md` to document the beta channel and stable-channel
   protection.
5. Enter Changesets prerelease mode for `beta` and generate
   `0.14.0-beta.0`, including the package lock, changelog, and immutable
   rollback marker for stable `0.13.2`.
6. Open a PR, require exact-head CI and clear review state, then merge.
7. Dispatch `Publish Package` on the merged release commit. The configured
   `npm-publish` environment remains the human approval gate.
8. Verify all public identities independently: Git tag, GitHub prerelease,
   npm version metadata, npm `beta` dist-tag, unchanged npm `latest` dist-tag,
   and package `gitHead`.

## Failure Handling

- Do not create or move tags manually if npm publication fails.
- Do not repair npm dist-tags manually as part of the normal path.
- If the protected environment is awaiting approval, report that as the active
  gate and leave the workflow pending.
- Pin checkout to the immutable dispatch SHA, serialize publish runs, and refuse
  any non-monotonic npm dist-tag move.
- Bind rollback truth to one validated marker in the reviewed changelog section
  so partial-publication retries cannot lose the pre-publish channel version.
- If `main`, the PR head, checks, or review threads drift before merge or
  publication, rehydrate live state and stop until the new head is reviewed.
- If npm publishes but a later tag or GitHub Release step fails, rerun the same
  workflow commit. Resume only when the existing npm version and tag identities
  match the approved source SHA; otherwise fail closed.

## Validation

Before PR publication:

- validate the workflow syntax and prerelease classification logic;
- run Changesets status/version checks against the corrected metadata;
- run `npm ci`, typecheck, tests, build, and package dry-run;
- confirm the generated version and changelog section are exactly
  `0.14.0-beta.0`.

Before merge and publish:

- confirm the PR is non-draft and current with `main`;
- confirm exact-head CI is successful;
- inspect top-level reviews, unresolved review threads, and check annotations;
- re-fetch canonical `main` immediately before merge and publication.

After publication:

- confirm `@martian-engineering/lossless-claw@0.14.0-beta.0` exists;
- confirm `beta=0.14.0-beta.0` and `latest=0.13.2`;
- confirm tag `v0.14.0-beta.0` points to the published `gitHead`;
- confirm the matching GitHub Release is marked as a prerelease.

## Non-Goals

- Promoting the beta to `latest`.
- Claiming the beta is stable or customer-runtime proven.
- Changing OpenClaw compatibility declarations without separate evidence.
- Publishing from the `100yenadmin/lossless-claw` fork.

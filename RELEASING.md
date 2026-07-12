# Releasing

This repo uses Changesets to make npm releases reviewable.

## Normal development

For any pull request that changes user-facing behavior, a changeset should be
added before the work is considered ready to release:

```bash
npm run changeset
```

Choose the smallest appropriate bump:

- `patch`: fixes, docs-visible behavior changes, small compatibility work
- `minor`: new features or notable new behavior
- `major`: breaking changes

The generated markdown file in `.changeset/` should explain the release impact in a sentence or two.

PRs that only touch internal tooling or CI can skip a changeset when they do not need an npm release note.

## Who adds the changeset

Maintainers own release metadata.

- For internal PRs, the author can add the changeset directly.
- For external PRs, do not expect the contributor to know or run the Changesets
  workflow. The reviewer or merge maintainer should add the changeset before
  merge, or immediately afterward in a small follow-up PR.
- If a releasable PR lands without a changeset, create a catch-up changeset PR
  before running the release flow.

The practical rule is simple: if the change should appear in npm release notes,
make sure a maintainer gets a `.changeset/*.md` file onto `main`.

## Release flow

1. Merge releasable PRs to `main`
2. Let the `Version Packages` workflow open or update the release PR
3. Review the generated version bump and `CHANGELOG.md`
4. Merge the release PR to `main`
5. Manually trigger the `Publish Package` workflow on the merged release commit
6. Approve the workflow if a protected GitHub Environment is configured
7. Let the workflow:
   - install dependencies
   - run tests
   - publish to npm
   - create tag `vX.Y.Z`
   - create the GitHub release using the matching `CHANGELOG.md` section as the primary notes
   - prepend those notes ahead of GitHub's generated contributor and compare summary

## External setup required

The repo-side files are not enough by themselves. A maintainer still needs to configure npm trusted publishing for this GitHub repository/workflow pair.

Recommended external setup:

1. Configure npm trusted publishing for this repo and the `publish.yml` workflow
2. Optionally create a GitHub Environment named `npm-publish` and add required reviewers
3. Confirm the repository label taxonomy used by `.github/release.yml`

When configuring npm trusted publishing, register the GitHub workflow using the exact workflow filename in this repo: `.github/workflows/publish.yml`.

The publish workflow is intentionally manual. Release issuance should stay deliberate even after trusted publishing is enabled.

## Beta releases

Use a Changesets prerelease when `main` needs broader testing before a stable release:

1. Run `npx changeset pre enter beta` on the reviewed release branch.
2. Run `npm run version-packages` and refresh `package-lock.json`.
3. Add exactly one `<!-- release-rollback-version: X.Y.Z -->` marker to the
   generated changelog section, where `X.Y.Z` is the current stable `latest`.
4. Review and merge the generated prerelease version and changelog.
5. Dispatch `Publish Package` from the branch containing the exact merged commit.

The publish workflow maps `X.Y.Z-beta.N` to npm's `beta` dist-tag and marks the
GitHub Release as a prerelease. Stable `X.Y.Z` versions map to npm's `latest`
dist-tag. Other prerelease identifiers fail closed.

The workflow pins the dispatch event's immutable commit, serializes publication,
and refuses to move a dist-tag backward. The reviewed changelog commit binds the
exact rollback version across retries. A retry resumes only when any existing
npm version, Git tag, and GitHub Release identities match that commit exactly.

Never use a beta publication to move or repair `latest` manually.

### Promote a beta line to stable

After the beta is accepted for stable release:

1. Run `npx changeset pre exit` on a new release branch from the beta-bearing
   `main` commit.
2. Run `npm run version-packages` and `npm install --package-lock-only`.
3. Add exactly one `<!-- release-rollback-version: X.Y.Z -->` marker to the
   stable changelog section, where `X.Y.Z` is the current npm `latest` version.
4. Verify `package.json`, the root lockfile version, and the lockfile root
   package version all equal the expected stable version, such as `0.14.0`.
5. Review the stable changelog, run `npm run release:verify`, and merge the
   stable release PR only after exact-head CI and review gates pass.
6. Dispatch `Publish Package` from that exact merged stable commit.

The stable publish moves npm's `latest` dist-tag only after the workflow proves
the candidate is newer than the current stable version. Its release notes pin
rollback guidance to the exact prior `latest` version.

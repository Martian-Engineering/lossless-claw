# Releasing

This repo uses Changesets to make npm releases reviewable.

## Normal development

For any pull request that changes user-facing behavior, add a changeset:

```bash
npm run changeset
```

Choose the smallest appropriate bump:

- `patch`: fixes, docs-visible behavior changes, small compatibility work
- `minor`: new features or notable new behavior
- `major`: breaking changes

The generated markdown file in `.changeset/` should explain the release impact in a sentence or two.

PRs that only touch internal tooling or CI can skip a changeset when they do not need an npm release note.

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
   - create the GitHub release

## External setup required

The repo-side files are not enough by themselves. A maintainer still needs to configure npm trusted publishing for this GitHub repository/workflow pair.

Recommended external setup:

1. Configure npm trusted publishing for this repo and the `publish.yml` workflow
2. Optionally create a GitHub Environment named `npm-publish` and add required reviewers
3. Confirm the repository label taxonomy used by `.github/release.yml`

When configuring npm trusted publishing, register the GitHub workflow using the exact workflow filename in this repo: `.github/workflows/publish.yml`.

The publish workflow is intentionally manual. Release issuance should stay deliberate even after trusted publishing is enabled.

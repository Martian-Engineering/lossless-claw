---
"@martian-engineering/lossless-claw": patch
---

Apply ingest protections during bootstrap import — credit to @jalehman for [#510](https://github.com/Martian-Engineering/lossless-claw/pull/510), inadvertently omitted from the v0.9.3 changelog. Bootstrap now routes each imported message through `ingestSingle` so oversized files, images, and tool-results are externalized on first import — peer of #511 and #521 which closed #492. (changesets/changelog-github attributes a changeset to the author of the PR introducing it; this entry exists explicitly to surface @jalehman as the author of #510 in the next release notes since the original changeset for that PR was never merged.)

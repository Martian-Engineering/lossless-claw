# Repository Instructions

## Principles

- Lossless means lossless. Do not delete, purge, truncate, or otherwise discard persisted user data unless the user has explicitly invoked a command or approved an action whose purpose is to remove that data.
- Automatic maintenance, bootstrap, repair, migration, compaction, cleanup, or rotation code must preserve user data. If continuity is uncertain, prefer degraded coverage, stale markers, warnings, or follow-up repair work over destructive recovery.
- Backups are not a substitute for this rule. The live system must not rely on being able to restore user data after an automatic delete.

## PR Review And Merge

- Before merging a PR, check whether it changes user-facing behavior or should appear in npm release notes.
- If yes, make sure a maintainer adds a `.changeset/*.md` file before merge or immediately after in a follow-up PR.
- Do not expect external contributors to know or run the Changesets workflow.
- Use the smallest appropriate bump:
  - `patch`: fixes, compatibility work, docs-visible behavior changes
  - `minor`: new features or notable new behavior
  - `major`: breaking changes
- Treat a PR as not release-ready until the changeset question has been answered.

## Release Notes Source Of Truth

- Follow [RELEASING.md](./RELEASING.md) for the repo's full Changesets and publish workflow.

## Config Schema Sync

- Whenever you add, rename, or remove a plugin config option in the runtime config loader or docs, update [`openclaw.plugin.json`](./openclaw.plugin.json) in the same change.
- Keep the manifest `configSchema` and `uiHints` aligned with every supported `plugins.entries.lossless-claw.config` field so OpenClaw accepts documented config keys.
- Keep [`docs/configuration.md`](./docs/configuration.md) exhaustive and current. When config keys, aliases, defaults, or precedence rules change, update the reference tables and the full example `plugins.entries.lossless-claw.config` block at the top of that file in the same change.
- Keep [`skills/lossless-claw/references/config.md`](./skills/lossless-claw/references/config.md) consistent with [`docs/configuration.md`](./docs/configuration.md), [`openclaw.plugin.json`](./openclaw.plugin.json), and the runtime defaults in [`src/db/config.ts`](./src/db/config.ts). When config keys, aliases, defaults, or precedence rules change, update that bundled skill reference in the same change.
- Add or update a regression test when changing config options so schema drift is caught before release.

# Lossless Claw MVP Skill And Commands

## Goal

Ship a first bundled operator surface for `lossless-claw` that helps users:

- configure the plugin correctly
- understand why the main settings matter
- diagnose broken or truncated summaries
- use recall tools effectively during normal agent work

This MVP stays inside the TypeScript plugin package. The Go TUI remains reference material only and is not required for install or daily use.

## Approved Scope

### Bundled skill

Add a bundled skill named `lossless-claw` with the following structure:

- `skills/lossless-claw/SKILL.md`
- `skills/lossless-claw/references/config.md`
- `skills/lossless-claw/references/architecture.md`
- `skills/lossless-claw/references/diagnostics.md`
- `skills/lossless-claw/references/recall-tools.md`

The skill should bias toward:

- configuration and operational setup
- explaining why the important knobs matter
- diagnostics and safe interpretation of summary-health signals
- recall-tool usage (`lcm_grep`, `lcm_describe`, `lcm_expand_query`)

The skill should not depend on the Go TUI binary for the MVP.

### Native plugin command surface

Add a plugin command surface for supported OpenClaw chat/native command providers centered on:

- `/lcm`
- `/lossless` as an alias

This scope is intentionally limited to plugin slash/native commands. It does not include a root shell CLI subcommand such as `openclaw lossless` or `openclaw lcm`.

MVP command behaviors:

- `/lcm`
  - version
  - whether `lossless-claw` is enabled
  - whether it is selected as the context engine
  - DB path
  - DB size
  - summary count
  - total summarized context when feasible
  - whether broken/truncated summaries are present
- `/lcm doctor`
  - the single user-facing broken-summary diagnostic entrypoint for MVP
  - diagnostic scan only; no advanced rewrite/backfill/repair UI here

### Explicitly out of scope

Do not expose or ship these as MVP plugin commands:

- rewrite
- backfill
- transplant
- dissolve
- separate repair-vs-doctor user flows
- shipping the Go TUI binary as part of plugin installation

## Implementation Plan

### 1. Bundle the skill

- Add the `skills/lossless-claw` directory with `SKILL.md` and the four required references.
- Update package publishing metadata so the skill ships in the npm package.
- Declare the bundled skill path in `openclaw.plugin.json`.

### 2. Add a focused command module

- Create a small plugin command module dedicated to `/lcm`.
- Keep parsing intentionally narrow: default status view plus `doctor`.
- Register the command from `src/plugin/index.ts` with `/lossless` as the native alias on supported native command surfaces.
- Do not add a root CLI command via `registerCli(...)` as part of this MVP.

### 3. Implement status reporting

- Read version from package metadata.
- Use the live plugin DB connection for summary and conversation counts.
- Read DB file size from the configured DB path when it is file-backed.
- Inspect OpenClaw config for plugin enabled/slot-selected state.
- Detect broken or truncated summaries with the same marker rules used by the Go doctor flow where practical.

### 4. Implement `/lcm doctor`

- Return scan-only diagnostics for broken/truncated summaries.
- Aggregate counts overall and by conversation.
- Point users at docs rather than exposing advanced mutation commands in this MVP.

### 5. Document and test

- Update README with the bundled skill and `/lcm` command surface.
- Add tests for:
  - manifest skill metadata
  - command registration
  - `/lcm` status output
  - `/lcm doctor` diagnostic output

## Notes

- “Total summarized context” should prefer source-message coverage over raw stored summary tokens when that metadata is available.
- If config cannot prove selection unambiguously, status output should still surface the current context-engine slot value so the user can reason about it.

---
title: Lossless Codex lcm_recent Enrichment Rendering
doc_type: architecture
status: draft-save-state
created_at: 2026-05-04
logical_dependencies:
  - https://github.com/Martian-Engineering/lossless-claw/pull/516
  - https://github.com/Martian-Engineering/lossless-claw/pull/589
---

# Lossless Codex lcm_recent Enrichment Rendering

## Purpose

This draft branch preserves the post-#516 integration target for Lossless Codex.
The sidecar plugin can already write compact rows to `lcm_temporal_enrichments`.
After #516 lands, `lcm_recent` should render those rows as temporal work hints.

## Intended Flow

```mermaid
flowchart LR
  A["lossless_codex_worklog"] --> B["lcm_temporal_enrichments"]
  B --> C["lcm_recent period/window lookup"]
  C --> D["Codex worklog hint section"]
  D --> E["lossless-codex:// refs for detail"]
```

## Implementation Tasks

- Query `lcm_temporal_enrichments` for the requested `day`, `week`, or `month`.
- Match the same timezone and period key resolution that #516 uses for rollups.
- Render a clearly labeled `Codex worklog hints` section in `lcm_recent`.
- Keep enrichment rows hidden when none exist or when the table is absent.
- Treat enrichment as a hint, not proof.
- Include sidecar refs when `includeSources=true`.
- Keep normal `lcm_recent` behavior unchanged when Lossless Codex is absent.

## Acceptance Tests

- `lcm_recent({ period: "yesterday" })` includes matching Codex project/day hints.
- `lcm_recent({ period: "week" })` includes matching week/month enrichment only when present.
- Missing `lcm_temporal_enrichments` table does not throw.
- Enrichment text does not appear as source proof for exact commands or paths.
- `includeSources=false` hides `lossless-codex://...` refs.
- `includeSources=true` exposes sidecar refs for follow-up with Lossless Codex tools.

## Non-Goals

- Do not import Codex data from `lcm_recent`.
- Do not open the Lossless Codex sidecar DB from `lcm_recent`.
- Do not write to OpenClaw tasks, Cortex, reminders, wakes, or Codex state.
- Do not move raw Codex transcripts or tool outputs into main LCM.


---
"@martian-engineering/lossless-claw": minor
---

LCM v4.1 — agent memory rebuild (replaces #516).

**New agent tools** (8 total):
- `lcm_grep` with new modes: `verbatim` (full message rows for citation/quote), `semantic` (pure-vector KNN via Voyage; absorbs the prior `lcm_semantic_recall` surface — Wave-12 consolidation). Hybrid mode uses Voyage rerank for +52.5pp paraphrastic recall. `summaryKinds` filter scopes hits to `['leaf']` or `['condensed']`.
- `lcm_synthesize_around` — time-anchored synthesis with three modes: `period` (yesterday/this-week/last-month/last-Nh/last-Nd, **timezone-aware**), `time` (±N hours around an anchor leaf), `semantic` (top-K most similar). Replaces v3 `lcm_recent`.
- `lcm_describe` extended with `expandChildren` / `expandMessages` flags for one-hop drilldown without sub-agent delegation.
- `lcm_expand` (sub-agent only) + `lcm_expand_query` (delegated multi-hop drilldown).
- `lcm_get_entity` + `lcm_search_entities` — entity catalog tools (canonical names + mentions, scoped per session_key, suppressed-mention filtered). `lcm_search_entities` supports browse-by-`entityType` with empty query.
- `lcm_compact` — agent-triggered LCM compaction (Wave-14; opt-in via `agentCompactionToolEnabled`).

**New schemas** (16 tables): per-model embedding tables (`lcm_embeddings_voyage4large`), embedding profile registry, synthesis cache + audit, prompt registry, entity catalog + mentions, extraction queue, worker locks, eval run tables, session-key audit. All migrations idempotent.

**New worker auto-ticks**:
- Backfill autostart (5min cadence, gated on `VOYAGE_API_KEY`, rate-limited 0.5 RPS).
- Entity coreference autostart (60s cadence, default-on, opt-out via `LCM_EXTRACTION_LLM_ENABLED=false`).

**New operator commands**:
- `/lcm health` — embeddings coverage, worker status, eval scores, drift index, suppression cleanup.
- `/lcm worker [status|tick embedding-backfill]` — worker lifecycle (tick is owner-gated).
- `/lcm reconcile-session-keys [--list|--apply]` — merge legacy session keys (apply is owner-gated).
- `/lcm eval [--baseline|--mode hybrid]` — recall + drift report (owner-gated; mutates eval tables, may use Voyage).
- `/lcm purge --reason X --apply` — soft-suppression cascade through 10+ read paths (owner-gated).
- `/lcm doctor [apply]` and `/lcm doctor clean [apply]` — broken-summary scan/repair (apply variants owner-gated).

**Behavior changes**:
- `assemble()` pyramid is structural (fresh tail → recent leaves → last-week condensed → last-month condensed → last-year synthesis). NO RAG-style per-turn semantic retrieval into the prompt.
- Search/expansion tools now treat rotated conversation segments sharing a stable session identity as one recall scope by default (session family).
- Soft-purge cascades through every read surface (FTS, LIKE, CJK, regex, vec0 metadata, entity tools, context items, synthesis cache).

**New runtime dependency** (optional):
- `sqlite-vec` added as `optionalDependencies` for semantic recall + hybrid search. Without it the plugin still works; semantic-mode tools return graceful "vec0 unavailable" errors. Install via `npm install sqlite-vec`.

**Removed** (preserved in companion draft PR #616):
- v3's `lcm_recent` rollup tool (replaced by `lcm_synthesize_around` + period mode).
- Themes consolidation, procedure mining, intentions extraction (all half-shipped or schema-only in v4 spec).
- `runPurge --immediate` mode (no drainer worker; soft-purge is the shipping path).

**Configuration**:
- `VOYAGE_API_KEY` (env or `~/.openclaw/credentials/voyage-api-key`) — required for semantic + hybrid retrieval. Plugin works without it.
- `LCM_EMBEDDING_MODEL` (default `voyage-4-large`), `LCM_EMBEDDING_DIM` (default 1024; voyage-4-large supports 256/512/1024/2048), `LCM_EXTRACTION_LLM_ENABLED` (default true).

See `docs/v4.1/PR_DESCRIPTION.md` for architecture diagrams, the 5-question routing model, cost discipline, and the audit/test history (10 audit waves, ~140 bugs closed, 1502 tests, mutation-tested sample files).

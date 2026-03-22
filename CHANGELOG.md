# @martian-engineering/lossless-claw

## 0.5.0

### Minor Changes

- [#157](https://github.com/Martian-Engineering/lossless-claw/pull/157) [`f3f0aa2`](https://github.com/Martian-Engineering/lossless-claw/commit/f3f0aa29e636542e47f5020a1d6759dff023d798) Thanks [@jalehman](https://github.com/jalehman)! - Add `lcm-tui doctor` command for auto-detecting and repairing truncation-fallback summaries. Features position-aware marker detection (rejects false positives from summaries that quote markers in narrative text), bottom-up repair ordering, OAuth/token CLI delegation, and transaction-safe dry-run mode.

- [#138](https://github.com/Martian-Engineering/lossless-claw/pull/138) [`9047e49`](https://github.com/Martian-Engineering/lossless-claw/commit/9047e49a91db0e4cba83f4f1c11fc10a899e5528) Thanks [@jalehman](https://github.com/jalehman)! - Add incremental bootstrap checkpoints and large tool-output externalization.

  This release speeds up restart/bootstrap by checkpointing session transcript state,
  skipping unchanged transcript replays, and using append-only tail imports when a
  session file only grew. It also externalizes oversized tool outputs into
  `large_files` with compact placeholders so long-running OpenClaw sessions keep
  their full recall surface without carrying giant inline tool payloads in the
  active transcript.

### Patch Changes

- [#156](https://github.com/Martian-Engineering/lossless-claw/pull/156) [`968b1d6`](https://github.com/Martian-Engineering/lossless-claw/commit/968b1d6b2ff41a297645309aa7c1d7dc80bee7ab) Thanks [@jalehman](https://github.com/jalehman)! - Fix compaction auth failures: surface provider auth errors instead of silently aborting, fall back to deterministic truncation when summarizer returns empty content, fall through to legacy auth-profiles.json when modelAuth returns scope-limited credentials. TUI now sets WAL mode and busy_timeout to prevent SQLITE_BUSY during concurrent usage.

- [#129](https://github.com/Martian-Engineering/lossless-claw/pull/129) [`133665c`](https://github.com/Martian-Engineering/lossless-claw/commit/133665c24d5e4bdd1ad01cd4373b65af5d37d868) Thanks [@semiok](https://github.com/semiok)! - Use LIKE search for full-text queries containing CJK characters. SQLite FTS5's `unicode61` tokenizer can return empty or incomplete results for Chinese/Japanese/Korean text, so CJK queries now bypass FTS and use the existing LIKE-based fallback for correct matches.

- [#132](https://github.com/Martian-Engineering/lossless-claw/pull/132) [`4522a72`](https://github.com/Martian-Engineering/lossless-claw/commit/4522a7217511dc99be2576ac49cb216515213aea) Thanks [@hhe48203-ctrl](https://github.com/hhe48203-ctrl)! - Persist the resolved compaction summarization model on summary records instead of
  always showing `unknown`.

  Existing `summaries` rows keep the `unknown` fallback through an additive
  migration, while newly created summaries now record the actual model configured
  for compaction.

- [#126](https://github.com/Martian-Engineering/lossless-claw/pull/126) [`437c240`](https://github.com/Martian-Engineering/lossless-claw/commit/437c240c580e0407f4732b401792bec10ab50f1b) Thanks [@cryptomaltese](https://github.com/cryptomaltese)! - Annotate attachment-only messages during compaction without dropping short captions.

  This release improves media-aware compaction summaries by replacing raw
  `MEDIA:/...` placeholders for attachment-only messages while still preserving
  real caption text, including short captions such as `Look at this!`, when a
  message also includes a media attachment.

- [#146](https://github.com/Martian-Engineering/lossless-claw/pull/146) [`c37777f`](https://github.com/Martian-Engineering/lossless-claw/commit/c37777f416afb088f816fe1bb10b17773d08306f) Thanks [@qualiobra](https://github.com/qualiobra)! - Fix a session-queue cleanup race that could leak per-session queue entries during
  overlapping ingest or compaction operations.

- [#131](https://github.com/Martian-Engineering/lossless-claw/pull/131) [`bab46cc`](https://github.com/Martian-Engineering/lossless-claw/commit/bab46ccd633ee159443b965793cb83cb64f673a2) Thanks [@semiok](https://github.com/semiok)! - Add 60-second timeout protection to summarizer LLM calls. Previously, a slow or unresponsive model provider could block the `deps.complete()` call indefinitely, starving the Node.js event loop and causing downstream failures such as Telegram polling disconnects. Both the initial and retry summarization calls are now wrapped with a timeout that rejects cleanly and falls through to the existing deterministic fallback.

## 0.4.0

### Minor Changes

- 45f714c: Add `expansionModel` and `expansionProvider` overrides for delegated
  `lcm_expand_query` subagent runs.
- 1e6812a: Add session scoping controls for ignored and stateless OpenClaw sessions,
  including cron and subagent pattern support, and make runtime summary model
  environment overrides win reliably over plugin config during compaction.

### Patch Changes

- 518a1b2: Restore automatic post-turn compaction when OpenClaw omits the top-level
  `tokenBudget`, by resolving fallback budget inputs consistently before using
  the default compaction budget.
- 6c54c7b: Declare explicit OpenClaw tool names for the LCM factory-registered tools so
  plugin metadata and tool listings stay populated in hosts that require
  `registerTool(..., { name })` hints for factory registrations.
- 9ee103a: Fix condensed summary expansion so replay walks the source summaries that were compacted into a node, and skip proactive compaction when turn ingest fails to avoid compacting a stale frontier.
- ae260f7: Fix the TUI Anthropic OAuth fallback so Claude CLI summaries respect the selected model and stay within the expected summary size budget.
- 8f77fe7: Run LCM migrations during engine startup and only advertise `ownsCompaction`
  when the database schema is operational, while preserving runtime compaction
  settings and accurate token accounting for structured tool results.
- 7fae41c: Fix assembler round-tripping for tool results so structured `tool_result` content is preserved and normalized tool metadata no longer inflates context token budgeting.
- ceee14e: Restore stable conversation continuity across OpenClaw session UUID recycling
  by resolving sessions through `sessionKey` for both writes and read-only
  lookups, and keep compaction/ingest serialization aligned with that stable
  identity.
- bbd2ecb: Emit LCM startup and configuration banner logs only once per process so
  repeated OpenClaw plugin registration during snapshot loads does not duplicate
  the same startup lines.
- 82becaf: Remove hardcoded non-LCM recall tool names from the dynamic summary prompt so
  agents rely on whatever memory tooling is actually available in the host
  session.
- 6b85751: Restore compatibility for existing OpenClaw sessions that still reference the
  legacy `default` context engine, and improve container deployments by adding a
  supported Docker image and startup flow for LCM-backed OpenClaw environments.
- 828d106: Improve LCM summarization model resolution so configured `summaryModel`
  overrides, OpenClaw `agents.defaults.compaction.model`, and newer
  `runtimeContext` inputs are honored more reliably while preserving
  compatibility with older `legacyCompactionParams` integrations.

## 0.3.0

### Minor Changes

- f1dfa5c: Catch up the release notes for work merged after `0.2.8`.

  This release adds Anthropic OAuth setup-token support in the TUI, resolves
  SecretRef-backed auth-profile credentials and provider-level custom provider
  configuration during summarization, and formats LCM tool timestamps in the local
  timezone instead of UTC.

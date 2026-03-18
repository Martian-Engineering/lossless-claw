# @martian-engineering/lossless-claw

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

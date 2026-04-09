# @martian-engineering/lossless-claw

## 0.8.0

### Minor Changes

- [#337](https://github.com/Martian-Engineering/lossless-claw/pull/337) [`0c139a2`](https://github.com/Martian-Engineering/lossless-claw/commit/0c139a2991350a062c59a0a9781f314ebb75af45) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Add `/lossless doctor clean apply` for backup-first cleanup of approved high-confidence junk conversations, while preserving archived-only handling for NULL-key subagent rows and surfacing integrity-check warnings after apply.

- [#323](https://github.com/Martian-Engineering/lossless-claw/pull/323) [`e781980`](https://github.com/Martian-Engineering/lossless-claw/commit/e781980ee706f5d67c902b903a003eaf7665c8e4) Thanks [@jalehman](https://github.com/jalehman)! - Allow `lcm_expand_query(allConversations: true)` to synthesize bounded answers across multiple conversations, including per-conversation diagnostics for partial or truncated results.

### Patch Changes

- [#332](https://github.com/Martian-Engineering/lossless-claw/pull/332) [`98cb02a`](https://github.com/Martian-Engineering/lossless-claw/commit/98cb02a2acddf177a4989e68887e4bbccf06292a) Thanks [@jalehman](https://github.com/jalehman)! - Clarify `lcm_grep` and `lcm_expand_query` guidance so agents use shorter FTS5 queries, keep natural-language instructions in `prompt`, and avoid over-constraining recall with extra keywords.

- [#344](https://github.com/Martian-Engineering/lossless-claw/pull/344) [`897a953`](https://github.com/Martian-Engineering/lossless-claw/commit/897a953300b35208b894050ac73bc8160a03b0da) Thanks [@jetd1](https://github.com/jetd1)! - Keep compaction summary caps and deterministic fallback truncation within budget for CJK-heavy and emoji-heavy content.

- [#331](https://github.com/Martian-Engineering/lossless-claw/pull/331) [`d7a57c5`](https://github.com/Martian-Engineering/lossless-claw/commit/d7a57c51361307fa27818d14c2c7b426609c9ee8) Thanks [@jalehman](https://github.com/jalehman)! - Recover from malformed legacy `summaries_fts` tables during migration instead of crashing plugin startup.

- [#334](https://github.com/Martian-Engineering/lossless-claw/pull/334) [`71d6d9c`](https://github.com/Martian-Engineering/lossless-claw/commit/71d6d9ce1a0846f85cefd92e6895c7cfaee2350a) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Harden malformed FTS migration recovery so stale trigram tables are cleaned up before other FTS schema probes and startup migrations no longer skip recovery by reusing a cached FTS5 capability check.

- [#172](https://github.com/Martian-Engineering/lossless-claw/pull/172) [`8bf5e7f`](https://github.com/Martian-Engineering/lossless-claw/commit/8bf5e7fb73b02d75350aae7cc47df46f9b425f1a) Thanks [@craigamcw](https://github.com/craigamcw)! - Skip ingesting empty assistant messages from errored or aborted provider responses so they do not accumulate in assembled context and trigger retry loops.

- [#330](https://github.com/Martian-Engineering/lossless-claw/pull/330) [`acf1e02`](https://github.com/Martian-Engineering/lossless-claw/commit/acf1e02ef43efc8f8187d51e37493f152fb9d06b) Thanks [@little-jax](https://github.com/little-jax)! - Restore direct-credential summarizer retries for custom provider aliases and avoid misreporting transient provider failures as `provider_config` errors.

- [#351](https://github.com/Martian-Engineering/lossless-claw/pull/351) [`ea1f80d`](https://github.com/Martian-Engineering/lossless-claw/commit/ea1f80d80111f9dafd3d527bf98976e38b6ea694) Thanks [@kitcommerce](https://github.com/kitcommerce)! - Ensure forced overflow recovery still runs compaction when live observed token counts are unavailable.

- [#328](https://github.com/Martian-Engineering/lossless-claw/pull/328) [`3de1f9e`](https://github.com/Martian-Engineering/lossless-claw/commit/3de1f9e8393970af9a170333becf7a3050cb066a) Thanks [@jalehman](https://github.com/jalehman)! - Fall back to `plugins.entries["lossless-claw"].config` when older or otherwise incompatible OpenClaw runtimes do not provide a usable `api.pluginConfig`.

## 0.7.0

### Minor Changes

- [#318](https://github.com/Martian-Engineering/lossless-claw/pull/318) [`b7078df`](https://github.com/Martian-Engineering/lossless-claw/commit/b7078df9c4466c6249a8c0f11424a6e75ea7be4c) Thanks [@jalehman](https://github.com/jalehman)! - Add optional dynamic leaf chunk sizing for incremental compaction, including bounded activity-based chunk growth, cold-cache max bumping, and automatic retry with smaller chunk targets when a provider rejects an oversized compaction request.

- [#296](https://github.com/Martian-Engineering/lossless-claw/pull/296) [`4906c62`](https://github.com/Martian-Engineering/lossless-claw/commit/4906c6283a4033f34397bf527ae4a5c40adccdfc) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Improve `lcm_grep` full-text recall with phrase-preserving queries and `sort` modes (`recency`, `relevance`, and `hybrid`) that rank results before `limit` is applied.

- [#285](https://github.com/Martian-Engineering/lossless-claw/pull/285) [`aac2668`](https://github.com/Martian-Engineering/lossless-claw/commit/aac266834b075f9adae95c86ccf9be9b91161275) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Add conversation prune function for bulk data retention, allowing deletion of conversations where all messages are older than a configurable threshold.

### Patch Changes

- [#295](https://github.com/Martian-Engineering/lossless-claw/pull/295) [`1ef1b29`](https://github.com/Martian-Engineering/lossless-claw/commit/1ef1b297c5d3dead44cc4460cdf60ef6191395ea) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Reduce compaction database work by caching per-phase context reads, skipping redundant ordinal resequencing, and tracking token-count deltas instead of re-querying after each pass.

- [#318](https://github.com/Martian-Engineering/lossless-claw/pull/318) [`b7078df`](https://github.com/Martian-Engineering/lossless-claw/commit/b7078df9c4466c6249a8c0f11424a6e75ea7be4c) Thanks [@jalehman](https://github.com/jalehman)! - Make incremental leaf compaction cache-aware by deferring extra passes while prompt caching is hot, allowing bounded catch-up when the cache goes cold, and adding `cacheAwareCompaction` config controls for the behavior.

- [#319](https://github.com/Martian-Engineering/lossless-claw/pull/319) [`3bc5bde`](https://github.com/Martian-Engineering/lossless-claw/commit/3bc5bde7a52b163ee2fe7f22302e97e3e8295b11) Thanks [@jalehman](https://github.com/jalehman)! - Document the full lossless-claw configuration surface and align the plugin manifest schema and UI hints with the runtime-supported config keys.

- [#288](https://github.com/Martian-Engineering/lossless-claw/pull/288) [`d74ad07`](https://github.com/Martian-Engineering/lossless-claw/commit/d74ad070888e7be5e4e1730ddc6506708075317e) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Wait for deferred LCM database initialization after lock-contended gateway restarts, and surface the real retry failure when deferred startup cannot recover.

- [#294](https://github.com/Martian-Engineering/lossless-claw/pull/294) [`43342d9`](https://github.com/Martian-Engineering/lossless-claw/commit/43342d9fea5c62ea4320a7bca60732bad09122d2) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Tune SQLite defaults for large lossless-claw databases by increasing the page cache, keeping temporary structures in memory, and using WAL-friendly synchronous settings.

  Add missing indexes for `summary_messages(message_id)` and `summaries(conversation_id, depth, kind)` so summary cleanup and depth-filtered queries avoid full table scans on existing databases.

- [#302](https://github.com/Martian-Engineering/lossless-claw/pull/302) [`558183d`](https://github.com/Martian-Engineering/lossless-claw/commit/558183d9ead262d06d58bbfc801e172781c278b8) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Fix compaction summarizer exhaustion handling so multi-provider non-auth failures log the terminal exhaustion path and fall back to deterministic truncation instead of returning an empty summary.

- [#322](https://github.com/Martian-Engineering/lossless-claw/pull/322) [`d0dacc9`](https://github.com/Martian-Engineering/lossless-claw/commit/d0dacc929f317bc7470fc935f6338461603f4039) Thanks [@jalehman](https://github.com/jalehman)! - Use OpenClaw runtime-ready model auth for summarization requests so managed auth providers work correctly.

- [#329](https://github.com/Martian-Engineering/lossless-claw/pull/329) [`6579b91`](https://github.com/Martian-Engineering/lossless-claw/commit/6579b913adcc3a88610d873f7eacefbaa663c3d2) Thanks [@jalehman](https://github.com/jalehman)! - Improve lossless-claw reliability around cache-aware compaction and transcript replay, including heartbeat-turn pruning, bootstrap compatibility for legacy JSONL message envelopes, and updated runtime logging/docs alignment.

- [#300](https://github.com/Martian-Engineering/lossless-claw/pull/300) [`a42f422`](https://github.com/Martian-Engineering/lossless-claw/commit/a42f422c1bc6c386c31e098d0b865dd3fedcbe9f) Thanks [@jalehman](https://github.com/jalehman)! - Fix `lcm-tui` Telegram topic session lookups so topic-backed sessions show the correct conversation metadata, summary counts, and file counts when browsing session keys.

## 0.6.3

### Patch Changes

- [#244](https://github.com/Martian-Engineering/lossless-claw/pull/244) [`cb51dd2`](https://github.com/Martian-Engineering/lossless-claw/commit/cb51dd237693e8992efb0d6eea843609619bd2bf) Thanks [@jalehman](https://github.com/jalehman)! - Use OpenClaw's enriched `session_end` hook to preserve clean LCM conversation boundaries across automatic session rollover, compaction session replacement, and session deletion.

- [`4ddf05c`](https://github.com/Martian-Engineering/lossless-claw/commit/4ddf05c399a2a752bd296cf4ddcdb87e0dc36a01) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Route all LCM startup diagnostics to stderr so `--json` CLI output stays machine-readable, while keeping debug-only migration details behind the host logger's debug gating.

- [#280](https://github.com/Martian-Engineering/lossless-claw/pull/280) [`9a2c3e1`](https://github.com/Martian-Engineering/lossless-claw/commit/9a2c3e1a3e74957e1280b8026cebad4b0e7f0418) Thanks [@liu51115](https://github.com/liu51115)! - Fix bootstrap checkpoint refresh after transcript maintenance so unchanged restarts stay on the fast path, and avoid advancing the checkpoint when replay-safety import caps abort reconciliation.

## 0.6.2

### Patch Changes

- [#270](https://github.com/Martian-Engineering/lossless-claw/pull/270) [`8618ea7`](https://github.com/Martian-Engineering/lossless-claw/commit/8618ea75278daec1f7e4be00775e40d5961d5697) Thanks [@jalehman](https://github.com/jalehman)! - Fix forced timeout-recovery compaction so live budget overflows use the capped `compactUntilUnder()` path instead of no-oping through a stored-context full sweep.

- [#273](https://github.com/Martian-Engineering/lossless-claw/pull/273) [`40c90b1`](https://github.com/Martian-Engineering/lossless-claw/commit/40c90b1e30d53202dee08ae86a91464aedd9d420) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Fix LCM summarization for runtime-managed OAuth providers like `openai-codex` by preserving first-pass credential resolution and skipping the incompatible direct-credential retry path. Also add configurable summarizer timeouts via `summaryTimeoutMs` and `LCM_SUMMARY_TIMEOUT_MS`.

- [#261](https://github.com/Martian-Engineering/lossless-claw/pull/261) [`65c76f1`](https://github.com/Martian-Engineering/lossless-claw/commit/65c76f17ad82f1b3392be4e1a5e85e3172eb9a3d) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Fix shared-SQLite transaction coordination during bootstrap and compaction so concurrent sessions do not collide on one database connection, and nested transaction scopes on the same async path stay safe.

## 0.6.1

### Patch Changes

- [`d1a9eb3`](https://github.com/Martian-Engineering/lossless-claw/commit/d1a9eb36b543050bdda442faab93bab48bd3e130) Thanks [@jalehman](https://github.com/jalehman)! - Fix conversation integrity regressions by pruning heartbeat-shaped ACK turns before compaction, avoiding synthetic compaction telemetry in canonical transcript history, and deduplicating replayed history using stable session key continuity during afterTurn processing.

## 0.6.0

### Minor Changes

- [#195](https://github.com/Martian-Engineering/lossless-claw/pull/195) [`8efd2e9`](https://github.com/Martian-Engineering/lossless-claw/commit/8efd2e98a0000edf90953ecbb5060cf9c56baad3) Thanks [@jalehman](https://github.com/jalehman)! - Add explicit `/new` and `/reset` lifecycle handling for OpenClaw sessions.

  `/new` now prunes fresh context from the active conversation while preserving retained summaries by configured depth, and `/reset` now archives the current conversation before starting a fresh active conversation for the same stable session key.

- [#243](https://github.com/Martian-Engineering/lossless-claw/pull/243) [`f074000`](https://github.com/Martian-Engineering/lossless-claw/commit/f07400009be2f181f3fe382dbab5985793873540) Thanks [@jalehman](https://github.com/jalehman)! - Add the bundled `lossless-claw` skill and the MVP `/lcm` command surface with summary-health diagnostics.

- [#148](https://github.com/Martian-Engineering/lossless-claw/pull/148) [`ef445da`](https://github.com/Martian-Engineering/lossless-claw/commit/ef445da2fa518cbb6abeabffa4577588f5d9d74e) Thanks [@jalehman](https://github.com/jalehman)! - Add runtime-assisted transcript GC for summarized externalized tool results so active session transcripts can shrink after oversized tool output has been condensed and preserved in `large_files`.

### Patch Changes

- [#255](https://github.com/Martian-Engineering/lossless-claw/pull/255) [`a1bda9b`](https://github.com/Martian-Engineering/lossless-claw/commit/a1bda9becb9914af8cfc5c091ef7f6bcdbdbf199) Thanks [@jalehman](https://github.com/jalehman)! - Limit first-time fork bootstrap imports so new conversations only inherit the newest slice of raw parent history instead of loading the entire parent transcript into lossless memory.

- [#258](https://github.com/Martian-Engineering/lossless-claw/pull/258) [`cd18739`](https://github.com/Martian-Engineering/lossless-claw/commit/cd18739b08410e5c1e4dcd529afb6016a48bf303) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Add regression coverage for bootstrap budget edge cases and invalid numeric env fallback behavior.

- [#230](https://github.com/Martian-Engineering/lossless-claw/pull/230) [`ca51445`](https://github.com/Martian-Engineering/lossless-claw/commit/ca51445c52e4c1c102023f0336a9d7e29f78c226) Thanks [@liu51115](https://github.com/liu51115)! - Fix compaction auth circuit breaker handling so auth failures during multi-pass sweeps still trip the breaker, while failures for one resolved summarizer no longer block unrelated providers or sessions.

- [#229](https://github.com/Martian-Engineering/lossless-claw/pull/229) [`1fb8b8f`](https://github.com/Martian-Engineering/lossless-claw/commit/1fb8b8ff37055eab16e4c9204249bdb91aa401ac) Thanks [@tingyiy](https://github.com/tingyiy)! - Preserve explicit timezone offsets when parsing stored timestamps while still treating bare SQLite `datetime('now')` values as UTC.

- [#219](https://github.com/Martian-Engineering/lossless-claw/pull/219) [`69e5f6a`](https://github.com/Martian-Engineering/lossless-claw/commit/69e5f6a1cc740107658c1a594945ef50834a45cc) Thanks [@catgodtwno4](https://github.com/catgodtwno4)! - Fix CJK summary search so mixed-language queries still require all terms, and single-character CJK queries continue to return matches.

- [#222](https://github.com/Martian-Engineering/lossless-claw/pull/222) [`d8261d7`](https://github.com/Martian-Engineering/lossless-claw/commit/d8261d74ec9c9d866045b4283034f123f38b5d81) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Block overlapping `lcm_expand_query` delegations from the same origin session so concurrent expansion requests fail fast instead of deadlocking on the shared sub-agent lane.

- [#257](https://github.com/Martian-Engineering/lossless-claw/pull/257) [`ea43f58`](https://github.com/Martian-Engineering/lossless-claw/commit/ea43f58746cf8c96b8feb5a9f6b8a1fe02477573) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Fix the hardened `afterTurn()` replay dedup path so it ingests the intended post-turn batch, and add coverage for restart replay when an auto-compaction summary is present.

- [#180](https://github.com/Martian-Engineering/lossless-claw/pull/180) [`ea84f45`](https://github.com/Martian-Engineering/lossless-claw/commit/ea84f454a07d205ff225b5c73d4f91f73e2614bd) Thanks [@GodsBoy](https://github.com/GodsBoy)! - Fix prompt-aware context eviction so blank or otherwise unsearchable prompts fall back to the existing chronological behavior instead of entering the relevance-scoring path.

- [#178](https://github.com/Martian-Engineering/lossless-claw/pull/178) [`0613b7f`](https://github.com/Martian-Engineering/lossless-claw/commit/0613b7fc7707a4ccea1ffbf7d2c8be82bd4dcee6) Thanks [@catgodtwno4](https://github.com/catgodtwno4)! - Fix summarizer auth-error detection so real provider auth envelopes nested under `data` or `body` still trigger handling, while successful summary payloads in `message` or `response` no longer cause false-positive auth failures.

- [#242](https://github.com/Martian-Engineering/lossless-claw/pull/242) [`3fe823f`](https://github.com/Martian-Engineering/lossless-claw/commit/3fe823f4dcec720c158f712fa4c4487482e80ade) Thanks [@jalehman](https://github.com/jalehman)! - Move static lossless recall policy guidance into the plugin prompt hook while keeping `systemPromptAddition` limited to session-specific compaction reminders.

  This makes the stable recall-order guidance cacheable, clarifies that lossless-claw takes precedence over generic memory recall only for compacted conversation history, and leaves deep-compaction expand-before-asserting guidance in the dynamic assembled prompt.

- [#252](https://github.com/Martian-Engineering/lossless-claw/pull/252) [`e843638`](https://github.com/Martian-Engineering/lossless-claw/commit/e8436388311e110b983d280e2157a9f013e41d4e) Thanks [@jalehman](https://github.com/jalehman)! - Sync the published plugin manifest schema with the runtime-supported plugin config surface so documented config keys are accepted by OpenClaw. This also removes the undocumented `autocompactDisabled` setting from the advertised config surface because it was parsed but not wired to runtime behavior.

## 0.5.3

### Patch Changes

- [#228](https://github.com/Martian-Engineering/lossless-claw/pull/228) [`2f5735d`](https://github.com/Martian-Engineering/lossless-claw/commit/2f5735d5e81f3eec2aa2c09d1b62e706e5e0a3b4) Thanks [@jalehman](https://github.com/jalehman)! - Make compaction summarization fall back to the next resolved model when the preferred model times out or returns repeated empty provider errors, and make the startup banner reflect the same compaction model precedence used at runtime.

- [#221](https://github.com/Martian-Engineering/lossless-claw/pull/221) [`9fa4f3d`](https://github.com/Martian-Engineering/lossless-claw/commit/9fa4f3d0b8de013f089e6160025d88cd1e48c76a) Thanks [@jalehman](https://github.com/jalehman)! - Raise the default protected fresh tail to 64 messages and make incremental compaction run one condensed pass by default.

- [#224](https://github.com/Martian-Engineering/lossless-claw/pull/224) [`1fd2a44`](https://github.com/Martian-Engineering/lossless-claw/commit/1fd2a44889411fd1fea3621a9b29aeee4b4e60fe) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Add a configurable delegated expansion timeout for `lcm_expand_query` via plugin config (`delegationTimeoutMs`) and `LCM_DELEGATION_TIMEOUT_MS`.

- [#223](https://github.com/Martian-Engineering/lossless-claw/pull/223) [`028f171`](https://github.com/Martian-Engineering/lossless-claw/commit/028f17182350c120bf94f81781be3c9fbf11b206) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Expose `leafChunkTokens` as a first-class plugin config option so deployments can tune leaf compaction frequency without patching the plugin manifest.

- [#220](https://github.com/Martian-Engineering/lossless-claw/pull/220) [`8f84d8e`](https://github.com/Martian-Engineering/lossless-claw/commit/8f84d8ebfbe2163e6624fffa7468ef0de928a9da) Thanks [@jalehman](https://github.com/jalehman)! - Improve LongMemEval compaction and retrieval reliability by filtering reasoning text from summaries, retrying truncated summaries, hardening delegated expansion, and falling back to raw-message search in shallow trees.

- [#205](https://github.com/Martian-Engineering/lossless-claw/pull/205) [`ef4865f`](https://github.com/Martian-Engineering/lossless-claw/commit/ef4865fb13a1a8e373a045c0dd2a907ae1bbbfde) Thanks [@aquaright1](https://github.com/aquaright1)! - Preserve assistant text and matched tool calls when pruning stale orphaned tool calls from assembled context.

- [#211](https://github.com/Martian-Engineering/lossless-claw/pull/211) [`7975a1e`](https://github.com/Martian-Engineering/lossless-claw/commit/7975a1e86f1d58808ef0d1bb0677c6e993f30c5e) Thanks [@GodsBoy](https://github.com/GodsBoy)! - Fix compaction cap handling so capped summaries stay within the configured token limit and direct compaction APIs respect `maxAssemblyTokenBudget`.

## 0.5.2

### Patch Changes

- [#185](https://github.com/Martian-Engineering/lossless-claw/pull/185) [`ec74779`](https://github.com/Martian-Engineering/lossless-claw/commit/ec747792c01153e44f08bfbf410ddf2526fca7cf) Thanks [@jalehman](https://github.com/jalehman)! - Fix `lcm-tui doctor` to detect third truncation marker format (`[LCM fallback summary; truncated for context management]`) and harden Claude CLI summarization with `--system-prompt` flag and neutral working directory to prevent workspace contamination.

- [#186](https://github.com/Martian-Engineering/lossless-claw/pull/186) [`c796f7d`](https://github.com/Martian-Engineering/lossless-claw/commit/c796f7d9d014a19f2b55e62895a32327b0347694) Thanks [@jalehman](https://github.com/jalehman)! - Harden LCM summarization so provider auth failures no longer persist fallback summaries, and stop forcing explicit temperature overrides on summarizer requests.

- [#182](https://github.com/Martian-Engineering/lossless-claw/pull/182) [`954a2fd`](https://github.com/Martian-Engineering/lossless-claw/commit/954a2fd848b6444561e26afc2b41ad01e27d5a08) Thanks [@jalehman](https://github.com/jalehman)! - Improve `lcm-tui` session browsing by showing stable session keys in the session list and conversation header, and align the session list columns so message counts and LCM metadata are easier to scan.

- [#128](https://github.com/Martian-Engineering/lossless-claw/pull/128) [`0f1a5d8`](https://github.com/Martian-Engineering/lossless-claw/commit/0f1a5d89a95225baee39e017449e5956e7990b27) Thanks [@TSHOGX](https://github.com/TSHOGX)! - Honor custom API base URL overrides for `lcm-tui rewrite`, `lcm-tui backfill`, and interactive rewrite so TUI summarization can use configured provider proxies and non-default endpoints.

## 0.5.1

### Patch Changes

- [#159](https://github.com/Martian-Engineering/lossless-claw/pull/159) [`20b6c1b`](https://github.com/Martian-Engineering/lossless-claw/commit/20b6c1bd0c8c5903ce4498e9cef235392fa0cfc4) Thanks [@tmchow](https://github.com/tmchow)! - Fix legacy tool-call backfill for rows that stored ids under `metadata.raw.call_id`.

- [#163](https://github.com/Martian-Engineering/lossless-claw/pull/163) [`31307a6`](https://github.com/Martian-Engineering/lossless-claw/commit/31307a671549438fe795b1ddd941a9af90ec51dc) Thanks [@jalehman](https://github.com/jalehman)! - Prevent the summarizer from reusing the active session auth profile when an explicit LCM summary provider and model are configured.

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

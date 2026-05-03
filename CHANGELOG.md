# @martian-engineering/lossless-claw

## 0.9.3

### Patch Changes

- [#557](https://github.com/Martian-Engineering/lossless-claw/pull/557) [`5a6b11b`](https://github.com/Martian-Engineering/lossless-claw/commit/5a6b11b0a1e1f37a2f095731ed0decad74a70847) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Honor `cacheAwareCompaction.enabled: false` at the deferred-compaction dispatch gate, and add a critical-pressure escape so deferred compaction fires regardless of prompt-cache state when `currentTokenCount >= criticalBudgetPressureRatio * tokenBudget` (default 0.70). Previously, mutation-sensitive providers (Anthropic, Codex, Copilot) could livelock the dispatcher in high-velocity sessions: each turn refreshed `lastCacheTouchAt`, the cache TTL never expired, deferred work never fired, and the runtime emergency overflow handler was left to do all the work. The new escape preserves cache-aware throttling in the 0–70% headroom band while ensuring compaction always fires before overflow.

- [#470](https://github.com/Martian-Engineering/lossless-claw/pull/470) [`8d634cd`](https://github.com/Martian-Engineering/lossless-claw/commit/8d634cdf4b7544c9093c2e701fbbe5075d1e3de6) Thanks [@GodsBoy](https://github.com/GodsBoy)! - Document `lcm-tui` Codex OAuth flows with the explicit `openai-codex` provider so repair, rewrite, doctor, and backfill examples match the new Codex CLI delegate path after `codex login`.

- [#535](https://github.com/Martian-Engineering/lossless-claw/pull/535) [`c8c185b`](https://github.com/Martian-Engineering/lossless-claw/commit/c8c185bb68f768db584c34abfb55b2b578b1b902) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Treat Codex prompt-cache writes and recent cache touches as mutation-sensitive so deferred compaction does not rewrite hot cached prompts before the cache TTL expires.

- [#549](https://github.com/Martian-Engineering/lossless-claw/pull/549) [`d8a7389`](https://github.com/Martian-Engineering/lossless-claw/commit/d8a73890933f2992dc997b0dea6a1e193e364d37) Thanks [@jalehman](https://github.com/jalehman)! - Fix `openai-codex` summarization for modern Codex model ids that are not present in the local `pi-ai` model catalog.

  Lossless now resolves native Codex transport defaults for these models and treats explicit provider error responses as provider failures, allowing configured fallback models to run instead of retrying as an empty summary and falling back to truncation.

- [#513](https://github.com/Martian-Engineering/lossless-claw/pull/513) [`4724d3f`](https://github.com/Martian-Engineering/lossless-claw/commit/4724d3fe6ccfd85f275aad732f3b01551d909e5a) Thanks [@mvanhorn](https://github.com/mvanhorn)! - Correct `lcm_expand_query` source-token accounting guidance for explicit leaf summaries.

- [#555](https://github.com/Martian-Engineering/lossless-claw/pull/555) [`4ea5a99`](https://github.com/Martian-Engineering/lossless-claw/commit/4ea5a99769238143e4a62c3b8797ffd56dd666c0) Thanks [@jeremyheslop](https://github.com/jeremyheslop)! - Declare `contracts.tools` in `openclaw.plugin.json` so OpenClaw 2026.5.2's stricter loader accepts the plugin's `lcm_grep`, `lcm_describe`, `lcm_expand`, and `lcm_expand_query` registrations. Without this declaration the loader emits `plugin must declare contracts.tools before registering agent tools` and the plugin fails to register, which silently disables compaction (the engine still loads but no tools are wired up).

- [#546](https://github.com/Martian-Engineering/lossless-claw/pull/546) [`a4f7059`](https://github.com/Martian-Engineering/lossless-claw/commit/a4f7059a6e50f75e916f688070d2172043627464) Thanks [@baghvn](https://github.com/baghvn)! - Resolve uncataloged DeepSeek and other known provider models to their expected API family and base URL defaults when OpenClaw model metadata is unavailable.

- [#551](https://github.com/Martian-Engineering/lossless-claw/pull/551) [`acb5643`](https://github.com/Martian-Engineering/lossless-claw/commit/acb5643a4ebd09af3626db1e3f2ce22133314ffd) Thanks [@jalehman](https://github.com/jalehman)! - Reconcile foreground transcript turns before post-turn ingestion so assistant replies cannot be stored without their user prompt.

- [#504](https://github.com/Martian-Engineering/lossless-claw/pull/504) [`7063a1f`](https://github.com/Martian-Engineering/lossless-claw/commit/7063a1f17b7be4cd60fc87563d5dbf9ce125b1c4) Thanks [@EpaL](https://github.com/EpaL)! - Prevent assistant-prefill failures on assemble fallback paths while preserving valid assembled assistant turns.

- [#502](https://github.com/Martian-Engineering/lossless-claw/pull/502) [`74004a4`](https://github.com/Martian-Engineering/lossless-claw/commit/74004a4ef486ba2e351a4143acfb8cb4a7573b6c) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Fix prefill errors on cold-cache new sessions that start with only an assistant greeting.

  When a session begins with an agent greeting before any user message and the Anthropic
  prompt cache goes cold (>5 min), `assemble()` could return a context containing only
  the assistant greeting with no user turns. Providers that require conversations to end
  with a user message would then reject the LLM call, silently dropping the user's first
  real message.

  `assemble()` now detects when the assembled context contains no user-role messages at
  all (raw-message-only DB state where every stored message is `assistant` or `toolResult`)
  and falls back to the live context, which correctly ends with the user's current message.
  Sessions with compaction summaries are unaffected because summaries are always stored
  with `role: "user"`.

- [#501](https://github.com/Martian-Engineering/lossless-claw/pull/501) [`ab22632`](https://github.com/Martian-Engineering/lossless-claw/commit/ab2263215877c59738ce3e6d7608274147290aa7) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Move `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, and `@mariozechner/pi-coding-agent` from `dependencies` to optional `peerDependencies` so the plugin always resolves them from the host OpenClaw runtime instead of a pinned local copy.

  Previously these packages were pinned as `dependencies` (fixed at `0.66.1`), which caused npm to install a snapshot in the plugin's own `node_modules/`. That snapshot's internal path references (e.g. `provider.runtime-BlZSfz5M.js`) became stale whenever OpenClaw shipped a new build that bumped `pi-*`, breaking plugin registration on `openclaw ≥ 2026.4.20`.

  By declaring them as optional peer dependencies:

  - No local copy is installed (npm v7+ skips optional peer deps when they are not required by the consumer), so the host-provided versions are resolved via normal Node.js module lookup.
  - The build already marks `@mariozechner/*` as external (`--external:"@mariozechner/*"`), so the runtime was always intended to supply these modules.
  - `devDependencies` retains the pinned `0.66.1` versions so local builds and tests continue to work without needing a live OpenClaw installation.

- [#551](https://github.com/Martian-Engineering/lossless-claw/pull/551) [`acb5643`](https://github.com/Martian-Engineering/lossless-claw/commit/acb5643a4ebd09af3626db1e3f2ce22133314ffd) Thanks [@jalehman](https://github.com/jalehman)! - Skip afterTurn messages whose content is already covered by an auto-compaction summary, preventing safeguard-mode summary re-injection from duplicating user instructions in LCM context.

- [#482](https://github.com/Martian-Engineering/lossless-claw/pull/482) [`8d6c0a1`](https://github.com/Martian-Engineering/lossless-claw/commit/8d6c0a1202b3079d718c47234c65b56b764abefa) Thanks [@banna-commits](https://github.com/banna-commits)! - Fix LCM migration recovery when existing databases are missing the `message_parts` table.

- [#500](https://github.com/Martian-Engineering/lossless-claw/pull/500) [`d3a8bae`](https://github.com/Martian-Engineering/lossless-claw/commit/d3a8bae41c8119c76196d9b399950223d2287d6c) Thanks [@Truck0ff](https://github.com/Truck0ff)! - Prefer model-level runtime `api` declarations over provider and catalog API defaults when dispatching LCM summarizer requests.

- [#521](https://github.com/Martian-Engineering/lossless-claw/pull/521) [`791c591`](https://github.com/Martian-Engineering/lossless-claw/commit/791c5916372680336b7c4a310530ad3b3cf5fa91) Thanks [@jalehman](https://github.com/jalehman)! - Externalize native user image blocks as image files before generic raw payload fallback.

- [#527](https://github.com/Martian-Engineering/lossless-claw/pull/527) [`473b90a`](https://github.com/Martian-Engineering/lossless-claw/commit/473b90a618cd8fdd541d953d69414bb69a494b54) Thanks [@vincentkoc](https://github.com/vincentkoc)! - Declare OpenClaw plugin API compatibility metadata and route plugin SDK type imports through the local compatibility bridge.

- [#506](https://github.com/Martian-Engineering/lossless-claw/pull/506) [`2f7b917`](https://github.com/Martian-Engineering/lossless-claw/commit/2f7b917f9a4239c0a4a29b7d23f7eaf7e15bb838) Thanks [@wujiaming88](https://github.com/wujiaming88)! - Prevent replayed Bedrock transcript tails from being reingested after compaction by matching against the actual stored message tail and treating fully matched suffixes as already stored.

- [#511](https://github.com/Martian-Engineering/lossless-claw/pull/511) [`eb59416`](https://github.com/Martian-Engineering/lossless-claw/commit/eb594167366366a9883c49b3cd30bec354da3f94) Thanks [@jalehman](https://github.com/jalehman)! - Externalize oversized raw message payloads into large file records after existing file, image, and tool-result interceptors run.

- [#515](https://github.com/Martian-Engineering/lossless-claw/pull/515) [`1c7b13f`](https://github.com/Martian-Engineering/lossless-claw/commit/1c7b13fcdacace9a9446d357c360fb9d4313c952) Thanks [@SweetSophia](https://github.com/SweetSophia)! - Use runtime prompt token counts for after-turn compaction decisions when OpenClaw provides usage data, falling back to transcript estimates only when runtime counts are unavailable.

- [#507](https://github.com/Martian-Engineering/lossless-claw/pull/507) [`f2574ed`](https://github.com/Martian-Engineering/lossless-claw/commit/f2574ed9585ebba46b3574d9d2541444766cab19) Thanks [@jalehman](https://github.com/jalehman)! - Drain deferred compaction debt only after foreground after-turn maintenance finishes so background work cannot race bootstrap refreshes or hot prompt-cache paths.

- [#503](https://github.com/Martian-Engineering/lossless-claw/pull/503) [`fd62205`](https://github.com/Martian-Engineering/lossless-claw/commit/fd6220563a3629f19d6e1b6ee2ca490566bc2a57) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Strip provider reasoning and thinking blocks from leaf compaction summarizer input while preserving visible message text.

## 0.9.2

### Patch Changes

- [#444](https://github.com/Martian-Engineering/lossless-claw/pull/444) [`6596fb4`](https://github.com/Martian-Engineering/lossless-claw/commit/6596fb4f3113aa34799662b46698d5fdd053683f) Thanks [@andyylin](https://github.com/andyylin)! - Fix context-engine registration so the plugin only registers its canonical `lossless-claw` id, align runtime Pi package versions with the current OpenClaw stack, and tighten selection helpers to stop treating the old `default` alias as equivalent to the plugin id.

- [#455](https://github.com/Martian-Engineering/lossless-claw/pull/455) [`370b91b`](https://github.com/Martian-Engineering/lossless-claw/commit/370b91b58033a890f5ff9e97fd2a950a50618ba4) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Wrap SQLite migrations in a single exclusive transaction so concurrent startup agents serialize migration work instead of racing on per-statement autocommit writes.

- [#465](https://github.com/Martian-Engineering/lossless-claw/pull/465) [`6f7f942`](https://github.com/Martian-Engineering/lossless-claw/commit/6f7f942ca516bf43dbec9b098a84defcd1677328) Thanks [@liu51115](https://github.com/liu51115)! - Harden defensive handling for non-string database path and timestamp values so malformed runtime data does not trigger `.trim()` crashes or silently skew stored chronology.

- [#405](https://github.com/Martian-Engineering/lossless-claw/pull/405) [`5949a4b`](https://github.com/Martian-Engineering/lossless-claw/commit/5949a4b8a4e35281421b3f3a18c0c95897d3cf4f) Thanks [@uf-hy](https://github.com/uf-hy)! - Restrict the missed-`/reset` bootstrap fallback to confirmed missing transcript paths so transient `stat()` failures do not rotate a live conversation.

- [#450](https://github.com/Martian-Engineering/lossless-claw/pull/450) [`36c80d5`](https://github.com/Martian-Engineering/lossless-claw/commit/36c80d5f8b12483ff4de827359fd22da61b8192b) Thanks [@coryscook](https://github.com/coryscook)! - Use the resolved plugin summary config when runtime config is unavailable so compaction keeps the configured summary model instead of falling back to emergency truncation.

- [#418](https://github.com/Martian-Engineering/lossless-claw/pull/418) [`f8fe367`](https://github.com/Martian-Engineering/lossless-claw/commit/f8fe367c9c7d18c0d2b470c72f799e516150c8aa) Thanks [@gitchrisqueen](https://github.com/gitchrisqueen)! - Fix manual and threshold-triggered compaction results so a full sweep that ends under the target budget reports `already under target` instead of a misleading no-op failure.

- [#468](https://github.com/Martian-Engineering/lossless-claw/pull/468) [`082b2a9`](https://github.com/Martian-Engineering/lossless-claw/commit/082b2a918c2721001ea30e952bde95bc500b7241) Thanks [@jalehman](https://github.com/jalehman)! - Unify `lcm-tui` summary provider configuration across doctor, repair, rewrite, and backfill so the standalone commands honor the same provider, model, and base URL overrides as interactive rewrite.

- [#467](https://github.com/Martian-Engineering/lossless-claw/pull/467) [`6580e8f`](https://github.com/Martian-Engineering/lossless-claw/commit/6580e8f641e3b19d7b452d030a71a2d871106722) Thanks [@jalehman](https://github.com/jalehman)! - Fix `lcm-tui` OAuth-backed Claude rewrites, repairs, and doctor apply runs so large prompts stream over stdin instead of overflowing the CLI argument limit.

- [#456](https://github.com/Martian-Engineering/lossless-claw/pull/456) [`134bb8a`](https://github.com/Martian-Engineering/lossless-claw/commit/134bb8aadada3e8e6884940843ad4ebaeb0bf254) Thanks [@jalehman](https://github.com/jalehman)! - Improve prompt-cache stability by making compacted-context guidance static and disabling prompt-aware eviction by default.

## 0.9.1

### Patch Changes

- [#392](https://github.com/Martian-Engineering/lossless-claw/pull/392) [`00d1fa2`](https://github.com/Martian-Engineering/lossless-claw/commit/00d1fa2c5a7cd2c1b77adb0a9f6c103e487f5e52) Thanks [@GodsBoy](https://github.com/GodsBoy)! - Avoid repeated full bootstrap rereads when an unchanged session transcript misses the normal checkpoint fast paths.

- [#305](https://github.com/Martian-Engineering/lossless-claw/pull/305) [`2d1446f`](https://github.com/Martian-Engineering/lossless-claw/commit/2d1446f29b2e54701baf5b234c2937a5b2909bd7) Thanks [@stilrmy](https://github.com/stilrmy)! - Fix startup-time summary model resolution when OpenClaw populates plugin config before the top-level runtime config surface.

- [#388](https://github.com/Martian-Engineering/lossless-claw/pull/388) [`5bdd596`](https://github.com/Martian-Engineering/lossless-claw/commit/5bdd596f6c3223c3cdaf12c15ba44b685d1b61c6) Thanks [@bennybuoy](https://github.com/bennybuoy)! - Fix the built-in API-family fallback for `ollama` providers so summarization can use OpenAI-compatible Ollama models without requiring an explicit `models.providers.ollama.api` setting.

- [#433](https://github.com/Martian-Engineering/lossless-claw/pull/433) [`5c8ef34`](https://github.com/Martian-Engineering/lossless-claw/commit/5c8ef34ff6baf551a42c73dc1b217a3bb4828891) Thanks [@jalehman](https://github.com/jalehman)! - Apply content-recency sorting consistently to CJK summary full-text search so recent summarized content does not lose to older but stronger trigram matches.

- [#441](https://github.com/Martian-Engineering/lossless-claw/pull/441) [`26708b9`](https://github.com/Martian-Engineering/lossless-claw/commit/26708b9b0b788babba4d1349158414722b18af63) Thanks [@jalehman](https://github.com/jalehman)! - Keep deferred incremental compaction debt pending until oversized raw backlog is actually compacted, and let budget-triggered catch-up scale passes with prompt overage instead of forcing one pass per turn.

- [#434](https://github.com/Martian-Engineering/lossless-claw/pull/434) [`049ce3b`](https://github.com/Martian-Engineering/lossless-claw/commit/049ce3b82339ad373dcc6ef6346fb98087c65159) Thanks [@jalehman](https://github.com/jalehman)! - Keep deferred Anthropic leaf compaction moving once the prompt-cache TTL has gone stale, even if cache-aware cold-observation smoothing still treats the session as effectively hot for routing-noise protection.

## 0.9.0

### Minor Changes

- [#408](https://github.com/Martian-Engineering/lossless-claw/pull/408) [`abf31da`](https://github.com/Martian-Engineering/lossless-claw/commit/abf31da5a5978fc40096699dbb1f52f97d766aaa) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Added deferred proactive compaction as the default mode, with explicit maintenance debt tracking and status visibility so foreground turns no longer run threshold compaction inline unless compatibility mode is enabled.

- [#355](https://github.com/Martian-Engineering/lossless-claw/pull/355) [`6e9388c`](https://github.com/Martian-Engineering/lossless-claw/commit/6e9388c17036caa6021ab075e4d91ee928d73986) Thanks [@LanicBlue](https://github.com/LanicBlue)! - Externalize inline base64 images before large tool-result text compaction, and add `largeFilesDir` / `LCM_LARGE_FILES_DIR` so externalized payload storage can be configured explicitly.

### Patch Changes

- [#403](https://github.com/Martian-Engineering/lossless-claw/pull/403) [`ea7d532`](https://github.com/Martian-Engineering/lossless-claw/commit/ea7d5327d648790350724c15990b5c1ab98bf611) Thanks [@jetd1](https://github.com/jetd1)! - Convert bootstrap's file I/O off the Node.js event loop. `readFileSegment` and `readLastJsonlEntryBeforeOffset` previously used sync `openSync`/`readSync`/`statSync`, which could block the gateway for minutes while scanning multi-MB JSONL transcripts during the bootstrap append-only path. The bootstrap entry `statSync` and `refreshBootstrapState` helper are now async as well. The backward-scan loop now only reads new chunks when the current carry has no more newlines, and the fast path short-circuits before the backward scan when the DB's latest hash no longer matches the checkpoint (the common case during active sessions, where the scan can never succeed).

- [#395](https://github.com/Martian-Engineering/lossless-claw/pull/395) [`2c05599`](https://github.com/Martian-Engineering/lossless-claw/commit/2c05599c7ac6977be47b3358589c8a43332b2d23) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Add `/lcm backup` and `/lcm rotate` plugin commands so users can snapshot the SQLite database on demand and split oversized active LCM conversations without changing their live OpenClaw session identity. Rotation now checkpoints the current transcript frontier so the fresh row starts from now forward instead of replaying older transcript history.

- [#425](https://github.com/Martian-Engineering/lossless-claw/pull/425) [`3faa9bd`](https://github.com/Martian-Engineering/lossless-claw/commit/3faa9bdb04c5fc01833a2b64a478f224254793a0) Thanks [@jalehman](https://github.com/jalehman)! - Report the canonical `lossless-claw` context-engine id from the runtime engine metadata so newer OpenClaw builds accept the plugin's registered engine slot.

- [#420](https://github.com/Martian-Engineering/lossless-claw/pull/420) [`e0fa375`](https://github.com/Martian-Engineering/lossless-claw/commit/e0fa375ae6fcd5964dae56cadf368e1718649128) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Fix `/lcm rotate` so it waits for the live database connection to become idle, takes a faithful pre-rotate backup on that connection, and then compacts the current session transcript without replacing the active LCM conversation. Rotation now preserves the existing conversation id, summaries, and context items while refreshing bootstrap state so dropped transcript history is not replayed.

- [#415](https://github.com/Martian-Engineering/lossless-claw/pull/415) [`7668717`](https://github.com/Martian-Engineering/lossless-claw/commit/7668717ba3790c208baa8bcb9c4f2ae4f35d7910) Thanks [@ryanngit](https://github.com/ryanngit)! - Handle conversation creation races on active session keys without crashing the caller.

- [#413](https://github.com/Martian-Engineering/lossless-claw/pull/413) [`347add7`](https://github.com/Martian-Engineering/lossless-claw/commit/347add70429ab64b81e2191afa354857e03fd16f) Thanks [@ryanngit](https://github.com/ryanngit)! - Increase the SQLite busy timeout to 30 seconds to better tolerate concurrent writer contention without spurious `SQLITE_BUSY` failures.

## 0.8.2

### Patch Changes

- [#400](https://github.com/Martian-Engineering/lossless-claw/pull/400) [`1711957`](https://github.com/Martian-Engineering/lossless-claw/commit/17119577e847750f3c08ab84e47e0e6628bca9ed) Thanks [@jalehman](https://github.com/jalehman)! - Strip comments from the pre-bundled dist/index.js so the OpenClaw install-time code safety scanner no longer flags JSDoc prose (e.g. "Fetch all context items") as a network-send pattern and blocks installation with an `env-harvesting` false positive.

## 0.8.1

### Patch Changes

- [#379](https://github.com/Martian-Engineering/lossless-claw/pull/379) [`7f42703`](https://github.com/Martian-Engineering/lossless-claw/commit/7f4270327ac22cc9028ff4261d44b53561d93a50) Thanks [@jalehman](https://github.com/jalehman)! - Improve the `session_id` fallback conversation lookup by adding the matching composite index so SQLite can satisfy the latest-conversation query without a scan and temp sort.

- [#366](https://github.com/Martian-Engineering/lossless-claw/pull/366) [`f4177ec`](https://github.com/Martian-Engineering/lossless-claw/commit/f4177ec9f06af3dbc9da5241288f62e61bcd26c0) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Fix bootstrap recovery when a session rotates to a new transcript file so stale summaries and checkpoints are cleared before re-importing the replacement session history.

- [#376](https://github.com/Martian-Engineering/lossless-claw/pull/376) [`06a05e5`](https://github.com/Martian-Engineering/lossless-claw/commit/06a05e515828cc99c4bbd1ceb4edfaa40f869264) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Add startup diagnostics that attribute resolved ignore/stateless pattern sources, and warn when env-backed pattern arrays override plugin config arrays.

- [#353](https://github.com/Martian-Engineering/lossless-claw/pull/353) [`6fa2829`](https://github.com/Martian-Engineering/lossless-claw/commit/6fa2829929c14f0c3175efd59a4df68c0e5b8d45) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Pre-bundle the plugin to `dist/index.js` using esbuild before publishing. This eliminates the per-invocation TypeScript compilation overhead caused by OpenClaw's JITI loader recursively transpiling every `.ts` source file, reducing CLI startup latency from 15–25 s to near-instant.

- [#354](https://github.com/Martian-Engineering/lossless-claw/pull/354) [`b0ad788`](https://github.com/Martian-Engineering/lossless-claw/commit/b0ad78872e3f51fe6b1b1bed0a9c93e8e439554e) Thanks [@copilot-swe-agent](https://github.com/apps/copilot-swe-agent)! - Honor `OPENCLAW_STATE_DIR` for the default database, large-file storage, auth-profile, and legacy secret paths so multi-profile OpenClaw gateways do not read and write each other's state.

- [#380](https://github.com/Martian-Engineering/lossless-claw/pull/380) [`33ecb88`](https://github.com/Martian-Engineering/lossless-claw/commit/33ecb8828b6f6258b6884da15e5750af07a0f846) Thanks [@jalehman](https://github.com/jalehman)! - Stop rerunning startup summary and tool-call backfills after they complete successfully, while still retrying the same backfill version cleanly if startup fails before the completion marker is written.

- [#371](https://github.com/Martian-Engineering/lossless-claw/pull/371) [`597ec70`](https://github.com/Martian-Engineering/lossless-claw/commit/597ec700f09660aa58899ef6ef3f37d19112e0df) Thanks [@holgergruenhagen](https://github.com/holgergruenhagen)! - Avoid treating omitted LCM summarizer reasoning settings like reasoning-disabled requests for reasoning-capable models by applying a low default only when the resolved model supports reasoning.

- [#377](https://github.com/Martian-Engineering/lossless-claw/pull/377) [`3b2d34c`](https://github.com/Martian-Engineering/lossless-claw/commit/3b2d34c4e68601e37ce3b012bb38ae4ca5e977af) Thanks [@100yenadmin](https://github.com/100yenadmin)! - Add an opt-in `transcriptGcEnabled` config flag, defaulting it to `false`, and skip transcript-GC rewrites during `maintain()` unless the flag is enabled. Also add startup diagnostics and documentation for the new setting.

- [#387](https://github.com/Martian-Engineering/lossless-claw/pull/387) [`5113044`](https://github.com/Martian-Engineering/lossless-claw/commit/5113044bbbea5af36324e2a546c5adc40b8aabb2) Thanks [@oguzbilgic](https://github.com/oguzbilgic)! - Refresh the bootstrap checkpoint after normal `afterTurn()` ingestion so persistent sessions can keep using the append-only bootstrap fast path after real conversation turns.

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

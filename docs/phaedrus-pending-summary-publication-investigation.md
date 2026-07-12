# Phaedrus pending-summary publication investigation

## Question

Why did Lossless repeatedly clamp or degrade assembled context during a sustained tool-heavy run even though the pending-summary system was preparing summaries with default settings?

The investigation must identify the causal mechanism and the correct implementation boundary. The visible symptom involves pending summaries, but the cause may be in pending-summary planning, publication, compaction scheduling, context assembly, token-pressure accounting, or coordination between those components.

## Environment

- Deployment: Phaedrus
- Lossless code: PR 952 diagnostic branch
- Conversation: `conversation_id=214`
- Session key: `agent:main:telegram:group:-1003998880259:topic:3235`
- Token budget recorded by compaction maintenance: 200,000
- Compaction threshold: 75%, or 150,000 tokens
- `freshTailCount`: no deployment override
- Effective fresh tail: 64 context items, confirmed by runtime `baseFreshTailCount=64` and `freshTailCount=64`

## Relevant preceding defect

One pending batch originally wedged because two Codex MCP tool results stored useful text under `value.result.content[0].text`. The structured-text sanitizer did not traverse that envelope and returned an empty source. The worker retried the deterministic failure twice and left one node failed, which prevented batch publication.

That defect was fixed and deployed. The failed leaf completed on its first retry after deployment, and the batch published at `2026-07-11 04:23:10 UTC`. The analysis below concerns behavior after that recovery.

## Database evidence

After the sanitizer fix, five new batches published and a sixth reached a complete ready frontier:

| Batch created | Published | Elapsed | Result |
| --- | --- | ---: | --- |
| 04:23:15 | 04:23:50 | 0.6 min | Published |
| 04:34:02 | 12:47:28 | 493.4 min | Published after conversation activity resumed |
| 12:56:19 | 13:44:18 | 48.0 min | Published |
| 14:00:02 | 14:22:28 | 22.4 min | Published |
| 14:26:41 | 14:40:48 | 14.1 min | Published |
| 15:12:44 | Not published at inspection | Ready frontier | Two leaf nodes and one depth-one condensed node ready |

Post-fix node state at inspection:

- 36 promoted leaf nodes
- 5 promoted depth-one condensed nodes
- 1 promoted depth-two condensed node
- 2 ready leaf nodes
- 1 ready depth-one condensed node
- Zero retries across these nodes
- Zero failed or stale nodes

The ready batch covers its publishable range. Its nodes are:

- Leaf `5..21`, ready at 15:12:48
- Condensed `2..21`, ready at 15:21:27
- Leaf `22..47`, ready at 15:21:35

The active context at inspection contained:

- 132 raw messages using 54,259 presented tokens
- 5 summaries using 8,189 presented tokens
- Those summaries represented 898,941 source tokens
- Total LCM-presented context: 62,448 tokens

All 48 canonical summaries for the conversation were non-empty. None contained the truncation marker checked during the inspection. Summary generation therefore appears healthy after the sanitizer fix.

## Log evidence

### Pending preparation

The independent Lossless log repeatedly reported:

```text
pending summaries ready for publish
```

For this conversation, that message appeared 152 times during the inspected post-fix period. Six additional attempts reported `drain-already-running`. No Lossless error occurred for the conversation.

This shows that after-turn preparation kept checking a batch whose ready work could not or should not be advanced by that path. The repeated checks may be expected polling, but they consume work and obscure the publication decision.

### Context pressure from 14:14 through 14:22

During a sustained tool-heavy run, assembly began clamping serialized context before the batch created at 14:00 published:

- 14:14:02: 199,393 internal tokens before serialization; 32 messages evicted
- 14:14:40: 207,688 internal tokens; volatile live input initially over budget; 32 messages evicted by the serialized clamp
- 14:15:45: 210,153 internal tokens; 32 messages evicted
- 14:16:02: 218,057 internal tokens; 46 messages evicted
- 14:16:59: 220,510 internal tokens; 54 messages evicted
- 14:17:28: 228,121 internal tokens; 65 messages evicted
- 14:18:34: 230,588 internal tokens; 67 messages evicted
- 14:19:04: 238,312 internal tokens; 77 messages evicted; serialized result still reported over budget
- 14:20:01: 240,833 internal tokens; 79 messages evicted
- 14:20:25: 241,517 internal tokens; 79 messages evicted; serialized result still reported over budget
- 14:22:28: the batch published

At 14:22:28, assembly also reported degraded live fallback because the observed context remained above the 150,000-token pressure threshold.

### Emergency debt handling at 14:40

The next batch was created at 14:26:41 and published at 14:40:48. Immediately before publication, assembly logged:

```text
emergency deferred compaction debt draining pre-assembly
currentTokenCount=343076
projectedTokenCount=151077
tokenBudget=200000
reason=over-budget
```

It then returned degraded live fallback with `reason=emergency-debt-still-pending`. The batch published seconds later.

The relationship between `currentTokenCount=343076`, `projectedTokenCount=151077`, the serialized assembly count, and the active LCM projection needs explanation. The values may represent different layers, but the scheduler uses them to decide whether to drain and degrade.

### Transcript-frontier warnings

The log also contains repeated warnings of this form:

```text
runtime batch does not align with the covered transcript frontier and overlaps persisted history (...); failing closed
```

The transcript reconcile imports the real messages on the next turn. These warnings did not fail pending nodes, but they may change the projection or prevent a ready batch from passing publication revalidation during a fast sequence of turns.

## What appears to work

- Background summary model calls complete.
- Pending nodes reach `ready` without retries.
- Ready nodes promote into canonical summaries when publication runs.
- Publication materially reduces active context.
- Raw history remains available.
- The 64-item fresh-tail default is honored.

## Behavior requiring explanation

Default settings should prepare enough work ahead of the 150,000-token compaction threshold to avoid repeated context clamps and emergency degraded fallback during ordinary sustained execution. The system instead permits assembled context to grow past the token budget for several minutes while pending work is in progress or ready.

The eight-hour batch lifetime is not strong evidence of a defect by itself because the conversation was idle for most of that interval. The active 14:14 through 14:22 and 14:40 intervals are the relevant reproductions.

## Competing hypotheses

These are hypotheses, not conclusions.

1. **Publication only occurs in a maintenance path that does not run at the right point between rapid turns.** After-turn work prepares nodes, but the coordinator waits for a later pre-assembly or deferred-maintenance opportunity to publish them.
2. **The publish gate uses stale or mismatched pressure inputs.** Pending preparation triggers from `rawTokensOutsideTail`, compaction triggers from observed or projected context, and assembly clamps against serialized/model budgets. These counters may cross their thresholds at different times.
3. **A complete ready frontier cannot publish while the live projection keeps advancing.** Transcript reconciliation or projection-fingerprint checks may cause publication to defer during rapid turns even when the ready prefix remains safe to publish.
4. **The 64-item fresh tail can contain enough large tool results to exceed the model budget.** A count-based protected tail does not bound tail tokens. If so, summary publication alone cannot prevent over-budget assembly, and the defaults need a token-bounded tail or a safe escape rule.
5. **The preparation lead threshold is too small for summary latency under burst load.** Preparation starts when raw tokens outside the tail exceed 20,000. A fast tool loop can add tokens faster than the summarizer produces and publishes nodes.
6. **Emergency debt handling checks completion only once.** It may initiate or observe deferred work, return degraded context, and miss a frontier that becomes publishable seconds later.
7. **Repeated after-turn polling competes with useful drain work.** The 152 `ready for publish` results may indicate that the selected phase performs a full or material check without advancing publication.

## Code paths to trace

- `src/engine.ts`
  - after-turn pending-summary preparation and drain scheduling
  - deferred compaction maintenance
  - pre-assembly emergency debt handling
  - degraded live fallback
  - serialized budget clamp
  - pressure computation and threshold selection
- `src/pending-summary-coordinator.ts`
  - `runOnce()` phase behavior
  - conditions that return `pending summaries ready for publish`
  - lease, retry, revalidation, and publication transitions
- `src/pending-summary-planner.ts`
  - `selectPendingPublishFrontier()`
  - ready-prefix coverage rules
  - fresh-tail exclusion
- `src/assembler.ts`
  - count-based fresh-tail protection
  - tail token accounting
  - eviction and serialized clamp interaction
- `src/compaction.ts`
  - fresh-tail resolution
  - projected token counts and compaction selection
- `src/db/config.ts`
  - default `freshTailCount=64`

## Questions for the investigator

1. What exact event is responsible for publishing a ready pending-summary frontier?
2. Can after-turn preparation publish, or does it deliberately stop at `ready for publish`?
3. Which code path published the 14:00 batch at 14:22:28 and the 14:26 batch at 14:40:48?
4. Why did assembly clamp context repeatedly before those publications?
5. Were the frontiers already complete during the clamp intervals, or was summary generation still catching up?
6. If generation was still running, why did preparation begin too late under default settings?
7. Does continuous projection growth invalidate publication, or can the longest ready prefix publish safely while newer items stay raw?
8. Are `currentTokenCount`, `projectedTokenCount`, `rawTokensOutsideTail`, internal estimated tokens, and serialized tokens measuring compatible quantities?
9. Can the protected 64-item tail exceed the token budget on its own? What behavior does the assembler use in that case?
10. Which component owns the fix: pending-summary coordination, deferred compaction scheduling, assembly, pressure accounting, configuration defaults, or a combination?

## Expected result

Produce a causal chain grounded in code and the evidence above. Separate confirmed facts from inference. Identify the smallest correct fix and the tests that would fail before it. Do not assume the symptom belongs to the pending-summary implementation merely because pending summaries appear in the logs.

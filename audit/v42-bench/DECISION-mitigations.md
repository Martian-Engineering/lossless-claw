# Decision: v4.2 stub-tier mitigations

## Context

After the Opus subagent A/B comparison of v4.1 baseline (333 blocks) vs v4.2-stubs (689 blocks at full migration; 421 in our partial-migration test) at the same 258K-token budget, four mitigations were recommended to address moderate-risk findings (stale-info, cognitive load, stub legibility):

1. Recency cue `[t-NNm]` on turn headers
2. Semantic stub wrapping `<lcm-stub …>` XML tags
3. Empty-assistant collapsing
4. Resolution markers at completion boundaries

We applied the first-principles-architectural-decision skill (Step 1: research, Step 1.5: run-the-system, Step 2: where-it-lives, Step 3: adversarial debate) before deciding to build any of them.

## Decision

**REJECT ALL FOUR.** Stay with v4.2 as currently shipped (Options C + D + F at commit `e309bed`).

## Rationale

### #1 — Recency cue `[t-NNm]` — REJECT

**Empirical finding (Step 1):** User messages already carry absolute timestamps in prefix form: `[Thu 2026-04-09 01:38 GMT+7]`. Counted 55 in baseline, 71 in v4.2 (one per user turn). The agent already has the recency signal it needs.

**Architectural failure (Step 2 diagram):** A `[t-NNm]` tag is a function of `now()` at assemble time. The same conversation prefix produces a different rendered string on every assembly. This invalidates the Anthropic prompt cache prefix all the way back to the first turn, on every single request. v4.2's whole value proposition (689 items at same budget) is amortized via prefix caching. Burning the cache to add information already present in the prefix is strictly negative ROI.

**Adversarial verdict:** FOR position 85% confidence ("low-cost insurance against unobserved failure mode"). AGAINST position ≥95% confidence (cache thrashing + redundant data). AGAINST wins decisively.

### #2 — Semantic stub wrapping `<lcm-stub>` XML — REJECT

**Empirical finding (Step 1.5):** The existing `[LCM Tool Output: file_xxx | tool=… | N bytes]` format works in our live Opus test. Opus correctly identifies stubs, matches user references to fileIds (after Option F's tool_input disambiguator), and writes the correct `lcm_describe(id="file_xxx")` call. The format has been in production since v4.1 (3 stubs use it in baseline transcript).

**Architectural failure:** Switching to a novel `<lcm-stub fileId=…>` invents a token sequence the model has not seen, and bets that "XML structure" outperforms a working format. The case FOR was admitted to be weak (~85% from the FOR agent itself: "future-proofing for richer metadata"). The semantic content (file id, tool name, byte count, drilldown instruction) is already present in the bracket form.

**Adversarial verdict:** FOR position couldn't reach 95%. AGAINST position 92%. Format works; novelty is cost without observed benefit.

### #3 — Empty-assistant collapsing — REJECT

**Empirical finding (Step 1):** ~39-40% of assistant turns are empty after stripping the rendered ` ```tool_use``` ` fences (177 → 71 in baseline; 249 → 98 in v4.2; ~identical proportion). Statistically significant.

**Architectural failure (Step 2 diagram):** The wire-format contract requires `tool_use` blocks to live in assistant turns; `tool_result` blocks pair to them by `toolCallId`. The Anthropic / OpenAI API will reject a `tool_result` whose preceding assistant turn doesn't carry the matching `tool_use`. The "empty" rendering in our dump is a display artifact — the assembler emits content arrays containing tool_use blocks; the dump renderer chose to elide them visually but they exist in the API payload.

**Two interpretations of the mitigation, both fail:**
- If "collapse" = render-time only → it's already happening (those blocks render empty in our dump). No-op.
- If "collapse" = drop tool_use blocks from the API payload → breaks provider contracts; the `toolCallId` on every tool_result line proves the pairing requirement. Producers reject orphan tool_results.

**Adversarial verdict:** FOR position 90% (real statistical evidence of empty turns). AGAINST position ≥95% (wire-contract is non-negotiable). AGAINST wins.

### #4 — Resolution markers — REJECT

**Empirical finding (Step 1):** No reliable signal exists for "work completed" in the actual transcript. User turns include `"go ahead"`, `"Yes, go ahead"`, `"keep digging"`, `"Do not come back to me; go autonomous"` — none mark completion; several look like completion phrases but authorize more work. Conversation oscillates with no clean boundary.

**Architectural failure:** The mitigation requires deciding WHEN to inject a synthetic system block. Heuristic options:
- PR merge events: agent isn't doing PR work in this session
- "User said 'fixed'": doesn't appear in either dump
- "User changed topic": false positives every time user pauses mid-problem
- Explicit annotation: 0% of real users will manually mark completion

False positives are strictly worse than no marker — they license premature stubbing of context that's still load-bearing.

**Adversarial verdict:** FOR position 70% (inferred future optimization). AGAINST position ≥95% (no shippable trigger). AGAINST wins.

## Counter-arguments considered

**FOR #1 strongest case:** "Low-cost insurance against unobserved stale-info risk."
- Rebuttal: cache thrashing is observable cost; stale-info is theoretical. Trading observed cost for theoretical benefit is strictly negative.

**FOR #3 strongest case:** "39% of assistant turns are empty — pure compression win."
- Rebuttal: the bytes attributed to "empty turns" are actually tool_use blocks (required by provider contracts). The dump renderer elides them; the API payload contains them. The "savings" are illusory.

**FOR #4 strongest case:** "Resolution markers help LCM make smarter eviction decisions."
- Rebuttal: even if true, there's no reliable signal to detect resolution. False positives cause premature eviction of load-bearing context — worse than current behavior.

## Risks accepted by rejecting all four

1. **Stale-info on user prompts that don't reference timestamps:** mitigated by the timestamps already in user prefixes. If observed in production, can revisit with a CACHE-STABLE recency signal (e.g., turn-position-based instead of clock-based).
2. **Cognitive load from 88 more blocks at same budget:** Opus's analysis showed signal-to-noise unchanged. If observed in production, address by raising the per-row stub threshold from 8KB to 16KB (ships fewer stubs).
3. **Stub legibility on a future model that hasn't seen the v4.1 format:** if the model ever fails to recognize `[LCM Tool Output:]`, the issue surfaces clearly (no drilldown calls), and we revisit.

## Open questions deferred

- **Live runtime drilldown rate measurement:** post-merge, in a controlled session, count how often agents invoke `lcm_describe(file_xxx)` when stubs are present. Pass: ≥70% on conversational queries that reference specific elided tool calls. This is the gating signal for default-on rollout.
- **JOIN cost of `getLargeFile()` lookups in `resolveMessageItem`** on a 2.6GB DB: needs benchmarking. Currently bench shows 124ms total assemble time, so likely fine, but worth measuring at scale.

## Reversibility

Rejecting these mitigations is fully reversible:

- If stale-info actually fires in production, build a cache-stable recency signal (e.g., turn-relative `[turn -47]` instead of clock-relative `[t-12m]`) — that's a different mitigation than #1.
- If a future model fails to recognize the bracket format, ship Option G (LLM-generated exploration summaries instead of tool_input disambiguators) which gives the agent semantic content rather than format recognition.
- Empty-assistant work can be revisited as a v4.1 cleanup PR (separate from v4.2, addresses both variants equally).
- Resolution markers can be revisited if/when explicit user annotations become a workflow primitive elsewhere in OpenClaw.

None of these would compete with the v4.2 work that's shipped.

## Conclusion

The current v4.2 (Options C + D + F at commit `e309bed`) is the right shipping shape. Each proposed mitigation either:
- Adds cost without observed benefit (#1 cache thrash; #2 novel format)
- Conflates rendered transcript with API payload (#3 wire-contract)
- Has no reliable trigger condition (#4 detection)

Empirical drilldown validation is the remaining gating signal, and that's a post-merge live-runtime test, not a pre-merge architectural change.

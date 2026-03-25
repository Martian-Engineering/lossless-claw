---
title: feat: Prompt-Aware Context Assembly with BM25-lite Relevance Scoring
type: feat
status: active
date: 2026-03-25
---

# feat: Prompt-Aware Context Assembly with BM25-lite Relevance Scoring

## Overview

LCM (lossless-claw v0.5.1) currently assembles context in strict chronological order — when the token budget is exceeded, oldest evictable items are dropped regardless of their relevance to the user's current query. OpenClaw PR #50848 (merged 21 Mar 2026) added an optional `prompt` parameter to the `ContextEngine.assemble()` interface so retrieval-oriented context engines can use the query for relevance-based eviction. This plan implements that parameter end-to-end with a zero-cost BM25-lite keyword scorer.

## Problem Statement

When the token budget is tight, the oldest summaries are evicted first — even if they are the most relevant to what the user is asking right now. A summary from 10 turns ago about "authentication bugs" is evicted before a recent-but-irrelevant summary about "UI theming" simply because it is older. This degrades response quality in long sessions.

Competitors like ByteRover use 5-tier query-aware retrieval to solve this. Our advantage is that we can solve it with zero token cost and no external API dependency using lightweight keyword scoring.

## Proposed Solution

When `prompt` is provided and the evictable window exceeds the remaining budget:

1. Extract text from each evictable `ResolvedItem` (already computed during resolution)
2. Score each item using BM25-lite (TF × IDF approximation using term frequency against corpus)
3. Sort evictable items by score descending (recency as tiebreaker)
4. Greedily fill the budget from highest-scoring items down
5. Re-sort selected items by ordinal to preserve chronological ordering in the output

When `prompt` is absent or all scores are equal, fall back to existing chronological behaviour (100% backward compatible).

## Technical Approach

### Files to Modify

#### 1. `src/assembler.ts`

**Interface change** (lines 14–19):
```typescript
export interface AssembleContextInput {
  conversationId: number;
  tokenBudget: number;
  freshTailCount?: number;
  prompt?: string;                    // ← ADD: optional user query for relevance scoring
}
```

**ResolvedItem enrichment** — add a `text: string` field to the private `ResolvedItem` interface (lines 626–637) so the scorer can access pre-extracted text without re-parsing `message.content`:
```typescript
interface ResolvedItem {
  ordinal: number;
  message: AgentMessage;
  tokens: number;
  isMessage: boolean;
  text: string;                       // ← ADD: pre-extracted plain text for scoring
  summarySignal?: SummaryPromptSignal;
}
```

Set `text` in both resolution paths:
- Raw message items: use `contentText` already computed in `resolveMessageItem` (~line 831)
- Summary items: use `summary.content` already available in `resolveSummaryItem` (~line 618)

**BM25-lite scorer** — add a pure function (no dependencies, no LLM calls):
```typescript
// src/assembler.ts (before or after the class)
function scoreRelevance(itemText: string, prompt: string): number {
  // Tokenize: lowercase, split on non-alphanumeric
  const promptTerms = tokenize(prompt);
  if (promptTerms.length === 0) return 0;
  const itemTerms = tokenize(itemText);
  const itemFreq = termFrequency(itemTerms);
  // BM25-lite: sum of tf * log(1 + promptTermCount/docFreq)
  // Simplified: TF-based overlap score
  let score = 0;
  for (const term of promptTerms) {
    score += (itemFreq.get(term) ?? 0) / (itemTerms.length || 1);
  }
  return score;
}
```

**Eviction logic replacement** (lines ~726–741) — replace the hard-break chronological loop with prompt-aware scoring when applicable:

```typescript
// Current hard-break loop → replace when prompt present
if (input.prompt && evictable.some(item => !item.isMessage)) {
  // Score each evictable item
  const scored = evictable.map((item, idx) => ({
    item,
    score: scoreRelevance(item.text, input.prompt!),
    idx,                              // original index = recency proxy
  }));
  // Sort: highest score first, then most recent (higher idx) as tiebreaker
  scored.sort((a, b) => b.score - a.score || b.idx - a.idx);
  // Greedy fill
  const kept: ResolvedItem[] = [];
  let accum = 0;
  for (const { item } of scored) {
    if (accum + item.tokens <= remainingBudget) {
      kept.push(item);
      accum += item.tokens;
    }
  }
  // Restore chronological order by ordinal
  kept.sort((a, b) => a.ordinal - b.ordinal);
  // Combine with freshTail
  ...
} else {
  // Existing chronological hard-break loop (unchanged)
  ...
}
```

#### 2. `src/engine.ts`

**Params change** (~line 2170):
```typescript
async assemble(params: {
  sessionId: string;
  sessionKey?: string;
  messages: AgentMessage[];
  tokenBudget?: number;
  prompt?: string;                    // ← ADD
}): Promise<AssembleResult>
```

**Thread through** to assembler call (~line 2222):
```typescript
const assembled = await this.assembler.assemble({
  conversationId: conversation.conversationId,
  tokenBudget,
  freshTailCount: this.config.freshTailCount,
  prompt: params.prompt,              // ← ADD
});
```

### New Test Cases (`test/engine.test.ts`)

Add a `describe('prompt-aware eviction')` block with:

| Test | Description |
|------|-------------|
| `prefers relevant summaries` | Budget tight; two summaries — one matches prompt keywords, one doesn't. Verify relevant one is kept. |
| `falls back to chronological when no prompt` | Same setup, no prompt. Verify oldest evicted as before. |
| `empty string prompt → chronological fallback` | Prompt is `""` — must not crash, must use chronological. |
| `single evictable item` | One evictable item; always kept if it fits, dropped if not — same as today. |
| `budget fits everything` | No eviction needed; prompt has no effect on output. |
| `engine.assemble() threads prompt through` | Integration: call engine.assemble() with prompt, verify assembler receives it (spy or observable effect). |

## System-Wide Impact

- **Backward compatibility:** `prompt` is optional with `undefined` default. All existing callers are unaffected. The chronological fallback is code-identical to the current implementation.
- **Performance:** BM25-lite runs in O(T·P) where T = number of evictable tokens and P = prompt term count. Negligible vs. DB round-trips.
- **State:** No persistent state changes. No DB schema changes.
- **Error propagation:** Scorer is a pure function; any exception would propagate up through `assemble()` as-is (same error contract as today).

## Acceptance Criteria

- [ ] `AssembleContextInput` has `prompt?: string`
- [ ] `LcmContextEngine.assemble()` params has `prompt?: string` and threads it to assembler
- [ ] `ResolvedItem` has `text: string` set during resolution for both message and summary items
- [ ] BM25-lite scorer is a pure function with no external dependencies and no LLM calls
- [ ] When `prompt` is set and eviction is needed, high-scoring items are kept over low-scoring older items
- [ ] When `prompt` is absent or `""`, output is identical to current chronological behaviour
- [ ] All existing tests pass (`vitest run --dir test`)
- [ ] New tests cover all cases listed above
- [ ] No TypeScript errors in strict mode (`tsc --noEmit`)
- [ ] No `any` types introduced

## Dependencies & Risks

- **No new npm dependencies** — scorer is implemented inline
- **Risk:** The `ResolvedItem.text` enrichment touches both resolution paths. If either path is missed, scoring will silently return 0 (safe degradation, not a crash).
- **Risk:** The hard-break loop assumption. Current code assumes contiguous selection. The new sort-then-fill approach changes this. Must verify that `ordinal` re-sorting correctly reconstructs chronological order in the final output.

## Sources & References

- OpenClaw PR #50848 — added `prompt?` to ContextEngine.assemble() interface
- `src/assembler.ts` — `AssembleContextInput` interface (lines 14–19), `ResolvedItem` (lines 626–637), eviction loop (lines 726–741)
- `src/engine.ts` — `LcmContextEngine.assemble()` (~line 2170), assembler call (~line 2222)
- `test/engine.test.ts` — existing assembler integration tests (lines 1044, 1156, 1836)

# Historical Session Backfill + Archive Compaction (TUI)

## Problem
Lossless Claw only creates LCM summaries for sessions that were active after LCM was enabled. Older JSONL sessions exist in `~/.openclaw/agents/*/sessions/` but have no LCM conversation rows, no summary DAG, and no way to transplant their history into current conversations.

## Goal
Add a TUI CLI workflow that can:
1. Import a pre-LCM session JSONL into LCM tables as a new conversation.
2. Run iterative depth-aware compaction to build a balanced summary DAG.
3. Optionally force-collapse to a single root summary node (archive root).
4. Optionally transplant the resulting context/DAG into a target conversation.

This enables “memory bootstrapping” from historical sessions.

---

## UX / CLI
Add new command:

```bash
lcm-tui backfill <agent> <session_id>
  [--dry-run]
  [--apply]
  [--single-root]
  [--transplant-to <conversation_id>]
  [--title "..."]
  [--leaf-chunk-tokens <n>]
  [--leaf-target-tokens <n>]
  [--condensed-target-tokens <n>]
  [--leaf-min-fanout <n>]
  [--condensed-min-fanout <n>]
  [--condensed-min-fanout-hard <n>]
  [--fresh-tail-count <n>]
  [--model <anthropic-model>]
```

### Behavior
- `--dry-run` (default): print plan and estimated work; no DB writes.
- `--apply`: perform import + compaction.
- `--single-root`: after normal compaction, run forced condensation passes until one summary remains in context.
- `--transplant-to`: if provided with `--apply`, transplant from newly backfilled conversation to target conversation using existing transplant flow.

---

## Implementation Design

### 1) New file: `tui/backfill.go`
Implement standalone command entrypoint analogous to `repair/rewrite/transplant/dissolve`.

#### Core phases
1. **Resolve source session file**
   - Path: `~/.openclaw/agents/<agent>/sessions/<session_id>.jsonl`
   - Validate file exists/readable.

2. **Create conversation row (or reuse by session_id if already exists)**
   - Insert into `conversations(session_id, title, bootstrapped_at)`.
   - Use provided `--title` or default: `Historical import: <agent>/<session_id>`.
   - If conversation already exists and has messages, abort unless explicitly same imported session (idempotency guard).

3. **Import messages + context items**
   - Parse JSONL with existing `parseSessionMessages` normalization logic.
   - Insert `messages` rows with monotonic `seq` starting at 1.
   - Insert matching `context_items` rows (`item_type='message'`, ordinals 0..N-1).
   - For minimum viable version, insert text-only message records (`role`, normalized `content`, estimated `token_count`).
   - Optional enhancement: import `message_parts` if easily reusable.

4. **Run archive compaction loop (new in TUI)**
   - Implement depth-aware compaction in Go (local command-level engine).
   - Reuse existing prompt/template stack from `prompts.go` (`renderPrompt`) and Anthropic client from `repair.go`.
   - Algorithm:
     - Repeated leaf passes over oldest raw-message chunks outside fresh tail.
     - Then condensed passes over shallowest eligible depth first.
     - Fanout thresholds:
       - d0: `leaf-min-fanout`
       - d1+: `condensed-min-fanout`
       - hard/forced passes: `condensed-min-fanout-hard`
     - Chunk token budget and target token sizes from flags (with sane defaults matching plugin).
     - Persist `summaries`, `summary_messages`, `summary_parents`, and context replacements in transactions.

5. **Optional single-root fold** (`--single-root`)
   - After normal convergence, if more than 1 summary remains in context, run forced condensed passes that ignore normal min-chunk threshold and keep condensing contiguous shallowest candidates until one summary remains.
   - Preserve DAG lineage (no destructive deletion).

6. **Optional transplant** (`--transplant-to`)
   - Invoke existing in-process transplant functions (`buildTransplantPlan` + `applyTransplant`) from source backfilled conversation -> target conversation.

7. **Reporting**
   - Print:
     - created/used conversation id
     - imported message count
     - summary counts by depth
     - final context item distribution
     - whether single-root achieved
     - transplant results (if requested)

---

## Reuse Existing Code
- **Session parsing/normalization**: `tui/data.go` (`parseSessionMessages`, content normalization helpers).
- **Prompt rendering**: `tui/prompts.go` (`renderPrompt`, depth mapping).
- **LLM client**: `tui/repair.go` anthropic client utilities.
- **Transplant**: `tui/transplant.go` plan/apply functions.
- **Previous-context retrieval patterns**: `tui/previous_context.go` / rewrite flow.

Keep new code modular; avoid duplicating large SQL snippets where existing helpers can be shared.

---

## Data Integrity & Safety
- All `--apply` mutations must run in transactions.
- Idempotency guard: do not duplicate import into same session conversation.
- Preserve existing conversations; no destructive updates outside new conversation + explicit transplant target.
- On dry-run, print intended inserts/compaction rounds without mutating DB.

---

## Edge Cases
- Missing/empty JSONL file.
- Session already imported.
- Message parsing yields zero messages.
- API failures mid-compaction (report partial progress; keep DB consistent via pass-level transactions).
- Target conversation missing for transplant.
- `--single-root` cannot progress due to malformed graph (abort with diagnosis).

---

## Tests
Add focused tests in `tui/backfill_test.go`:
1. Import creates conversation + message/context rows from fixture JSONL.
2. Dry-run performs no writes.
3. Compaction creates d0 summaries and replaces message ranges.
4. Condensation builds parent edges with increasing depth.
5. `--single-root` reduces active summary context to one node.
6. `--transplant-to` runs and prepends target context summaries.
7. Idempotency guard blocks double import.

Use in-memory sqlite fixtures similar to `transplant_test.go`.

---

## Acceptance Criteria
- Command exists and is documented in `tui.md` + `tui/README.md`.
- A historical session with no prior LCM conversation can be imported and compacted end-to-end.
- Resulting DAG is balanced by shallowest-depth-first condensation.
- `--single-root` yields exactly one summary context item when possible.
- Optional transplant copies the full reachable DAG into target conversation.
- Tests pass.

---

## Non-Goals (first pass)
- Perfect byte-for-byte parity with plugin compaction internals.
- Importing every nuanced `message_parts` variant from raw JSONL.
- Multi-session batch orchestration (can be added later via wrapper command).
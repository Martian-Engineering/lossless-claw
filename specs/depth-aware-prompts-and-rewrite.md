# Depth-Aware Summary Prompts & Rewrite Tooling

**Status:** Draft  
**Date:** 2026-02-19  
**Scope:** OpenClaw LCM (open-lcm plugin) + lcm-tui

## Problem

LCM's condensed summaries are low-quality for two reasons:

1. **No temporal information.** `leafPass` concatenates message contents with `\n\n` — discarding the `created_at` timestamps that exist on every message record. `condensedPass` similarly concatenates child summary contents with no time context. The summarizer has no way to produce a timeline even if instructed to.

2. **One-size-fits-all prompt.** `buildCondensedSummaryPrompt` uses a rigid Pi-style template (Goals & Context, Key Decisions, Progress, Constraints, Critical Details, Files) regardless of depth. A d1 node compressing 8 leaf summaries covering 2 hours of activity gets the same prompt as a d3 node compressing months of work. The result: status reports that repeat the same project context verbatim across every node, with no sense of temporal progression or information hierarchy.

Additionally, the prompts are biased toward software development (the domain of all test content to date), but OpenClaw is a general-purpose personal agent used for research, business, content creation, personal tasks, and more. Prompts must be domain-agnostic.

## Changes

### 1. Timestamp injection in compaction.ts

**leafPass** currently builds:
```typescript
const concatenated = messageContents.map((m) => m.content).join("\n\n");
```

Change to include message timestamps:
```typescript
const concatenated = messageContents
  .map((m) => `[${formatTimestamp(m.createdAt)}]\n${m.content}`)
  .join("\n\n");
```

This requires `leafPass` to also select `createdAt` when fetching messages. The `getMessageById` return type (`MessageRecord`) already includes `createdAt: Date`.

**condensedPass** currently builds:
```typescript
const concatenated = summaryRecords.map((s) => s.content).join("\n\n");
```

Change to include time ranges derived from the summary's source messages:
```typescript
const concatenated = summaryRecords
  .map((s) => {
    const range = timeRanges.get(s.summaryId);
    const header = range
      ? `[${formatTimestamp(range.earliest)} – ${formatTimestamp(range.latest)}]`
      : `[${formatTimestamp(s.createdAt)}]`;
    return `${header}\n${s.content}`;
  })
  .join("\n\n");
```

**Time range resolution** for condensed pass inputs: For each child summary, derive the time range from the earliest and latest `created_at` of the messages at the leaves of its DAG subtree. This requires a recursive query (or cached columns — see section 3).

**`formatTimestamp`**: A utility that formats `Date` to a human-readable string. For leaf pass (message-level), include date and time: `"2026-02-17 15:37 UTC"`. For condensed pass, the same format works — the depth-aware prompts tell the model what granularity to use in output.

### 2. Depth-aware prompts in summarize.ts

Replace `buildCondensedSummaryPrompt` with a depth-dispatching function:

```typescript
function buildCondensedSummaryPrompt(params: {
  text: string;
  targetTokens: number;
  depth: number;           // ← new
  previousSummary?: string;
  customInstructions?: string;
}): string {
  const { depth } = params;
  if (depth <= 1) return buildD1Prompt(params);
  if (depth === 2) return buildD2Prompt(params);
  return buildD3PlusPrompt(params);
}
```

The `depth` parameter is the target depth of the node being created (i.e., `targetDepth + 1` from `condensedPass`). It's already available in `condensedPass` as `targetDepth` — just needs threading through.

#### d1 Prompt — `condensed-d1.tmpl` (leaves → depth 1)

```
You are compacting leaf-level conversation summaries into a single condensed memory node.

You are preparing context for a fresh model instance that will continue this conversation.
{{if .PreviousContext -}}
It already has the following preceding summary as context — do NOT repeat information
that appears there unchanged. Focus on what is new, changed, or resolved:

<previous_context>
{{.PreviousContext}}
</previous_context>

{{else -}}
Focus on what matters for continuation:
{{end -}}
- Decisions made and their rationale (only when rationale matters going forward)
- Decisions from earlier that were altered or superseded, and what replaced them
- Tasks or topics completed, with outcomes (not just "done" — what was the result?)
- Things still in progress: current state, what remains
- Blockers, open questions, and unresolved tensions
- Specific references (names, paths, URLs, identifiers) that future turns will need

Drop minutiae — operational details that won't affect future turns:
{{- if .PreviousContext}}
- Context that hasn't changed since previous_context (the model already has it)
{{- end}}
- Intermediate exploration or dead ends when the conclusion is known (keep the conclusion)
- Transient states that are already resolved
- Tool-internal mechanics and process scaffolding
- Verbose references when shorter forms would suffice

Use plain text. No mandatory structure — organize however makes the content clearest.

Include a timeline with timestamps (to the hour or half-hour) for significant events —
decisions, completions, state changes. Present information in chronological order.
Mark decisions that supersede earlier ones.

Target length: about {{.TargetTokens}} tokens.
```

#### d2 Prompt — `condensed-d2.tmpl` (d1s → depth 2)

```
You are condensing multiple session-level summaries into a higher-level memory node.

Each input summary covers a significant block of conversation. Your job is to extract the arc:
what was the goal, what happened, and what carries forward.

A future model instance will read this to understand the trajectory of this conversation —
not the details of each session, but the overall shape of what occurred and where things stand.

Preserve:
- Decisions that are still in effect and their rationale
- Decisions that evolved: what changed and why
- Completed work with outcomes (not process)
- Active constraints, limitations, and known issues
- Current state of anything still in progress
- Key references only if they're still relevant

Drop:
- Per-session operational minutiae (internal IDs, tool mechanics, process details)
- Specific identifiers and references that were only relevant within a session
- Anything that was "planned" in an earlier summary and "completed" in a later one —
  just record the completion
- Intermediate states that a later summary supersedes
- How things were done (unless the method itself was the decision)

Use plain text. Brief section headers are fine if they help organize, but don't force a
rigid template.

Include a timeline with timestamps (date and approximate time of day) for key milestones —
decisions, completions, phase transitions. The reader should understand both what happened
and roughly when.

Target length: about {{.TargetTokens}} tokens.
```

#### d3+ Prompt — `condensed-d3.tmpl` (d2s → depth 3+)

```
You are creating a high-level memory node from multiple phase-level summaries.

This node may persist for the entire remaining conversation. Only include what a fresh model
instance would need to pick up this conversation cold — possibly days or weeks from now.

Think: "what would I need to know?" not "what happened?"

Preserve:
- Key decisions and their rationale
- What was accomplished and its current state
- Active constraints and hard limitations
- Important relationships between people, systems, or concepts
- Lessons learned ("don't do X because Y")

Drop:
- All operational and process detail
- How things were done (only what was decided and the outcome)
- Specific references unless they're essential for continuation
- Progress narratives (everything is either done or captured as current state)

Use plain text. Be ruthlessly concise.

Include a brief timeline with dates (or date ranges) for major milestones and decisions.

Target length: about {{.TargetTokens}} tokens.
```

### 3. Summary time range tracking (optional schema addition)

Computing time ranges via recursive DAG traversal at summarization time is expensive for deep trees. Two options:

**Option A: Compute at summarization time (no schema change).** For each child summary in `condensedPass`, run a recursive query joining through `summary_parents` → `summary_messages` → `messages` to find `MIN(created_at)` and `MAX(created_at)`. This is a read-only query on indexed columns; cost is proportional to DAG depth.

**Option B: Add `earliest_at` / `latest_at` columns to summaries table.** Populated at insert time:
- For leaves: `earliest_at` = min message `created_at`, `latest_at` = max message `created_at`
- For condensed: `earliest_at` = min child `earliest_at`, `latest_at` = max child `latest_at`

This makes time ranges O(1) at read time. Migration backfills from existing DAG structure. Schema change:
```sql
ALTER TABLE summaries ADD COLUMN earliest_at TEXT;
ALTER TABLE summaries ADD COLUMN latest_at TEXT;
```

**Recommendation:** Option A for initial implementation. Option B as a follow-up if query cost becomes noticeable. The recursive query is bounded by DAG depth (typically 3-4 levels) and runs only during compaction passes, not on every turn.

### 4. Thread depth through to the prompt

Currently `condensedPass` has `targetDepth` (the depth of the input nodes). The output node's depth is `targetDepth + 1`. The prompt needs this output depth to select the right template.

In the call chain:
```
condensedPass(conversationId, summaryItems, targetDepth, summarize)
  → summarizeWithEscalation({ sourceText, summarize, options: { isCondensed: true } })
    → summarize(sourceText, aggressive, { isCondensed: true })
      → buildCondensedSummaryPrompt({ text, targetTokens })
```

Add `depth` to `LcmSummarizeOptions`:
```typescript
export type LcmSummarizeOptions = {
  previousSummary?: string;
  isCondensed?: boolean;
  depth?: number;  // ← new: output node depth (1 = d1, 2 = d2, etc.)
};
```

Pass it through from `condensedPass`:
```typescript
options: {
  previousSummary: previousSummaryContent,
  isCondensed: true,
  depth: targetDepth + 1,
}
```

### 5. Leaf prompt: previous_context note

The d1 condensed prompt references `<previous_context>` because leaf summaries receive it. At d2+, `condensedPass` currently only resolves previous context for `targetDepth === 0`. This is correct — higher depths don't have a meaningful "previous context" in the same way. The d2/d3+ prompts don't reference `<previous_context>`, which matches the current code behavior.

No code change needed here, but worth documenting: previous_context is a d1-only construct.

---

## lcm-tui Rewrite Tool

### Purpose

Retroactively rewrite summaries in-place using new or custom prompts. Use cases:

1. **Test prompt improvements** on live conversation data without re-running the entire conversation
2. **Upgrade existing summaries** when prompts are improved (like this change)
3. **Operator customization** — allow individual OpenClaw operators to tune their summary style

### Design

New `rewrite` subcommand and interactive TUI integration.

#### CLI: `lcm-tui rewrite`

```
lcm-tui rewrite <conversation_id> [flags]

Flags:
  --summary <id>       Rewrite a single summary
  --depth <n>          Rewrite all summaries at depth n
  --all                Rewrite all summaries (bottom-up)
  --dry-run            Show before/after without writing (default: true)
  --apply              Actually write changes
  --prompt-dir <path>  Custom prompt templates directory (future)
  --model <model>      Model to use (default: claude-sonnet-4-20250514)
  --diff               Show unified diff of old vs new content
  --bottom-up          Process leaves first, then d1, d2, etc. (default for --all)
  --timestamps         Inject timestamps into source text before summarizing (default: true)
```

#### Execution order

When rewriting multiple summaries, order matters because condensed nodes depend on their children's content:

1. **Bottom-up by depth**: d0 (leaves) first, then d1, then d2, etc.
2. Within a depth level, process in chronological order (by `earliest_at` or `created_at`)
3. After rewriting a summary, update its `content` and `token_count` in the database
4. When processing the next depth level, fetch fresh child content (which may have been rewritten in the previous pass)

This means rewriting `--all` produces a cascade: improved leaves → better d1 condensation → better d2 condensation.

#### Source text construction

**For leaf summaries (depth 0):**
```
SELECT m.role, m.content, m.created_at
FROM summary_messages sm
JOIN messages m ON m.message_id = sm.message_id
WHERE sm.summary_id = ?
ORDER BY sm.ordinal ASC
```
Format each message as `[YYYY-MM-DD HH:MM UTC] [role] content` and concatenate.

This reuses the existing `buildLeafRepairSource` pattern from repair.go, extended with timestamps.

**For condensed summaries (depth 1+):**
```
SELECT s.summary_id, s.content, s.created_at
FROM summary_parents sp
JOIN summaries s ON s.summary_id = sp.parent_summary_id
WHERE sp.summary_id = ?
ORDER BY sp.ordinal ASC
```
For each child, derive time range (recursive query to leaf messages) and prepend as header:
`[YYYY-MM-DD HH:MM – YYYY-MM-DD HH:MM UTC]\n<content>`.

#### Previous context resolution

Same logic as current compaction and existing repair.go:
- For depth 0 (leaves): find the preceding leaf summary in context_items order and use its content
- For depth 1+ (condensed): no previous_context (matches current code behavior)

#### Prompt selection

Select prompt based on the output depth:
- depth 0 → leaf prompt (existing `buildLeafSummaryPrompt` equivalent)
- depth 1 → d1 condensed prompt
- depth 2 → d2 condensed prompt
- depth 3+ → d3+ condensed prompt

#### Dry-run output

For each summary:
```
━━━ sum_f8ee4e7a5a7b7090 (d1, 36 children, 2026-02-17 15:37–21:14 UTC) ━━━

OLD (1523 tokens):
  Goals & Context
  Working on OpenClaw's LCM system...
  [truncated preview]

NEW (1401 tokens):
  Timeline:
  - 15:30 Feb 17: Started LCM depth-aware condensation work...
  [truncated preview]

  Δ tokens: -122 (1523 → 1401)
```

With `--diff`, show a unified text diff between old and new content.

#### Database writes (--apply)

```sql
UPDATE summaries
SET content = ?, token_count = ?
WHERE summary_id = ?
```

No structural changes — same summary ID, same parent/child links, same context_items references. Just the content and token count change.

#### Interactive TUI integration

The DAG view already has a pattern for node-level actions: pressing `d` on a selected node
triggers a dissolve with a dry-run preview overlay and y/n confirmation. Rewrite follows the
same UX pattern but introduces an async step (the API call takes 5-30 seconds).

##### State machine

Add a `pendingRewrite` field to the model struct, parallel to `pendingDissolve`:

```go
type rewriteState struct {
    target     summaryNode         // the selected summary
    sourceText string              // reconstructed source (with timestamps)
    prompt     string              // the prompt that will be sent
    depth      int                 // output depth (determines prompt variant)
    timeRange  string              // "2026-02-17 15:37 – 21:14 UTC"
    phase      rewritePhase        // preview → inflight → review → done
    newContent string              // result from API (populated after inflight)
    newTokens  int                 // token count of new content
    err        error               // set if API call fails
}

type rewritePhase int
const (
    rewritePreview  rewritePhase = iota  // showing source + prompt before firing
    rewriteInflight                       // API call in progress (spinner)
    rewriteReview                         // showing old vs new, awaiting y/n
)
```

##### Keybindings

- **`w`** on a selected summary node: Start rewrite flow
  1. Build source text (messages for leaves, child summaries for condensed — with timestamps)
  2. Select prompt variant based on depth
  3. Set `pendingRewrite` with phase=`rewritePreview`
  4. Render shows: source text stats, time range, prompt variant, estimated tokens
  5. Help bar: `enter: send to API | esc: cancel`

- **`enter`** during preview phase: Fire API call
  1. Transition to phase=`rewriteInflight`
  2. Launch goroutine via `tea.Cmd` that calls `anthropicClient.summarize()`
  3. Render shows spinner + "Rewriting sum_xxx with d1 prompt..."
  4. On completion, custom `tea.Msg` arrives with result
  5. Transition to phase=`rewriteReview`

- **Review phase** render: Side-by-side or sequential old/new comparison
  ```
  ━━━ Rewrite: sum_f8ee4e7a5a7b7090 (d1, 36 children) ━━━
  Time range: 2026-02-17 15:37 – 21:14 UTC

  OLD (1523 tokens):
    Goals & Context
    Working on OpenClaw's LCM system...
    [scrollable with Shift+J/K]

  NEW (1401 tokens):
    Timeline:
    - 15:30 Feb 17: Started LCM depth-aware condensation...
    [scrollable with Shift+J/K]

  Δ tokens: -122 (1523 → 1401)

  y/enter: apply | n/esc: discard | d: show diff
  ```

- **`y`/`enter`** during review: Apply the rewrite
  1. `UPDATE summaries SET content = ?, token_count = ? WHERE summary_id = ?`
  2. Refresh DAG view (reload summary graph)
  3. Clear `pendingRewrite`, update status: "Rewrote sum_xxx: 1523t → 1401t (-122)"

- **`n`/`esc`** at any phase: Cancel, clear `pendingRewrite`

- **`d`** during review: Toggle unified diff view of old vs new content

##### Async pattern (new for this TUI)

The TUI is currently fully synchronous — dissolve works because it's a local DB operation.
Rewrite introduces the first async `tea.Cmd`. The pattern:

```go
// Custom message type for rewrite completion
type rewriteResultMsg struct {
    content string
    tokens  int
    err     error
}

// In handleSummariesKey, when user presses enter during preview:
func (m *model) startRewriteAPI() tea.Cmd {
    rw := m.pendingRewrite
    return func() tea.Msg {
        client := &anthropicClient{apiKey: rw.apiKey}
        content, err := client.summarize(context.Background(), rw.prompt, rw.targetTokens)
        return rewriteResultMsg{
            content: content,
            tokens:  estimateTokenCount(content),
            err:     err,
        }
    }
}

// In Update(), handle the result message:
case rewriteResultMsg:
    if m.pendingRewrite == nil {
        return m, nil
    }
    if msg.err != nil {
        m.pendingRewrite.err = msg.err
        m.status = "Rewrite failed: " + msg.err.Error()
        m.pendingRewrite = nil
        return m, nil
    }
    m.pendingRewrite.newContent = msg.content
    m.pendingRewrite.newTokens = msg.tokens
    m.pendingRewrite.phase = rewriteReview
```

This is the standard Bubble Tea async pattern. The goroutine runs in the background, and
the TUI remains responsive (can cancel with `esc`, status bar shows "Rewriting...").

##### Subtree rewrite (`W`)

- **`W`** (shift+w): Rewrite selected node and all descendants, bottom-up
  1. Walk DAG to collect all descendant summaries
  2. Sort bottom-up: leaves first, then d1, d2, etc.; chronological within each depth
  3. Show plan: "Rewrite 38 summaries (25 leaves, 10 d1, 2 d2, 1 d3)? [y/n]"
  4. On confirm, process sequentially with progress: "Rewriting 7/38: sum_xxx (d1)..."
  5. Each completion updates the DB immediately so subsequent rewrites see fresh content
  6. On finish, refresh DAG and show summary: "Rewrote 38 summaries. Total: 45,230t → 38,100t (-7,130)"

### Prompt Template System

Prompts are Go `text/template` files, not hardcoded strings. Defaults are embedded in the
binary via `//go:embed`; filesystem overrides take precedence.

#### Template files

```
prompts/              # embedded in binary via //go:embed
  leaf.tmpl           # Leaf summary prompt (depth 0)
  condensed-d1.tmpl   # Depth 1 condensed prompt
  condensed-d2.tmpl   # Depth 2 condensed prompt
  condensed-d3.tmpl   # Depth 3+ condensed prompt
```

Filesystem override location (checked first):
```
~/.config/lcm-tui/prompts/
  leaf.tmpl
  condensed-d1.tmpl
  condensed-d2.tmpl
  condensed-d3.tmpl
```

Resolution order per template: filesystem path → embedded default. A missing filesystem
file silently falls back to embedded. Partial overrides work — override just `condensed-d1.tmpl`
and the rest use defaults.

#### Template variables

All templates receive a `PromptVars` struct:

```go
type PromptVars struct {
    TargetTokens    int    // token budget for the output
    PreviousContext string // content of preceding summary (empty if none)
    ChildCount      int    // number of source items (messages or child summaries)
    TimeRange       string // formatted range, e.g. "2026-02-17 15:37 – 21:14 UTC"
    Depth           int    // output depth (0=leaf, 1=d1, etc.)
}
```

#### Conditional blocks for optional fields

The key design problem: `PreviousContext` is only meaningful for d1 summaries, and even
then only when a preceding summary exists. Go's `text/template` handles this naturally —
`{{if .PreviousContext}}` is falsy on empty string:

```
{{if .PreviousContext -}}
The model already has this preceding summary as context — do NOT repeat information
that appears there unchanged. Focus on what is new, changed, or resolved:

<previous_context>
{{.PreviousContext}}
</previous_context>

{{else -}}
Focus on what matters for continuation:
{{end -}}
```

This pattern works for any optional field. Template authors can use `{{if}}`, `{{range}}`,
`{{with}}`, and all standard Go template directives.

#### Template loading in Go

```go
import "embed"

//go:embed prompts/*.tmpl
var defaultPrompts embed.FS

const defaultPromptDir = "~/.config/lcm-tui/prompts"

func loadPromptTemplate(name string, overrideDir string) (*template.Template, error) {
    // Check filesystem override first
    if overrideDir != "" {
        overridePath := filepath.Join(expandHome(overrideDir), name)
        if data, err := os.ReadFile(overridePath); err == nil {
            return template.New(name).Parse(string(data))
        }
    }
    // Check default filesystem location
    defaultPath := filepath.Join(expandHome(defaultPromptDir), name)
    if data, err := os.ReadFile(defaultPath); err == nil {
        return template.New(name).Parse(string(data))
    }
    // Fall back to embedded default
    data, err := defaultPrompts.ReadFile("prompts/" + name)
    if err != nil {
        return nil, fmt.Errorf("missing embedded prompt template %q: %w", name, err)
    }
    return template.New(name).Parse(string(data))
}

func promptNameForDepth(depth int) string {
    switch {
    case depth == 0:
        return "leaf.tmpl"
    case depth == 1:
        return "condensed-d1.tmpl"
    case depth == 2:
        return "condensed-d2.tmpl"
    default:
        return "condensed-d3.tmpl"
    }
}

func renderPrompt(depth int, vars PromptVars, overrideDir string) (string, error) {
    name := promptNameForDepth(depth)
    tmpl, err := loadPromptTemplate(name, overrideDir)
    if err != nil {
        return "", err
    }
    var buf bytes.Buffer
    if err := tmpl.Execute(&buf, vars); err != nil {
        return "", fmt.Errorf("execute template %q: %w", name, err)
    }
    return buf.String(), nil
}
```

#### `lcm-tui prompts` subcommand

For discoverability and iteration workflow:

```
lcm-tui prompts --list                  # show active template sources (embedded vs override)
lcm-tui prompts --export [dir]          # dump all defaults to dir (default: ~/.config/lcm-tui/prompts/)
lcm-tui prompts --show <name>           # print active template to stdout (e.g. "condensed-d1")
lcm-tui prompts --diff <name>           # diff override vs embedded default
lcm-tui prompts --render <name> [flags] # render template with sample vars for preview
```

`--export` enables the iteration workflow: export defaults → edit in your editor → `w` on a
node in the TUI to test → see the result → tweak → repeat. No recompilation needed.

`--list` output example:
```
leaf.tmpl           embedded (no override)
condensed-d1.tmpl   ~/.config/lcm-tui/prompts/condensed-d1.tmpl (override)
condensed-d2.tmpl   embedded (no override)
condensed-d3.tmpl   embedded (no override)
```

`--render` lets you preview what a prompt looks like with realistic variable values before
actually sending it to an API:
```
lcm-tui prompts --render condensed-d1 --target-tokens 2000 --previous-context "Some prior summary..."
```

#### CLI and TUI integration

The `--prompt-dir` flag is available on both the `rewrite` subcommand and threaded into the
TUI's rewrite flow:

```
lcm-tui rewrite 642 --all --apply --prompt-dir ~/my-prompts/
```

In the TUI, the prompt dir is resolved at startup from (in order):
1. `--prompt-dir` CLI flag (if lcm-tui was launched with it)
2. `~/.config/lcm-tui/prompts/` (default filesystem location)
3. Embedded defaults

The TUI rewrite preview phase (before firing the API call) shows the rendered prompt text,
so you can see exactly what will be sent — including which template source was used.

#### Relationship to open-lcm plugin (TypeScript)

The open-lcm plugin (TypeScript, runs inside OpenClaw) and lcm-tui (Go, standalone binary)
need the same prompt logic. Two approaches:

**Option A: Duplicate prompts in both codebases.** Simple, no cross-language dependency.
The prompts are ~50 lines each and change infrequently. Divergence risk is low and
acceptable during active development.

**Option B: Shared prompt files on disk.** Both open-lcm and lcm-tui read from
`~/.config/lcm-tui/prompts/` (or a shared location). Open-lcm would need its own
`text/template`-compatible parser in TypeScript — doable but adds complexity.

**Recommendation:** Option A for now. The prompts will stabilize through iteration with the
rewrite tool, then be ported to open-lcm's TypeScript. Once they're stable, Option B can be
revisited if drift becomes a problem.

---

## Implementation Plan

### Phase 1: lcm-tui prompt templates + rewrite tool

**Files:** new `prompts/*.tmpl`, new `rewrite.go`, new `prompts.go`, modify `main.go`

1. Create `prompts/` directory with 4 `.tmpl` files (embedded via `//go:embed`)
2. Implement `prompts.go`: template loading, resolution, rendering, `PromptVars` type
3. Implement `prompts` subcommand (`--list`, `--export`, `--show`, `--diff`, `--render`)
4. Implement `rewrite.go`: source text construction (timestamped), prompt rendering,
   bottom-up ordering, dry-run output with diff, `--apply` mode, API client reuse from repair.go
5. Wire `w`/`W` keybindings into TUI DAG view with async `tea.Cmd` pattern
6. Test on conversation 642: rewrite individual nodes, compare old vs new quality

Estimated: ~800-1000 lines across rewrite.go + prompts.go + templates.

### Phase 2: Timestamp injection + depth-aware prompts in open-lcm (TypeScript)

**Files:** `src/summarize.ts`, `src/compaction.ts`

1. Add `formatTimestamp()` utility
2. Modify `leafPass` to prepend timestamps to each message
3. Add time range resolution query for condensed children
4. Modify `condensedPass` to prepend time ranges to each child summary
5. Add `depth` to `LcmSummarizeOptions`
6. Thread `depth` from `condensedPass` through to `buildCondensedSummaryPrompt`
7. Port the 4 prompt templates from Go `text/template` to TypeScript string interpolation
8. Update tests

Estimated: ~100-150 lines changed across 2 files + tests.

### Phase 3: Iteration and stabilization

1. Use `lcm-tui rewrite` to A/B test prompt variants on real conversations
2. Compare token efficiency, information retention, and readability
3. Iterate on templates without recompilation
4. Once prompts stabilize, ensure TypeScript port matches
5. Consider shared prompt files (Option B) if maintaining two copies becomes painful

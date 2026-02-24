# TUI Reference

The Lossless Claw TUI (`lcm-tui`) is an interactive terminal application for inspecting, debugging, and maintaining the LCM database. It provides direct visibility into what the model sees (context assembly), how summaries are structured (DAG hierarchy), and tools for surgical repairs when things go wrong.

## Installation

**From GitHub releases:**

Download the latest binary for your platform from [Releases](https://github.com/Martian-Engineering/lossless-claw/releases).

**Build from source:**

```bash
cd tui
go build -o lcm-tui .
# or: make build
# or: go install github.com/Martian-Engineering/lossless-claw/tui@latest
```

Requires Go 1.24+.

## Quick Start

```bash
lcm-tui                              # default: ~/.openclaw/lcm.db
lcm-tui --db /path/to/lcm.db        # custom database path
```

The TUI auto-discovers agent session directories from `~/.openclaw/agents/`.

## Navigation Model

The TUI is organized as a drill-down hierarchy. You navigate deeper with Enter and back with `b`/Backspace.

```
Agents → Sessions → Conversation → [Summary DAG | Context View | Large Files]
```

### Screen 1: Agent List

Lists all agents discovered under `~/.openclaw/agents/`. Select an agent to see its sessions.

| Key | Action |
|-----|--------|
| `↑`/`↓` or `k`/`j` | Move cursor |
| `Enter` | Open agent's sessions |
| `r` | Reload agent list |
| `q` | Quit |

### Screen 2: Session List

Shows JSONL session files for the selected agent, sorted by last modified time. Each entry shows the filename, last update time, message count, conversation ID (if LCM-tracked), summary count, and large file count.

Sessions load in batches of 50. Scrolling near the bottom automatically loads more.

| Key | Action |
|-----|--------|
| `↑`/`↓` or `k`/`j` | Move cursor |
| `Enter` | Open conversation |
| `b`/`Backspace` | Back to agents |
| `r` | Reload sessions |
| `q` | Quit |

### Screen 3: Conversation View

A scrollable, color-coded view of the raw session messages. Each message shows its timestamp, role (user/assistant/system/tool), and content. Roles are color-coded:

- **Green** — user messages
- **Blue** — assistant messages
- **Yellow** — system messages
- **Gray** — tool calls and results

This is the raw session data, not the LCM-managed context. Use it to understand what actually happened in the conversation.

For sessions with an LCM `conv_id`, the conversation view uses keyset-paged windows by `message_id` (newest window first) instead of hydrating full history.

| Key | Action |
|-----|--------|
| `↑`/`↓` or `k`/`j` | Scroll one line |
| `PgUp`/`PgDn` | Scroll half page |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `[` | Load older message window |
| `]` | Load newer message window |
| `l` | Open **Summary DAG** view |
| `c` | Open **Context** view |
| `f` | Open **Large Files** view |
| `b`/`Backspace` | Back to sessions |
| `r` | Reload messages |
| `q` | Quit |

## Summary DAG View

The core inspection tool. Shows the full hierarchy of LCM summaries for a conversation as an expandable tree.

Each row shows:
```
[marker] summary_id [kind, tokens] content preview
```

- **Marker**: `>` (collapsed, has children), `v` (expanded), `-` (leaf, no children)
- **Kind**: `leaf` for depth-0 summaries, `d1`/`d2`/`d3` for condensed summaries at each depth
- **Tokens**: token count of the summary content

The bottom panel shows the detail view for the selected summary: full content text and source messages (the raw messages that were summarized to create this node).

### When to Use

- **Verify summarization quality** — read what the model will actually see
- **Check DAG structure** — ensure the depth hierarchy is balanced
- **Find corrupted nodes** — look for suspiciously short content, "[LCM fallback summary]" markers, or raw tool output that leaked into summaries
- **Understand temporal coverage** — each summary's source messages show exactly which conversation segment it covers

### Navigation

| Key | Action |
|-----|--------|
| `↑`/`↓` or `k`/`j` | Move cursor in list |
| `Enter`/`l`/`Space` | Expand/collapse node |
| `h` | Collapse current node |
| `g` | Jump to first summary |
| `G` | Jump to last summary |
| `Shift+J` | Scroll detail panel down |
| `Shift+K` | Scroll detail panel up |
| `w` | **Rewrite** selected summary |
| `W` | **Subtree rewrite** (selected + all descendants) |
| `d` | **Dissolve** selected condensed summary |
| `r` | Reload DAG |
| `b`/`Backspace` | Back to conversation |
| `q` | Quit |

## Context View

Shows exactly what the model sees: the ordered list of context items (summaries + fresh tail messages) that LCM assembles for the next turn. This is the ground truth for "what does the agent know right now?"

Each row shows:
```
ordinal  kind  [id, tokens]  content_preview
```

- **Summaries** show as `leaf`, `d1`, `d2`, etc. with their summary ID
- **Messages** show their role (user/assistant/system/tool) with message ID

The status bar shows totals: how many summaries, how many messages, total items, and total tokens.

### When to Use

- **Debug context overflow** — see total token count and identify what's consuming the budget
- **Verify assembly order** — summaries should appear before fresh tail messages, ordered chronologically
- **Check after dissolve/rewrite** — confirm your changes are reflected in what the model sees
- **Compare with raw conversation** — the conversation view shows everything; the context view shows what survives compaction

| Key | Action |
|-----|--------|
| `↑`/`↓` or `k`/`j` | Move cursor |
| `g` | Jump to first item |
| `G` | Jump to last item |
| `Shift+J` | Scroll detail panel down |
| `Shift+K` | Scroll detail panel up |
| `r` | Reload context |
| `b`/`Backspace` | Back to conversation |
| `q` | Quit |

## Large Files View

Lists files that exceeded the large file threshold (default 25k tokens) and were intercepted by LCM. Shows file ID, display name, MIME type, byte size, and creation time. The detail panel shows the exploration summary that was generated as a lightweight stand-in.

| Key | Action |
|-----|--------|
| `↑`/`↓` or `k`/`j` | Move cursor |
| `g`/`G` | Jump to first/last |
| `r` | Reload files |
| `b`/`Backspace` | Back to conversation |
| `q` | Quit |

## Operations

### Rewrite (`w`)

Re-summarizes a single summary node using the current depth-aware prompt templates. The process:

1. **Preview** — shows the prompt that will be sent, including source material, target token count, previous context, and time range
2. **API call** — sends to the configured provider API (Anthropic by default)
3. **Review** — shows old and new content side-by-side with token delta. Toggle unified diff view with `d`. Scroll with `j`/`k`.

| Key (Preview) | Action |
|-----|--------|
| `Enter` | Send to API |
| `Esc` | Cancel |

| Key (Review) | Action |
|-----|--------|
| `y`/`Enter` | Apply rewrite to database |
| `n`/`Esc` | Discard |
| `d` | Toggle unified diff view |
| `j`/`k` | Scroll content |

**When to use:** A summary has poor quality (too verbose, missing key details, or was generated before the depth-aware prompts were implemented). Rewriting regenerates it from its original source material using the current prompts.

### Subtree Rewrite (`W`)

Rewrites the selected summary and all its descendants, bottom-up. Leaves are rewritten first so that condensed parents pick up the improved content. Nodes are processed one at a time through the same preview→API→review cycle.

| Key (additional) | Action |
|-----|--------|
| `A` | **Auto-accept** — apply current and all remaining automatically |
| `n` | Skip current node, advance to next |
| `Esc` | Abort entire subtree rewrite |

The status bar shows progress as `[N/total]`. Auto-accept pauses on errors so you can inspect failures.

**When to use:** A whole branch of the DAG has outdated formatting (e.g., pre-depth-aware summaries). Subtree rewrite regenerates everything from the leaves up.

### Dissolve (`d`)

Reverses a condensation: removes a condensed summary from the active context and restores its parent summaries in its place. This is a surgical undo of a compaction step.

The confirmation screen shows:
- The target summary (kind, depth, tokens, context ordinal)
- Token impact (condensed tokens → total restored parent tokens)
- Ordinal shift (how many items after the target will be renumbered)
- Parent summaries that will be restored (with previews)

| Key | Action |
|-----|--------|
| `y`/`Enter` | Execute dissolve |
| `n`/`Esc` | Cancel |

**When to use:**
- A condensed summary is too lossy — you want the original finer-grained summaries back
- A corrupted condensed node needs to be removed so its parents can be individually repaired
- You want to re-do a condensation after improving the leaf summaries

**Important:** Dissolving increases the number of context items and total token count. Check the context view afterward to verify you haven't exceeded the context window threshold.

## CLI Subcommands

Each interactive operation also has a standalone CLI equivalent for scripting and batch operations.

### `lcm-tui repair`

Finds and fixes corrupted summaries (those containing the `[LCM fallback summary]` marker from failed summarization attempts).

```bash
# Scan a specific conversation (dry run)
lcm-tui repair 44

# Scan all conversations
lcm-tui repair --all

# Apply repairs
lcm-tui repair 44 --apply

# Repair a specific summary
lcm-tui repair 44 --summary-id sum_abc123 --apply
```

The repair process:
1. Identifies corrupted summaries by scanning for the fallback marker
2. Orders them bottom-up: leaves first (in context ordinal order), then condensed nodes by ascending depth
3. Reconstructs source material from linked messages (leaves) or child summaries (condensed)
4. Resolves `previous_context` for each node (for deduplication in the prompt)
5. Sends to Anthropic API with the appropriate depth prompt
6. Updates the database in a single transaction

| Flag | Description |
|------|-------------|
| `--apply` | Write repairs to database (default: dry run) |
| `--all` | Scan all conversations |
| `--summary-id <id>` | Target a specific summary |
| `--verbose` | Show content hashes and previews |

### `lcm-tui rewrite`

Re-summarizes summaries using current depth-aware prompts. Unlike repair, this works on any summary, not just corrupted ones.

```bash
# Rewrite a single summary (dry run)
lcm-tui rewrite 44 --summary sum_abc123

# Rewrite all depth-0 summaries
lcm-tui rewrite 44 --depth 0 --apply

# Rewrite everything bottom-up
lcm-tui rewrite 44 --all --apply --diff

# Rewrite with OpenAI Responses API
lcm-tui rewrite 44 --summary sum_abc123 --provider openai --model gpt-5.3-codex --apply

# Use custom prompt templates
lcm-tui rewrite 44 --all --apply --prompt-dir ~/.config/lcm-tui/prompts
```

| Flag | Description |
|------|-------------|
| `--summary <id>` | Rewrite a single summary |
| `--depth <n>` | Rewrite all summaries at depth N |
| `--all` | Rewrite all summaries (bottom-up by depth, then timestamp) |
| `--apply` | Write changes to database |
| `--dry-run` | Show before/after without writing (default) |
| `--diff` | Show unified diff |
| `--provider <id>` | API provider (inferred from `--model` when omitted) |
| `--model <model>` | API model (default depends on provider) |
| `--prompt-dir <path>` | Custom prompt template directory |
| `--timestamps` | Inject timestamps into source text (default: true) |
| `--tz <timezone>` | Timezone for timestamps (default: system local) |

Exactly one of `--summary`, `--depth`, or `--all` is required.

### `lcm-tui dissolve`

Reverses a condensation, restoring parent summaries to the active context.

```bash
# Preview (dry run)
lcm-tui dissolve 44 --summary-id sum_abc123

# Execute
lcm-tui dissolve 44 --summary-id sum_abc123 --apply

# Keep the condensed summary record (don't purge from DB)
lcm-tui dissolve 44 --summary-id sum_abc123 --apply --purge=false
```

| Flag | Description |
|------|-------------|
| `--summary-id <id>` | Condensed summary to dissolve (required) |
| `--apply` | Execute changes |
| `--purge` | Also delete the condensed summary record (default: true) |

### `lcm-tui transplant`

Deep-copies a summary DAG from one conversation to another. Used when an agent gets a new conversation (session rollover) but you want to carry forward summaries from the old one.

```bash
# Preview what would be copied
lcm-tui transplant 18 653

# Execute
lcm-tui transplant 18 653 --apply
```

The transplant:
1. Identifies all summary context items in the source conversation
2. Recursively collects the full DAG (all ancestor summaries)
3. Deep-copies every summary with new IDs, owned by the target conversation
4. Deep-copies all linked messages and message_parts with new IDs
5. Rewires summary_messages and summary_parents edges
6. Prepends transplanted summaries to the target's context (existing items shift)
7. Detects duplicates via content SHA256 and aborts if any match

Everything runs in a single transaction.

| Flag | Description |
|------|-------------|
| `--apply` | Execute transplant |
| `--dry-run` | Show what would be transplanted (default) |

### `lcm-tui backfill`

Imports a pre-LCM JSONL session into `conversations/messages/context_items`, runs iterative depth-aware compaction with the configured provider + prompt templates, optionally forces a single-root fold, and can transplant the result to another conversation.

```bash
# Preview import + compaction plan (no writes)
lcm-tui backfill my-agent session_abc123

# Import + compact
lcm-tui backfill my-agent session_abc123 --apply

# Re-run compaction for an already-imported session
lcm-tui backfill my-agent session_abc123 --apply --recompact

# Force a single summary root when possible
lcm-tui backfill my-agent session_abc123 --apply --recompact --single-root

# Import + compact + transplant into an active conversation
lcm-tui backfill my-agent session_abc123 --apply --transplant-to 653

# Backfill using OpenAI
lcm-tui backfill my-agent session_abc123 --apply --provider openai --model gpt-5.3-codex
```

All write paths are transactional:
1. Import transaction (conversation/messages/message_parts/context)
2. Per-pass compaction transactions (leaf/condensed replacements)
3. Optional transplant transaction (reuse of transplant command internals)

An idempotency guard prevents duplicate imports for the same `session_id`.

| Flag | Description |
|------|-------------|
| `--apply` | Execute import/compaction/transplant |
| `--dry-run` | Show what would run, without writes (default) |
| `--recompact` | Re-run compaction for already-imported sessions (message import remains idempotent) |
| `--single-root` | Force condensed folding until one summary remains when possible |
| `--transplant-to <conv_id>` | Transplant backfilled summaries into target conversation |
| `--title <text>` | Override imported conversation title |
| `--leaf-chunk-tokens <n>` | Max source tokens per leaf chunk |
| `--leaf-target-tokens <n>` | Target output tokens for leaf summaries |
| `--condensed-target-tokens <n>` | Target output tokens for condensed summaries |
| `--leaf-fanout <n>` | Min leaves required for d1 condensation |
| `--condensed-fanout <n>` | Min summaries required for d2+ condensation |
| `--hard-fanout <n>` | Min summaries for forced single-root passes |
| `--fresh-tail <n>` | Preserve freshest N raw messages from leaf compaction |
| `--provider <id>` | API provider (inferred from model when omitted) |
| `--model <id>` | API model (default depends on provider) |
| `--prompt-dir <path>` | Custom depth-prompt directory |

### `lcm-tui prompts`

Manage and inspect depth-aware prompt templates. Templates control how the LLM summarizes at each depth level.

```bash
# List active template sources (embedded vs filesystem override)
lcm-tui prompts --list

# Export default templates to filesystem for customization
lcm-tui prompts --export                              # default: ~/.config/lcm-tui/prompts/
lcm-tui prompts --export /path/to/my/prompts

# Show a specific template's content
lcm-tui prompts --show leaf

# Diff a filesystem override against the embedded default
lcm-tui prompts --diff condensed-d1

# Render a template with test variables
lcm-tui prompts --render leaf --target-tokens 800
```

| Flag | Description |
|------|-------------|
| `--list` | Show which templates are active and their source |
| `--export [dir]` | Export embedded defaults to filesystem |
| `--show <name>` | Print the active template content |
| `--diff <name>` | Unified diff between override and embedded default |
| `--render <name>` | Render template with provided variables |
| `--prompt-dir <dir>` | Custom prompt template directory |

**Template names:** `leaf`, `condensed-d1`, `condensed-d2`, `condensed-d3` (`.tmpl` suffix optional).

**Customization workflow:**
1. `lcm-tui prompts --export` to get the defaults
2. Edit the templates in `~/.config/lcm-tui/prompts/`
3. `lcm-tui prompts --diff condensed-d1` to verify changes
4. Templates are automatically picked up by rewrite/repair operations

## Depth-Aware Prompt Templates

The TUI uses four distinct prompt templates, one per depth level. This matches the plugin's depth-dispatched summarization strategy:

| Template | Depth | Strategy | Receives `previous_context` |
|----------|-------|----------|-----------------------------|
| `leaf.tmpl` | d0 | Narrative preservation with timestamps, file tracking | Yes |
| `condensed-d1.tmpl` | d1 | Chronological session narrative, delta-oriented (avoids repeating previous context) | Yes |
| `condensed-d2.tmpl` | d2 | Arc-focused: goal → outcome → what carries forward. Self-contained. | No |
| `condensed-d3.tmpl` | d3+ | Maximum abstraction. Durable context only. Self-contained. | No |

**d0/d1** summaries receive `previous_context` (the content of the preceding summary at the same depth) so they can avoid repeating information. **d2+** summaries are self-contained — they're designed to be independently useful for `lcm_expand_query` retrieval without requiring sibling context.

All templates end with an `"Expand for details about:"` footer listing topics available for deeper retrieval via the agent tools.

## Authentication

The TUI resolves API keys by provider for rewrite, repair, and backfill compaction operations.

- Anthropic: `ANTHROPIC_API_KEY`
- OpenAI: `OPENAI_API_KEY`

Resolution order:
1. Provider API key environment variable
2. OpenClaw config (`~/.openclaw/openclaw.json`) — checks matching provider auth profile mode
3. OpenClaw env file
4. `~/.zshrc` export
5. Credential file candidates under `~/.openclaw/`

If the provider auth profile mode is `oauth` (not `api_key`), set the provider API key environment variable explicitly.

Interactive rewrite (`w`/`W`) can be configured with:
- `LCM_TUI_SUMMARY_PROVIDER`
- `LCM_TUI_SUMMARY_MODEL`
- `LCM_TUI_CONVERSATION_WINDOW_SIZE` (default `200`)

It also honors `LCM_SUMMARY_PROVIDER` / `LCM_SUMMARY_MODEL` as fallback.

## Database

The TUI operates directly on the SQLite database at `~/.openclaw/lcm.db`. All write operations (rewrite, dissolve, repair, transplant, backfill) use transactions. Changes take effect on the next conversation turn — the running OpenClaw instance picks up database changes automatically.

**Backup recommendation:** Before batch operations (repair `--all`, rewrite `--all`, transplant, backfill), copy the database:

```bash
cp ~/.openclaw/lcm.db ~/.openclaw/lcm.db.bak-$(date +%Y%m%d)
```

## Troubleshooting

**"No LCM summaries found"** — The session may not have an associated conversation in the LCM database. Check that the `conv_id` column shows a non-zero value in the session list. Sessions without LCM tracking won't have summaries.

**Rewrite returns empty/bad content** — Check provider/model access and API key. If normalization still yields empty text, the TUI now returns diagnostics including `provider`, `model`, and response `block_types` to help pinpoint adapter mismatches.

**Dissolve fails with "not condensed"** — Only condensed summaries (depth > 0) can be dissolved. Leaf summaries have no parent summaries to restore.

**Transplant aborts with duplicates** — The target conversation already has summaries with identical content hashes. This prevents accidental double-transplants. If intentional, delete the duplicates from the target first.

**Token count discrepancies** — The TUI estimates tokens as `len(content) / 4`. This is a rough heuristic, not a precise tokenizer count. The plugin uses the same estimate for consistency.

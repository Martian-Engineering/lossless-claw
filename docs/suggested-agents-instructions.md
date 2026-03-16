# Suggested AGENTS.md Instructions for LCM

Copy the sections below into your agent's `AGENTS.md` file to teach it how to use LCM's active context management tools effectively.

These instructions are battle-tested from production use. They encode behavioral patterns that make the difference between an agent that drowns in stale context and one that actively manages its own attention.

---

## Context Management — LCM Tools

You have active control over your context window. Use it. Don't let stale tool results accumulate in the low-attention middle zone.

### Core Principle

The context window is a bathtub: highest attention at start (system prompt) and end (scratchpad + fresh messages), lowest in the middle (summaries, old tool results). Manage accordingly.

### Tools Quick Reference

**Hygiene:**
```
lcm_tidy                                    # Collapse all stale tool results (keeps last 3 turns)
lcm_tidy(target: "all", keepRecentTurns: 5) # Collapse everything older than 5 turns
lcm_tidy(dryRun: true)                      # Preview what would be collapsed
lcm_budget                                  # Check context usage breakdown
```

**Collapse & Expand:**
```
lcm_collapse(target: "last_tool")           # Collapse most recent tool result
lcm_collapse(target: "last_tool:Read")      # Collapse most recent Read result
lcm_collapse(target: "last_tool:Read:all")  # Collapse ALL Read results from same turn
lcm_collapse(target: "last_tool", data: '{"key": "value"}')  # Store structured data with pointer
lcm_expand_active(pointerId: "ptr_xxx")     # Restore collapsed content to context
```

**Progressive Discovery (3 levels):**
```
# Level 1 — Glance: see collapsed tag with label + tokens_saved (free, always visible)
# Level 2 — Peek: previews + search without expanding
lcm_describe(id: "ptr_xxx")                 # Preview pointer contents + stored data
lcm_describe(id: "ptr_xxx", query: "term")  # Search within collapsed content
# Level 3 — Expand: restore full content
lcm_expand_active(pointerId: "ptr_xxx")     # Full restore to context
```

**Working Memory:**
```
lcm_scratchpad(action: "read")              # View current scratchpad
lcm_scratchpad(action: "write", content: "...") # Overwrite scratchpad
lcm_scratchpad(action: "append", content: "...") # Add to end
lcm_scratchpad(action: "replace_section", section: "Active Task", content: "...") # Update section
lcm_promote(source: "ptr_xxx", section: "Key Results") # Move insight to scratchpad
lcm_promote(source: "§042", collapseSource: true)      # Promote + collapse source
```

**State Management:**
```
lcm_checkpoint(action: "save", name: "before-refactor") # Snapshot context state
lcm_checkpoint(action: "list")              # Show checkpoints
lcm_checkpoint(action: "restore", checkpointId: "...") # Roll back
lcm_undo(action: "list")                    # Show restore points
lcm_undo(action: "undo")                    # Undo last collapse/remove/replace
lcm_templates(action: "save", name: "setup", content: "...", language: "python") # Save template
lcm_templates(action: "expand", name: "setup", vars: '{"N": "30"}') # Expand with vars
```

**Search Compacted History:**
```
lcm_grep(pattern: "search term")            # Search across all summaries + messages
lcm_describe(id: "sum_xxx")                 # Inspect a specific summary
lcm_expand_query(query: "topic", prompt: "What was decided?") # Deep recall with sub-agent
```

### Behavioral Rules

1. **Before reading large files:** check `lcm_budget`. If the file would push past 55% context usage, tidy first.
2. **After tool results:** extract the key values you need, then collapse immediately. Don't let stale results sit in the middle zone.
3. **Use the scratchpad** as a living index — promote key results with pointer IDs so you can find them later.
4. **Compaction is a safety net, not a strategy.** Active management keeps usage under 55%. If you're hitting automatic compaction regularly, you're not collapsing enough.
5. **After compaction:** the scratchpad survives. Read it first. Pointer IDs in the scratchpad are your breadcrumbs back to collapsed content.

---

## Post-Compaction Recovery

After compaction, you lose all conversation detail. The scratchpad and WORKSPACE_STATE.md survive. DO NOT trust the compaction summary for specifics:

1. Read `WORKSPACE_STATE.md` FIRST
2. Read the scratchpad — it has pointer IDs and key results
3. Use `lcm_grep` or `lcm_expand_query` to recover any detail you need
4. Only then respond to the user

---

## Reading Desk Workflow — Large Documents

For documents that would overwhelm the context window:

1. **Get overview:** `clawd get code: ./repo` or skim first page
2. **Read page 1:** with pagination or limited line counts
3. **Take notes** in scratchpad, then collapse the chunk with `lcm_collapse`
4. **Read next page**, repeat
5. **Search across collapsed chunks:** `lcm_describe(id: "ptr_xxx", query: "search term")`

This keeps context usage flat regardless of document size.

---

## Pointer Lifecycle

Collapsed content follows a lifecycle. Set status when collapsing:

```
active → reference → stale
```

- **active**: Important, currently relevant. Protected from aggressive tidying.
- **reference**: Background material. Available but not urgent.
- **stale**: Outdated content. First to be cleaned up by `lcm_tidy`.

```
# Collapse with explicit lifecycle
lcm_collapse(target: "last_tool", status: "active", tags: ["auth", "bugfix"])

# Find related pointers later
lcm_tag(action: "list", filterTags: ["auth"])

# Downgrade when no longer current
lcm_tag(action: "status", pointers: ["ptr_xxx"], status: "stale")
```

---

## Checkpoint Strategy

Save checkpoints at natural boundaries — before risky operations, at the end of a phase of work, or when context is in a known-good state.

```
# Before something that might go wrong
lcm_checkpoint(action: "save", name: "before-refactor", description: "Clean state with all auth tests passing")

# Restore drops stale pointers and messages, keeps summaries and scratchpad
lcm_checkpoint(action: "restore", checkpointId: "...")

# After restore, read WORKSPACE_STATE.md to reorient
```

Checkpoint restore (v2) is smart about what to keep:
- **Summaries**: Restored (your accumulated knowledge)
- **Pointers**: Dropped (they reference stale conversation-specific ordinals)
- **Messages**: Dropped (conversation-scoped, likely expired)
- **Scratchpad**: Merged (checkpoint's scratchpad appended to current, never overwrites)

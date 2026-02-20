# Repair Corrupted Summaries

**Issue:** lcmtui-TBD
**Date:** 2026-02-18

## Problem

LCM's condensed summarizer had a bug where `completeSimple()` returned thinking blocks only (no text content) when called with `reasoning: "high"`. The fallback path then brutally truncated raw conversation text and appended `[LCM fallback summary; truncated for context management]`. This produced corrupted summary nodes in the DAG — structurally correct (right depth, right children) but with garbage content.

Example: conversation 553 has 6 corrupted summaries in active context out of 8 total summary items, including all condensed (d1/d2) nodes.

The upstream bug is fixed (openclaw-641), but existing corrupted summaries need repair.

## Design

### CLI Command

```bash
# Scan a conversation for corrupted summaries
lcm-tui repair <conversation_id>

# Scan and show what would be regenerated (default, dry-run)
lcm-tui repair <conversation_id> --dry-run

# Actually apply repairs
lcm-tui repair <conversation_id> --apply

# Repair a specific summary only
lcm-tui repair <conversation_id> --summary-id sum_abc123 --apply

# Scan ALL conversations
lcm-tui repair --all
```

This is a **CLI subcommand**, not a TUI screen. Repair is a one-shot operation that should be scriptable and produce clear output.

### Detection

A summary is corrupted if its `content` column contains the marker:
```
[LCM fallback summary; truncated for context management]
```

Scan: `SELECT summary_id, kind, depth, token_count, length(content) FROM summaries WHERE conversation_id = ? AND content LIKE '%[LCM fallback summary; truncated for context management]%'`

### Repair Strategy

Repair proceeds bottom-up through the DAG — leaves first, then condensed nodes (which depend on their children's content being correct).

**For corrupted leaf summaries:**
1. Look up linked messages via `summary_messages` join table
2. Fetch message content from `messages` + `message_parts` tables  
3. Concatenate message content as the source text
4. Call the Anthropic API to generate a real summary
5. Update `summaries.content` and `summaries.token_count`

**For corrupted condensed summaries:**
1. Look up children via `summary_parents` table (where `parent_summary_id = this node`)
2. Fetch children's `content` from `summaries` table (must be repaired first if also corrupted)
3. Concatenate children content as the source text
4. Call the Anthropic API to generate a real condensed summary
5. Update `summaries.content` and `summaries.token_count`

### Summarization

Use the Anthropic API directly (not OpenClaw's internal summarizer — this is an external tool).

**Leaf prompt:**
```
Summarize the following conversation segment. Preserve:
- Key decisions and their reasoning
- File operations (created, modified, deleted) with paths
- Technical details (commands, config values, error messages)
- Action items and next steps

Target length: ~1200 tokens. Be comprehensive but concise.

<conversation>
{source_messages}
</conversation>
```

**Condensed prompt:**
```
You are condensing multiple conversation summaries into a single higher-level summary.
Preserve the most important information across all child summaries:
- Major decisions and outcomes
- Files created/modified/deleted
- Key technical findings
- Active work items and their status

Target length: ~2000 tokens.

<summaries>
{child_summary_contents}
</summaries>
```

Model: `claude-sonnet-4-20250514` (fast, cheap, good at summarization).
API key: Read from `~/.openclaw/openclaw.json` auth profiles (same as lcm-tui already does for DB path resolution — the `anthropic:default` or `anthropic:manual` profile).

### Output Format

**Dry-run (default):**
```
Scanning conversation 553...

Found 6 corrupted summaries:
  sum_c83e88d80bc2025e  condensed  d2  2015t  8057 chars  [2 children]
  sum_65089aa5f17ac263  condensed  d1  2015t  8057 chars  [7 children]
  sum_686b344a0680ddcb  leaf       d0  9330t  37314 chars
  sum_9f3cf1fecf5bef04  leaf       d0  10639t 42552 chars
  sum_d4fdebf24c72e467  leaf       d0  3545t  14177 chars
  sum_ab7d69d47f535967  leaf       d0  208t   829 chars

Repair order (bottom-up):
  1. 4 leaves (d0)
  2. 1 condensed (d1) — depends on leaf repairs
  3. 1 condensed (d2) — depends on d1 repair

Run with --apply to execute repairs.
```

**Apply mode:**
```
Repairing conversation 553...

[1/6] sum_686b344a0680ddcb (leaf, d0)
  Sources: 47 messages (23,415 tokens)
  Old: 37314 chars / 9330 tokens (truncated garbage)
  New: 4821 chars / 1205 tokens ✓

[2/6] sum_9f3cf1fecf5bef04 (leaf, d0)
  Sources: 52 messages (26,120 tokens)
  Old: 42552 chars / 10639 tokens (truncated garbage)
  New: 4912 chars / 1228 tokens ✓

... (etc)

[5/6] sum_65089aa5f17ac263 (condensed, d1)
  Sources: 7 child summaries (8,540 tokens)
  Old: 8057 chars / 2015 tokens (truncated garbage)
  New: 7890 chars / 1973 tokens ✓

[6/6] sum_c83e88d80bc2025e (condensed, d2)
  Sources: 2 child summaries (3,988 tokens)
  Old: 8057 chars / 2015 tokens (truncated garbage)
  New: 7654 chars / 1914 tokens ✓

Done. 6 summaries repaired. Changes take effect on next conversation turn.
```

### API Key Resolution

Read `~/.openclaw/openclaw.json`, parse the `auth.profiles` section. Look for `anthropic:default` or `anthropic:manual` profile. For `mode: "api_key"`, the key is stored in the OpenClaw credentials file or environment. For simplicity, also support `ANTHROPIC_API_KEY` env var as override.

The existing `data.go` already resolves `~/.openclaw/` paths — extend `appDataPaths` to also locate the config file.

### Message Content Reconstruction

For leaf repair, reconstruct the conversation from DB:

```sql
-- Get message IDs linked to a summary
SELECT message_id FROM summary_messages 
WHERE summary_id = ? 
ORDER BY message_id ASC;

-- Get content for each message
SELECT m.role, m.content, mp.text_content, mp.part_type
FROM messages m
LEFT JOIN message_parts mp ON m.message_id = mp.message_id
WHERE m.message_id = ?
ORDER BY mp.ordinal ASC;
```

Format as:
```
[user] What should we do about the failing tests?
[assistant] Looking at the test output, there are three issues...
[user] Fix the first one.
[assistant] I'll update the assertion in test-helpers.ts...
```

### Token Estimation

Use the same rough estimator the TUI already uses: `len(content) / 4`. Good enough for display and for the token_count DB field (which is advisory, not authoritative).

### Safety

- Default is dry-run. Must explicitly pass `--apply` to write.
- Back up the original content before overwriting (print old content hash + first 100 chars in verbose mode).
- Transaction: wrap all UPDATEs for a single conversation in one SQLite transaction.
- Never delete summaries or alter DAG structure — only update `content` and `token_count`.

## Implementation Notes

- Add a new `repair.go` file for the repair logic (detection, ordering, source gathering, API calls)
- Add Anthropic API client (minimal: just `/v1/messages` POST with `claude-sonnet-4-20250514`)
- Extend `main.go` with subcommand parsing: if `os.Args[1] == "repair"`, run repair CLI instead of TUI
- Keep the TUI completely unchanged — repair is a separate code path

## Non-Goals

- TUI screen for repair (might add later, but CLI first)
- Rewriting the summarization prompts to match OpenClaw's internal ones exactly (close enough is fine)
- Repairing DAG structure (only content repair — structure is already correct)
- Handling conversations where source messages have been deleted (they haven't — LCM never deletes raw messages)

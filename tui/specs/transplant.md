# lcm-tui transplant — Context Transplant Spec

## Problem

When a session resets (context overflow, manual reset, etc.), OpenClaw starts a new conversation. The new conversation has no LCM history — it's a blank slate. All the accumulated summaries from the previous conversation are orphaned. The agent loses long-term context.

## Goal

Copy the active context summaries from a source conversation into a target conversation, so the target inherits the source's compacted knowledge. The target conversation then continues building on that foundation as if the session had never reset.

## Approach: Deep Copy of Active Context Summaries and Sources

Copy the summary-type context items from the source conversation into the target, creating new first-class summary rows owned by the target. Also deep-copy linked source messages and `message_parts`, then rewire `summary_messages` to the copied message IDs. No cross-conversation references remain.

### Why deep copy

- Transplanted summaries become first-class citizens in the target conversation
- No cross-conversation FK weirdness — integrity checker works as-is
- Future compaction naturally condenses them (they're just regular summaries)
- No special-case logic needed anywhere in the system

### What we transplant

Only **summary-type context items** from the source are prepended into target context, but the full linked summary DAG and linked message sources are copied.

For each source summary, we copy:
- The summary row itself (new `summary_id`, target `conversation_id`, same content/kind/depth/token_count/file_ids)
- Its `summary_parents` edges (remapped to new IDs)
- The linked message rows (`messages`) with fresh IDs and target conversation ownership
- The linked message parts (`message_parts`) with fresh `part_id`s and target session ownership
- Its `summary_messages` edges remapped to copied message IDs

### Schema recap

```sql
-- context_items: the ordered context window
(conversation_id, ordinal, item_type, message_id, summary_id, created_at)

-- summaries: the actual summary content  
(summary_id, conversation_id, kind, content, token_count, created_at, file_ids, depth)

-- summary_parents: DAG edges (child → parent)
(summary_id, parent_summary_id, ordinal)

-- summary_messages: leaf → message mappings
(summary_id, message_id, ordinal)
```

### Algorithm

```
transplant(source_conv, target_conv):
  1. Read source's summary-type context items (ordered by ordinal)
  2. Collect the full set of summaries to copy:
     - The context summaries themselves
     - Recursively walk summary_parents to get the full DAG beneath them
     - Deduplicate (a parent may be shared by multiple children)
  3. Topological sort: copy parents before children (leaves first, then d1, d2, ...)
  4. For each summary in topo order:
     a. Generate new summary_id (same format: sum_<16 hex chars>)
     b. INSERT into summaries with conversation_id = target
     c. Copy summary_parents rows (remapped: both summary_id and parent_summary_id use new IDs)
     d. Record old_id → new_id mapping
  5. Collect unique message IDs from summary_messages across copied summaries
  6. Copy each message into target conversation with fresh seq + message_id
  7. Copy each message's message_parts with fresh part_id values
  8. Update messages_fts for copied message content
  9. Copy summary_messages rows using remapped summary_id and remapped message_id
  10. Shift target's existing context_items ordinals up by len(source_context_summaries)
  11. Insert new context_items at ordinals 0..N-1, pointing to new summary_ids
     (only for the summaries that were in source's context — not the full DAG)
  12. Report what was transplanted
```

### Why copy the full DAG (not just context summaries)

The context items reference the "top" of the DAG (the highest-depth condensed summaries + recent leaves). But `lcm_expand_query` walks `summary_parents` to expand deeper. If we only copy the top-level summaries, expansion would hit dead ends or cross-conversation references. Copying the full DAG makes expansion work natively.

### Detailed steps

**Step 1: Read source context summaries**
```sql
SELECT ci.ordinal, ci.summary_id, s.depth, s.kind, s.token_count, s.content, s.file_ids
FROM context_items ci
JOIN summaries s ON ci.summary_id = s.summary_id
WHERE ci.conversation_id = :source AND ci.item_type = 'summary'
ORDER BY ci.ordinal;
```

**Step 2: Walk the DAG recursively**
Starting from the context summary IDs, follow `summary_parents` down:
```sql
-- Recursive CTE to find all ancestors
WITH RECURSIVE ancestors(sid) AS (
  VALUES (:context_summary_id_1), (:context_summary_id_2), ...
  UNION
  SELECT sp.parent_summary_id
  FROM summary_parents sp
  JOIN ancestors a ON sp.summary_id = a.sid
)
SELECT DISTINCT s.*
FROM ancestors a
JOIN summaries s ON s.summary_id = a.sid;
```

**Step 3: Topological sort by depth**
Sort ascending by depth (d0 first, then d1, d2). Within same depth, preserve creation order.

**Step 4: Copy summaries and source messages**
For each summary in topo order:
```sql
-- New summary
INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, created_at, file_ids, depth)
VALUES (:new_id, :target_conv, :kind, :content, :token_count, :created_at, :file_ids, :depth);

-- Copy parent edges (remapped)
INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
SELECT :new_id, :remapped_parent_id, ordinal
FROM summary_parents WHERE summary_id = :old_id;
```

Then copy unique linked messages and parts:
```sql
-- Copy linked messages with new message IDs
INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at)
VALUES (:target_conv, :next_seq, :role, :content, :token_count, :created_at);

-- Copy linked message_parts with new part_id and target session_id
INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, ...)
VALUES (:new_part_id, :new_message_id, :target_session_id, :part_type, :ordinal, ...);

-- Rewire summary_messages to copied message IDs
INSERT INTO summary_messages (summary_id, message_id, ordinal)
VALUES (:new_summary_id, :new_message_id, :ordinal);
```

**Step 5-6: Update context_items**
```sql
-- Shift existing ordinals
UPDATE context_items
SET ordinal = ordinal + :num_context_summaries
WHERE conversation_id = :target;

-- Insert transplanted context items
INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
VALUES (:target, :ordinal, 'summary', :new_summary_id);
```

All in a single transaction.

### CLI interface

```
lcm-tui transplant <source_conversation_id> <target_conversation_id> [--dry-run] [--apply]
```

Default is dry-run (show what would happen). Must pass `--apply` to execute.

**Dry-run output:**
```
Transplant: conversation 553 → conversation 642

Source context summaries (14):
  sum_c83e88d80bc2025e  condensed  d2  1790t  "Status update with completed overnight..."
  sum_65089aa5f17ac263  condensed  d1  1700t  "Josh asked about rebasing main into..."
  sum_2a983d00ad0496df  leaf       d0   640t  "..."
  ...

Full DAG to copy: 80 summaries (14 context + 66 ancestors)
  d0: 58 leaves
  d1: 18 condensed
  d2: 4 condensed

Target current context (145 items):
  5 summaries + 140 messages

After transplant:
  14 new context items prepended
  80 summaries copied (new IDs, owned by conversation 642)
  Estimated token overhead in context: ~7,496 tokens

Run with --apply to execute.
```

### What we copy

- **Summary rows** — new IDs, target conversation_id, same content
- **summary_parents edges** — remapped to new IDs
- **messages rows** — deduplicated across summaries, fresh IDs and target ownership
- **message_parts rows** — copied with fresh `part_id`s and target session ownership
- **messages_fts entries** — inserted for copied messages
- **summary_messages edges** — remapped to copied message IDs

### What we do NOT copy

- **Source context_items** — we create new ones for the target.

### Edge cases

1. **Target already has transplanted summaries** — detect by checking if any source summary content already exists in target (content hash comparison), warn and abort
2. **Source has no summary context items** — nothing to transplant, warn and exit
3. **Source summaries were corrupted/repaired** — copies the current (repaired) content
4. **Shared source messages across multiple summaries** — deduplicated so each source message is copied once and reused by remapped `summary_messages`.
5. **Future compaction in target** — works naturally. LCM sees the transplanted summaries as regular context items, condenses them into new d1/d2 summaries owned by target. The transplanted DAG becomes the foundation layer.

### Integrity

No special handling needed. Summaries, linked messages, and linked message parts are owned by the target conversation/session after transplant, so there are no cross-conversation `summary_messages` references.

### Token budget

The 14 source summaries total ~7,496 tokens. With the new 200k context window, this is ~3.7% — negligible overhead for full historical context.

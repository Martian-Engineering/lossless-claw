---
name: codex-lcm-reader
description: Use when Codex should inspect local OpenClaw/lossless-claw LCM memory through read-only tools. Search and expand evidence from the local SQLite database without mutating OpenClaw state.
---

# Codex LCM Reader

Use this plugin when a task needs prior OpenClaw conversation context stored in the local lossless-claw LCM database.

The tools are read-only and bounded. They do not run LCM maintenance, write rollups, mutate OpenClaw task state, or write Cortex memory.

## Tool Routing

- Use `lcm_grep` for keyword, phrase, topic, path, error, PR number, or identifier discovery.
- Use `lcm_describe` when you already have a `sum_...` or `file_...` ID and need cheap inspection.
- Use `lcm_expand` to expand a known summary subtree into source evidence.
- Use `lcm_expand_query` when you have either summary IDs or a short query and want an evidence bundle to answer from.

## Proof Rule

LCM output is evidence, not authority. Verify exact claims such as commands, SHAs, file paths, timestamps, root cause, and shipped status against source evidence or the relevant external authority before asserting them.

## Database Path

The MCP server reads `LCM_CODEX_DB_PATH` first, then `LCM_DATABASE_PATH`, then defaults to `${OPENCLAW_STATE_DIR:-~/.openclaw}/lcm.db`.

Prefer pointing `LCM_CODEX_DB_PATH` at a copied database for production rehearsal or destructive experiments. The server opens SQLite in read-only mode and sets `PRAGMA query_only = ON`.

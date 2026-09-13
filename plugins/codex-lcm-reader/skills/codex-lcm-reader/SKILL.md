---
name: codex-lcm-reader
description: Use when Codex should inspect local OpenClaw/lossless-claw LCM memory through read-only tools. Search and expand evidence from the local SQLite database without mutating OpenClaw state.
---

# Lossless Codex

Use this plugin when a task needs prior OpenClaw conversation context stored in the local lossless-claw LCM database and the user has asked for memory/previous-context recall or clearly consented to using local memory. The user-facing plugin name is Lossless Codex; the package folder remains `codex-lcm-reader`.

The tools are read-only and bounded. They do not run LCM maintenance, write rollups, mutate OpenClaw task state, or write Cortex memory.

Do not search all local LCM memory for unrelated repo/path/error questions by default. Prefer repo, time, keyword, or `conversationId` filters when the user gives them, and say when a broad all-conversation search was needed.

## Tool Routing

- Use `lcm_grep` for keyword, phrase, topic, path, error, PR number, or identifier discovery. Use `sort: "oldest"` when the user asks when something first appeared.
- Use `lcm_describe` when you already have a `sum_...`, `message:<id>`, numeric message ID, or `file_...` ID and need cheap inspection.
- Use `lcm_expand` to expand a known summary subtree into source evidence.
- Use `lcm_expand_query` when you have either summary IDs or a short query and want an evidence bundle to answer from.

## Proof Rule

LCM output is evidence, not authority. Verify exact claims such as commands, SHAs, file paths, timestamps, root cause, and shipped status against source evidence or the relevant external authority before asserting them.

## Database Path

The MCP server reads `LCM_CODEX_DB_PATH` first, then `LCM_DATABASE_PATH`, then `LOSSLESS_CLAW_DB_PATH`, then `OPENCLAW_LCM_DB_PATH`, and finally defaults to `${OPENCLAW_STATE_DIR:-~/.openclaw}/lcm.db`.

Prefer pointing `LCM_CODEX_DB_PATH` at a copied database for production rehearsal or destructive experiments. The server opens SQLite in read-only mode and sets `PRAGMA query_only = ON`.

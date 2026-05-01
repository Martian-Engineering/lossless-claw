# Codex LCM Reader

Codex LCM Reader is a repo-local Codex Desktop plugin for read-only access to a local OpenClaw lossless-claw LCM SQLite database.

This first slice intentionally exposes only the tools that exist on current lossless-claw `main`:

- `lcm_grep`
- `lcm_describe`
- `lcm_expand`
- `lcm_expand_query`

The plugin does not mutate OpenClaw state, run LCM maintenance, build rollups, write Cortex memory, or write OpenClaw tasks. It opens SQLite in read-only mode and enables `PRAGMA query_only = ON`.

## Database Path

The MCP server resolves the database path in this order:

1. `LCM_CODEX_DB_PATH`
2. `LCM_DATABASE_PATH`
3. `LOSSLESS_CLAW_DB_PATH`
4. `OPENCLAW_LCM_DB_PATH`
5. `${OPENCLAW_STATE_DIR:-~/.openclaw}/lcm.db`

Use `LCM_CODEX_DB_PATH` when pointing Codex Desktop at a production database copy for migration or compatibility rehearsal.

## Tool Semantics

`lcm_grep` searches messages and summaries with bounded result limits. Regex mode scans a bounded slice; full-text mode uses LCM FTS tables when available and falls back to escaped `LIKE` predicates. Use `sort: "oldest"` for first-occurrence style discovery.

`lcm_describe` returns cheap metadata and lineage for a known summary, `message:<id>`, numeric message ID, or file ID.

`lcm_expand` expands known summary IDs through the persisted summary DAG and returns bounded evidence text.

`lcm_expand_query` finds seed summaries by query, expands them, and returns an evidence bundle for Codex to synthesize from. Unlike OpenClaw's in-runtime `lcm_expand_query`, this local Codex adapter does not spawn an OpenClaw sub-agent.

## Proof Rule

LCM output is evidence, not authority. Verify exact commands, SHAs, file paths, timestamps, root cause, and shipped status against source evidence or the relevant external authority before asserting them.

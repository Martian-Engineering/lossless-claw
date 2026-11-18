# Lossless Codex

Lossless Codex is a Codex Desktop plugin for read-only access to a local OpenClaw lossless-claw LCM SQLite database. The package folder is `codex-lcm-reader` so existing plugin installs and branch names remain stable.

This first slice intentionally exposes only the tools that exist on current lossless-claw `main`:

- `lcm_grep`
- `lcm_describe`
- `lcm_expand`
- `lcm_expand_query`

The plugin does not mutate OpenClaw state, run LCM maintenance, build rollups, write Cortex memory, or write OpenClaw tasks. It opens SQLite in read-only mode and enables `PRAGMA query_only = ON`.

## Install Into Codex Desktop

Prerequisites:

- Codex Desktop must be able to launch `node`.
- `node` must support `node:sqlite`; check with:

```bash
node -e "import('node:sqlite').then(() => console.log('node:sqlite ok'))"
```

If Codex Desktop is launched from the macOS GUI and cannot see your shell `PATH`, either launch Codex from a shell that can run `node`, or adjust your local Codex/plugin environment so the `node` command resolves to Node 22+.

For local development from a `lossless-claw` checkout:

1. Keep this plugin directory at `plugins/codex-lcm-reader`.
2. Ensure `.agents/plugins/marketplace.json` includes the `codex-lcm-reader` local plugin entry.
3. Restart Codex Desktop or refresh its plugin registry.
4. Point the plugin at an LCM database with `LCM_CODEX_DB_PATH=/absolute/path/to/lcm.db` when the default `~/.openclaw/lcm.db` is not the database you want.

For a home-local install:

1. Copy `plugins/codex-lcm-reader` to `~/plugins/codex-lcm-reader`:

```bash
mkdir -p ~/plugins ~/.agents/plugins
cp -R plugins/codex-lcm-reader ~/plugins/codex-lcm-reader
```

2. Add a complete marketplace file at `~/.agents/plugins/marketplace.json`, or merge the `codex-lcm-reader` entry into your existing file:

```json
{
  "name": "lossless-codex-local",
  "interface": {
    "displayName": "Lossless Codex Local"
  },
  "plugins": [
    {
      "name": "codex-lcm-reader",
      "source": {
        "source": "local",
        "path": "./plugins/codex-lcm-reader"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Engineering"
    }
  ]
}
```

3. Restart Codex Desktop.

Codex should then expose the plugin as **Lossless Codex** with read-only LCM tools.

When using a non-default database path from Codex Desktop, make sure the Codex process receives `LCM_CODEX_DB_PATH=/absolute/path/to/lcm.db` or another supported DB-path variable. The plugin falls back to `~/.openclaw/lcm.db` only when no explicit path is provided.

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

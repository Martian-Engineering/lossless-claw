# Lossless Claw CLI

The `lcm` executable provides bounded, structured access to Lossless Claw's persisted conversations, messages, summaries, context state, token counts, maintenance state, and effective configuration. JSON is the default output so agents can consume results without parsing terminal decoration.

The CLI opens `lcm.db` with SQLite's read-only mode and enables `PRAGMA query_only = ON`. Database commands do not run migrations, compaction, cleanup, repair, checkpoint, vacuum, or other write operations. `lcm config set` is the only command that writes state.

## Commands

```text
lcm status
lcm conversations list
lcm conversations show (--conversation-id <id> | --session-key <key>)
lcm messages list (--conversation-id <id> | --session-key <key>)
lcm messages tail (--conversation-id <id> | --session-key <key>)
lcm summaries list [--conversation-id <id> | --session-key <key>]
lcm summaries show <summary-id>
lcm config show
lcm config get <path>
lcm config set <path> <json-value>
lcm doctor
```

Run `lcm --help` for the command and option inventory. Add `--pretty` for indented JSON or `--format table` for compact terminal output.

## Paths

The OpenClaw state directory uses this precedence:

1. `--openclaw-dir`
2. `LCM_OPENCLAW_DIR`
3. `OPENCLAW_STATE_DIR`
4. `${OPENCLAW_HOME}/.openclaw`
5. `${HOME}/.openclaw`

The OpenClaw config file uses this precedence:

1. `--config`
2. `OPENCLAW_CONFIG_PATH`
3. `<state-directory>/openclaw.json`

The LCM database uses this precedence:

1. `--db`
2. `LCM_DATABASE_PATH`
3. `plugins.entries.lossless-claw.config.databasePath`
4. `plugins.entries.lossless-claw.config.dbPath`
5. `<state-directory>/lcm.db`

All response metadata uses absolute paths.

## Status and conversations

`lcm status` returns database size, conversation/message/summary counts, token totals, coverage timestamps, context totals, summary depth distribution, maintenance state, and the effective fresh-tail limits.

```bash
lcm status --pretty
lcm status --db /srv/openclaw/lcm.db
```

Conversation listing is keyset-paginated and ordered by update time plus conversation ID:

```bash
lcm conversations list --limit 50
lcm conversations list --limit 50 --cursor '<nextCursor>'
```

Conversation detail accepts a numeric conversation ID or stable session key:

```bash
lcm conversations show --conversation-id 42
lcm conversations show --session-key 'agent:main:telegram:direct:1234'
```

The detail response includes aggregate messages, summaries, active context, protected fresh tail, compaction telemetry, deferred maintenance, bootstrap frontier, focus briefs, and large-file storage.

## Messages and fresh tail

Message lists support role filters, time filters, pagination, and full-content opt-in:

```bash
lcm messages list --conversation-id 42 --limit 100
lcm messages list --session-key 'agent:main:example' --role user --role assistant
lcm messages list --conversation-id 42 --after 2026-07-01T00:00:00Z
lcm messages list --conversation-id 42 --recency 6h --include-content
```

Without `--include-content`, each row contains a bounded single-line preview. With it, each row also contains the complete stored `content` value.

`lcm messages tail` reads raw messages from the active `context_items` frontier. It applies `freshTailCount` and `freshTailMaxTokens` with the same rules as runtime assembly: the newest message remains protected even when it exceeds the token cap.

```bash
lcm messages tail --conversation-id 42
lcm messages tail --conversation-id 42 --count 20
```

The response reports selected messages/tokens, total persisted messages/tokens, the selected sequence interval, and messages in ascending prompt order.

## Summaries

Summary lists can be global or conversation-scoped:

```bash
lcm summaries list --limit 50
lcm summaries list --conversation-id 42 --depth 0 --kind leaf
lcm summaries list --session-key 'agent:main:example' --recency 7d
lcm summaries list --between 2026-07-01T00:00:00Z..2026-07-08T00:00:00Z
```

Summary time filters use `latestAt` when present and `createdAt` as the fallback coverage timestamp.

```bash
lcm summaries show sum_abc123
```

Summary detail includes full content, higher-depth `parents` that consume the selected summary, lower-depth source `children`, and ordered raw source messages. Related rows are constrained to the selected summary's conversation.

## Time filters

- `--after <timestamp>` includes records at the timestamp.
- `--before <timestamp>` excludes records at the timestamp.
- `--between <start>..<end>` applies an inclusive start and exclusive end.
- `--recency <duration>` accepts a positive integer followed by `s`, `m`, `h`, `d`, or `w`.

`--between` cannot be combined with another time option. `--recency` cannot be combined with `--after`.

## Pagination

List commands accept `--limit` from 1 through 500 and an opaque `--cursor`. Every list response includes:

```json
{
  "pagination": {
    "limit": 50,
    "returned": 50,
    "hasMore": true,
    "nextCursor": "opaque-value"
  }
}
```

Pass `nextCursor` to the same resource command. A message cursor cannot be used for conversations or summaries.

## Configuration

`lcm config show` returns only the raw Lossless plugin config, effective `LcmConfig`, config diagnostics, and names of active environment overrides. It does not return unrelated OpenClaw config sections or credentials.

```bash
lcm config show --pretty
lcm config get freshTailCount
lcm config get autoRotateSessionFiles.enabled
```

`lcm config set` accepts a dot path relative to `plugins.entries.lossless-claw.config` and a JSON value:

```bash
lcm config set freshTailCount 96
lcm config set promptAwareEviction true
lcm config set summaryModel '"openai/gpt-5.4-mini"'
lcm config set ignoreSessionPatterns '["agent:*:cron:**"]'
lcm config set autoRotateSessionFiles.enabled false
```

The command checks the path and value against `openclaw.plugin.json`, validates the complete Lossless config, creates an exclusive timestamped sibling backup, preserves the source mode, fsyncs a sibling temporary file, and atomically replaces `openclaw.json`.

Config writes refuse:

- symlink config paths
- JSON5 syntax or comments
- malformed JSON
- `$include` at the root, plugin containers, Lossless entry, or Lossless config
- paths absent from the Lossless manifest schema
- values that violate the target or complete config schema

These failures happen before backup creation and leave the config unchanged.

## Output and exit codes

Successful JSON responses contain `ok`, `command`, `data`, optional `pagination`, and `meta`. Expected failures write one JSON object to stderr.

| Exit | Meaning |
|---:|---|
| `0` | Success |
| `1` | Unexpected internal failure |
| `2` | Invalid command, option, selector, filter, or cursor |
| `3` | Requested database, config, conversation, summary, or key not found |
| `4` | Config parse, validation, backup, or write failure |
| `5` | Database open or query failure |

## Doctor namespace

`lcm doctor` reserves the shell namespace for a separate read-only diagnostics contract. It reports `available: false` and does not open or modify the database. Native `/lcm doctor` behavior remains independent of the shell CLI.

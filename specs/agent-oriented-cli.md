# Agent-Oriented CLI Specification

## Objective

Package a TypeScript executable named `lcm` with Lossless Claw. The executable gives agents a stable, structured interface for inspecting LCM conversations, messages, summaries, context state, token totals, compaction state, and effective configuration. It reads the LCM SQLite database without modifying it. Its only write command sets one validated Lossless plugin configuration value in OpenClaw's config file.

The CLI succeeds when an agent can locate a conversation by numeric ID or session key, page through its records without loading unbounded results, inspect the configured fresh tail and summary DAG, apply exact time filters, and change one supported config key without exposing or rewriting unrelated secrets.

## Public Interface

### Commands

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

`lcm doctor` reserves a read-only namespace for later diagnostic checks. It returns a structured unsupported-operation result until doctor subcommands have their own approved specification.

### Global options

```text
--db <path>                 Explicit LCM database
--config <path>             Explicit OpenClaw config file
--openclaw-dir <path>       Explicit OpenClaw state directory
--format <json|table>       Output format; defaults to json
--pretty                    Indent JSON output
--help                      Command help
--version                   Package version
```

### Selection and filtering

- Commands that require one conversation accept exactly one of `--conversation-id` and `--session-key`.
- Session-key resolution prefers an active row and then the newest row.
- `--after <timestamp>` is inclusive.
- `--before <timestamp>` is exclusive.
- `--between <start>..<end>` applies the same inclusive-start, exclusive-end interval.
- `--recency <duration>` computes an inclusive lower bound once at process start. Durations use an integer followed by `s`, `m`, `h`, `d`, or `w`.
- `--between` conflicts with `--after`, `--before`, and `--recency`.
- `--recency` conflicts with `--after`.
- Summary lists accept `--depth <integer>` and `--kind <leaf|condensed>`.
- Message lists accept repeatable `--role <system|user|assistant|tool>` and `--include-content`.

### Pagination

Every list command returns at most `--limit` records. The default is 50 and the maximum is 500. Results use deterministic descending order by timestamp plus a stable identifier. `--cursor` is an opaque URL-safe base64 cursor returned by the previous page.

Every list response includes:

```json
{
  "pagination": {
    "limit": 50,
    "returned": 50,
    "hasMore": true,
    "nextCursor": "opaque-or-null"
  }
}
```

The cursor encodes a version, resource type, timestamp, and stable identifier. A cursor for one resource cannot be used with another resource.

### Output contract

JSON is the default. Successful commands write one JSON document to stdout:

```json
{
  "ok": true,
  "command": "messages.list",
  "data": [],
  "pagination": null,
  "meta": {
    "databasePath": "/home/agent/.openclaw/lcm.db",
    "configPath": "/home/agent/.openclaw/openclaw.json"
  }
}
```

Failures write one JSON document to stderr:

```json
{
  "ok": false,
  "error": {
    "code": "CONVERSATION_NOT_FOUND",
    "message": "No conversation matched session key agent:main:example.",
    "details": {}
  }
}
```

Exit codes are stable:

- `0`: success
- `2`: invalid command, option, selector, filter, or cursor
- `3`: requested conversation, summary, config key, or file not found
- `4`: config parse, validation, or safe-write failure
- `5`: database open or query failure
- `1`: unexpected internal failure

Table output is a compact projection of the same data. It does not change query semantics or omit pagination metadata.

## Path Resolution

The state directory uses this precedence:

1. `--openclaw-dir`
2. `LCM_OPENCLAW_DIR`
3. `OPENCLAW_STATE_DIR`
4. `${OPENCLAW_HOME}/.openclaw`
5. `${HOME}/.openclaw`

The config file uses this precedence:

1. `--config`
2. `OPENCLAW_CONFIG_PATH`
3. `<state-directory>/openclaw.json`

The database uses this precedence:

1. `--db`
2. `LCM_DATABASE_PATH`
3. `plugins.entries.lossless-claw.config.dbPath`
4. `plugins.entries.lossless-claw.config.databasePath`
5. `<state-directory>/lcm.db`

`databasePath` is preferred for new configuration. If both plugin keys exist, the legacy `dbPath` value wins to match the current runtime resolver.

All returned paths are absolute. `~` expands against `OPENCLAW_HOME` when set and the process home otherwise.

## Command Data

### `status`

Returns package version, database size, conversation count, active conversation count, message count and tokens, summary count and tokens by kind/depth, summarized source tokens, context tokens, fresh-tail configuration, maintenance state counts, earliest/latest activity, and the raw/effective Lossless config boundary.

### `conversations list`

Each row includes conversation ID, session ID, session key, active/archive state, title, created/updated/bootstrap timestamps, message count/tokens, summary count/tokens, context count/tokens, fresh-tail message count/tokens, maximum summary depth, latest message timestamp, and latest summary timestamp.

### `conversations show`

Returns one conversation row plus:

- aggregate message, summary, context, and fresh-tail statistics
- summary counts and tokens grouped by kind/depth
- ordered context-item type/token totals
- compaction telemetry and maintenance records
- bootstrap frontier record
- focus-brief counts and active brief metadata
- large-file counts, bytes, and latest timestamp
- earliest and latest persisted message and summary timestamps

### `messages list`

Each row includes message ID, conversation ID, sequence, role, token count, created timestamp, large-content reference, and a bounded preview. `--include-content` adds full stored content. Results do not expose message parts unless a later specification adds that surface.

### `messages tail`

Returns messages in ascending sequence order so the result matches runtime prompt order. The default tail uses the effective `freshTailCount` and `freshTailMaxTokens`. `--count` overrides the count for inspection. The response includes configured limits, selected message count, selected tokens, total conversation messages/tokens, and the sequence interval.

The token cap walks newest to oldest, always retains the newest message, and stops before adding an older message that would exceed the cap. This matches the runtime's protected-tail semantics.

### `summaries list`

Each row includes summary ID, conversation ID, kind, depth, token counts, descendant counts/tokens, source-message tokens, model, earliest/latest covered timestamps, created timestamp, file IDs, direct parent count, direct child count, source-message count, and a bounded preview. `--include-content` adds full stored content.

### `summaries show`

Returns the complete summary row plus ordered direct parents, ordered direct children, and ordered source messages. Source messages include ID, sequence, role, token count, timestamp, and content. Every related record must belong to the selected summary's conversation.

### `config show|get|set`

`config show` returns only:

- resolved state, config, and database paths
- raw `plugins.entries.lossless-claw.config`
- effective `LcmConfig` after environment overrides and defaults
- the names of environment variables that override file-backed values

It never returns other OpenClaw config sections.

`config get <path>` reads a dot-separated path relative to the Lossless plugin config. It reports raw and effective values separately.

`config set <path> <json-value>`:

1. Requires the path to exist in `openclaw.plugin.json` `configSchema`.
2. Parses the value as JSON.
3. Applies it to a cloned plugin config.
4. Validates the full cloned plugin config against the manifest schema.
5. Creates a timestamped sibling backup.
6. Writes and fsyncs a sibling temporary file.
7. Atomically renames the temporary file over the config file while preserving its mode.
8. Returns the old value, new value, config path, and backup path.

The writer refuses symlinks, non-JSON syntax, malformed files, and `$include` at the root, `plugins`, `plugins.entries`, the Lossless entry, or its `config` object. Refusal leaves the source and backup set unchanged.

## Tech Stack

- TypeScript 5.7 with strict checking
- Node.js 22 ESM
- `node:sqlite` for read-only queries
- `node:util.parseArgs` for argument parsing
- TypeBox, already a direct dependency, for manifest-schema validation
- esbuild for the executable bundle
- Vitest for unit and integration tests

No new runtime dependency is required.

## Commands

```bash
npm run build
npm run typecheck
npm test
npm run test -- --run test/cli-args.test.ts
npm run test -- --run test/cli-database.test.ts
npm run test -- --run test/cli-queries.test.ts
npm run test -- --run test/cli-config.test.ts
npm pack --dry-run
```

## Project Structure

```text
cli.ts                       Executable entrypoint
src/cli/args.ts              Parsed command contract and validation
src/cli/config-file.ts       Lossless-only config reads and writes
src/cli/database.ts          Read-only SQLite connection
src/cli/main.ts              Command dispatch
src/cli/output.ts            JSON envelope and table projections
src/cli/paths.ts             State/config/database resolution
src/cli/queries.ts           Typed diagnostic queries
test/cli-args.test.ts        Parser, cursor, selector, and time tests
test/cli-config.test.ts      Config resolution and safe-write tests
test/cli-database.test.ts    Read-only connection tests
test/cli-queries.test.ts     Fixture-backed query tests
docs/cli.md                  User and agent reference
```

Each source file has one purpose. Public functions and types include purpose-oriented doc comments. Functions that exceed ten lines include comments for non-obvious internal stages.

## Code Style

Use explicit input and output types at module boundaries. Validate external strings before converting them to domain values. Keep database rows private to the query module and map them to camel-case response types.

```typescript
/** Resolve one persisted conversation from an explicit CLI selector. */
export function resolveConversation(
  db: DatabaseSync,
  selector: ConversationSelector,
): ConversationIdentity {
  const row = selector.kind === "conversationId"
    ? selectConversationById(db, selector.value)
    : selectConversationBySessionKey(db, selector.value);

  if (!row) {
    throw new CliError("CONVERSATION_NOT_FOUND", selector, 3);
  }
  return mapConversationIdentity(row);
}
```

SQL uses bound parameters for every external value. Dynamic SQL is limited to internal, enumerated fragments such as sort direction and role placeholder counts.

## Testing Strategy

- Write failing tests before behavior code.
- Unit-test argument parsing, timestamps, durations, selectors, cursors, config paths, and output envelopes.
- Use temporary real SQLite databases for query integration tests.
- Run production migrations only when creating test fixtures. Open the fixture through the CLI's dedicated read-only connection for assertions.
- Prove the read-only boundary by asserting that inserts and schema changes fail through the CLI handle.
- Exercise pagination across identical timestamps to prove the stable identifier tie-breaker.
- Exercise config writes against temporary files and assert byte-for-byte preservation on every failure path.
- Add an end-to-end test that invokes the built `dist/cli.js` against a fixture database.
- Run the full TypeScript test suite and typecheck before closing the epic.

## Boundaries

### Always

- Open LCM databases read-only and enable `PRAGMA query_only = ON`.
- Bind external values in SQL.
- Paginate list commands and return pagination metadata.
- Return deterministic field names, ordering, errors, and exit codes.
- Back up the config before a successful replacement.
- Keep `docs/configuration.md`, the bundled skill config reference, `openclaw.plugin.json`, and runtime defaults synchronized if a config option changes.
- Add a minor Changeset for the new executable.

### Ask first

- Add a runtime dependency.
- Change the LCM schema or run migrations from the CLI.
- Support config includes or comment-preserving JSON5 writes.
- Add any database mutation command, including doctor repairs.
- Change an existing dependency version.

### Never

- Create a missing database as a side effect of inspection.
- Run migrations, vacuum, optimize, checkpoint, cleanup, repair, delete, compact, rotate, rewrite, transplant, or backfill from this CLI.
- Print unrelated OpenClaw config sections or secrets.
- Accept unbounded list output.
- Flatten `$include` config structures.
- merge the feature branch without explicit maintainer approval.

## Implementation Plan

### Task 1: CLI contract and read-only foundations (`lc-3dd.1`)

Implement path resolution, parsing, shared filters, cursor encoding, response envelopes, and the read-only SQLite handle.

Acceptance:

- Invalid inputs produce stable structured errors.
- Path precedence matches this specification.
- A missing database is not created and an open handle cannot write.

Verify with focused parser/path/database tests and `npm run typecheck`.

### Task 2: Status and conversation diagnostics (`lc-3dd.2`)

Implement global status, conversation list, and conversation show.

Acceptance:

- Aggregate and per-conversation fixture results match exact expected values.
- Conversation pagination has no gaps or duplicates.
- Session-key selection uses active/newest precedence.

Verify with fixture-backed query tests.

### Task 3: Messages and fresh tail (`lc-3dd.3`)

Implement message listing, shared time filters, and tail selection/statistics.

Acceptance:

- Time boundaries and role filters are exact.
- Pagination metadata is present on every list response.
- Tail ordering and count/token caps match runtime semantics.

Verify with fixture-backed query and command tests.

### Task 4: Summary inspection (`lc-3dd.4`)

Implement global/scoped summary listing and summary detail.

Acceptance:

- Depth zero filtering works.
- Summary pagination has no gaps or duplicates.
- Parent, child, and source records cannot cross the conversation boundary.

Verify with fixture-backed DAG tests.

### Task 5: Config inspection and editing (`lc-3dd.5`)

Implement config show/get/set with manifest validation, secret isolation, backups, and atomic replacement.

Acceptance:

- Invalid edits leave source bytes unchanged and create no backup.
- Valid edits change only the targeted Lossless config key.
- Output never contains unrelated OpenClaw values.

Verify with temporary-file integration tests.

### Task 6: Packaging and documentation (`lc-3dd.6`)

Add the executable bundle, package metadata, help/reference docs, bundled skill updates, Changeset, and end-to-end verification.

Acceptance:

- `npm run build` emits `dist/cli.js` with an executable shebang.
- `npm pack --dry-run` includes the CLI artifact and docs.
- The full test suite and typecheck pass.
- Autoreview findings are resolved before PR preparation.

## Success Criteria

- Agents can discover every command and option from `lcm --help` and command-local help.
- All list commands are bounded and keyset-paginated.
- Conversation ID and session key work consistently across scoped commands.
- ISO time, interval, and recency filters work for messages and summaries.
- Status and detail commands report persisted token, tail, context, config, and maintenance facts.
- The CLI cannot modify `lcm.db`, including through accidental helper reuse.
- Config reads expose only Lossless values; config set is targeted, validated, backed up, and atomic.
- The npm package installs an `lcm` executable implemented in TypeScript.
- Tests, typecheck, build, package inspection, runtime smoke tests, documentation, and Changeset are complete.

## Open Questions

- Approve JSON as the default output format.
- Approve fail-closed config writes for JSON5 and `$include` forms in the first release.
- Confirm `lcm` as the executable name.

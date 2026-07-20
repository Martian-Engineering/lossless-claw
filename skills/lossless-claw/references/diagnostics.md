# Diagnostics

For the MVP, use the native command surface first. For debugging lossless-claw behavior or failures, inspect the independent Lossless log before the shared OpenClaw gateway log.

## Fast path

### `lcm` shell CLI

Use the packaged shell CLI for bounded, structured database inspection outside an OpenClaw conversation:

```bash
lcm status --pretty
lcm conversations show --session-key 'agent:main:example'
lcm messages tail --conversation-id 42
lcm summaries list --conversation-id 42 --depth 0 --recency 7d
```

JSON is the default output. List commands return opaque keyset cursors. Database commands open `lcm.db` read-only and do not run migrations, repair, cleanup, compaction, or other write operations. `lcm config set` is the only state-changing shell command and edits one manifest-validated Lossless config path with a timestamped backup.

Path overrides use `--db`, `LCM_DATABASE_PATH`, `--openclaw-dir`, `LCM_OPENCLAW_DIR`, `OPENCLAW_STATE_DIR`, `OPENCLAW_HOME`, `--config`, and `OPENCLAW_CONFIG_PATH`. See `docs/cli.md` in the package for precedence and the complete command contract.

### Independent Lossless log

Check this first when lossless-claw needs to debug itself, because routine `[lcm]` info and debug lines are written here instead of the shared OpenClaw gateway log.

Default path:

```bash
/tmp/openclaw/lossless-claw-YYYY-MM-DD.log
```

For today's local log, use:

```bash
tail -n 200 "/tmp/openclaw/lossless-claw-$(date +%F).log"
```

Useful patterns:

```bash
rg -n "\\[lcm\\] (auto-rotate|rotate|runtime\\.llm\\.complete|summary|compact|assembly)" /tmp/openclaw/lossless-claw-*.log
rg -n "warn|error|failed|truncated|deterministic|fallback" /tmp/openclaw/lossless-claw-*.log
```

The dated default log rolls over daily. Dated files are pruned after 3 days, and oversized active logs rotate through `.1.log` to `.5.log`. Startup banners and warning/error lines are also sent to OpenClaw's runtime logger, so check `/tmp/openclaw/openclaw-YYYY-MM-DD.log` after the Lossless log when you need gateway-level startup or failure context.

### `/lossless` (`/lcm` alias)

Use this when you need a quick health snapshot.

It should answer:

- Is `lossless-claw` enabled?
- Is it selected as the context engine?
- Which DB is active?
- Is the DB growing as expected?
- Are summaries present?
- Are broken or truncated summaries present?

### `/lossless doctor`

Use this when summary corruption or truncation is suspected.

It is the single user-facing diagnostic entrypoint for summary-health issues in the MVP.

What it should help confirm:

- whether broken summaries exist
- whether truncation markers exist
- which conversations are affected most

### `/lossless doctor apply`

Use this only after `/lossless doctor` identifies broken summaries. The command rewrites affected summary content in place after creating a database backup.

- `/lossless doctor apply` repairs the current conversation and keeps the normal large/hot safety preflight.
- `/lossless doctor apply confirm-offline` overrides that preflight for the current conversation after its active channel path has been isolated.
- `/lossless doctor apply <conversation-id> confirm-offline` targets a specific conversation, including an archived or non-current conversation. Targeted repair always requires the explicit offline confirmation.

Conversation ids are gateway-wide maintenance identifiers rather than sender ownership credentials. Only authorized OpenClaw command senders can invoke the command; before targeting an id, pause or move active delivery away from that conversation and verify the displayed session key is the intended lane.

### `/lossless doctor clean`

Use this when the user wants read-only diagnostics for high-confidence junk patterns before any cleanup.

It should help confirm:

- whether archived subagent sessions are present
- whether cron sessions are accumulating unexpectedly
- whether NULL-key orphaned subagent conversations are present
- which high-confidence filters match the most conversations and messages

This command is read-only. Use it to identify likely cleanup candidates before taking any separate cleanup action.

## Interpreting common states

### `/lossless` tokens vs `/status` context

These numbers are related, but they are not the same metric.

- `/lossless` reports LCM-side conversation metrics such as the current frontier token count and compression ratio.
- `/status` reports the last assembled runtime prompt snapshot for the active model.

Why they can differ:

- runtime assembly can trim or omit frontier material before the request is sent
- model-specific token budgeting and packing happen after LCM frontier selection
- `/status` reflects a last-run snapshot, while `/lossless` reads live LCM state from the DB

Treat `/lossless` as the LCM health/shape view, and `/status` as the runtime request view.

### No summaries yet

Usually means one of:

- the conversation has not crossed compaction thresholds yet
- the plugin is not selected as the context engine
- writes are being skipped because the session matches stateless or ignored patterns

### DB exists but stays tiny

Usually means one of:

- the plugin is not receiving traffic
- the wrong DB path is configured
- the plugin is enabled but not selected

### Broken or truncated summaries detected

Treat this as a signal to inspect summary health before trusting compacted context heavily.

For MVP guidance:

- keep the user on `/lossless doctor`
- explain the count and affected conversations
- avoid advertising separate repair-vs-doctor command families

## Safe operator advice

- Do not guess exact historical details from compacted context alone.
- When a user wants a fact pattern verified, use recall tools to recover evidence.
- Prefer changing one configuration knob at a time and then re-checking `/lossless`.

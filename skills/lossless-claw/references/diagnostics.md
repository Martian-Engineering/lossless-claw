# Diagnostics

For the MVP, use the native command surface first.

## Fast path

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

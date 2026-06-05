# Session lifecycle (`/new`, `/reset`, and `/lossless rotate`)

This reference describes the current behavior on `main`.

## Short version

For stock `lossless-claw` on current main:

- OpenClaw handles `/new` and `/reset` as session-reset operations.
- `lossless-claw` handles `/lossless rotate` (`/lcm rotate`) as transcript maintenance on the current conversation.
- `lossless-claw` prefers **`sessionKey`** as the stable identity for an LCM conversation.
- `/reset` archives the active conversation and creates a fresh active row for the same stable `sessionKey`.
- Cron scheduler keys (`agent:<agent>:cron:<job>...`) are isolated per runtime run when a new `sessionId` reuses the same `sessionKey`.
- For ordinary non-cron session keys, continuity still follows the stable `sessionKey`.

## What that means in practice

If a user asks whether `/new` or `/reset` gives them a fresh LCM conversation, distinguish the commands.

They get a fresh OpenClaw session runtime, but LCM continuity usually still follows the stable `sessionKey` when one is available.

So today:

- `/new` prunes active context but keeps the same LCM conversation row
- `/reset` archives the active LCM conversation row and creates a fresh active row
- ordinary chat/thread LCM history may continue in the same row across runtime `sessionId` changes when the stable `sessionKey` continues
- cron scheduler keys create fresh LCM rows per runtime run so prior runs do not enter the new run's assembled context
- `/lossless rotate` keeps that same conversation row, summaries, and context items in place while compacting only the live transcript backing

## Why

Current lossless-claw conversation resolution generally does this:

1. look up by `sessionKey` first
2. fall back to `sessionId` only when no `sessionKey` match exists
3. if the `sessionKey` already exists but the `sessionId` changed, update the stored `sessionId` on that same conversation

That behavior preserves continuity across session resets for the same chat identity.

Cron keys are the exception: when an active cron conversation exists for the same `sessionKey` but a different runtime `sessionId`, lossless-claw archives the prior active row and starts a fresh one for the new run. Prior messages remain persisted on the archived conversation.

## `/lossless rotate`

`/lossless rotate` is distinct from `/new` and `/reset`.

- it does **not** create a fresh LCM conversation row
- it does **not** archive the current conversation
- it **does** create or replace the rolling `rotate-latest` SQLite backup first
- it **does** rewrite the current transcript into a compact suffix-preserving form
- it **does** refresh bootstrap state on the same conversation so dropped transcript history is not replayed
- it **does** preserve the current conversation id, summary DAG, and active context items

This makes rotate the lightweight option when the problem is transcript bloat rather than LCM conversation structure.

## Important limitation

There is a plugin-specific `/new` vs `/reset` split in current lossless-claw behavior.

If someone is asking for semantics like:

- `/new` gives them a fresh LCM conversation row

that remains a **design/spec topic**, not current stock behavior.

## Safe operator guidance

When answering users:

- do not promise that `/new` clears LCM history
- explain that `/reset` archives the active LCM row and starts a fresh one for the same stable `sessionKey`
- explain that `/lossless rotate` compacts the current transcript without splitting the LCM conversation
- explain that ordinary current stock behavior follows `sessionKey` continuity
- explain that cron scheduler session keys are isolated per runtime run while preserving archived prior runs
- if they need a truly separate LCM history, use a different session key context (for example a different chat/thread/binding) or explicit non-MVP migration/surgery tools

## Relation to `/status`

This session behavior is separate from `/status` metrics.

- `/status` reflects runtime session state and the last assembled request snapshot
- `/lossless` reflects LCM conversation state keyed by the plugin's conversation mapping rules

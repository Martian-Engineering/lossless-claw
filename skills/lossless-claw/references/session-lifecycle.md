# Session lifecycle (`/new`, `/reset`, and `/lossless rotate`)

This reference describes the current behavior on `main`.

## Short version

For stock `lossless-claw` on current main:

- OpenClaw handles `/new` and `/reset` as session-reset operations.
- `lossless-claw` handles `/lossless rotate` (`/lcm rotate`) as transcript maintenance on the current conversation.
- `lossless-claw` does **not** currently register its own `before_reset` hook or a custom reset policy.
- `lossless-claw` prefers **`sessionKey`** as the stable identity for an LCM conversation.
- When the same `sessionKey` reappears with a new `sessionId`, `lossless-claw` updates the stored `sessionId` on the existing LCM conversation row instead of creating a brand-new LCM conversation.

## What that means in practice

If a user asks whether `/new` or `/reset` gives them a fresh LCM conversation, the answer is usually **no** under the current implementation.

They get a fresh OpenClaw session runtime, but LCM continuity still follows the stable `sessionKey` when one is available.

So today:

- `/new` and `/reset` can reset the runtime session
- but LCM history may continue in the same conversation row if the chat/thread keeps the same `sessionKey`
- `/lossless rotate` keeps that same conversation row, summaries, and context items in place while compacting only the live transcript backing

## Why

Current lossless-claw conversation resolution does this:

1. look up by `sessionKey` first
2. fall back to `sessionId` only when no `sessionKey` match exists
3. if the `sessionKey` already exists but the `sessionId` changed, update the stored `sessionId` on that same conversation

That behavior preserves continuity across session resets for the same chat identity.

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

There is still **no plugin-specific `/new` vs `/reset` split** in stock lossless-claw docs or runtime behavior.

If someone is asking for semantics like:

- `/new` gives them a fresh LCM conversation row
- `/reset` archives old LCM conversation and starts a new one for the same stable `sessionKey`

that is a **design/spec topic**, not current stock behavior.

## Safe operator guidance

When answering users:

- do not promise that `/new` or `/reset` clears LCM history
- explain that `/lossless rotate` compacts the current transcript without splitting the LCM conversation
- explain that current stock behavior follows `sessionKey` continuity
- if they need a truly separate LCM history, use a different session key context (for example a different chat/thread/binding) or explicit non-MVP migration/surgery tools

## Relation to `/status`

This session behavior is separate from `/status` metrics.

- `/status` reflects runtime session state and the last assembled request snapshot
- `/lossless` reflects LCM conversation state keyed by the plugin's conversation mapping rules

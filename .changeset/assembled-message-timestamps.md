---
"@martian-engineering/lossless-claw": patch
---

Give every assembled message a numeric `timestamp`. Summaries, focus briefs, prompt-recall cues, stored raw messages and synthetic tool results were returned without one, which made OpenClaw's settled-turn finalization fail with `Invalid time value`. Each timestamp comes from stored data, never the wall clock, so it stays the same across turns. When OpenClaw prefixes user messages with their time, summaries and historical user turns now show a stable date prefix; the first request after upgrading writes the prompt cache once.

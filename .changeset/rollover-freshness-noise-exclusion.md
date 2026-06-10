---
"@martian-engineering/lossless-claw": patch
---

Exclude template noise from the ambiguous-rollover freshness overlap check.

The tier-2 rollover resolution false-blocked on the very lane it was built
for: a week-idle conversation whose entire recent history was synthetic
heartbeat traffic. Every session's transcript contains identical
"[OpenClaw heartbeat poll]" / "HEARTBEAT_OK" lines, so the identity-overlap
test matched 46 heartbeat rows and reported plausible lineage where there
was none.

The overlap comparison now considers only lineage-discriminating content:
synthetic heartbeat traffic and content that recurs within the window are
excluded from both sides, and the window widens (50 -> 500) when the recent
history yields nothing comparable. When even the widened window is pure
template noise, the overlap test is acknowledged as no-signal and the
strict per-entry time gate decides alone — every new entry must still
postdate the conversation's last persisted message. Real unique-content
overlap still freezes the lane exactly as before.

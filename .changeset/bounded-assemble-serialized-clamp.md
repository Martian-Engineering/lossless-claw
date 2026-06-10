---
"@martian-engineering/lossless-claw": patch
---

Bound assemble() output by serialized model-boundary token estimate.

Live messages that carry structured tool payloads (e.g. transcripts imported
from a previous harness) were estimated by text blocks only, undercounting the
real prompt by 2-3x. assemble() could return a context the host's LLM-boundary
estimator rejected as far over budget, wedging the session in a
compact/overflow loop while every internal pressure check stayed green.

Token estimates for live messages now serialize the full message structure
(with a fixed per-part substitution for embedded binary payloads), live
fallback paths return budget-bounded suffixes instead of the unbounded
transcript, and a final serialized-estimate clamp guarantees assembled output
never exceeds the token budget. Assemble telemetry now logs the serialized
estimate, the internal estimate, and clamp activity (`serializedClamped=`,
`[lcm] assemble: serialized budget clamp`, `[lcm] assemble: bounded live
fallback`) for live monitoring.

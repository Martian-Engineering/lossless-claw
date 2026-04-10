---
"@martian-engineering/lossless-claw": patch
---

Honor `OPENCLAW_STATE_DIR` for the default database, large-file storage, auth-profile, and legacy secret paths so multi-profile OpenClaw gateways do not read and write each other's state.

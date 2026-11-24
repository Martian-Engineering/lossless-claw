# LCM Pattern Regression Tests

This directory contains regression tests for LCM (Lossless Context Management) integration with OpenClaw.

## Overview

These tests validate that LCM tools (`lcm_grep`, `lcm_expand`, `lcm_describe`, `lcm_expand_query`) integrate correctly with OpenClaw's session, cron, and agent infrastructure.

## Test Patterns

| Pattern | Description | Validates |
|---------|-------------|-----------|
| 001 | LCM Tools Integration | `lcm_grep`, `lcm_expand`, `lcm_expand_query` work after compaction |
| 002 | Compaction | Summarizer completes without error |
| 003 | Auth Profiles | Summarizer uses correct model/auth |

## Running Tests

```bash
# Run all pattern tests
npm test -- test/pattern-regression.test.ts

# Run with custom OpenClaw binary
OPENCLAW_BINARY=/path/to/openclaw npm test -- test/pattern-regression.test.ts

# Run with custom LCM DB path
LCM_DB_PATH=/path/to/lcm.db npm test -- test/pattern-regression.test.ts
```

## Test Design Principles

1. **Black-box**: Tests invoke LCM through OpenClaw's tool interface, not internal APIs
2. **Idempotent**: Can run repeatedly without polluting the DB
3. **Failure isolation**: Each test cleans up its own data
4. **Deterministic**: Uses fixed test conversations with known content
5. **Timeout-aware**: Respects summarizer latency (60s default)

## Prerequisites

- OpenClaw binary in PATH or specified via `OPENCLAW_BINARY`
- LCM plugin enabled in OpenClaw config
- Valid model credentials for summarizer

## Adding New Tests

1. Create `test/pattern-regression/NNN-description.test.ts`
2. Import from `pattern-regression.test.ts` for shared fixtures
3. Follow the naming convention: `NNN` = zero-padded pattern number

## Related

- [Issue #162: Auth profile drift](https://github.com/Martian-Engineering/lossless-claw/issues/162)
- [LCM Plugin Docs](https://docs.openclaw.ai/plugins/lcm)
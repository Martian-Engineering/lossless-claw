# Layer 3 & 4 Validation Log — LCM-PG Mirror E2E

**Date**: 2026-03-21
**OpenClaw**: 2026.3.8 (3caab92)
**LCM-PG**: 0.4.0 (commit `2444cf5`)
**PostgreSQL**: 16.13 (Homebrew, local)
**Model**: minimax-cn/MiniMax-M2.5
**OS**: macOS (darwin 25.3.0, aarch64)

---

## Background

After completing Layers 1–2 (unit tests + PG integration tests), we proceeded to Layer 3 (end-to-end with a live OpenClaw gateway) and Layer 4 (regression check with mirror disabled).

A prior agent session had renamed the project from `lossless-claw` to `lcm-pg` across 30 files but lost its workspace when the folder was renamed on disk. We reopened, committed the rename (`2444cf5`), and continued from here.

---

## Problem 1: `contextEngine` Slot Mismatch

After uninstalling the old `lossless-claw` plugin and linking the fork as `lcm-pg`, the agent command failed:

```
Error: Context engine "lossless-claw" is not registered.
Available engines: lcm-pg, default, legacy
```

**Root cause**: `~/.openclaw/openclaw.json` still had the old plugin ID in the slot config:

```json
"slots": {
  "contextEngine": "lossless-claw"   // ← stale reference
}
```

**Fix** (by Liz): Manually update line 320 of `openclaw.json`:

```json
"slots": {
  "contextEngine": "lcm-pg"
}
```

**Lesson**: When renaming a plugin ID, remember to update the `slots.contextEngine` reference in `openclaw.json` — OpenClaw uses the slot binding to route requests to the context engine, and it doesn't auto-resolve renames.

---

## Problem 2: LLM Provider 503 (Claude Down)

After fixing the slot, the first agent call failed because all configured Claude models on the `aiclaudexyz` proxy were returning HTTP 503:

```
FailoverError: 503 分组 优惠渠道 下模型 claude-opus-4-6 无可用渠道（distributor）
```

All three failover models failed:
- `aiclaudexyz/claude-opus-4-6` → 503
- `aiclaudexyz/claude-sonnet-4-6` → 503
- `openaixyz/gpt-5.3-codex` → 503 (timeout)

**Fix** (by Liz): Switch to the MiniMax provider which was already configured:

```bash
openclaw config set agents.defaults.model "minimax-cn/MiniMax-M2.5"
```

Gateway restart confirmed the new model:

```
[lcm] Compaction summarization model: minimax-cn/MiniMax-M2.5 (default)
[gateway] agent model: minimax-cn/MiniMax-M2.5
```

**Lesson**: Always have a fallback model provider configured. The `openclaw config set agents.defaults.model` command changes the default model; a gateway restart is required.

---

## Problem 3: Compaction Never Triggers (Threshold Too High)

After 9 successful conversation turns (~20k tokens in SQLite), compaction still hadn't triggered. No summaries were created, and the mirror had nothing to write.

**Root cause**: The default `contextThreshold=0.75` means compaction triggers when token usage exceeds 75% of the 128k default token budget — that's ~96k tokens. Our 20k tokens were nowhere near.

**Fix**: Lower the threshold via environment variable:

```bash
LCM_CONTEXT_THRESHOLD=0.05 openclaw gateway --force
```

With 5% of 128k = ~6.4k tokens as the threshold, the existing 20k tokens immediately exceeded it. The next message (turn 10) triggered compaction.

**Lesson**: For integration testing, set `LCM_CONTEXT_THRESHOLD` to a low value (e.g., `0.05`) to trigger compaction quickly without needing hundreds of messages. In production, the default `0.75` is appropriate.

---

## Success: Mirror Row in PostgreSQL

After compaction triggered on turn 10, the mirror job ran and wrote a row to `lcm_mirror`.

### Gateway log confirmation

```
[lcm] Plugin loaded (enabled=true, db=~/.openclaw/lcm.db, threshold=0.05)
[lcm] PG mirror enabled (mode=latest_nodes, maxNodes=5)
[lcm] Compaction summarization model: minimax-cn/MiniMax-M2.5 (default)
```

### PostgreSQL query result

```sql
SELECT mirror_id, agent_id, mode, length(content), summary_ids, captured_at
FROM lcm_mirror;
```

```
              mirror_id               | agent_id |     mode     | length | summary_ids                | captured_at
--------------------------------------+----------+--------------+--------+----------------------------+----------------------------
 a1b54675-ad6f-45d0-8d86-9449151030ac | main     | latest_nodes |    943 | ["sum_3e719b6fe75c707d"]   | 2026-03-21 19:34:17.307+08
```

### Full row details

| Column            | Value |
|-------------------|-------|
| `mirror_id`       | `a1b54675-ad6f-45d0-8d86-9449151030ac` |
| `session_key`     | (empty — CLI agent sessions have no session key) |
| `conversation_id` | `8` |
| `agent_id`        | `main` |
| `mode`            | `latest_nodes` |
| `content`         | 943-character summary (see below) |
| `summary_ids`     | `["sum_3e719b6fe75c707d"]` |
| `content_hash`    | `5b4631a446c63ff84b6931aab44458b37c0a5836f1a6274bd97a06640890ebc9` |
| `session_id`      | `lcm-pg-e2e-test` |
| `captured_at`     | `2026-03-21 19:34:17.307+08` |
| `ingested_at`     | `2026-03-21 19:34:17.488782+08` |

### Mirror content (summary text)

> The conversation segment shows:
> 1. Multiple repeated requests from user asking for a detailed story (500+ words) about a robot learning to cook Italian food
> 2. The user mentions testing "LCM-PG context engine"
> 3. Several "Continue where you left off" messages suggesting the previous attempt failed or timed out
> ...

### `lcm_mirror` table schema

```
     Column      |           Type           | Default
-----------------+--------------------------+----------------------
 mirror_id       | uuid                     | gen_random_uuid()
 session_key     | text                     | ''
 conversation_id | bigint                   |
 agent_id        | text                     |
 mode            | text                     | 'latest_nodes'
 content         | text                     |
 summary_ids     | jsonb                    | '[]'
 content_hash    | text                     |
 session_id      | text                     |
 captured_at     | timestamp with time zone |
 ingested_at     | timestamp with time zone | now()

Indexes:
  lcm_mirror_pkey                              PRIMARY KEY (mirror_id)
  lcm_mirror_conversation_id_content_hash_key  UNIQUE (conversation_id, content_hash)
  lcm_mirror_agent_idx                         (agent_id, ingested_at DESC)
  lcm_mirror_session_key_idx                   (session_key, ingested_at DESC)
```

---

## Layer 4: Regression Check — PASSED

Restarted gateway with `LCM_MIRROR_ENABLED=false`:

- No "PG mirror enabled" banner in logs
- Agent conversation succeeded normally
- No PG/mirror errors in logs
- Plugin loads as `lcm-pg` (ID), `LCM-PG Context Management` (name)

```
[lcm] Plugin loaded (enabled=true, db=~/.openclaw/lcm.db, threshold=0.75)
[lcm] Compaction summarization model: minimax-cn/MiniMax-M2.5 (default)
```

No mirror line — correct.

---

## Summary of Steps

| # | Action | Outcome |
|---|--------|---------|
| 1 | Commit rename (`lossless-claw` → `lcm-pg`) across 30 files | `2444cf5` pushed to GitHub |
| 2 | `openclaw plugins uninstall lossless-claw` | Old plugin removed |
| 3 | `openclaw plugins install --link ~/Documents/OpenClaw/VibeCoding/LCM-PG` | Fork linked as `lcm-pg` |
| 4 | Fix `openclaw.json` slot: `contextEngine: "lcm-pg"` | Slot mismatch resolved |
| 5 | Switch model to `minimax-cn/MiniMax-M2.5` | Claude 503 bypassed |
| 6 | Set `LCM_CONTEXT_THRESHOLD=0.05` | Compaction triggers at low token count |
| 7 | 10 conversation turns via `openclaw agent` | Compaction → summary → mirror write |
| 8 | `SELECT * FROM lcm_mirror` | 1 row with correct fields |
| 9 | Restart with `LCM_MIRROR_ENABLED=false` | No PG errors, regression passed |

---

## Testing Tips for Reproducing

```bash
# 1. Link the plugin
openclaw plugins install --link /path/to/LCM-PG

# 2. Ensure openclaw.json has: "slots": { "contextEngine": "lcm-pg" }

# 3. Start gateway with mirror + low threshold for fast compaction
LCM_MIRROR_ENABLED=true \
LCM_MIRROR_DATABASE_URL="postgresql://$(whoami)@localhost:5432/lcm_test" \
LCM_MIRROR_MODE=latest_nodes \
LCM_CONTEXT_THRESHOLD=0.05 \
openclaw gateway --force

# 4. Send a few messages
openclaw agent --session-id test-mirror --message "Tell me a long story about X." --json

# 5. Check PG
psql -d lcm_test -c "SELECT mirror_id, agent_id, mode, length(content), captured_at FROM lcm_mirror;"
```

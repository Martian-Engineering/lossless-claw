# lcm-tui

Interactive terminal UI for inspecting, debugging, and maintaining the [Lossless Claw](https://github.com/Martian-Engineering/lossless-claw) database. Browse conversations, navigate the summary DAG, see exactly what the model sees in context, and perform surgical repairs — all from the terminal.

## Install

**From releases:**

Download the latest binary from [GitHub Releases](https://github.com/Martian-Engineering/lossless-claw/releases).

**From source:**

```bash
go build -o lcm-tui .
# or: go install github.com/Martian-Engineering/lossless-claw/tui@latest
```

Requires Go 1.24+.

## Usage

```bash
lcm-tui                          # default: ~/.openclaw/lcm.db
lcm-tui --db /path/to/lcm.db    # custom database path
```

## Features

**Browse & Inspect**
- **Agent/session browser** — drill down from agents → sessions → conversations
- **Windowed conversation paging** — keyset pagination by `message_id` for large LCM conversations
- **Summary DAG** — expandable tree of the full summary hierarchy with depth, kind, token counts, and source messages
- **Context view** — see the exact ordered list of summaries + messages the model receives each turn
- **Large files** — inspect intercepted oversized files and their exploration summaries

**Repair & Maintain**
- **Rewrite** (`w`) — re-summarize a node using current depth-aware prompts
- **Subtree rewrite** (`W`) — bottom-up rewrite of an entire branch with auto-accept mode
- **Doctor** — detect and repair genuinely truncated summaries with position-aware marker checks
- **Dissolve** (`d`) — reverse a condensation, restoring parent summaries to active context
- **Repair** — find and fix corrupted summaries (fallback truncations from failed API calls)
- **Transplant** — deep-copy summary DAGs between conversations with full message/edge rewiring
- **Backfill** — import pre-LCM JSONL sessions, compact depth-aware history, optional single-root fold + transplant

**Prompt Management**
- Four depth-aware templates: leaf, d1 (session), d2 (arc), d3+ (durable)
- Export, customize, diff, and render templates via `lcm-tui prompts`

## CLI Subcommands

Each interactive operation has a standalone CLI equivalent for scripting:

```bash
lcm-tui doctor 44 --apply --provider openai-codex --model gpt-5.3-codex
lcm-tui repair 44 --apply --provider openai-codex --model gpt-5.3-codex
lcm-tui rewrite 44 --all --apply --diff --provider openai-codex --model gpt-5.3-codex
lcm-tui dissolve 44 --summary-id sum_abc --apply     # undo a condensation
lcm-tui transplant 18 653 --apply                    # copy DAG between conversations
lcm-tui backfill my-agent session_abc --apply --provider openai-codex --model gpt-5.3-codex
lcm-tui backfill my-agent session_abc --apply --recompact --single-root # re-fold existing import to one root
lcm-tui prompts --list                               # show active prompt sources
```

Use `--provider openai-codex` after `codex login` when you want the TUI to delegate through the Codex CLI OAuth session. Keep `--provider openai` for direct OpenAI-compatible HTTP calls with a raw `OPENAI_API_KEY`.

## Documentation

Full reference with keybindings, screen descriptions, flag tables, and troubleshooting: **[docs/tui.md](../docs/tui.md)**

## Architecture

The TUI reads directly from the LCM SQLite database (`~/.openclaw/lcm.db`) and session JSONL files (`~/.openclaw/agents/`). Write operations (rewrite, repair, dissolve, transplant, backfill) use transactions. Changes take effect on the next conversation turn — no restart needed.

Doctor, repair, rewrite, and backfill compaction operations all accept `--provider`, `--model`, and `--base-url`, and they also honor `LCM_TUI_SUMMARY_PROVIDER`, `LCM_TUI_SUMMARY_MODEL`, and `LCM_TUI_SUMMARY_BASE_URL` before falling back to the legacy `LCM_SUMMARY_*` settings. By default, repair/rewrite/backfill use Anthropic (`claude-sonnet-4-20250514`), while doctor keeps its lighter default (`claude-haiku-4-5`).

## License

Part of the [Lossless Claw](https://github.com/Martian-Engineering/lossless-claw) monorepo.

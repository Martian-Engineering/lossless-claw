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
- **Summary DAG** — expandable tree of the full summary hierarchy with depth, kind, token counts, and source messages
- **Context view** — see the exact ordered list of summaries + messages the model receives each turn
- **Large files** — inspect intercepted oversized files and their exploration summaries

**Repair & Maintain**
- **Rewrite** (`w`) — re-summarize a node using current depth-aware prompts
- **Subtree rewrite** (`W`) — bottom-up rewrite of an entire branch with auto-accept mode
- **Dissolve** (`d`) — reverse a condensation, restoring parent summaries to active context
- **Repair** — find and fix corrupted summaries (fallback truncations from failed API calls)
- **Transplant** — deep-copy summary DAGs between conversations with full message/edge rewiring

**Prompt Management**
- Four depth-aware templates: leaf, d1 (session), d2 (arc), d3+ (durable)
- Export, customize, diff, and render templates via `lcm-tui prompts`

## CLI Subcommands

Each interactive operation has a standalone CLI equivalent for scripting:

```bash
lcm-tui repair 44 --apply                           # fix corrupted summaries
lcm-tui rewrite 44 --all --apply --diff              # re-summarize everything
lcm-tui dissolve 44 --summary-id sum_abc --apply     # undo a condensation
lcm-tui transplant 18 653 --apply                    # copy DAG between conversations
lcm-tui prompts --list                               # show active prompt sources
```

## Documentation

Full reference with keybindings, screen descriptions, flag tables, and troubleshooting: **[docs/tui.md](../docs/tui.md)**

## Architecture

The TUI reads directly from the LCM SQLite database (`~/.openclaw/lcm.db`) and session JSONL files (`~/.openclaw/agents/`). Write operations (rewrite, repair, dissolve, transplant) use transactions. Changes take effect on the next conversation turn — no restart needed.

Rewrite and repair operations call the Anthropic API directly (requires `ANTHROPIC_API_KEY` or an `api_key`-mode auth profile in OpenClaw config).

## License

Part of the [Lossless Claw](https://github.com/Martian-Engineering/lossless-claw) monorepo.

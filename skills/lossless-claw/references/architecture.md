# Architecture

`lossless-claw` stores full conversation history in SQLite and uses summaries to keep active context within model limits.

## Core flow

1. Messages are persisted into the LCM database.
2. Older messages are compacted into leaf summaries.
3. Leaf summaries can be condensed into higher-depth summaries.
4. Context assembly mixes summaries with the fresh raw tail.
5. Recall tools let agents drill back into compacted material when precision matters.

## Mental model

Think of LCM as two layers:

- durable storage of the full conversation record
- a summary DAG used to present compacted context efficiently

The summary DAG is not the source of truth. Raw messages remain the ground truth.

## Why summary quality matters

Bad summaries do not stay local:

- poor leaf summaries degrade condensed summaries
- poor condensed summaries degrade future recall
- aggressive truncation reduces the precision of downstream answers

That is why configuration choices around compaction thresholds and summary model quality matter operationally.

## What `/lcm` tells you

The MVP command surface focuses on operational facts:

- package version
- whether the plugin is enabled and selected
- database path and size
- summary counts
- total summarized source-token coverage when available
- broken or truncated summary presence

## What `/lcm doctor` tells you

The MVP doctor flow is diagnostic only.

It looks for known summary-health markers that indicate:

- deterministic fallback summaries
- truncated summary artifacts near the end of stored content

This gives users one place to answer the question “is my summary graph healthy?” without introducing a broader mutation surface.

## What `/lcm doctor clean` tells you

The cleaners flow is also diagnostic first.

It reports high-confidence junk patterns that are structurally safe to review as standalone cleanup candidates, including:

- archived subagent sessions
- cron sessions
- NULL-key orphaned subagent context conversations

This keeps cleanup discovery separate from summary-health diagnostics while still using the same native command surface.

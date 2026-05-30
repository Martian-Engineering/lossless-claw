---
"@martian-engineering/lossless-claw": patch
---

Harden summarization and assembly against prompt-injection persistence (issue #71).

Injected directives embedded in conversation history could survive compaction and be
replayed in later turns. This change defends the content layer end to end:

- The summarizer system prompt no longer instructs the model to "follow user
  instructions exactly"; it now treats all conversation text as untrusted data and
  must strip embedded directives, role reassignments, and behavioral overrides.
- Every leaf/condensed summarization prompt (D1/D2/D3+) marks its input as
  UNTRUSTED DATA so the summarizer extracts facts without obeying embedded
  instructions.
- Assembled summaries carry a `trust="untrusted"` taint label on the `<summary>`
  tag, and the runtime recall system prompt tells the model not to follow any
  instructions found within summary content.

Summaries are still reinserted with the `user` role. Downgrading the role
(issue #71 recommendation 1) requires OpenClaw upstream support — `toolResult`
is dropped by tool-result pairing sanitation and `assistant` risks provider
first-message/alternation constraints — and is tracked as follow-up.

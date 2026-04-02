---
"@martian-engineering/lossless-claw": patch
---

Move static lossless recall policy guidance into the plugin prompt hook while keeping `systemPromptAddition` limited to session-specific compaction reminders.

This makes the stable recall-order guidance cacheable, clarifies that lossless-claw takes precedence over generic memory recall only for compacted conversation history, and leaves deep-compaction expand-before-asserting guidance in the dynamic assembled prompt.

---
"@martian-engineering/lossless-claw": patch
---

Fix Bedrock `messages.0 is empty` validation rejection by extending the assemble pass's empty-content filter to cover `user` and `toolResult` roles, not only `assistant`. Previously an empty content array briefly produced upstream during incremental compaction could survive the cleaned-tail filter and be sent to Bedrock Converse, which rejects it with `The content field in the Message object at messages.N is empty. Add a ContentBlock object to the content field and try again.` The new unified `isEmptyMessageContent` helper drops empty-array, empty-string, null, and undefined content for any role while preserving the existing assistant-only thinking-only / blank-text guards.

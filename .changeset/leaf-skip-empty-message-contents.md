---
"lossless-claw": patch
---

Guard leaf compaction against empty messageContents. When selectOldestLeafChunk returns items whose messageId fields are all null, or whose referenced messages no longer exist, messageContents is empty. Previously leafPass would still call summarizer, create a summary with removedTokens=0, and grow the context (tokensAfter = tokensBefore + tokenCount). Now it returns null early, letting callers bail without wasted LLM calls or context inflation.

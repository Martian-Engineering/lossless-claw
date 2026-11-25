---
"@martian-engineering/lossless-claw": patch
---

Treat `conversationId` values of 0 or below as "not provided" in the LCM recall tools, so models on OpenAI strict tool schemas (which fill every optional property) search the current conversation instead of getting empty results.

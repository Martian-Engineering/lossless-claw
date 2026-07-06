---
"@martian-engineering/lossless-claw": patch
---

Strip a structurally validated host chat-history recap block ("Chat history since last reply (untrusted, for context):" plus its JSON-fenced message array) when reducing an OpenClaw inbound turn to its model-facing body, and when canonicalizing it for identity hashing. Building on the metadata-block strip landed in [#967](https://github.com/Martian-Engineering/lossless-claw/pull/967), a decorated inbound turn that also carries a recap of unread channel messages previously kept the recap embedded in its reduced body, so it never matched its bare persisted row and both got replayed to the model (see [#973](https://github.com/Martian-Engineering/lossless-claw/issues/973)). The strip only fires on the exact heading, fence, and JSON-array grammar OpenClaw core emits, so a user merely quoting the heading in prose, or a malformed payload, is left untouched.

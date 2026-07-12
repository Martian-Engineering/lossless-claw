---
"@martian-engineering/lossless-claw": patch
---

Strip a structurally validated host chat-history recap block when reducing an OpenClaw inbound turn to its model-facing body, and when canonicalizing it for identity hashing. Building on the metadata-block strip landed in [#967](https://github.com/Martian-Engineering/lossless-claw/pull/967), a decorated inbound turn that also carries a recap of unread channel messages previously kept the recap embedded in its reduced body, so it never matched its bare persisted row and both got replayed to the model (see [#973](https://github.com/Martian-Engineering/lossless-claw/issues/973)).

The matcher recognizes the two recap headings OpenClaw core emits ("Chat history since last reply (untrusted, for context):" and "Conversation context (untrusted, chronological, selected for current message):", kept in a single extensible list) across both observed body grammars: the JSON-fenced message array and the older per-message prose line format. It also consumes the exact host JSON context blocks OpenClaw can emit between metadata and recap, such as reply target, thread starter, forwarded-message, and location context. Each combination is validated fail-closed: the strip requires a positive host `history_count`, an exact known heading, and a body that parses under the expected grammar, so user-authored recap-shaped text, a quoted heading, or a malformed payload is left untouched.

The identity canonicalization also excludes the host's volatile recap count, media count, and truncation fields whenever trusted history is present. On upgrade, the versioned OpenClaw identity repair refreshes message and bootstrap hashes that were already canonicalized before recap removal, preventing stale identity state from re-importing those rows.

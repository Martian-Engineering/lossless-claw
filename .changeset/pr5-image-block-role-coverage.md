---
"@martian-engineering/lossless-claw": patch
---

Generalize the native-image-block externalizer to assistant, system, tool, and toolResult messages.  PR #521 in v0.9.3 only ran on user-role messages, so:

- Assistant or system messages carrying native `{type:"image", data:...}` blocks fell through to the generic raw-payload externalizer and were stored as `raw-{role}-payload.json` blobs with embedded base64 instead of dedupe-friendly image files.
- Tool and toolResult messages (which skip raw-payload externalization entirely) had their image blocks persisted inline through the standard `message_parts` pipeline, embedding base64 directly in the DB row.

In both cases the result was the same: no large_file row, no `lcm_describe` rendering, and no inter-conversation dedupe.  The interceptor now runs for every persistable role, replacing native image blocks with `[<Role> image: ... | LCM file: file_…]` references and storing the image file once.

`interceptLargeRawPayload` also no longer skips externalization based on a content substring match (`isExternalizedReferenceContent`); it now only skips when the message already carries the explicit `rawPayloadExternalized: true` flag, so a still-oversized message that merely embeds an image reference alongside other content is still externalized.

Extension map: added `image/heic`, `image/avif`, and `image/bmp` so MIME-detection misses for those formats produce a sensible filename.

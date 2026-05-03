---
"@martian-engineering/lossless-claw": patch
---

Generalize the native-image-block externalizer to assistant and tool messages — PR #521 in v0.9.3 only ran on user-role messages, so MCP tools that return native `{type: "image", data: ...}` blocks ended up serialized as `raw-*-payload.json` blobs with embedded base64 instead of dedupe-friendly image files. The extension map also gained `image/heic`, `image/avif`, and `image/bmp` so detection-miss MIME types still produce a sensible filename.

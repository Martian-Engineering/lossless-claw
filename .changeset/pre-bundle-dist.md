---
"@martian-engineering/lossless-claw": patch
---

Pre-bundle the plugin to `dist/index.js` using esbuild before publishing. This eliminates the per-invocation TypeScript compilation overhead caused by OpenClaw's JITI loader recursively transpiling every `.ts` source file, reducing CLI startup latency from 15–25 s to near-instant.

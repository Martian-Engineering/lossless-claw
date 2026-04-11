---
"@martian-engineering/lossless-claw": patch
---

Strip comments from the pre-bundled dist/index.js so the OpenClaw install-time code safety scanner no longer flags JSDoc prose (e.g. "Fetch all context items") as a network-send pattern and blocks installation with an `env-harvesting` false positive.

---
"@martian-engineering/lossless-claw": patch
---

Pin the context explorer's bundled DOMPurify sanitizer to 3.4.16, addressing GHSA-6688-9rhm-gjv2 and GHSA-p98j-92pf-mc4p. The existing string-to-DOM-fragment rendering policy and context assembly behavior are unchanged.

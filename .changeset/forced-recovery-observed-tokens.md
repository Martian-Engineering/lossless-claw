---
"@martian-engineering/lossless-claw": patch
---

Forced overflow recovery now honors the host-observed prompt size when the host owns prompt framing. Lossless scales the host's observed overflow into a stored-token target, so it no longer reports a successful no-op while the host is still over its budget.

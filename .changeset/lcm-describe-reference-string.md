---
"@martian-engineering/lossless-claw": patch
---

`lcm_describe` now accepts a full `[LCM Tool Output: file_xxx | ...]` reference string as `id`, extracting the embedded `file_xxx` or `sum_xxx` ID automatically. Bare IDs continue to work, and unrecognized inputs return a clearer error hint.

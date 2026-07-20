---
"@martian-engineering/lossless-claw": patch
---

`lcm_describe` now accepts full copied reference strings such as `[LCM Tool Output: file_xxx | ...]` and `[LCM File: file_xxx | ...]` as `id`, extracting the embedded `file_xxx` or `sum_xxx` ID automatically. Bare IDs continue to work; ambiguous input (multiple IDs), zero/empty IDs, and malformed IDs now return clear errors.

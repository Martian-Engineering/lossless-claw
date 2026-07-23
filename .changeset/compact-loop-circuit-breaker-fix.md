---
"lossless-claw": patch
---

Fix compact-loop circuit breaker reset condition for deferred compaction debt drain. The breaker counter was reset when `exhausted` was false, but all failure paths (ENOENT, etc.) also return `exhausted: false`, causing perpetual resets and preventing the breaker from ever tripping. Now reset only when `changed === true` — meaning compaction actually made progress, a genuine cooling signal. Adds regression test coverage for the assemble deferred compaction breaker path.

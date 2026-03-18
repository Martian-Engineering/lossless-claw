This PR addresses two critical issues preventing `lossless-claw` from running smoothly on existing OpenClaw sessions and containerized environments.

### 1. Context Engine Backward Compatibility
* Added a `registerContextEngine("default", ...)` alias to `index.ts`. 
* Without this, installing the plugin orphans any active OpenClaw sessions that were originally anchored to the `"default"` engine, causing them to crash with missing engine errors.

### 2. Docker Containerization Fixes
* **Node Base Image:** Changed `node:20-alpine` to `node:22-bookworm`. `node-llama-cpp` (via `koffi`) requires `glibc` and `linux/limits.h`, which Alpine (`musl`) does not natively support. Additionally, `llama.cpp` demands `cmake >= 3.19`, which Bookworm natively provides.
* **Build Tools:** Added `git python3 make g++ cmake linux-libc-dev` so native dependencies compile cleanly on `npm ci`.
* **Gateway Command:** Updated the `ENTRYPOINT` to `openclaw gateway run --dev --bind auto` to ensure the container boots in the foreground with a generated dev configuration and binds to all interfaces, instead of immediately crashing looking for `systemd`/`launchd`.
* **Plugin Install:** Fixed a typo (`openclaw plugin` -> `openclaw plugins install`).

These changes have been thoroughly tested on a local fork. All 247 unit tests pass.

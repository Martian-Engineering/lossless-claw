---
"@martian-engineering/lossless-claw": patch
---

Tighten packaging guards to prevent the silent-load failure mode #555 fixed:

- Add `test/manifest.test.ts` that asserts `openclaw.plugin.json#contracts.tools` matches the canonical `name:` fields exported by `src/tools/*` and the `registerTool` call sites in `src/plugin/index.ts`. Catches drift the next time a tool is added or renamed without a manifest update.
- Tighten `peerDependencies` for `@mariozechner/pi-*` from `*` to `>=0.66 <1`, and `openclaw` from `*` to `>=2026.2.17 <2026.6.0`, so the next major silently mismatches at install-time rather than at runtime.
- Add an upper bound (`<2026.6.0`) and a `tested: ["2026.5.2"]` array to `package.json#openclaw.compat`, so `openclaw plugins doctor` can flag known-incompatible host versions.
- Add a CI smoke job that installs the bundle against `openclaw@latest` and asserts the `registerTool` surface wires up the four `lcm_*` tools — catches host-side contract changes like #555 before they ship.
- The Windows installer's hook-pack detector (#451) already saw `kind: "context-engine"` in the manifest; this is now covered by an explicit assertion in the manifest drift test.

Closes #570.

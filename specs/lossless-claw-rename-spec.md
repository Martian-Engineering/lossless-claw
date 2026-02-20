# Rename Spec: `openclaw-lcm` -> `lossless-claw`

## Scope and naming decisions

- Package name: `@martian-engineering/lossless-claw`
- Plugin/context-engine id: `lossless-claw`
- GitHub repo name: `lossless-claw`
- Go module path: `github.com/Martian-Engineering/lossless-claw/tui`
- Pebbles prefix (new issues only): `lossless-claw`

## Required line-by-line changes

### package + registry metadata

- [ ] `package.json:2`
  Old: `"name": "@martian-engineering/openclaw-lcm"`
  New: `"name": "@martian-engineering/lossless-claw"`

- [ ] `package.json:7`
  Add repository metadata (currently missing):
  New:
  ```json
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Martian-Engineering/lossless-claw.git"
  },
  "homepage": "https://github.com/Martian-Engineering/lossless-claw#readme",
  "bugs": {
    "url": "https://github.com/Martian-Engineering/lossless-claw/issues"
  },
  ```

- [ ] `package-lock.json:2`
  Old: `"name": "@martian-engineering/openclaw-lcm"`
  New: `"name": "@martian-engineering/lossless-claw"`

- [ ] `package-lock.json:8`
  Old: `"name": "@martian-engineering/openclaw-lcm"`
  New: `"name": "@martian-engineering/lossless-claw"`

### plugin registration and ids

- [ ] `index.ts:2`
  Old: `* @martian-engineering/openclaw-lcm — ...`
  New: `* @martian-engineering/lossless-claw — ...`

- [ ] `index.ts:746`
  Old: `id: "openclaw-lcm"`
  New: `id: "lossless-claw"`

- [ ] `index.ts:771`
  Old: `api.registerContextEngine("openclaw-lcm", () => lcm);`
  New: `api.registerContextEngine("lossless-claw", () => lcm);`

- [ ] `openclaw.plugin.json:2`
  Old: `"id": "openclaw-lcm"`
  New: `"id": "lossless-claw"`

### release and module paths

- [ ] `.goreleaser.yml:41`
  Old: `name: openclaw-lcm`
  New: `name: lossless-claw`

- [ ] `tui/go.mod:1`
  Old: `module github.com/Martian-Engineering/openclaw-lcm/tui`
  New: `module github.com/Martian-Engineering/lossless-claw/tui`

### README links, install paths, and config keys

- [ ] `README.md:1`
  Old: `# openclaw-lcm`
  New: `# lossless-claw`

- [ ] `README.md:29`
  Old: `git clone https://github.com/Martian-Engineering/openclaw-lcm.git`
  New: `git clone https://github.com/Martian-Engineering/lossless-claw.git`

- [ ] `README.md:30`
  Old: `cd openclaw-lcm`
  New: `cd lossless-claw`

- [ ] `README.md:44`
  Old: `"/path/to/openclaw-lcm"`
  New: `"/path/to/lossless-claw"`

- [ ] `README.md:47`
  Old: `"contextEngine": "openclaw-lcm"`
  New: `"contextEngine": "lossless-claw"`

- [ ] `README.md:63`
  Old: `Add an \`openclaw-lcm\` block ...`
  New: `Add a \`lossless-claw\` block ...`

- [ ] `README.md:69`
  Old: `"openclaw-lcm": {`
  New: `"lossless-claw": {`

- [ ] `README.md:256`
  Old URL: `https://github.com/Martian-Engineering/openclaw-lcm/releases`
  New URL: `https://github.com/Martian-Engineering/lossless-claw/releases`

- [ ] `README.md:264`
  Old: `go install github.com/Martian-Engineering/openclaw-lcm/tui@latest`
  New: `go install github.com/Martian-Engineering/lossless-claw/tui@latest`

### docs/*.md

- [ ] `docs/architecture.md:3`
  Old: `openclaw-lcm`
  New: `lossless-claw`

- [ ] `docs/configuration.md:10`
  Old: `"/path/to/openclaw-lcm"`
  New: `"/path/to/lossless-claw"`

- [ ] `docs/configuration.md:12`
  Old: `"contextEngine": "openclaw-lcm"`
  New: `"contextEngine": "lossless-claw"`

### source + tests (string literals/log prefixes/tmp dirs)

- [ ] `src/transcript-repair.ts:80`
  Old: `[openclaw-lcm] missing tool result ...`
  New: `[lossless-claw] missing tool result ...`

- [ ] `test/engine.test.ts:89`
  Old: `"openclaw-lcm-engine-"`
  New: `"lossless-claw-engine-"`

- [ ] `test/engine.test.ts:101`
  Old: `"openclaw-lcm-session-"`
  New: `"lossless-claw-session-"`

- [ ] `test/engine.test.ts:107`
  Old: `"openclaw-lcm-engine-"`
  New: `"lossless-claw-engine-"`

- [ ] `test/engine.test.ts:118`
  Old: `"openclaw-lcm-home-"`
  New: `"lossless-claw-home-"`

- [ ] `test/engine.test.ts:363`
  Old: `"openclaw-lcm-shared-db-"`
  New: `"lossless-claw-shared-db-"`

- [ ] `test/migration.test.ts:19`
  Old: `"openclaw-lcm-migration-"`
  New: `"lossless-claw-migration-"`

### specs/*.md (internal docs still referencing old name)

- [ ] `specs/summary-presentation-and-depth-aware-prompts.md:5`
  Old: `openclaw-lcm plugin (TypeScript)`
  New: `lossless-claw plugin (TypeScript)`

- [ ] `specs/depth-aware-prompts-and-rewrite.md:5`
  Old: `OpenClaw LCM (open-lcm plugin) + lcm-tui`
  New: `Lossless Claw plugin + lcm-tui`

- [ ] `specs/depth-aware-prompts-and-rewrite.md:657`
  Old: `Relationship to open-lcm plugin (TypeScript)`
  New: `Relationship to lossless-claw plugin (TypeScript)`

- [ ] `specs/depth-aware-prompts-and-rewrite.md:659`
  Old: `The open-lcm plugin ...`
  New: `The lossless-claw plugin ...`

- [ ] `specs/depth-aware-prompts-and-rewrite.md:666`
  Old: `Both open-lcm and lcm-tui ...`
  New: `Both lossless-claw and lcm-tui ...`

- [ ] `specs/depth-aware-prompts-and-rewrite.md:671`
  Old: `... ported to open-lcm's TypeScript`
  New: `... ported to lossless-claw's TypeScript`

- [ ] `specs/depth-aware-prompts-and-rewrite.md:692`
  Old: `... in open-lcm (TypeScript)`
  New: `... in lossless-claw (TypeScript)`

- [ ] `specs/extraction-plan.md:5`
  Old: ``@martian-engineering/open-lcm``
  New: ``@martian-engineering/lossless-claw``

### pebbles tracker naming

- [ ] `.pebbles/config.json:2`
  Old: `"prefix": "open-lcm"`
  New: `"prefix": "lossless-claw"`

## Files audited with no direct rename needed

- `tui/Makefile`: no `openclaw-lcm` / `open-lcm` / `@martian-engineering/openclaw-lcm` references. `BINARY := lcm-tui` can remain unless you explicitly want a binary rename.

## GitHub repo rename implications

- Update repo URLs in docs and install instructions (covered above).
- Rename Go module path and update any downstream imports from `github.com/Martian-Engineering/openclaw-lcm/tui`.
- Update npm package consumers importing `@martian-engineering/openclaw-lcm` to `@martian-engineering/lossless-claw`.

## Import path impact summary

- In-repo TypeScript files do not import `@martian-engineering/openclaw-lcm` today (no internal import rewrites required).
- External consumers will require import/path updates for npm and Go module names.

## Historical data note (do not rewrite)

- `.pebbles/events.jsonl` contains historical issue IDs like `open-lcm-8a9` and `open-lcm-6fc`.
- These are append-only history records and should be preserved as-is.

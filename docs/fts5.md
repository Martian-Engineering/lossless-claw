# Optional: enable FTS5 for fast full-text search

`lossless-claw` works without FTS5 as of the current release. When FTS5 is unavailable in the
Node runtime that runs the OpenClaw gateway, the plugin:

- keeps persisting messages and summaries
- falls back from `"full_text"` search to a slower `LIKE`-based search
- loses FTS ranking/snippet quality

If you want native FTS5 search performance and ranking, the **exact Node runtime that runs the
gateway** must have SQLite FTS5 compiled in.

## Probe the gateway runtime

Run this with the same `node` binary your gateway uses:

```bash
node --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
const options = db.prepare('pragma compile_options').all().map((row) => row.compile_options);

console.log(options.filter((value) => value.includes('FTS')).join('\n') || 'no fts compile options');

try {
  db.exec("CREATE VIRTUAL TABLE t USING fts5(content)");
  console.log("fts5: ok");
} catch (err) {
  console.log("fts5: fail");
  console.log(err instanceof Error ? err.message : String(err));
}
NODE
```

Expected output:

```text
ENABLE_FTS5
fts5: ok
```

If you get `fts5: fail`, build or install an FTS5-capable Node and point the gateway at that runtime.

## Build an FTS5-capable Node on macOS

This workflow was verified with Node `v22.15.0`.

```bash
cd ~/Projects
git clone --depth 1 --branch v22.15.0 https://github.com/nodejs/node.git node-fts5
cd node-fts5
```

Edit `deps/sqlite/sqlite.gyp` and add `SQLITE_ENABLE_FTS5` to the `defines` list for the `sqlite`
target:

```diff
 'defines': [
   'SQLITE_DEFAULT_MEMSTATUS=0',
+  'SQLITE_ENABLE_FTS5',
   'SQLITE_ENABLE_MATH_FUNCTIONS',
   'SQLITE_ENABLE_SESSION',
   'SQLITE_ENABLE_PREUPDATE_HOOK'
 ],
```

Important:

- patch `deps/sqlite/sqlite.gyp`, not only `node.gyp`
- `node:sqlite` uses the embedded SQLite built from `deps/sqlite/sqlite.gyp`

Build the runtime:

```bash
./configure --prefix="$PWD/out-install"
make -j8 node
```

Expose the binary under a Node-compatible basename that OpenClaw recognizes:

```bash
mkdir -p ~/Projects/node-fts5/bin
ln -sfn ~/Projects/node-fts5/out/Release/node ~/Projects/node-fts5/bin/node-22.15.0
```

Use a basename like `node-22.15.0`, `node`, or `nodejs`. Names like
`node-v22.15.0-fts5` may not be recognized correctly by OpenClaw's CLI/runtime parsing.

Verify the new runtime:

```bash
~/Projects/node-fts5/bin/node-22.15.0 --version
~/Projects/node-fts5/bin/node-22.15.0 --input-type=module - <<'NODE'
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(':memory:');
db.exec("CREATE VIRTUAL TABLE t USING fts5(content)");
console.log("fts5: ok");
NODE
```

## Point the OpenClaw gateway at that runtime on macOS

Back up the existing LaunchAgent plist first:

```bash
cp ~/Library/LaunchAgents/ai.openclaw.gateway.plist \
  ~/Library/LaunchAgents/ai.openclaw.gateway.plist.bak-$(date +%Y%m%d-%H%M%S)
```

Replace the runtime path, then reload the agent:

```bash
/usr/libexec/PlistBuddy -c 'Set :ProgramArguments:0 /Users/youruser/Projects/node-fts5/bin/node-22.15.0' \
  ~/Library/LaunchAgents/ai.openclaw.gateway.plist

launchctl bootout gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist 2>/dev/null || true
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
```

Verify the live runtime:

```bash
launchctl print gui/$UID/ai.openclaw.gateway | sed -n '1,80p'
```

You should see:

```text
program = /Users/youruser/Projects/node-fts5/bin/node-22.15.0
```

## Verify `lossless-claw`

Check the logs:

```bash
tail -n 60 ~/.openclaw/logs/gateway.log
tail -n 60 ~/.openclaw/logs/gateway.err.log
```

You want:

- `[gateway] [lcm] Plugin loaded ...`
- no new `no such module: fts5`

Then force one turn through the gateway and verify the DB fills:

```bash
/Users/youruser/Projects/node-fts5/bin/node-22.15.0 \
  /path/to/openclaw/dist/index.js \
  agent --session-id fts5-smoke --message 'Reply with exactly: ok' --timeout 60

sqlite3 ~/.openclaw/lcm.db '
  select count(*) as conversations from conversations;
  select count(*) as messages from messages;
  select count(*) as summaries from summaries;
'
```

Those counts should increase after a real turn.

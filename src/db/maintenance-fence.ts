import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, basename, join, resolve } from "node:path";

/** OS-released lifetime leases. All database owners MUST participate. Old binaries,
 * raw sqlite handles, or replacing/unlinking the sidecar are outside this fence. */
export function acquireDatabaseLease(
  path: string,
  exclusive = false
): () => void {
  const absolute = resolve(path);
  const canonical = existsSync(absolute)
    ? realpathSync(absolute)
    : join(realpathSync(dirname(absolute)), basename(absolute));
  if (existsSync(canonical) && lstatSync(canonical).nlink !== 1) {
    throw new Error("Maintenance fence refuses hard-linked databases");
  }
  const sidecar = canonical + ".maintenance.sqlite";
  if (
    existsSync(sidecar) &&
    (!lstatSync(sidecar).isFile() || lstatSync(sidecar).nlink !== 1)
  ) {
    throw new Error("Unsafe maintenance sidecar");
  }
  const lock = new DatabaseSync(sidecar);
  try {
    chmodSync(sidecar, 0o600);
    lock.exec("PRAGMA busy_timeout=0");
    // Never WAL: a held read transaction must exclude the repair owner.
    const mode = lock.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    if (mode.journal_mode !== "delete")
      throw new Error("Maintenance sidecar must use DELETE journal mode");
    if (!lock.prepare("SELECT 1 FROM sqlite_master WHERE name='lease'").get()) {
      lock.exec(
        "CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY); INSERT OR IGNORE INTO lease VALUES (1)"
      );
    }
    lock.exec(exclusive ? "BEGIN EXCLUSIVE" : "BEGIN");
    lock.prepare("SELECT * FROM lease").all();
  } catch (cause) {
    lock.close();
    throw new Error("Maintenance fence unavailable: another owner is active", {
      cause,
    });
  }
  let released = false;
  return () => {
    if (!released) {
      lock.close();
      released = true;
    }
  };
}

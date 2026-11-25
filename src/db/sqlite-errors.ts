const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * True when an error is SQLite reporting a busy or locked database.
 *
 * node:sqlite throws errors with an `errcode` holding the (possibly
 * extended) SQLite result code; its low byte is the primary code. The message
 * check covers wrappers that keep only the SQLite text.
 */
export function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode === "number") {
    const primary = errcode & 0xff;
    if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) {
      return true;
    }
  }
  const message = (error as { message?: unknown }).message;
  return (
    typeof message === "string"
    && /\b(database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED)\b/i.test(message)
  );
}

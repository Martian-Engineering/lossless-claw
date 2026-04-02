/**
 * Parse a SQLite UTC timestamp string into a Date object.
 * SQLite stores timestamps via datetime('now') without a Z suffix,
 * which causes JS to parse them as local time instead of UTC.
 * See: https://github.com/Martian-Engineering/lossless-claw/issues/216
 */
export function parseUtcTimestamp(value: string): Date {
  const s = value.trim();
  return new Date(s.endsWith("Z") ? s : s + "Z");
}

export function parseUtcTimestampOrNull(
  value: string | null | undefined,
): Date | null {
  if (value == null) return null;
  return parseUtcTimestamp(value);
}

/**
 * Parse a SQLite UTC timestamp string into a Date object.
 * SQLite stores timestamps via datetime('now') without a Z suffix,
 * which causes JS to parse them as local time instead of UTC.
 * See: https://github.com/Martian-Engineering/lossless-claw/issues/216
 */
export function parseUtcTimestamp(value: string): Date {
  const s = value.trim();
  if (/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(s)) {
    return new Date(s);
  }

  const normalized = s.includes("T") ? s : s.replace(" ", "T");
  return new Date(`${normalized}Z`);
}

/**
 * Parse a nullable SQLite UTC timestamp string into a Date object.
 */
export function parseUtcTimestampOrNull(
  value: string | null | undefined,
): Date | null {
  if (value == null) return null;
  return parseUtcTimestamp(value);
}

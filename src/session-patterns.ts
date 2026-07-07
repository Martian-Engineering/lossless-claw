/**
 * Compile a session glob into a regex.
 *
 * `*` matches any non-colon characters, while `**` can span colons.
 */
export function compileSessionPattern(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^:]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Compile all configured ignore patterns once at startup. */
export function compileSessionPatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => compileSessionPattern(pattern));
}

/** Check whether a session key matches any compiled ignore pattern. */
export function matchesSessionPattern(sessionKey: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(sessionKey));
}

/** Whether a session key names an isolated scheduled cron run. */
export function isIsolatedCronSessionKey(
  sessionKey: string | null | undefined,
): boolean {
  const trimmed = sessionKey?.trim();
  if (!trimmed) {
    return false;
  }
  const parts = trimmed.split(":");
  return parts.length >= 4 && parts[0] === "agent" && parts[2] === "cron";
}

const SESSION_KEY_CHANNEL_SCOPE = /^(.*:channel:[^:]+)(?::thread:[^:]+|:active-memory:[^:]+)*$/;

/**
 * The agent-and-channel scope a session key belongs to, with thread and
 * active-memory suffixes stripped. Sibling sessions of the same agent on the
 * same channel share this scope; keys without a channel segment have none.
 */
export function sessionKeyChannelScope(
  sessionKey: string | null | undefined,
): string | null {
  if (!sessionKey) {
    return null;
  }
  const match = SESSION_KEY_CHANNEL_SCOPE.exec(sessionKey);
  return match ? match[1] : null;
}

/** Whether a session key names the base session for its agent and channel. */
export function isBaseChannelSessionKey(sessionKey: string | null | undefined): boolean {
  const scope = sessionKeyChannelScope(sessionKey);
  return scope !== null && scope === sessionKey;
}

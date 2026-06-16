// Stub for openclaw/plugin-sdk/redact in test environments.
// The real module is provided by the host at runtime.
export function redactTranscriptMessage(
  message: Record<string, unknown>,
): Record<string, unknown> {
  return message;
}

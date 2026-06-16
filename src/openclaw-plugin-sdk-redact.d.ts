declare module "openclaw/plugin-sdk/redact" {
  /**
   * Redact sensitive content from an agent message using the same redaction
   * rules applied by the transcript writing layer.
   *
   * Returns a new object; does not mutate the input message.
   * When logging.redactSensitive is "off", returns the message unchanged.
   */
  export function redactTranscriptMessage(
    message: Record<string, unknown>,
  ): Record<string, unknown>;
}

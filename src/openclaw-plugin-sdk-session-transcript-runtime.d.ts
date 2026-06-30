declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  type SessionTranscriptReadTarget =
    import("./types.js").SessionTranscriptReadTarget;
  type VisibleSessionTranscriptMessageEntry =
    import("./types.js").VisibleSessionTranscriptMessageEntry;

  export function readVisibleSessionTranscriptMessageEntries(
    target: SessionTranscriptReadTarget,
  ): Promise<VisibleSessionTranscriptMessageEntry[]>;
}

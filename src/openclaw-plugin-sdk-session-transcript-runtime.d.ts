declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  type SessionTranscriptReadTarget =
    import("./types.js").SessionTranscriptReadTarget;
  type VisibleSessionTranscriptMessageEntry =
    import("./types.js").VisibleSessionTranscriptMessageEntry;
  type SessionTranscriptVisibleMessageDeltaParams =
    import("./types.js").SessionTranscriptVisibleMessageDeltaParams;
  type SessionTranscriptVisibleMessageDeltaResult =
    import("./types.js").SessionTranscriptVisibleMessageDeltaResult;
  type SessionTranscriptRawDeltaParams =
    import("./types.js").SessionTranscriptRawDeltaParams;
  type SessionTranscriptRawDeltaResult =
    import("./types.js").SessionTranscriptRawDeltaResult;

  export function readVisibleSessionTranscriptMessageEntries(
    target: SessionTranscriptReadTarget,
  ): Promise<VisibleSessionTranscriptMessageEntry[]>;

  export function readSessionTranscriptVisibleMessageDelta(
    params: SessionTranscriptVisibleMessageDeltaParams,
  ): Promise<SessionTranscriptVisibleMessageDeltaResult>;

  export function readSessionTranscriptRawDelta(
    params: SessionTranscriptRawDeltaParams,
  ): Promise<SessionTranscriptRawDeltaResult>;
}

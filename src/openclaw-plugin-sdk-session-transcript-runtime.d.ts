declare module "openclaw/plugin-sdk/session-transcript-runtime" {
  import type {
    SessionTranscriptReadTarget,
    VisibleSessionTranscriptMessageEntry,
  } from "./types.js";

  export function readVisibleSessionTranscriptMessageEntries(
    target: SessionTranscriptReadTarget,
  ): Promise<VisibleSessionTranscriptMessageEntry[]>;
}

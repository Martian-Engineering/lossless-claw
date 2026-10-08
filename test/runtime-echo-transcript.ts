/**
 * Per-session fake OpenClaw transcripts that record runtime turn payloads the
 * way the host persists a turn before it notifies the context engine.
 *
 * Test engines built without any transcript reader use this so engine entry
 * points that receive runtime arrays (ingest, ingestBatch, afterTurn,
 * commitTurn) exercise the production single-writer path: the engine only
 * ever stores what the transcript contains.
 */
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { getTranscriptEntryId } from "../src/transcript.js";
import type { LcmDependencies } from "../src/types.js";
import { FakeTranscriptHost } from "./transcript-delta-fake-host.js";

export class RuntimeEchoTranscripts {
  private readonly hosts = new Map<string, FakeTranscriptHost>();

  /** Return the fake transcript for one session, creating it on first use. */
  host(sessionId: string, sessionKey?: string): FakeTranscriptHost {
    const key = `${sessionKey ?? ""}\0${sessionId}`;
    let host = this.hosts.get(key);
    if (!host) {
      host = new FakeTranscriptHost(sessionId);
      this.hosts.set(key, host);
    }
    return host;
  }

  /** Append runtime messages that are not on the session transcript yet. */
  record(
    session: { sessionId: string; sessionKey?: string },
    messages: readonly AgentMessage[],
  ): void {
    const host = this.host(session.sessionId, session.sessionKey);
    for (const message of messages) {
      const entryId = getTranscriptEntryId(message) ?? undefined;
      if (entryId && host.positionOf(entryId) >= 0) {
        continue;
      }
      host.append(message, entryId ? { entryId } : undefined);
    }
  }

  /**
   * Record an accepted turn range the way the host transcript holds it: the
   * admission and terminal carry their entry ids, and when the admission is
   * already on the transcript only the messages beyond the stored part of the
   * range are appended.
   */
  recordTurn(
    admission: { sessionId: string; sessionKey: string; entryId: string },
    terminal: { entryId: string },
    messages: readonly AgentMessage[],
  ): void {
    const host = this.host(admission.sessionId, admission.sessionKey);
    const admissionPosition = host.positionOf(admission.entryId);
    const present = admissionPosition < 0 ? 0 : host.visibleMessages().length - admissionPosition;
    for (let index = present; index < messages.length; index += 1) {
      const entryId =
        index === 0
          ? admission.entryId
          : index === messages.length - 1
            ? terminal.entryId
            : `${admission.entryId}:${index}`;
      if (host.positionOf(entryId) < 0) {
        host.append(messages[index]!, { entryId });
      }
    }
  }

  /** Transcript readers routed to the per-session fake transcripts. */
  deps(): Pick<
    LcmDependencies,
    | "readVisibleSessionTranscriptMessageEntries"
    | "readSessionTranscriptVisibleMessageDelta"
    | "readSessionTranscriptRawDelta"
  > {
    return {
      readVisibleSessionTranscriptMessageEntries: (target) =>
        this.host(target.sessionId, target.sessionKey).readVisibleEntries(),
      readSessionTranscriptVisibleMessageDelta: (params) =>
        this.host(params.sessionId, params.sessionKey).readVisibleDelta(params),
      readSessionTranscriptRawDelta: (params) =>
        this.host(params.sessionId, params.sessionKey).readRawDelta(params),
    };
  }
}

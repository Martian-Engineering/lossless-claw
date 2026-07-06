// Reconcile ingest replay-twin detection (Fix B). OpenClaw retry/failover storms
// re-append the same logical inbound event under a FRESH transcript entry id but
// with the same FROZEN inner source timestamp (message.timestamp), spread across
// separate reconcile passes. The entry-id idempotency check cannot see a fresh
// id, so each copy was imported as a new row. A candidate with a proven-absent id
// is now skipped when the same parsed transcript tail already contains a
// persisted entry that shares its role, canonical content, and full-precision
// inner timestamp. Genuine repeats are distinct source events with distinct inner
// timestamps, so they are never twins; a missing inner timestamp fails open.
import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { readLeafPathMessages } from "../src/transcript.js";
import { cleanupEngineTestState, createEngine, createSessionFilePath } from "./helpers.js";

afterEach(cleanupEngineTestState);

const FROZEN_MS = 1_700_000_000_200;

function headerLine(id: string): string {
  return JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  });
}

function entryLine(params: {
  id: string;
  parentId: string | null;
  role: AgentMessage["role"];
  text: string;
  innerMs?: number;
}): string {
  const message: Record<string, unknown> = {
    role: params.role,
    content: [{ type: "text", text: params.text }],
  };
  if (params.innerMs !== undefined) {
    // The frozen inner source-event timestamp, distinct from the per-append
    // envelope timestamp below.
    message.timestamp = params.innerMs;
  }
  return JSON.stringify({
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: new Date().toISOString(),
    message,
  });
}

function writeTranscript(sessionFile: string, header: string, entries: string[]): void {
  writeFileSync(sessionFile, [header, ...entries].join("\n") + "\n", "utf8");
}

async function userContents(engine: ReturnType<typeof createEngine>, sessionId: string): Promise<string[]> {
  const conversation = await engine
    .getConversationStore()
    .getConversationForSession({ sessionId });
  const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
  return messages.map((message) => message.content);
}

describe("reconcile ingest replay-twin detection (inner source timestamp)", () => {
  it("skips a re-appended twin: fresh id, identical role/content/inner-ms, original already persisted", async () => {
    const sessionFile = createSessionFilePath("replay-twin-skip");
    const header = headerLine("replay-twin-skip-header");
    const feathers = "a kilogram of feathers";
    writeTranscript(sessionFile, header, [
      entryLine({ id: "e1", parentId: null, role: "user", text: feathers, innerMs: FROZEN_MS }),
    ]);

    const engine = createEngine();
    const sessionId = "replay-twin-skip";
    await engine.bootstrap({ sessionId, sessionFile });

    // Append an unrelated turn, then a retry re-append of the first turn under a
    // FRESH id carrying the SAME frozen inner timestamp.
    writeTranscript(sessionFile, header, [
      entryLine({ id: "e1", parentId: null, role: "user", text: feathers, innerMs: FROZEN_MS }),
      entryLine({
        id: "e-mid",
        parentId: "e1",
        role: "assistant",
        text: "they weigh the same",
        innerMs: FROZEN_MS + 5_000,
      }),
      entryLine({ id: "e2", parentId: "e-mid", role: "user", text: feathers, innerMs: FROZEN_MS }),
    ]);
    await engine.afterTurn({ sessionId, sessionFile, messages: [], prePromptMessageCount: 0 });

    expect(await userContents(engine, sessionId)).toEqual([feathers, "they weigh the same"]);
  });

  it("keeps a genuine repeat carrying a DISTINCT inner timestamp", async () => {
    const sessionFile = createSessionFilePath("replay-twin-distinct-ts");
    const header = headerLine("replay-twin-distinct-ts-header");
    const feathers = "a kilogram of feathers";
    writeTranscript(sessionFile, header, [
      entryLine({ id: "e1", parentId: null, role: "user", text: feathers, innerMs: FROZEN_MS }),
    ]);

    const engine = createEngine();
    const sessionId = "replay-twin-distinct-ts";
    await engine.bootstrap({ sessionId, sessionFile });

    writeTranscript(sessionFile, header, [
      entryLine({ id: "e1", parentId: null, role: "user", text: feathers, innerMs: FROZEN_MS }),
      entryLine({
        id: "e-mid",
        parentId: "e1",
        role: "assistant",
        text: "they weigh the same",
        innerMs: FROZEN_MS + 5_000,
      }),
      // A genuinely repeated question is a distinct source event: distinct inner ms.
      entryLine({ id: "e2", parentId: "e-mid", role: "user", text: feathers, innerMs: FROZEN_MS + 1 }),
    ]);
    await engine.afterTurn({ sessionId, sessionFile, messages: [], prePromptMessageCount: 0 });

    expect(await userContents(engine, sessionId)).toEqual([feathers, "they weigh the same", feathers]);
  });

  it("imports a candidate with NO inner timestamp (fail-open)", async () => {
    const sessionFile = createSessionFilePath("replay-twin-no-inner-ts");
    const header = headerLine("replay-twin-no-inner-ts-header");
    const feathers = "a kilogram of feathers";
    writeTranscript(sessionFile, header, [
      entryLine({ id: "e1", parentId: null, role: "user", text: feathers, innerMs: FROZEN_MS }),
    ]);

    const engine = createEngine();
    const sessionId = "replay-twin-no-inner-ts";
    await engine.bootstrap({ sessionId, sessionFile });

    writeTranscript(sessionFile, header, [
      entryLine({ id: "e1", parentId: null, role: "user", text: feathers, innerMs: FROZEN_MS }),
      entryLine({
        id: "e-mid",
        parentId: "e1",
        role: "assistant",
        text: "they weigh the same",
        innerMs: FROZEN_MS + 5_000,
      }),
      // No inner timestamp on the candidate: the guard cannot prove a replay, so
      // it fails open and imports.
      entryLine({ id: "e2", parentId: "e-mid", role: "user", text: feathers }),
    ]);
    await engine.afterTurn({ sessionId, sessionFile, messages: [], prePromptMessageCount: 0 });

    expect(await userContents(engine, sessionId)).toEqual([feathers, "they weigh the same", feathers]);
  });

  it("continues past capped replay-twin prefixes to import real backlog entries", async () => {
    const sessionFile = createSessionFilePath("replay-twin-capped-prefix");
    const header = headerLine("replay-twin-capped-prefix-header");
    const feathers = "a kilogram of feathers";
    writeTranscript(sessionFile, header, [
      entryLine({ id: "e1", parentId: null, role: "user", text: feathers, innerMs: FROZEN_MS }),
    ]);

    const engine = createEngine();
    const sessionId = "replay-twin-capped-prefix";
    await engine.bootstrap({ sessionId, sessionFile });

    const replayTwins = Array.from({ length: 55 }, (_, index) =>
      entryLine({
        id: `e-twin-${index}`,
        parentId: index === 0 ? "e1" : `e-twin-${index - 1}`,
        role: "user",
        text: feathers,
        innerMs: FROZEN_MS,
      }),
    );
    writeTranscript(sessionFile, header, [
      entryLine({ id: "e1", parentId: null, role: "user", text: feathers, innerMs: FROZEN_MS }),
      ...replayTwins,
      entryLine({
        id: "e-real",
        parentId: "e-twin-54",
        role: "assistant",
        text: "the scale agrees",
        innerMs: FROZEN_MS + 1_000,
      }),
    ]);

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const reconcile = await engine.getTranscriptReconciler().reconcileSessionTail({
      sessionId,
      conversationId: conversation!.conversationId,
      historicalMessages: await readLeafPathMessages(sessionFile),
      lastProcessedEntryId: "e1",
    });

    expect(reconcile).toMatchObject({ blockedByImportCap: false, importedMessages: 1 });
    expect(await userContents(engine, sessionId)).toEqual([feathers, "the scale agrees"]);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";
import type { VisibleSessionTranscriptMessageEntry } from "../src/types.js";
import {
  cleanupEngineTestState,
  createEngineWithDepsOverridesAndDb,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

function entry(
  index: number,
  message: AgentMessage
): VisibleSessionTranscriptMessageEntry {
  return {
    entryId: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    seq: index + 1,
    role: message.role,
    message,
    createdAt: new Date(Date.UTC(2026, 8, 1, 12, 0, index)).toISOString(),
  };
}

async function createProjection(
  entries: VisibleSessionTranscriptMessageEntry[],
  anchoredIndexes: number[],
  liveMessages: AgentMessage[],
  suspectIndexes: number[]
) {
  const sessionId = "suspect-anchor-projection";
  const sessionKey = "agent:main:suspect-anchor-projection";
  const { engine, db } = createEngineWithDepsOverridesAndDb({
    readVisibleSessionTranscriptMessageEntries: vi.fn(async () => entries),
  });
  await engine.ingestBatch({
    sessionId,
    sessionKey,
    messages: [
      ...anchoredIndexes.map((index) => {
        const projected = entries[index]!;
        return attachTranscriptEntryMeta(
          { ...projected.message },
          {
            entryId: projected.entryId,
            parentId: projected.parentId ?? null,
            timestamp: projected.createdAt ?? null,
          }
        );
      }),
      ...liveMessages,
    ],
  });
  const conversation = await engine
    .getConversationStore()
    .getConversationForSession({
      sessionId,
      sessionKey,
    });
  const conversationId = conversation!.conversationId;
  for (const index of suspectIndexes) {
    const anchor = await engine
      .getConversationStore()
      .getTranscriptEntryAnchorCandidate(
        conversationId,
        entries[index]!.entryId
      );
    await engine.getConversationStore().upsertMessageTranscriptAnchorTrust({
      conversationId,
      messageId: anchor!.messageId,
      transcriptEntryId: entries[index]!.entryId,
      trustState: "suspect",
      source: "projection-audit",
      reason: "entry id lacks explicit trust",
    });
  }
  const rows = () =>
    db
      .prepare(
        "SELECT message_id, content, transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq"
      )
      .all(conversationId);
  const bootstrap = () =>
    engine.bootstrap({
      sessionId,
      sessionKey,
      runtimeContext: {
        transcriptStorage: { kind: "sqlite" },
        sessionTarget: {
          agentId: "main",
          sessionId,
          sessionKey,
          storePath: "/tmp/agent.sqlite",
        },
      },
    });
  return { engine, db, conversationId, rows, bootstrap };
}

describe("SQLite projection adoption after suspect anchors", () => {
  const old = entry(0, { role: "user", content: "Earlier context" });
  const trusted = entry(1, {
    role: "assistant",
    content: "Verified later response",
  });

  it("adopts the live tail after a later verified anchor and keeps replay idempotent", async () => {
    const tail = [
      entry(2, { role: "user", content: "Continue the investigation" }),
      entry(3, { role: "assistant", content: "The report is ready" }),
    ];
    const fixture = await createProjection(
      [old, trusted, ...tail],
      [0, 1],
      tail.map((item) => item.message),
      [0]
    );
    const before = fixture.rows();

    await expect(fixture.bootstrap()).resolves.toMatchObject({
      importedMessages: 0,
    });
    expect(fixture.rows()).toEqual(
      before.map((row, index) => ({
        ...row,
        transcript_entry_id: `entry-${index}`,
      }))
    );
    await expect(fixture.bootstrap()).resolves.toMatchObject({
      importedMessages: 0,
    });
    expect(fixture.rows()).toHaveLength(4);
    expect(
      await fixture.engine
        .getConversationStore()
        .isTrustedTranscriptAnchor(fixture.conversationId, old.entryId)
    ).toBe(false);
    expect(
      await fixture.engine
        .getConversationStore()
        .isTrustedTranscriptAnchor(fixture.conversationId, tail[0]!.entryId)
    ).toBe(true);
  });

  it.each([
    {
      name: "no later verified anchor",
      anchors: [old],
      suspect: [0],
      imported: 1,
    },
    {
      name: "a newer suspect anchor",
      anchors: [
        old,
        trusted,
        entry(2, { role: "user", content: "Unproven again" }),
      ],
      suspect: [0, 2],
      imported: 1,
    },
    {
      name: "verified continuity after both suspect anchors",
      anchors: [
        old,
        trusted,
        entry(2, { role: "user", content: "Unproven again" }),
        entry(3, { role: "assistant", content: "Verified again" }),
      ],
      suspect: [0, 2],
      imported: 0,
    },
  ])("respects $name", async ({ anchors, suspect, imported }) => {
    const tail = entry(anchors.length, {
      role: "user",
      content: "Live tail message",
    });
    const fixture = await createProjection(
      [...anchors, tail],
      anchors.map((_, index) => index),
      [tail.message],
      suspect
    );
    const before = fixture.rows();
    await expect(fixture.bootstrap()).resolves.toMatchObject({
      importedMessages: imported,
    });
    expect(fixture.rows()).toHaveLength(before.length + imported);
    expect(
      fixture
        .rows()
        .map((row) => row.message_id)
        .slice(0, before.length)
    ).toEqual(before.map((row) => row.message_id));
  });

  it("retains a missing projection entry before an adoptable live row", async () => {
    const missing = entry(2, {
      role: "user",
      content: "Do not lose this correction",
    });
    const tail = entry(3, {
      role: "assistant",
      content: "Already ingested response",
    });
    const fixture = await createProjection(
      [old, trusted, missing, tail],
      [0, 1],
      [tail.message],
      [0]
    );
    await expect(fixture.bootstrap()).resolves.toMatchObject({
      importedMessages: 2,
    });
    expect(fixture.rows().map((row) => row.content)).toContain(
      missing.message.content
    );
    const rows = fixture.rows();
    await fixture.bootstrap();
    expect(fixture.rows()).toEqual(rows);
  });

  it("does not collapse ambiguous repeated live messages", async () => {
    const tail = [
      entry(2, { role: "user", content: "ok" }),
      entry(3, { role: "user", content: "ok" }),
    ];
    const fixture = await createProjection(
      [old, trusted, ...tail],
      [0, 1],
      tail.map((item) => item.message),
      [0]
    );
    const before = fixture.rows();
    await expect(fixture.bootstrap()).resolves.toMatchObject({
      importedMessages: 2,
    });
    expect(fixture.rows().slice(0, before.length)).toEqual(before);
    expect(fixture.rows()).toHaveLength(6);
  });

  it.each([false, true])(
    "checks structured tool output before adoption (changed=%s)",
    async (changed) => {
      const live: AgentMessage = {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        content: [{ type: "text", text: "original output" }],
      };
      const projected = entry(
        2,
        changed
          ? {
              ...live,
              content: [{ type: "text", text: "different output" }],
            }
          : live
      );
      const fixture = await createProjection(
        [old, trusted, projected],
        [0, 1],
        [live],
        [0]
      );
      const before = fixture.rows();
      await expect(fixture.bootstrap()).resolves.toMatchObject({
        importedMessages: changed ? 1 : 0,
      });
      expect(fixture.rows()[2]!.message_id).toBe(before[2]!.message_id);
      expect(fixture.rows()[2]!.content).toBe("original output");
      expect(fixture.rows()).toHaveLength(changed ? 4 : 3);
      if (changed) {
        expect(fixture.rows()[3]!.content).toBe("different output");
      }
    }
  );
});

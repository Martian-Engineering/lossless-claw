import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runLcmMigrations } from "../src/db/migration.js";
import { ContextAssembler } from "../src/assembler.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const BLOB_MIGRATE_SCRIPT = fileURLToPath(
  new URL("../scripts/lcm-blob-migrate.mjs", import.meta.url),
);

/**
 * v4.2 §B (Option C) — stub-tier stratification end-to-end behavior tests.
 *
 * Option C reuses the v4.1 `large_files` storage model:
 *  - `messages.large_content` stores the externalized `file_xxx` id
 *    (NOT a content copy)
 *  - On-disk file under `<storage-dir>/<file_id>.txt` holds the bytes
 *  - `large_files` row has byte_size, file_name, mime_type, storage_uri
 *  - Assembler emits the v4.1 `[LCM Tool Output: file_xxx | tool=… | N bytes]`
 *    reference for evictable items; agent drills down via
 *    `lcm_describe(id="file_xxx")` (existing v4.1 path, unchanged).
 *
 * Contracts proved here:
 *
 *  1. With `stubLargeToolPayloads=false`, behavior is identical to v4.1.
 *  2. With `stubLargeToolPayloads=true`, evictable tool-result rows
 *     whose `large_content` resolves to a `large_files` row get
 *     substituted with the v4.1 `[LCM Tool Output: …]` reference.
 *  3. Fresh-tail tool messages are NEVER stubbed regardless of flag.
 *  4. Tool messages without an associated file are NEVER stubbed (legacy
 *     rows untouched).
 *  5. tool_use ↔ tool_result pairing is preserved — `toolCallId` survives.
 *  6. `lcm_describe(id="file_xxx")` returns the original payload —
 *     end-to-end drilldown works (closes the gap that the messageId-based
 *     stub format had: it pointed at a non-existent tool path).
 */

interface SeedToolMsg {
  toolCallId: string;
  toolName: string;
  payload: string;
  /** When true, externalize the payload to large_files and store fileId in large_content. */
  externalize?: boolean;
}

function seedConversation(
  db: DatabaseSync,
  storageDir: string,
  toolMessages: SeedToolMsg[],
): { conversationId: number; fileIds: Map<string, string> } {
  const convRow = db
    .prepare(
      `INSERT INTO conversations (session_id, session_key, active) VALUES (?, ?, 1) RETURNING conversation_id`,
    )
    .get("test-session", "agent:main:main") as { conversation_id: number };
  const conversationId = convRow.conversation_id;
  const fileIds = new Map<string, string>();

  let seq = 1;
  // Initial user prompt — keeps the convo non-empty.
  db.prepare(
    `INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, 'user', ?, ?)`,
  ).run(conversationId, seq++, "kick off the work", 4);
  db.prepare(
    `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', last_insert_rowid())`,
  ).run(conversationId, seq);

  for (const tm of toolMessages) {
    // assistant tool_use
    const assistantContent = JSON.stringify([
      { type: "tool_use", id: tm.toolCallId, name: tm.toolName, input: { q: "x" } },
    ]);
    const aRes = db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, 'assistant', ?, ?) RETURNING message_id`,
      )
      .get(conversationId, seq++, assistantContent, 6) as { message_id: number };
    db.prepare(
      `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_input)
       VALUES (?, ?, ?, 'tool', 0, ?, ?, ?)`,
    ).run(
      `p-${aRes.message_id}-tu`,
      aRes.message_id,
      "test-session",
      tm.toolCallId,
      tm.toolName,
      JSON.stringify({ q: "x" }),
    );
    db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)`,
    ).run(conversationId, seq, aRes.message_id);

    // tool result row.
    const tokenCount = Math.max(1, Math.ceil(tm.payload.length / 4));
    let largeContentValue: string | null = null;
    if (tm.externalize) {
      // Mirror the lcm-blob-migrate.mjs migration: write file to disk,
      // insert large_files row, store the fileId in messages.large_content.
      const fileId = `file_test_${tm.toolCallId.replace(/[^a-zA-Z0-9]/g, "")}`;
      const storageUri = join(storageDir, `${fileId}.txt`);
      writeFileSync(storageUri, tm.payload);
      db.prepare(
        `INSERT INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      ).run(
        fileId,
        conversationId,
        `tool-output-${tm.toolCallId}.txt`,
        "text/plain",
        tm.payload.length,
        storageUri,
      );
      largeContentValue = fileId;
      fileIds.set(tm.toolCallId, fileId);
    }
    const tRes = db
      .prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count, large_content)
         VALUES (?, ?, 'tool', ?, ?, ?) RETURNING message_id`,
      )
      .get(
        conversationId,
        seq++,
        tm.payload,
        tokenCount,
        largeContentValue,
      ) as { message_id: number };
    db.prepare(
      `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_call_id, tool_name, tool_output, metadata)
       VALUES (?, ?, ?, 'tool', 0, ?, ?, ?, ?)`,
    ).run(
      `p-${tRes.message_id}-tr`,
      tRes.message_id,
      "test-session",
      tm.toolCallId,
      tm.toolName,
      tm.payload,
      JSON.stringify({ originalRole: "toolResult", rawType: "tool_result" }),
    );
    db.prepare(
      `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', ?)`,
    ).run(conversationId, seq, tRes.message_id);
  }
  return { conversationId, fileIds };
}

function bigPayload(prefix: string, kb: number): string {
  return `${prefix}\n` + "x".repeat(kb * 1024);
}

function setupDb(): { db: DatabaseSync; storageDir: string } {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  const storageDir = mkdtempSync(join(tmpdir(), "v42-stub-storage-"));
  return { db, storageDir };
}

function setupScriptDb(): { db: DatabaseSync; dbPath: string; storageDir: string; stateDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "v42-script-state-"));
  const storageDir = join(stateDir, "lcm-files");
  mkdirSync(storageDir, { recursive: true });
  const dbPath = join(stateDir, "lcm.db");
  const db = new DatabaseSync(dbPath);
  runLcmMigrations(db, { fts5Available: false });
  return { db, dbPath, storageDir, stateDir };
}

describe("v4.2 §B (Option C) stub-tier stratification", () => {
  it("emits stubs only for evictable externalized tool messages", async () => {
    const { db, storageDir } = setupDb();

    seedConversation(db, storageDir, [
      { toolCallId: "call-1", toolName: "Read", payload: bigPayload("R1", 16), externalize: true },
      { toolCallId: "call-2", toolName: "Read", payload: "small ack", externalize: false },
      { toolCallId: "call-3", toolName: "Bash", payload: bigPayload("B3", 32), externalize: true },
      { toolCallId: "call-4", toolName: "Edit", payload: "ok", externalize: false },
      { toolCallId: "call-5", toolName: "Grep", payload: bigPayload("G5", 8), externalize: true },
      // Final entry — will land in the fresh tail (freshTailCount=2 below).
      { toolCallId: "call-6", toolName: "Read", payload: bigPayload("R6", 24), externalize: true },
    ]);

    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC");

    const baseline = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 200_000,
      freshTailCount: 2,
      stubLargeToolPayloads: false,
    });
    const stubbed = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 200_000,
      freshTailCount: 2,
      stubLargeToolPayloads: true,
    });

    expect(baseline.debug?.stubStats?.stubbedCount ?? 0).toBe(0);

    // 3 evictable externalized tool messages should be stubbed
    // (the 4th externalized message is in the fresh tail). Small results
    // are ineligible (no fileId).
    const stats = stubbed.debug?.stubStats;
    expect(stats).toBeDefined();
    expect(stats!.stubbedCount).toBe(3);
    expect(stats!.tokensSaved).toBeGreaterThan(0);
    expect(stubbed.estimatedTokens).toBeLessThan(baseline.estimatedTokens);

    // Stubs use the v4.1 `[LCM Tool Output: …]` reference format.
    const stubTexts = stubbed.messages
      .map((m) => {
        const c = (m as { content?: unknown }).content;
        return typeof c === "string" ? c : Array.isArray(c) ? JSON.stringify(c) : "";
      })
      .filter((t) => t.includes("[LCM Tool Output:"));
    expect(stubTexts.length).toBeGreaterThan(0);
    // Each stub references a file_xxx id and includes the v4.2 hint
    // pointing at lcm_describe with expandFile=true (the path that
    // actually returns content from disk).
    for (const t of stubTexts) {
      expect(t).toMatch(/\[LCM Tool Output: file_/);
      expect(t).toContain("Call lcm_describe");
      expect(t).toContain("expandFile=true");
    }
  });

  it("preserves tool_use ↔ tool_result pairing when stubbing", async () => {
    const { db, storageDir } = setupDb();
    seedConversation(db, storageDir, [
      { toolCallId: "id-A", toolName: "Read", payload: bigPayload("A", 12), externalize: true },
      { toolCallId: "id-B", toolName: "Read", payload: bigPayload("B", 12), externalize: true },
      // Fresh tail — never stubbed.
      { toolCallId: "id-C", toolName: "Read", payload: bigPayload("C", 12), externalize: true },
    ]);

    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC");

    const out = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 200_000,
      freshTailCount: 2,
      stubLargeToolPayloads: true,
    });

    const toolUses = new Set<string>();
    const toolResults = new Set<string>();
    for (const msg of out.messages) {
      if ((msg as { role?: string }).role === "assistant") {
        const content = (msg as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const rec = block as { type?: string; id?: string };
            if (rec?.type === "tool_use" && rec.id) toolUses.add(rec.id);
          }
        }
      }
      if ((msg as { role?: string }).role === "toolResult") {
        const id = (msg as { toolCallId?: string }).toolCallId;
        if (id) toolResults.add(id);
      }
    }
    for (const id of toolUses) {
      expect(toolResults.has(id)).toBe(true);
    }
  });

  it("never stubs tool messages without externalized files (legacy rows)", async () => {
    const { db, storageDir } = setupDb();
    seedConversation(db, storageDir, [
      { toolCallId: "x", toolName: "Bash", payload: bigPayload("X", 8), externalize: false },
      { toolCallId: "y", toolName: "Bash", payload: bigPayload("Y", 8), externalize: false },
      { toolCallId: "z", toolName: "Bash", payload: bigPayload("Z", 8), externalize: false },
    ]);

    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC");

    const out = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 200_000,
      freshTailCount: 1,
      stubLargeToolPayloads: true,
    });
    expect(out.debug?.stubStats?.stubbedCount ?? 0).toBe(0);
    expect(out.debug?.stubStats?.tokensSaved ?? 0).toBe(0);
  });

  it("preserves multi-block tool_result content shape (text + image)", async () => {
    // P1 fix verification (Wave 1 Agent 4 found this test was fake):
    // when the source tool_result was a multi-block array (e.g. text +
    // image), the stub must also be array-shaped so downstream provider
    // serialization doesn't change shape mid-stream. Previous test
    // version only seeded single-text-block content and asserted the
    // stub was array-shaped — but a regression that collapsed
    // multi-block to string would still pass.
    //
    // This rewrite directly seeds a multi-block tool_result by inserting
    // TWO message_parts (text + image) for the same tool message, so
    // the assembler reconstructs an array content. Then verifies the
    // post-stub content is still a 1-element text-block array.
    const { db, storageDir } = setupDb();

    // Set up conversation + assistant tool_use (using helper with one entry).
    seedConversation(db, storageDir, [
      { toolCallId: "mb-1", toolName: "Read", payload: bigPayload("MB", 16), externalize: true },
    ]);

    // The toolResult message (id=3 by seq) has a single 'tool' part
    // installed by seedConversation. Add a SECOND part to make it
    // multi-block: text part + image-like text part with structured
    // raw metadata that maps to an array shape after contentFromParts.
    const secondPartMetadata = JSON.stringify({
      originalRole: "toolResult",
      raw: { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KG..." } },
    });
    db.prepare(
      `INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content, metadata)
       VALUES (?, ?, ?, 'text', 1, ?, ?)`,
    ).run(
      `p-mb-img`,
      3, // toolResult message id from helper (1=user prompt, 2=assistant, 3=toolResult)
      "test-session",
      "[image elided]",
      secondPartMetadata,
    );

    // Pad with follow-up small messages so the multi-block tool_result
    // is evictable, not in the fresh tail. Append directly (don't call
    // seedConversation, which would try to create a duplicate conv).
    for (let pad = 0; pad < 3; pad++) {
      const seq = 5 + pad;
      db.prepare(
        `INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (?, ?, 'user', 'follow up', 1)`,
      ).run(1, seq);
      db.prepare(
        `INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (?, ?, 'message', last_insert_rowid())`,
      ).run(1, seq + 1);
    }

    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC");

    const out = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 200_000,
      freshTailCount: 1,
      stubLargeToolPayloads: true,
    });

    // Find the stubbed toolResult and verify content is array-shaped.
    const stubbedToolResult = out.messages.find(
      (m) => (m as { role?: string }).role === "toolResult"
        && Array.isArray((m as { content?: unknown }).content)
        && JSON.stringify((m as { content?: unknown }).content).includes("[LCM Tool Output:"),
    );
    expect(stubbedToolResult).toBeDefined();
    const content = (stubbedToolResult as { content: unknown[] }).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBe(1);
    expect((content[0] as { type: string }).type).toBe("text");
    expect((content[0] as { text: string }).text).toContain("[LCM Tool Output:");
  });
});

/**
 * End-to-end drilldown test — closes the gap the adversarial review caught:
 * the original `messageId`-based stub format pointed at a tool path that
 * doesn't exist. With Option C, the stub points at the v4.1 `file_xxx`
 * channel, and `lcm_describe(id="file_xxx")` resolves to the on-disk file.
 *
 * This test stands up the assembler, captures the emitted stub's fileId,
 * looks up the `large_files` row, reads the storage URI from disk, and
 * asserts the bytes match the original tool-result payload.
 */
import { readFileSync } from "node:fs";
describe("v4.2 §B (Option C) drilldown round-trip", () => {
  it("agent can recover the full payload via the file_xxx referenced in the stub", async () => {
    const { db, storageDir } = setupDb();
    const originalPayload = bigPayload("END-TO-END", 20);
    const { fileIds } = seedConversation(db, storageDir, [
      { toolCallId: "drill-1", toolName: "Read", payload: originalPayload, externalize: true },
      // Push the externalized result outside the fresh tail so it gets stubbed.
      { toolCallId: "filler-1", toolName: "Read", payload: "ok", externalize: false },
      { toolCallId: "filler-2", toolName: "Read", payload: "ok", externalize: false },
      { toolCallId: "filler-3", toolName: "Read", payload: "ok", externalize: false },
    ]);

    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC");

    const out = await assembler.assemble({
      conversationId: 1,
      tokenBudget: 200_000,
      freshTailCount: 2,
      stubLargeToolPayloads: true,
    });

    // Find the stub for drill-1 in the assembled output and extract the file_xxx id.
    const expectedFileId = fileIds.get("drill-1");
    expect(expectedFileId).toBeDefined();
    const stubText = out.messages
      .map((m) => {
        const c = (m as { content?: unknown }).content;
        if (typeof c === "string") return c;
        if (Array.isArray(c)) return JSON.stringify(c);
        return "";
      })
      .find((t) => t.includes(expectedFileId!));
    expect(stubText).toBeDefined();
    expect(stubText).toContain("[LCM Tool Output:");
    expect(stubText).toContain("Call lcm_describe");
    expect(stubText).toContain("expandFile=true");

    // Drilldown: actually go through the retrieval.describe API path with
    // expandFile=true. This is the same path lcm_describe tool uses, so
    // a regression in either retrieval.ts or describeFile would surface
    // here. The previous test variant bypassed this by calling
    // readFileSync directly on storage_uri; that hid the P0-B gap that
    // describeFile didn't read content at all.
    const { RetrievalEngine } = await import("../src/retrieval.js");
    const retrieval = new RetrievalEngine(conversationStore, summaryStore);
    const described = await retrieval.describe(expectedFileId!, {
      expandFile: true,
      largeFilesDir: storageDir,
    });
    expect(described).not.toBeNull();
    expect(described!.type).toBe("file");
    expect(described!.file).toBeDefined();
    expect(described!.file!.byteSize).toBe(originalPayload.length);
    expect(described!.file!.content).toBe(originalPayload);
    expect(described!.file!.contentTruncated).toBe(false);

    // Belt-and-suspenders: storage on disk also matches.
    const fileRow = await summaryStore.getLargeFile(expectedFileId!);
    expect(fileRow).not.toBeNull();
    const onDisk = readFileSync(fileRow!.storageUri, "utf8");
    expect(onDisk).toBe(originalPayload);
  });

  it("recovers migrated payloads from the message row when the disk file is unavailable", async () => {
    const { db, storageDir } = setupDb();
    const originalPayload = bigPayload("FALLBACK", 12);
    const { fileIds } = seedConversation(db, storageDir, [
      { toolCallId: "fallback-1", toolName: "Read", payload: originalPayload, externalize: true },
      { toolCallId: "filler-1", toolName: "Read", payload: "ok", externalize: false },
      { toolCallId: "filler-2", toolName: "Read", payload: "ok", externalize: false },
    ]);

    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const retrieval = new (await import("../src/retrieval.js")).RetrievalEngine(
      conversationStore,
      summaryStore,
    );
    const fileId = fileIds.get("fallback-1");
    expect(fileId).toBeDefined();

    const fileRow = await summaryStore.getLargeFile(fileId!);
    expect(fileRow).not.toBeNull();
    unlinkSync(fileRow!.storageUri);

    const described = await retrieval.describe(fileId!, {
      expandFile: true,
      largeFilesDir: storageDir,
    });
    expect(described).not.toBeNull();
    expect(described!.type).toBe("file");
    expect(described!.file!.content).toBe(originalPayload);
    expect(described!.file!.contentTruncated).toBe(false);
  });
});

describe("v4.2 §B blob-migrate script", () => {
  it("uses the runtime large-files root derived from OPENCLAW_STATE_DIR", () => {
    const { db, dbPath, stateDir } = setupScriptDb();
    db.close();

    const raw = execFileSync(
      process.execPath,
      [BLOB_MIGRATE_SCRIPT, "--db", dbPath, "--dry-run"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          LCM_LARGE_FILES_DIR: "",
        },
      },
    );
    const summary = JSON.parse(raw) as { storageDir: string };
    expect(summary.storageDir).toBe(join(stateDir, "lcm-files"));
  });

  it("honors --revert --dry-run instead of exiting through the forward dry-run path", () => {
    const { db, dbPath, storageDir } = setupScriptDb();
    seedConversation(db, storageDir, [
      { toolCallId: "revert-1", toolName: "Read", payload: bigPayload("REVERT", 4), externalize: true },
    ]);
    db.close();

    const raw = execFileSync(
      process.execPath,
      [BLOB_MIGRATE_SCRIPT, "--db", dbPath, "--revert", "--dry-run", "--storage-dir", storageDir],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env,
      },
    );
    const summary = JSON.parse(raw) as {
      mode?: string;
      candidateCount?: number;
      rowsCleared?: number;
      filesDeleted?: number;
    };
    expect(summary.mode).toBe("revert");
    expect(summary.candidateCount).toBe(1);
    expect(summary.rowsCleared).toBe(0);
    expect(summary.filesDeleted).toBe(0);
  });
});

// Engine ingest: content extraction, message-part storage, large-payload and image externalization at ingest time.
// Split from the former monolithic test/engine.test.ts; shared fixtures live in test/helpers.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ContextAssembler } from "../src/assembler.js";
import { LcmContextEngine } from "../src/engine.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { RetrievalEngine } from "../src/retrieval.js";
import {
  cleanupEngineTestState,
  appendSessionMessage,
  createEngine,
  createSessionFilePath,
  createEngineWithConfig,
  withTempHome,
  makeMessage,
  ingestAndReadStoredContent,
  tempDirs,
} from "./helpers.js";

afterEach(cleanupEngineTestState);
describe("LcmContextEngine.ingest content extraction", () => {
  it("stores string content as-is", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ role: "user", content: "hello world" }),
    });

    expect(content).toBe("hello world");
  });

  it("flattens text content block arrays to plain text", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({
        content: [{ type: "text", text: "hello" }],
      }),
    });

    expect(content).toBe("hello");
  });

  it("extracts only text blocks from mixed content arrays", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({
        content: [
          { type: "text", text: "line one" },
          { type: "thinking", thinking: "internal chain of thought" },
          { type: "tool_use", name: "bash" },
          { type: "text", text: "line two" },
        ],
      }),
    });

    expect(content).toBe("line one\nline two");
  });

  it("stores empty string for empty content arrays", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ content: [] }),
    });

    expect(content).toBe("");
  });

  it("falls back to JSON.stringify for non-array, non-string content", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ content: { status: "ok", count: 2 } }),
    });

    expect(content).toBe('{"status":"ok","count":2}');
  });

  it("roundtrip stores plain text, not JSON content blocks", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      }),
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].content).toBe("HEARTBEAT_OK");
    expect(storedMessages[0].content).not.toContain('{"type":"text"');
  });

  it("intercepts oversized <file> blocks and persists large file metadata", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const fileText = `${"line about architecture\n".repeat(160)}closing notes`;
      const messageContent = `<file name="lcm-paper.md" mime="text/markdown">${fileText}</file>`;

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: messageContent }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("[LCM File: file_");
      expect(messages[0].content).toContain("Exploration Summary:");
      expect(messages[0].content).not.toContain("<file name=");

      const fileIdMatch = messages[0].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];

      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("lcm-paper.md");
      expect(storedFile!.mimeType).toBe("text/markdown");
      expect(storedFile!.storageUri).toContain(
        `lcm-files/${conversation!.conversationId}/`,
      );
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(fileText);

      const parts = await engine.getConversationStore().getMessageParts(messages[0].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].textContent).toContain("[LCM File: file_");
      expect(parts[0].textContent).not.toContain("<file name=");
    });
  });

  it("keeps <file> blocks inline when below the large-file threshold", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 100_000 });
      const sessionId = randomUUID();
      const messageContent = '<file name="small.json" mime="application/json">{"ok":true}</file>';

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: messageContent }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe(messageContent);

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(0);
    });
  });

  it("externalizes oversized plain user text as a raw payload", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const rawText = `${"plain raw message line\n".repeat(160)}done`;

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: rawText }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("[LCM Raw Payload: file_");
      expect(messages[0].content).toContain("role=user");
      expect(messages[0].content).toContain("reason=large_raw_message");
      expect(messages[0].content).not.toContain(rawText.slice(0, 64));

      const fileIdMatch = messages[0].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];
      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("raw-user-payload.txt");
      expect(storedFile!.mimeType).toBe("text/plain");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(rawText);

      const parts = await engine.getConversationStore().getMessageParts(messages[0].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].textContent).toBe(messages[0].content);
      const metadata = JSON.parse(parts[0].metadata ?? "{}") as Record<string, unknown>;
      expect(metadata).toMatchObject({
        originalRole: "user",
        rawPayloadExternalized: true,
        externalizedFileId: fileId,
        originalByteSize: Buffer.byteLength(rawText, "utf8"),
        externalizationReason: "large_raw_message",
      });
    });
  });

  it("keeps plain user text inline when below the raw-payload threshold", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 100_000 });
      const sessionId = randomUUID();
      const rawText = "short raw message";

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: rawText }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe(rawText);

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(0);
    });
  });

  it("externalizes oversized non-file non-tool raw payloads", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const rawBlob = "RAW_VENDOR_PAYLOAD ".repeat(220);
      const rawPayload = [{ type: "vendor_payload", blob: rawBlob, status: "ok" }];

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "assistant", content: rawPayload }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("[LCM Raw Payload: file_");
      expect(messages[0].content).toContain("role=assistant");
      expect(messages[0].content).not.toContain(rawBlob.slice(0, 64));

      const fileIdMatch = messages[0].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("raw-assistant-payload.json");
      expect(storedFile!.mimeType).toBe("application/json");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(JSON.stringify(rawPayload));

      const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
      const assembled = await assembler.assemble({
        conversationId: conversation!.conversationId,
        tokenBudget: 10_000,
      });
      const assembledMessage = assembled.messages[0] as {
        role: string;
        content?: Array<{ type?: unknown; text?: unknown }>;
      };
      expect(assembledMessage.role).toBe("assistant");
      expect(assembledMessage.content?.[0]?.type).toBe("text");
      expect(String(assembledMessage.content?.[0]?.text)).toContain("[LCM Raw Payload:");
    });
  });

  it("does not externalize assistant tool or reasoning blocks generically", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const largeReasoning = "protected reasoning ".repeat(220);
      const largeInput = "protected tool input ".repeat(220);

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [
            { type: "reasoning", summary: [{ text: largeReasoning }] },
            {
              type: "toolCall",
              id: "call_protected",
              name: "exec",
              input: { cmd: largeInput },
            },
          ],
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).not.toContain("[LCM Raw Payload:");
      expect(messages[0].content).not.toContain("protected reasoning");

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(0);

      const parts = await engine.getConversationStore().getMessageParts(messages[0].messageId);
      expect(parts.map((part) => part.partType)).toEqual(["reasoning", "tool"]);
      expect(parts[1].toolCallId).toBe("call_protected");
      expect(parts[1].toolName).toBe("exec");
    });
  });

  it("stores externalized inline images under largeFilesDir", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    // Realistic threshold so the post-image-rewrite content (which is below
    // it) doesn't also trigger raw-payload externalization — this test only
    // verifies the image-externalizer path.
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBOR${"A".repeat(600)}`;

    await engine.ingest({
      sessionId,
      message: makeMessage({
        role: "user",
        content: `[media attached: screenshot.png]\n${base64Image}\n`,
      }),
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("[User image: screenshot.png");
    expect(messages[0].content).not.toContain(base64Image.slice(0, 32));

    const fileIdMatch = messages[0].content.match(/file_[a-f0-9]{16}/);
    expect(fileIdMatch).not.toBeNull();
    const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.mimeType).toBe("image/png");
    expect(storedFile!.storageUri).toContain(
      `${largeFilesDir}/${conversation!.conversationId}/`,
    );
  });

  it("externalizes native user image blocks before raw payload fallback", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    // Realistic threshold — the post-image-rewrite content is below it, so
    // only the native-image-block path runs (raw-payload would otherwise
    // also fire under the artificially-low 20-token threshold this test
    // used to set, which is the scenario the new mixed-content test in
    // this file deliberately exercises with a longer body).
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `/9j/${"A".repeat(600)}`;
    const userText =
      "[media attached: /Users/example/inbound/screenshot.jpg (image/jpeg)]\nplease inspect";

    await engine.ingest({
      sessionId,
      message: makeMessage({
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image", data: base64Image, mimeType: "image/jpeg" },
        ],
      }),
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("please inspect");
    expect(messages[0].content).toContain("[User image: screenshot.jpg");
    expect(messages[0].content).not.toContain("[LCM Raw Payload:");
    expect(messages[0].content).not.toContain(base64Image.slice(0, 32));

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);
    expect(largeFiles[0].fileName).toBe("screenshot.jpg");
    expect(largeFiles[0].mimeType).toBe("image/jpeg");
    expect(readFileSync(largeFiles[0].storageUri)).toEqual(Buffer.from(base64Image, "base64"));

    const parts = await engine.getConversationStore().getMessageParts(messages[0].messageId);
    expect(parts.map((part) => part.partType)).toEqual(["text", "text"]);
    expect(JSON.stringify(parts)).not.toContain(base64Image.slice(0, 32));

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });
    const assembledUser = assembled.messages[0] as {
      role: string;
      content?: Array<{ type?: unknown; text?: unknown }>;
    };
    expect(assembledUser.role).toBe("user");
    expect(assembledUser.content?.[0]?.text).toContain("please inspect");
    expect(assembledUser.content?.[1]?.text).toContain("[User image: screenshot.jpg");
    expect(JSON.stringify(assembled.messages)).not.toContain(base64Image.slice(0, 32));
  });

  it("externalizes native assistant image blocks before raw payload fallback", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    // Realistic threshold — see the user-image variant above for rationale.
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBORw0KGgo${"A".repeat(600)}`;

    await engine.ingest({
      sessionId,
      message: makeMessage({
        role: "assistant",
        content: [
          { type: "text", text: "Here is the rendered chart:" },
          { type: "image", data: base64Image, mimeType: "image/png" },
        ],
      }),
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("Here is the rendered chart");
    expect(messages[0].content).toContain("[Assistant image:");
    expect(messages[0].content).not.toContain("raw-assistant-payload");
    expect(messages[0].content).not.toContain("[LCM Raw Payload:");
    expect(messages[0].content).not.toContain(base64Image.slice(0, 32));

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);
    expect(largeFiles[0].mimeType).toBe("image/png");
    expect(largeFiles[0].fileName).toBe("assistant-image.png");
  });

  it("externalizes native tool-result image blocks instead of persisting them inline", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 20,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBORw0KGgo${"B".repeat(600)}`;

    // First the assistant tool call so the conversation has a corresponding tool message.
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_screenshot",
            name: "take_screenshot",
            input: {},
          },
        ],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_screenshot",
        toolName: "take_screenshot",
        content: [
          { type: "image", data: base64Image, mimeType: "image/png" },
        ],
      } as AgentMessage,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(2);
    const toolMessage = messages[1];
    expect(toolMessage.role).toBe("tool");
    // The important behavior: toolResult native image is replaced by an
    // externalized reference and the base64 payload never reaches the DB
    // row inline. Tool messages skip raw-payload externalization entirely
    // (see `interceptLargeRawPayload` early-return), so we don't assert on
    // a `raw-tool-payload.json` shape.
    expect(toolMessage.content).toContain("[Tool image:");
    expect(toolMessage.content).not.toContain(base64Image.slice(0, 32));

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);
    expect(largeFiles[0].mimeType).toBe("image/png");
    expect(largeFiles[0].fileName).toBe("tool-image.png");
  });

  it("externalizes native system image blocks instead of falling through to raw-system-payload", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBORw0KGgo${"S".repeat(600)}`;

    await engine.ingest({
      sessionId,
      message: {
        role: "system",
        content: [
          { type: "text", text: "Workspace bootstrap." },
          { type: "image", data: base64Image, mimeType: "image/png" },
        ],
      } as AgentMessage,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("Workspace bootstrap");
    expect(messages[0].content).toContain("[System image:");
    expect(messages[0].content).not.toContain("raw-system-payload");
    expect(messages[0].content).not.toContain(base64Image.slice(0, 32));

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);
    expect(largeFiles[0].fileName).toBe("system-image.png");
  });

  it("still externalizes large mixed-content messages that embed an image reference alongside oversized text", async () => {
    // Regression for the substring-skip bug in `interceptLargeRawPayload`:
    // a previous skip on `isExternalizedReferenceContent(stored.content)`
    // tripped on any content containing `LCM file: file_...`, so a message
    // with an image reference plus a large amount of other text was never
    // externalized as a raw payload. The skip is now gated on the explicit
    // `rawPayloadExternalized: true` flag set by the raw-payload pass itself.
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 20,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBORw0KGgo${"M".repeat(600)}`;
    // 4_000-word body so the assistant message blows past the threshold
    // even after the image is externalized to a short reference.
    const longBody = "lorem ipsum ".repeat(2_000);

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "Render the chart please." }),
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Here's the rendered chart:" },
          { type: "image", data: base64Image, mimeType: "image/png" },
          { type: "text", text: longBody },
        ],
      } as AgentMessage,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    // Two large_files rows: one for the image and one for the
    // raw-payload externalization that the substring-skip used to suppress.
    expect(largeFiles.length).toBeGreaterThanOrEqual(2);
    const mimeTypes = largeFiles.map((row) => row.mimeType);
    expect(mimeTypes).toContain("image/png");
    expect(mimeTypes.some((m) => m === "application/json" || m === "text/plain")).toBe(true);
  });

  it("infers extensions for heic, avif, and bmp native image blocks", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });

    const cases: Array<{ mimeType: string; extension: string }> = [
      { mimeType: "image/heic", extension: "heic" },
      { mimeType: "image/avif", extension: "avif" },
      { mimeType: "image/bmp", extension: "bmp" },
    ];

    for (const variant of cases) {
      const sessionId = randomUUID();
      // Use a base64 payload that will NOT match any magic-byte prefix so we
      // exercise the declared mimeType -> extension fallback.
      const base64Image = `ZZZZ${"C".repeat(600)}`;

      await engine.ingest({
        sessionId,
        message: makeMessage({
          role: "user",
          content: [
            { type: "text", text: "look at this" },
            { type: "image", data: base64Image, mimeType: variant.mimeType },
          ],
        }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(1);
      const largeFile = largeFiles[0]!;
      expect(largeFile.mimeType).toBe(variant.mimeType);
      expect(largeFile.storageUri.endsWith(`.${variant.extension}`)).toBe(true);
      expect(largeFile.fileName?.endsWith(`.${variant.extension}`)).toBe(true);
    }
  });

  it("externalizes oversized tool-result payloads into large_files", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const toolOutput = `${"tool output line\n".repeat(160)}done`;

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_externalized",
              name: "exec",
              input: { cmd: "pwd" },
            },
          ],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "toolResult",
          toolCallId: "call_externalized",
          toolName: "exec",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_externalized",
              name: "exec",
              content: [{ type: "text", text: toolOutput }],
            },
          ],
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(2);
      expect(storedMessages[1].content).toContain("[LCM Tool Output: file_");
      expect(storedMessages[1].content).toContain("tool=exec");
      expect(storedMessages[1].content).not.toContain(toolOutput.slice(0, 64));

      const fileIdMatch = storedMessages[1].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];

      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("exec.txt");
      expect(storedFile!.mimeType).toBe("text/plain");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(toolOutput);

      const parts = await engine.getConversationStore().getMessageParts(storedMessages[1].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].partType).toBe("tool");
      const metadata = JSON.parse(parts[0].metadata ?? "{}") as Record<string, unknown>;
      expect(metadata).toMatchObject({
        externalizedFileId: fileId,
        originalByteSize: Buffer.byteLength(toolOutput, "utf8"),
        toolOutputExternalized: true,
        externalizationReason: "large_tool_result",
      });

      const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
      const assembled = await assembler.assemble({
        conversationId: conversation!.conversationId,
        tokenBudget: 10_000,
      });
      expect(assembled.messages).toHaveLength(2);
      const assembledToolResult = assembled.messages[1] as {
        role: string;
        content?: Array<{ output?: unknown }>;
      };
      expect(assembledToolResult.role).toBe("toolResult");
      expect(typeof assembledToolResult.content?.[0]?.output).toBe("string");
      expect(String(assembledToolResult.content?.[0]?.output)).toContain(fileId);

      const retrieval = new RetrievalEngine(
        engine.getConversationStore(),
        engine.getSummaryStore(),
      );
      const described = await retrieval.describe(fileId);
      expect(described?.type).toBe("file");
      expect(described?.file?.storageUri).toBe(storedFile!.storageUri);

      const searchable = await engine.getConversationStore().searchMessages({
        conversationId: conversation!.conversationId,
        query: "exec",
        mode: "full_text",
      });
      expect(searchable).toHaveLength(1);

      const noisy = await engine.getConversationStore().searchMessages({
        conversationId: conversation!.conversationId,
        query: "lcm_describe",
        mode: "full_text",
      });
      expect(noisy).toHaveLength(0);
    });
  });

  it("greps externalized file contents via scope=files", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const uniqueMarker = `UNIQUE_MARKER_${randomUUID().slice(0, 8)}`;
      const toolOutput = `${"tool output line\n".repeat(80)}${uniqueMarker}\n${"more lines\n".repeat(80)}done`;

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_grep_file",
              name: "exec",
              input: { cmd: "cat large.log" },
            },
          ],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "toolResult",
          toolCallId: "call_grep_file",
          toolName: "exec",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_grep_file",
              name: "exec",
              content: [{ type: "text", text: toolOutput }],
            },
          ],
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(1);
      const fileId = largeFiles[0]!.fileId;

      const retrieval = new RetrievalEngine(
        engine.getConversationStore(),
        engine.getSummaryStore(),
      );

      const regexResult = await retrieval.grep({
        query: uniqueMarker,
        mode: "regex",
        scope: "files",
        conversationId: conversation!.conversationId,
        largeFilesDir: engine.configView.largeFilesDir,
      });
      expect(regexResult.files).toHaveLength(1);
      expect(regexResult.files[0]!.fileId).toBe(fileId);
      expect(regexResult.files[0]!.matchedText).toBe(uniqueMarker);
      expect(regexResult.files[0]!.lineNumber).toBe(81);
      expect(regexResult.files[0]!.byteOffset).toBe(toolOutput.indexOf(uniqueMarker));
      expect(regexResult.files[0]!.snippet).toContain(uniqueMarker);

      const fullTextResult = await retrieval.grep({
        query: uniqueMarker,
        mode: "full_text",
        scope: "files",
        conversationId: conversation!.conversationId,
        largeFilesDir: engine.configView.largeFilesDir,
      });
      expect(fullTextResult.files).toHaveLength(1);
      expect(fullTextResult.files[0]!.matchedText).toBe(uniqueMarker);

      const fileIdsResult = await retrieval.grep({
        query: "no-such-pattern-xyz",
        mode: "regex",
        scope: "files",
        fileIds: [fileId],
        largeFilesDir: engine.configView.largeFilesDir,
      });
      expect(fileIdsResult.files).toHaveLength(0);
    });
  });

  it("externalizes oversized plain-text tool-result blocks from live exec-style messages", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const toolOutput = `${"minified js chunk\n".repeat(160)}done`;

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_live_exec",
              name: "exec",
              input: { cmd: "head -c 200000 viewer-runtime.js" },
            },
          ],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "toolResult",
          toolCallId: "call_live_exec",
          toolName: "exec",
          isError: false,
          content: [
            {
              type: "text",
              text: toolOutput,
            },
          ],
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(2);
      expect(storedMessages[1].content).toContain("[LCM Tool Output: file_");
      expect(storedMessages[1].content).toContain("tool=exec");
      expect(storedMessages[1].content).not.toContain(toolOutput.slice(0, 64));

      const fileIdMatch = storedMessages[1].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];

      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("exec.txt");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(toolOutput);

      const parts = await engine.getConversationStore().getMessageParts(storedMessages[1].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].partType).toBe("tool");
      expect(parts[0].toolCallId).toBe("call_live_exec");
      expect(parts[0].toolName).toBe("exec");
      const metadata = JSON.parse(parts[0].metadata ?? "{}") as Record<string, unknown>;
      expect(metadata).toMatchObject({
        originalRole: "toolResult",
        rawType: "tool_result",
        externalizedFileId: fileId,
        originalByteSize: Buffer.byteLength(toolOutput, "utf8"),
        toolOutputExternalized: true,
        externalizationReason: "large_tool_result",
      });

      const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
      const assembled = await assembler.assemble({
        conversationId: conversation!.conversationId,
        tokenBudget: 10_000,
      });
      expect(assembled.messages).toHaveLength(2);
      const assembledToolResult = assembled.messages[1] as {
        role: string;
        toolCallId?: string;
        toolName?: string;
        content?: Array<{ type?: unknown; text?: unknown; output?: unknown }>;
      };
      expect(assembledToolResult.role).toBe("toolResult");
      expect(assembledToolResult.toolCallId).toBe("call_live_exec");
      expect(assembledToolResult.toolName).toBe("exec");
      const block = assembledToolResult.content?.[0];
      expect(block?.type).toBe("text");
      expect(typeof block?.text).toBe("string");
      expect(String(block?.text)).toContain(fileId);
      expect(block).not.toHaveProperty("output");
    });
  });

  it("keeps oversized lcm_describe tool results inline instead of re-externalizing", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const describedOutput = `${"described line\n".repeat(160)}done`;

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_describe",
              name: "lcm_describe",
              input: { id: "file_abc37559665143d0", expandFile: true },
            },
          ],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "toolResult",
          toolCallId: "call_describe",
          toolName: "lcm_describe",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_describe",
              name: "lcm_describe",
              content: [{ type: "text", text: describedOutput }],
            },
          ],
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(2);

      // Tool-result content is intentionally stored as empty string; the real
      // payload lives in message_parts.
      expect(storedMessages[1].content).toBe("");

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(0);

      const parts = await engine
        .getConversationStore()
        .getMessageParts(storedMessages[1].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].partType).toBe("tool");
      expect(parts[0].toolName).toBe("lcm_describe");
      const metadata = JSON.parse(parts[0].metadata ?? "{}") as Record<string, unknown>;
      expect(metadata).not.toHaveProperty("toolOutputExternalized");
      expect(metadata).not.toHaveProperty("externalizedFileId");
      const raw = metadata.raw as { content?: Array<{ text?: string }> };
      expect(raw.content?.[0]?.text).toBe(describedOutput);
    });
  });

  it("externalizes structured tool-result image payloads before text externalization", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 20,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBOR${"A".repeat(600)}`;

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_structured_image",
            name: "capture",
            input: { cmd: "screenshot" },
          },
        ],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_structured_image",
        toolName: "capture",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_structured_image",
            name: "capture",
            content: [{ type: "text", text: base64Image }],
          },
        ],
      } as AgentMessage,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages[1].content).toBe("");

    const parts = await engine.getConversationStore().getMessageParts(storedMessages[1].messageId);
    expect(parts).toHaveLength(1);
    expect(parts[0].partType).toBe("tool");
    expect(parts[0].toolOutput).toBeNull();
    const metadata = JSON.parse(parts[0].metadata ?? "{}") as Record<string, unknown>;
    const raw = metadata.raw as {
      type: string;
      content: Array<{ type: string; text: string }>;
    };
    const imageReference = raw.content[0]?.text ?? "";
    expect(imageReference).toContain("[Tool image: tool-image.png");
    expect(imageReference).not.toContain(base64Image.slice(0, 32));

    const fileIdMatch = imageReference.match(/file_[a-f0-9]{16}/);
    expect(fileIdMatch).not.toBeNull();
    const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.mimeType).toBe("image/png");
    expect(storedFile!.fileName).toBe("tool-image.png");

    expect(metadata.raw).toMatchObject({
      type: "tool_result",
      content: [{ type: "text", text: expect.stringContaining("[Tool image: tool-image.png") }],
    });

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });
    const assembledToolResult = assembled.messages[1] as {
      role: string;
      content?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(assembledToolResult.role).toBe("toolResult");
    expect(assembledToolResult.content?.[0]?.content?.[0]?.text).toContain("[Tool image: tool-image.png");
  });

  it("externalizes string-content tool-result images without converting them to text files", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 20,
      largeFilesDir,
    });
    const sessionId = randomUUID();
    const base64Image = `iVBOR${"A".repeat(600)}`;

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_text_image",
            name: "capture",
            input: { cmd: "screenshot" },
          },
        ],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_text_image",
        toolName: "capture",
        isError: false,
        content: base64Image,
      } as AgentMessage,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages[1].content).toContain("[Tool image: tool-image.png");
    expect(storedMessages[1].content).not.toContain("[LCM Tool Output:");

    const fileIdMatch = storedMessages[1].content.match(/file_[a-f0-9]{16}/);
    expect(fileIdMatch).not.toBeNull();
    const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.mimeType).toBe("image/png");
    expect(storedFile!.fileName).toBe("tool-image.png");
    expect(storedFile!.storageUri.endsWith(".png")).toBe(true);

    const parts = await engine.getConversationStore().getMessageParts(storedMessages[1].messageId);
    expect(parts).toHaveLength(1);
    expect(parts[0].partType).toBe("text");
    expect(JSON.parse(parts[0].metadata ?? "{}")).toMatchObject({
      toolCallId: "call_text_image",
      toolName: "capture",
      isError: false,
    });
  });

  it("maintain() does not rewrite transcript entries for GC", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const sessionFile = createSessionFilePath("transcript-gc-removed");
      const toolOutput = `${"tool output line\n".repeat(160)}done`;

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_gc_rewrite",
              name: "exec",
              input: { cmd: "pwd" },
            },
          ],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "toolResult",
          toolCallId: "call_gc_rewrite",
          toolName: "exec",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_gc_rewrite",
              name: "exec",
              content: [{ type: "text", text: toolOutput }],
            },
          ],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      const toolMessage = storedMessages[1];
      expect(toolMessage?.content).toContain("[LCM Tool Output: file_");

      const summaryId = `sum_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      await engine.getSummaryStore().insertSummary({
        summaryId,
        conversationId: conversation!.conversationId,
        kind: "leaf",
        content: "summarized tool output",
        tokenCount: 16,
      });
      await engine.getSummaryStore().linkSummaryToMessages(summaryId, [toolMessage.messageId]);
      await engine.getSummaryStore().replaceContextRangeWithSummary({
        conversationId: conversation!.conversationId,
        startOrdinal: 1,
        endOrdinal: 1,
        summaryId,
      });

      const rewriteTranscriptEntries = vi.fn(async (request: { replacements: unknown[] }) => ({
        changed: true,
        bytesFreed: 123,
        rewrittenEntries: request.replacements.length,
      }));

      const result = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          rewriteTranscriptEntries,
        },
      });

      expect(result).toEqual({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "no deferred maintenance work",
      });
      expect(rewriteTranscriptEntries).not.toHaveBeenCalled();
      expect(await engine.getConversationStore().getConversationBySessionId(sessionId)).not.toBeNull();
    });
  });

  it("serializes recycled session writes by stable sessionKey", async () => {
    const engine = createEngine();
    const sessionKey = "agent:main:main";

    await engine.ingest({
      sessionId: "runtime-seed",
      sessionKey,
      message: makeMessage({ role: "assistant", content: "seed" }),
    });

    const store = engine.getConversationStore();
    const originalCreateMessage = store.createMessage.bind(store);
    let releaseFirstCreate: () => void = () => {};
    let unblockFirstCreate!: () => void;
    const firstCreateBlocked = new Promise<void>((resolve) => {
      unblockFirstCreate = resolve;
    });
    let heldFirstCreate = false;

    const createMessageSpy = vi
      .spyOn(store, "createMessage")
      .mockImplementation(async (input) => {
        if (!heldFirstCreate) {
          heldFirstCreate = true;
          unblockFirstCreate();
          await new Promise<void>((resolve) => {
            releaseFirstCreate = resolve;
          });
        }
        return originalCreateMessage(input);
      });

    const firstIngest = engine.ingest({
      sessionId: "runtime-a",
      sessionKey,
      message: makeMessage({ role: "assistant", content: "first recycled reply" }),
    });
    await firstCreateBlocked;

    const secondIngest = engine.ingest({
      sessionId: "runtime-b",
      sessionKey,
      message: makeMessage({ role: "assistant", content: "second recycled reply" }),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createMessageSpy).toHaveBeenCalledTimes(1);

    releaseFirstCreate();

    await expect(Promise.all([firstIngest, secondIngest])).resolves.toEqual([
      { ingested: true },
      { ingested: true },
    ]);

    const conversation = await store.getConversationBySessionKey(sessionKey);
    expect(conversation).not.toBeNull();
    expect(conversation!.sessionId).toBe("runtime-b");

    const stored = await store.getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed",
      "first recycled reply",
      "second recycled reply",
    ]);
  });
});

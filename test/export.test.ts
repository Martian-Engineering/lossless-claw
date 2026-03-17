import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLcmMigrations } from "../src/db/migration.js";
import { exportConversations } from "../src/export.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { ContactStore } from "../src/store/contact-store.js";

describe("LCM Export", () => {
  let db: DatabaseSync;
  let tempDir: string;
  let outputDir: string;
  let conversationStore: ConversationStore;
  let contactStore: ContactStore;

  beforeEach(() => {
    // Create temp directory
    tempDir = join(tmpdir(), `lcm-export-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    outputDir = join(tempDir, "exports");

    // Create in-memory database
    db = new DatabaseSync(":memory:");
    runLcmMigrations(db);

    conversationStore = new ConversationStore(db);
    contactStore = new ContactStore(db);
  });

  afterEach(() => {
    db?.close();
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("exports DM conversation to correct directory structure", async () => {
    // Create contact
    contactStore.create({
      peerId: "user:alice123",
      peerName: "Alice",
      chatType: "dm",
    });

    // Create conversation
    const conv = await conversationStore.createConversation({
      sessionId: "test-session-1",
      peerId: "user:alice123",
      channel: "feishu",
      title: "Chat with Alice",
    });

    // Add messages
    await conversationStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "Hello, how are you?",
      tokenCount: 10,
    });

    await conversationStore.createMessage({
      conversationId: conv.conversationId,
      seq: 2,
      role: "assistant",
      content: "I'm doing well, thanks for asking!",
      tokenCount: 15,
    });

    // Export
    const result = exportConversations(db, { outputDir });

    expect(result.messagesExported).toBe(2);
    expect(result.filesWritten).toBe(1);

    // Verify file exists
    const files = findMarkdownFiles(outputDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain("dm/Alice/");
    expect(files[0]).toMatch(/\d{4}-\d{2}-\d{2}\.md$/);

    // Verify content format
    const content = readFileSync(files[0], "utf-8");
    expect(content).toContain("[feishu]");
    expect(content).toContain("Alice: Hello, how are you?");
    expect(content).toContain("Assistant: I'm doing well");
  });

  it("exports group conversation to group directory", async () => {
    // Create contact
    contactStore.create({
      peerId: "chat:project-alpha",
      peerName: "Project Alpha",
      chatType: "group",
    });

    // Create conversation
    const conv = await conversationStore.createConversation({
      sessionId: "test-session-2",
      peerId: "chat:project-alpha",
      channel: "telegram",
      title: "Project Discussion",
    });

    // Add messages
    await conversationStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "Team meeting at 3pm",
      tokenCount: 8,
    });

    // Export
    const result = exportConversations(db, { outputDir, chatType: "group" });

    expect(result.messagesExported).toBe(1);

    // Verify file is in group directory
    const files = findMarkdownFiles(outputDir);
    expect(files[0]).toContain("group/Project Alpha");
  });

  it("filters by peerId", async () => {
    // Create two contacts
    contactStore.create({ peerId: "user:alice", peerName: "Alice", chatType: "dm" });
    contactStore.create({ peerId: "user:bob", peerName: "Bob", chatType: "dm" });

    // Create two conversations
    const conv1 = await conversationStore.createConversation({
      sessionId: "session-1",
      peerId: "user:alice",
      channel: "feishu",
    });
    const conv2 = await conversationStore.createConversation({
      sessionId: "session-2",
      peerId: "user:bob",
      channel: "feishu",
    });

    // Add messages
    await conversationStore.createMessage({
      conversationId: conv1.conversationId,
      seq: 1,
      role: "user",
      content: "Message to Alice",
      tokenCount: 5,
    });
    await conversationStore.createMessage({
      conversationId: conv2.conversationId,
      seq: 1,
      role: "user",
      content: "Message to Bob",
      tokenCount: 5,
    });

    // Export only Alice
    const result = exportConversations(db, { outputDir, peerId: "user:alice" });

    expect(result.messagesExported).toBe(1);
    const content = readFileSync(findMarkdownFiles(outputDir)[0], "utf-8");
    expect(content).toContain("Message to Alice");
    expect(content).not.toContain("Message to Bob");
  });

  it("handles missing peer info gracefully", async () => {
    // Create conversation without peer
    const conv = await conversationStore.createConversation({
      sessionId: "session-no-peer",
      channel: "feishu",
    });

    await conversationStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "Anonymous message",
      tokenCount: 5,
    });

    // Export
    const result = exportConversations(db, { outputDir });

    expect(result.messagesExported).toBe(1);
    const files = findMarkdownFiles(outputDir);
    expect(files[0]).toContain("/unknown/");
  });
});

function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  
  function walk(d: string) {
    if (!existsSync(d)) return;
    const entries = require("fs").readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".md")) {
        files.push(path);
      }
    }
  }
  
  walk(dir);
  return files;
}

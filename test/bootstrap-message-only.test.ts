import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { __testing } from "../src/engine.js";

const { readLastJsonlEntryBeforeOffset } = __testing;

function tmpJsonl(lines: string[]): string {
  const file = join(tmpdir(), `lcm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function fileSize(path: string): number {
  return statSync(path).size;
}

const cleanups: string[] = [];
afterEach(() => {
  for (const f of cleanups) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
  cleanups.length = 0;
});

function makeTmpJsonl(lines: string[]): string {
  const f = tmpJsonl(lines);
  cleanups.push(f);
  return f;
}

// Helper entries
const userMessage = JSON.stringify({ role: "user", content: "hello" });
const assistantMessage = JSON.stringify({ role: "assistant", content: "hi there" });
const cacheTtl = JSON.stringify({ type: "openclaw.cache-ttl", ttl: 300 });
const toolResult = JSON.stringify({ type: "openclaw.tool-result", result: "ok" });
const customMeta = JSON.stringify({ type: "openclaw.session-meta", version: 2 });
// Canonical SessionManager message envelope
const envelopedMessage = JSON.stringify({ type: "message", message: { role: "user", content: "wrapped" } });
// Noncanonical entry that happens to carry a nested message payload
const commentaryEnvelope = JSON.stringify({ type: "commentary", message: { role: "assistant", content: "ignore me" } });

describe("readLastJsonlEntryBeforeOffset with messageOnly", () => {
  it("messageOnly=true skips trailing cache-ttl entries and returns last message", async () => {
    const file = makeTmpJsonl([userMessage, assistantMessage, cacheTtl, cacheTtl]);
    const offset = fileSize(file);

    const result = await readLastJsonlEntryBeforeOffset(file, offset, true);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.role).toBe("assistant");
    expect(parsed.content).toBe("hi there");
  });

  it("messageOnly=true skips multiple non-message types (cache-ttl, tool-result, meta)", async () => {
    const file = makeTmpJsonl([userMessage, assistantMessage, cacheTtl, toolResult, customMeta]);
    const offset = fileSize(file);

    const result = await readLastJsonlEntryBeforeOffset(file, offset, true);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.role).toBe("assistant");
    expect(parsed.content).toBe("hi there");
  });

  it("returns null when JSONL has only non-message entries and messageOnly=true", async () => {
    const file = makeTmpJsonl([cacheTtl, toolResult, customMeta]);
    const offset = fileSize(file);

    const result = await readLastJsonlEntryBeforeOffset(file, offset, true);
    expect(result).toBeNull();
  });

  it("messageOnly=true and messageOnly=false return same result when last entry is a message", async () => {
    const file = makeTmpJsonl([userMessage, assistantMessage]);
    const offset = fileSize(file);

    const withFlag = await readLastJsonlEntryBeforeOffset(file, offset, true);
    const withoutFlag = await readLastJsonlEntryBeforeOffset(file, offset, false);
    expect(withFlag).toBe(withoutFlag);
  });

  it("messageOnly=false (default) returns non-message entries", async () => {
    const file = makeTmpJsonl([userMessage, cacheTtl]);
    const offset = fileSize(file);

    const result = await readLastJsonlEntryBeforeOffset(file, offset, false);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.type).toBe("openclaw.cache-ttl");
  });

  it("default messageOnly parameter returns non-message entries (backward compat)", async () => {
    const file = makeTmpJsonl([userMessage, cacheTtl]);
    const offset = fileSize(file);

    // Call without third argument — should behave like messageOnly=false
    const result = await readLastJsonlEntryBeforeOffset(file, offset);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.type).toBe("openclaw.cache-ttl");
  });

  it("handles canonical SessionManager message envelopes", async () => {
    const file = makeTmpJsonl([envelopedMessage, cacheTtl]);
    const offset = fileSize(file);

    const result = await readLastJsonlEntryBeforeOffset(file, offset, true);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.message.role).toBe("user");
    expect(parsed.message.content).toBe("wrapped");
  });

  it("skips non-message envelopes even when they contain nested message-shaped data", async () => {
    const file = makeTmpJsonl([userMessage, commentaryEnvelope]);
    const offset = fileSize(file);

    const result = await readLastJsonlEntryBeforeOffset(file, offset, true);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.role).toBe("user");
    expect(parsed.content).toBe("hello");
  });

  it("returns null for empty file", async () => {
    const file = makeTmpJsonl([]);
    const offset = fileSize(file);
    await expect(readLastJsonlEntryBeforeOffset(file, offset, true)).resolves.toBeNull();
  });

  it("returns null when offset is 0", async () => {
    const file = makeTmpJsonl([userMessage]);
    await expect(readLastJsonlEntryBeforeOffset(file, 0, true)).resolves.toBeNull();
  });

  it("finds message when it is the only entry (first line)", async () => {
    const file = makeTmpJsonl([userMessage]);
    const offset = fileSize(file);

    const result = await readLastJsonlEntryBeforeOffset(file, offset, true);
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.role).toBe("user");
  });

  it("returns null when only entry is non-message and messageOnly=true", async () => {
    const file = makeTmpJsonl([cacheTtl]);
    const offset = fileSize(file);

    const result = await readLastJsonlEntryBeforeOffset(file, offset, true);
    expect(result).toBeNull();
  });
});

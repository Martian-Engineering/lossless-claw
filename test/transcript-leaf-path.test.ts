import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getTranscriptEntryId, readLeafPathMessages } from "../src/transcript.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  tempDirs.length = 0;
});

function writeSessionFile(lines: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lcm-leaf-path-"));
  tempDirs.push(dir);
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(
    sessionFile,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n",
    "utf8",
  );
  return sessionFile;
}

const header = { type: "session", version: 3, id: "session-1", timestamp: "2026-06-10T00:00:00.000Z" };

function messageEntry(id: string, parentId: string | null, role: string, content: string) {
  return { type: "message", id, parentId, timestamp: "2026-06-10T00:00:00.000Z", message: { role, content } };
}

function contents(messages: Awaited<ReturnType<typeof readLeafPathMessages>>): unknown[] {
  return messages.map((message) => message.content);
}

describe("readLeafPathMessages leaf-path selection", () => {
  it("returns the full path for a linear transcript", async () => {
    const sessionFile = writeSessionFile([
      header,
      messageEntry("a", null, "user", "one"),
      messageEntry("b", "a", "assistant", "two"),
      messageEntry("c", "b", "user", "three"),
    ]);
    const messages = await readLeafPathMessages(sessionFile);
    expect(contents(messages)).toEqual(["one", "two", "three"]);
    expect(messages.map((m) => getTranscriptEntryId(m))).toEqual(["a", "b", "c"]);
  });

  it("excludes abandoned branches left by a host branch()", async () => {
    // Host branched back to "a" and continued with b2/c2; b1/c1 are abandoned.
    const sessionFile = writeSessionFile([
      header,
      messageEntry("a", null, "user", "root"),
      messageEntry("b1", "a", "assistant", "abandoned reply"),
      messageEntry("c1", "b1", "user", "abandoned follow-up"),
      messageEntry("b2", "a", "assistant", "active reply"),
      messageEntry("c2", "b2", "user", "active follow-up"),
    ]);
    const messages = await readLeafPathMessages(sessionFile);
    expect(contents(messages)).toEqual(["root", "active reply", "active follow-up"]);
  });

  it("excludes the old suffix after a rewriteTranscriptEntries-style re-append", async () => {
    // Host rewrite: suffix c/d re-appended as c2/d2 (c2 replaces c's content),
    // branching from b. The old c/d remain in the file as an abandoned branch.
    const sessionFile = writeSessionFile([
      header,
      messageEntry("a", null, "user", "prompt"),
      messageEntry("b", "a", "assistant", "answer"),
      messageEntry("c", "b", "toolResult", "oversized payload"),
      messageEntry("d", "c", "assistant", "summary"),
      messageEntry("c2", "b", "toolResult", "[LCM Tool Output: stub]"),
      messageEntry("d2", "c2", "assistant", "summary"),
    ]);
    const messages = await readLeafPathMessages(sessionFile);
    expect(contents(messages)).toEqual(["prompt", "answer", "[LCM Tool Output: stub]", "summary"]);
    expect(messages.map((m) => getTranscriptEntryId(m))).toEqual(["a", "b", "c2", "d2"]);
  });

  it("starts from a mid-file root after a host resetLeaf()", async () => {
    const sessionFile = writeSessionFile([
      header,
      messageEntry("a", null, "user", "before reset"),
      messageEntry("b", "a", "assistant", "also before reset"),
      messageEntry("c", null, "user", "fresh root"),
      messageEntry("d", "c", "assistant", "fresh reply"),
    ]);
    const messages = await readLeafPathMessages(sessionFile);
    expect(contents(messages)).toEqual(["fresh root", "fresh reply"]);
  });

  it("walks through non-message entries that link the chain", async () => {
    const sessionFile = writeSessionFile([
      header,
      messageEntry("a", null, "user", "question"),
      { type: "custom", id: "x", parentId: "a", timestamp: "2026-06-10T00:00:00.000Z", customType: "marker", data: {} },
      messageEntry("b", "x", "assistant", "reply"),
      { type: "compaction", id: "y", parentId: "b", timestamp: "2026-06-10T00:00:00.000Z", summary: "s", firstKeptEntryId: "a", tokensBefore: 1 },
    ]);
    const messages = await readLeafPathMessages(sessionFile);
    expect(contents(messages)).toEqual(["question", "reply"]);
  });

  it("collapses a replayed duplicate entry line to one occurrence", async () => {
    const replayed = messageEntry("b", "a", "assistant", "reply");
    const sessionFile = writeSessionFile([
      header,
      messageEntry("a", null, "user", "question"),
      replayed,
      replayed,
    ]);
    const messages = await readLeafPathMessages(sessionFile);
    expect(contents(messages)).toEqual(["question", "reply"]);
  });

  it("falls back to flatten when any message lacks an entry id", async () => {
    const sessionFile = writeSessionFile([
      header,
      messageEntry("a", null, "user", "root"),
      messageEntry("b1", "a", "assistant", "abandoned"),
      { role: "user", content: "bare line without envelope" },
      messageEntry("b2", "a", "assistant", "active"),
    ]);
    const messages = await readLeafPathMessages(sessionFile);
    expect(contents(messages)).toEqual([
      "root",
      "abandoned",
      "bare line without envelope",
      "active",
    ]);
  });

  it("falls back to flatten on a dangling parent reference", async () => {
    const sessionFile = writeSessionFile([
      header,
      messageEntry("a", null, "user", "one"),
      messageEntry("b", "missing-parent", "assistant", "two"),
    ]);
    const messages = await readLeafPathMessages(sessionFile);
    expect(contents(messages)).toEqual(["one", "two"]);
  });

  it("falls back to flatten on a parent cycle", async () => {
    const sessionFile = writeSessionFile([
      header,
      messageEntry("a", "b", "user", "one"),
      messageEntry("b", "a", "assistant", "two"),
    ]);
    const messages = await readLeafPathMessages(sessionFile);
    expect(contents(messages)).toEqual(["one", "two"]);
  });

  it("keeps JSON-array session files unchanged", async () => {
    const sessionFile = writeSessionFile([
      JSON.stringify([
        { role: "user", content: "array one" },
        { role: "assistant", content: "array two" },
      ]),
    ]);
    const messages = await readLeafPathMessages(sessionFile);
    expect(contents(messages)).toEqual(["array one", "array two"]);
  });

  it("ignores trailing malformed lines and walks from the last valid entry", async () => {
    const sessionFile = writeSessionFile([
      header,
      messageEntry("a", null, "user", "one"),
      messageEntry("b", "a", "assistant", "two"),
      '{"type":"message","id":"c","parentId":"b","message":{"role":"user","content":"tr',
    ]);
    const messages = await readLeafPathMessages(sessionFile);
    expect(contents(messages)).toEqual(["one", "two"]);
  });
});

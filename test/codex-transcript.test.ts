import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexTranscript } from "../src/codex-transcript.js";

const roots: string[] = [];

function writeRollout(lines: unknown[], suffix = "\n"): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-codex-transcript-"));
  roots.push(root);
  const file = join(root, "rollout.jsonl");
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}${suffix}`);
  return file;
}

function meta(id = "thread:with:colon", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "session_meta",
    payload: { id, timestamp: "2026-10-03T10:00:00.000Z", ...extra },
  };
}

function response(payload: Record<string, unknown>, timestamp = "2026-10-03T10:00:01.000Z") {
  return { type: "response_item", timestamp, payload };
}

function event(type: string, message: string, timestamp = "2026-10-03T10:00:01.000Z") {
  return { type: "event_msg", timestamp, payload: { type, message } };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("readCodexTranscript", () => {
  it("keeps canonical user, assistant, and tool records, deduplicates mirrored events, and preserves distinct event text", async () => {
    const file = writeRollout([
      meta(),
      response({ type: "message", role: "user", content: [{ type: "input_text", text: "first request" }] }),
      event("user_message", "first request"),
      response({ type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }),
      event("agent_message", "answer"),
      response({ type: "function_call", name: "shell", arguments: "{\"cmd\":\"pwd\"}", call_id: "call-1" }),
      response({ type: "function_call_output", call_id: "call-1", output: "workspace" }),
      response({ type: "message", role: "user", content: [{ type: "input_text", text: "injected context" }] }),
      event("user_message", "original user event"),
      response({ type: "future_item", value: "preserve me" }),
    ]);

    const transcript = await readCodexTranscript(file);

    expect(transcript.threadId).toBe("thread:with:colon");
    expect(transcript.messages.map(({ message }) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "toolResult",
      "user",
      "user",
      "assistant",
    ]);
    expect(transcript.messages[0]?.message.timestamp).toBe(Date.parse("2026-10-03T10:00:01.000Z"));
    expect(transcript.messages.map(({ line }) => line)).toEqual([2, 4, 6, 7, 8, 9, 10]);
    expect(transcript.warnings).toContain(
      "A Codex event_msg user record could not be proven to mirror a canonical response_item and was preserved separately.",
    );
    expect(transcript.warnings).toContain(
      'Unsupported Codex response_item type "future_item" was preserved as source metadata.',
    );
    expect(transcript.messages[2]?.sourceRecord.payload).toMatchObject({
      name: "shell",
      arguments: "{\"cmd\":\"pwd\"}",
      call_id: "call-1",
    });
    expect(transcript.messages[3]?.sourceRecord.payload).toMatchObject({ call_id: "call-1", output: "workspace" });
  });

  it("uses event_msg records when canonical conversation responses are absent", async () => {
    const file = writeRollout([
      meta("event-only"),
      event("user_message", "request"),
      event("agent_message", "response"),
    ]);

    const transcript = await readCodexTranscript(file);

    expect(transcript.messages.map(({ message }) => [message.role, message.content])).toEqual([
      ["user", "request"],
      ["assistant", "response"],
    ]);
  });

  it("consumes only one nearby mirrored event for each canonical record", async () => {
    const file = writeRollout([
      meta("repeated"),
      response({ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }),
      event("user_message", "hello"),
      event("user_message", "hello"),
    ]);

    const transcript = await readCodexTranscript(file);

    expect(transcript.messages.map(({ line }) => line)).toEqual([2, 4]);
    expect(transcript.messages.map(({ message }) => message.role)).toEqual(["user", "user"]);
    expect(transcript.messages[0]?.sessionMeta).toMatchObject({ id: "repeated" });
    expect(transcript.messages[1]?.sessionMeta).toBeUndefined();
  });

  it.each([
    [
      "turn boundaries despite matching timestamps",
      [
        meta("repeat-across-turns"),
        response({ type: "message", role: "user", content: [{ type: "input_text", text: "same request" }] }),
        { type: "event_msg", timestamp: "2026-10-03T10:00:01.000Z", payload: { type: "task_complete" } },
        { type: "event_msg", timestamp: "2026-10-03T10:00:01.000Z", payload: { type: "task_started" } },
        event("user_message", "same request"),
      ],
      [2, 5],
    ],
    [
      "distant timestamps without a turn boundary",
      [
        meta("repeat-distant-timestamp"),
        response({ type: "message", role: "user", content: [{ type: "input_text", text: "same request" }] }),
        event("user_message", "same request", "2026-10-03T18:00:01.000Z"),
      ],
      [2, 3],
    ],
  ])("preserves identical requests across %s", async (_label, entries, expectedLines) => {
    const file = writeRollout(entries as unknown[]);

    const transcript = await readCodexTranscript(file);

    expect(transcript.messages.map(({ line }) => line)).toEqual(expectedLines);
    expect(transcript.messages.map(({ message }) => message.role)).toEqual(["user", "user"]);
  });

  it("warns when a rollout is paginated and leaves inherited-history resolution explicit", async () => {
    const file = writeRollout([
      meta("paginated", {
        history_mode: "paginated",
        history_base: { thread_id: "parent", end_ordinal_exclusive: 42 },
      }),
      response({ type: "message", role: "user", content: "current request" }),
    ]);

    const transcript = await readCodexTranscript(file);

    expect(transcript.warnings).toContain(
      "Codex rollout is paginated or forked; only this available file was imported. Inherited source history was not resolved.",
    );
  });

  it.each([
    ["malformed JSON", '{"type":"session_meta","payload":{"id":"broken"}}\nnot-json\n'],
    ["missing final newline", '{"type":"session_meta","payload":{"id":"partial"}}'],
    ["missing native thread id", '{"type":"session_meta","payload":{}}\n'],
  ])("rejects %s before the migration can write", async (_label, source) => {
    const root = mkdtempSync(join(tmpdir(), "lcm-codex-transcript-invalid-"));
    roots.push(root);
    const file = join(root, "rollout.jsonl");
    writeFileSync(file, source);

    await expect(readCodexTranscript(file)).rejects.toThrow();
  });
});

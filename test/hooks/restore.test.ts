import { describe, it, expect, vi } from "vitest";
import { handleSessionStart } from "../../src/hooks/restore.js";

describe("handleSessionStart", () => {
  it("outputs context and exits 0 on success", async () => {
    const client = {
      health: vi.fn().mockResolvedValue({ status: "ok" }),
      post: vi.fn().mockResolvedValue({ context: "<memory-orientation>\nMemory active\n</memory-orientation>" }),
    };
    const result = await handleSessionStart(JSON.stringify({ session_id: "s1", cwd: "/proj", hook_event_name: "SessionStart" }), client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("<memory-orientation>");
  });

  it("exits 0 with empty output when daemon down", async () => {
    const client = { health: vi.fn().mockResolvedValue(null), post: vi.fn() };
    const result = await handleSessionStart("{}", client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

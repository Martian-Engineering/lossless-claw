import { describe, it, expect, vi } from "vitest";
import { handlePreCompact } from "../../src/hooks/compact.js";

describe("handlePreCompact", () => {
  it("returns exitCode 2 and summary when daemon healthy", async () => {
    const client = { health: vi.fn().mockResolvedValue({ status: "ok" }), post: vi.fn().mockResolvedValue({ summary: "Compacted 500 tokens" }) };
    const result = await handlePreCompact(JSON.stringify({ session_id: "s1", cwd: "/proj", hook_event_name: "PreCompact" }), client as any);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toContain("Compacted");
  });

  it("returns exitCode 0 when daemon unreachable", async () => {
    const client = { health: vi.fn().mockResolvedValue(null), post: vi.fn() };
    const result = await handlePreCompact("{}", client as any);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

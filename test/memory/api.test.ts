import { describe, it, expect, vi } from "vitest";
import { createMemoryApi } from "../../src/memory/index.js";

describe("createMemoryApi", () => {
  it("store calls POST /store", async () => {
    const mockPost = vi.fn().mockResolvedValue({ stored: true });
    const api = createMemoryApi({ post: mockPost, health: vi.fn() } as any);
    await api.store("Decision: use PostgreSQL", ["decision"], { projectPath: "/foo" });
    expect(mockPost).toHaveBeenCalledWith("/store", { text: "Decision: use PostgreSQL", tags: ["decision"], metadata: { projectPath: "/foo" } });
  });

  it("search calls POST /search and returns both layers", async () => {
    const mockPost = vi.fn().mockResolvedValue({ episodic: [{ id: "1", content: "test", source: "sqlite", score: 1.5 }], semantic: [] });
    const api = createMemoryApi({ post: mockPost, health: vi.fn() } as any);
    const result = await api.search("PostgreSQL decision");
    expect(result.episodic).toHaveLength(1);
    expect(result.semantic).toHaveLength(0);
  });

  it("compact calls POST /compact via daemon", async () => {
    const mockPost = vi.fn().mockResolvedValue({ summary: "Compacted" });
    const api = createMemoryApi({ post: mockPost, health: vi.fn() } as any);
    const result = await api.compact("sess-1", "/path/transcript");
    expect(result.summary).toBe("Compacted");
    expect(mockPost).toHaveBeenCalledWith("/compact", expect.objectContaining({ session_id: "sess-1" }));
  });

  it("recent calls POST /recent", async () => {
    const mockPost = vi.fn().mockResolvedValue({ summaries: [] });
    const api = createMemoryApi({ post: mockPost, health: vi.fn() } as any);
    await api.recent("project-hash-123");
    expect(mockPost).toHaveBeenCalledWith("/recent", expect.objectContaining({ projectId: "project-hash-123" }));
  });
});

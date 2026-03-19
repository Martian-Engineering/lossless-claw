import { describe, it, expect, afterEach, vi } from "vitest";
import { createDaemon, type DaemonInstance } from "../../../src/daemon/server.js";
import { loadDaemonConfig } from "../../../src/daemon/config.js";

// --- Summarizer branching unit tests ---

vi.mock("../../../src/llm/anthropic.js", () => ({
  createAnthropicSummarizer: vi.fn().mockReturnValue(async () => "anthropic-summary"),
}));

vi.mock("../../../src/llm/openai.js", () => ({
  createOpenAISummarizer: vi.fn().mockReturnValue(async () => "openai-summary"),
}));

import { createAnthropicSummarizer } from "../../../src/llm/anthropic.js";
import { createOpenAISummarizer } from "../../../src/llm/openai.js";
import { createCompactHandler } from "../../../src/daemon/routes/compact.js";
import type { DaemonConfig } from "../../../src/daemon/config.js";

function makeConfig(provider: "anthropic" | "openai" | "disabled"): DaemonConfig {
  return {
    version: 1,
    daemon: { port: 3737, socketPath: "/tmp/test.sock", logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7 },
    compaction: {
      leafTokens: 1000, maxDepth: 5,
      promotionThresholds: { minDepth: 2, compressionRatio: 0.3, keywords: {}, architecturePatterns: [] },
    },
    restoration: { recentSummaries: 3, semanticTopK: 5, semanticThreshold: 0.35 },
    llm: { provider, model: "test-model", apiKey: "sk-test", baseURL: "http://localhost:11435/v1" },
    claudeCliProxy: { enabled: true, port: 3456, startupTimeoutMs: 10000, model: "claude-haiku-4-5" },
    cipher: { configPath: "/tmp/cipher.yml", collection: "test" },
  };
}

describe("createCompactHandler — summarizer branching", () => {
  it("uses createAnthropicSummarizer when provider is anthropic", () => {
    vi.clearAllMocks();
    createCompactHandler(makeConfig("anthropic"));
    expect(createAnthropicSummarizer).toHaveBeenCalledWith(expect.objectContaining({ model: "test-model" }));
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
  });

  it("uses createOpenAISummarizer when provider is openai", () => {
    vi.clearAllMocks();
    createCompactHandler(makeConfig("openai"));
    expect(createOpenAISummarizer).toHaveBeenCalledWith(
      expect.objectContaining({ model: "test-model", baseURL: "http://localhost:11435/v1" })
    );
    expect(createAnthropicSummarizer).not.toHaveBeenCalled();
  });

  it("returns no-op when provider is 'disabled' — no summarizer created", () => {
    vi.clearAllMocks();
    createCompactHandler(makeConfig("disabled"));
    expect(createAnthropicSummarizer).not.toHaveBeenCalled();
    expect(createOpenAISummarizer).not.toHaveBeenCalled();
  });
});

describe("POST /compact", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("accepts compact request and returns summary", async () => {
    daemon = await createDaemon(loadDaemonConfig("/x", { daemon: { port: 0 }, llm: { apiKey: "sk-test" } }));
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "test-sess", cwd: "/tmp/test-compact-proj", hook_event_name: "PreCompact" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("summary");
    expect(typeof body.summary).toBe("string");
  });
});

describe("POST /compact with disabled provider", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("returns early with message when provider is disabled", async () => {
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    daemon = await createDaemon(config);
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "test-sess", cwd: "/tmp/test-disabled-proj" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toContain("disabled");
  });
});

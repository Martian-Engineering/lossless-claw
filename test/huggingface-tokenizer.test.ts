import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// Mock global fetch to avoid network calls in tests
const mockFetch = vi.fn().mockImplementation((url: string) => {
  // Return mock tokenizer and config JSON for HuggingFace URLs
  if (url.includes("tokenizer.json")) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: "1.0", vocab: {} }),
      text: () => Promise.resolve(JSON.stringify({ version: "1.0", vocab: {} })),
    });
  }
  if (url.includes("tokenizer_config.json")) {
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ do_lower_case: false }),
      text: () => Promise.resolve(JSON.stringify({ do_lower_case: false })),
    });
  }
  return Promise.resolve({ ok: false, status: 404 });
});
vi.stubGlobal("fetch", mockFetch);

const { setGlobalDispatcher, ProxyAgent } = vi.hoisted(() => ({
  setGlobalDispatcher: vi.fn(),
  ProxyAgent: vi.fn().mockImplementation((url: string) => ({ proxyUrl: url })),
}));
vi.mock("undici", () => ({
  ProxyAgent,
  setGlobalDispatcher,
}));

// Mock fs module to simulate file system
vi.mock("fs/promises", () => ({
  access: vi.fn().mockImplementation((path: string) => {
    // Reject for non-existent model cache paths
    if (path.includes("non_existent") || path.includes("xyz")) {
      return Promise.reject({ code: "ENOENT" });
    }
    return Promise.resolve();
  }),
  readFile: vi.fn().mockResolvedValue("{}"),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock the @huggingface/tokenizers module - Tokenizer is a constructor class
vi.mock("@huggingface/tokenizers", () => {
  // Mock Tokenizer constructor that can be called with new
  const MockTokenizer = vi.fn().mockImplementation((json: any, config: any) => {
    return {
      encode: vi.fn().mockImplementation((text: string) => {
        // Simple mock: return ~1 token per 2 chars
        const tokenCount = Math.ceil(text.length / 2);
        return { ids: new Array(tokenCount).fill(0), length: tokenCount };
      }),
      toJSON: vi.fn().mockReturnValue(json || {}),
    };
  });
  
  // Add static methods
  MockTokenizer.fromFile = vi.fn().mockResolvedValue(MockTokenizer());
  MockTokenizer.fromPretrained = vi.fn().mockResolvedValue(MockTokenizer());
  MockTokenizer.fromJSON = vi.fn().mockResolvedValue(MockTokenizer());
  
  return {
    Tokenizer: MockTokenizer,
  };
});

// We'll test the implementation after we write it
import { HuggingFaceTokenizer, createTokenizerService } from "../src/tokenizers/huggingface.js";

describe("HuggingFaceTokenizer", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    setGlobalDispatcher.mockClear();
    ProxyAgent.mockClear();
  });

  describe("constructor", () => {
    it("creates tokenizer with default model glm-5", () => {
      const tokenizer = new HuggingFaceTokenizer();
      expect(tokenizer).toBeDefined();
    });

    it("creates tokenizer with custom model", () => {
      const tokenizer = new HuggingFaceTokenizer("gpt-4o");
      expect(tokenizer).toBeDefined();
    });
  });

  describe("isEnabled", () => {
    it("returns false before initialization", () => {
      const tokenizer = new HuggingFaceTokenizer();
      expect(tokenizer.isEnabled()).toBe(false);
    });
  });

  describe("initialize", () => {
    it("throws when model does not exist", async () => {
      const tokenizer = new HuggingFaceTokenizer("non-existent-model-xyz-12345");
      await expect(tokenizer.initialize()).rejects.toThrow();
    });

    it("uses a request-scoped proxy dispatcher instead of mutating the global dispatcher", async () => {
      mockFetch.mockClear();
      setGlobalDispatcher.mockClear();
      ProxyAgent.mockClear();

      const proxyUrl = "http://user:pass@proxy.example.test:7890";
      const previousCacheDir = process.env.TOKENIZER_CACHE_DIR;
      process.env.TOKENIZER_CACHE_DIR = path.join(os.tmpdir(), `non_existent_proxy_test_${Date.now()}`);

      try {
        const tokenizer = new HuggingFaceTokenizer("glm-5", proxyUrl);
        await tokenizer.initialize();

        expect(ProxyAgent).toHaveBeenCalledWith(proxyUrl);
        expect(setGlobalDispatcher).not.toHaveBeenCalled();
        expect(mockFetch).toHaveBeenNthCalledWith(
          1,
          expect.stringContaining("/tokenizer.json"),
          expect.objectContaining({
            dispatcher: { proxyUrl },
          }),
        );
        expect(mockFetch).toHaveBeenNthCalledWith(
          2,
          expect.stringContaining("/tokenizer_config.json"),
          expect.objectContaining({
            dispatcher: { proxyUrl },
          }),
        );
      } finally {
        if (previousCacheDir === undefined) {
          delete process.env.TOKENIZER_CACHE_DIR;
        } else {
          process.env.TOKENIZER_CACHE_DIR = previousCacheDir;
        }
      }
    });
  });

  describe("countTokens", () => {
    it("throws when not initialized", () => {
      const tokenizer = new HuggingFaceTokenizer();
      expect(() => tokenizer.countTokens("hello")).toThrow("Tokenizer not initialized");
    });

    it("counts tokens after initialization", async () => {
      const tokenizer = new HuggingFaceTokenizer();
      await tokenizer.initialize();
      const count = tokenizer.countTokens("hello");
      expect(count).toBeGreaterThan(0);
      expect(tokenizer.isEnabled()).toBe(true);
    }, 30000);
  });
});

describe("createTokenizerService", () => {
  it("creates and initializes tokenizer", async () => {
    const tokenizer = await createTokenizerService("glm-5");
    expect(tokenizer).toBeDefined();
    expect(tokenizer.isEnabled()).toBe(true);
  }, 30000);

  it("counts tokens correctly", async () => {
    const tokenizer = await createTokenizerService("glm-5");
    const count = tokenizer.countTokens("Hello, world!");
    expect(count).toBeGreaterThan(0);
  }, 30000);

  it("handles Chinese text", async () => {
    const tokenizer = await createTokenizerService("glm-5");
    const count = tokenizer.countTokens("你好世界");
    expect(count).toBeGreaterThan(0);
  }, 30000);

  it("handles empty string", async () => {
    const tokenizer = await createTokenizerService("glm-5");
    const count = tokenizer.countTokens("");
    expect(count).toBe(0);
  }, 30000);

  it("handles long text", async () => {
    const tokenizer = await createTokenizerService("glm-5");
    const longText = "hello world ".repeat(1000);
    const count = tokenizer.countTokens(longText);
    expect(count).toBeGreaterThan(0);
  }, 30000);
});

// URL verification tests are skipped because the test environment may not have internet access.
// The HuggingFace URLs have been manually verified with curl:
// - GLM-5: zai-org/GLM-5 → 302 redirect (OK)
// - GLM-4.7: zai-org/GLM-4.7 → 302 redirect (OK)
// - MiniMax-M2.5: MiniMaxAI/MiniMax-M2.5 → 307 redirect (OK)
// - MiniMax-M2.1: MiniMaxAI/MiniMax-M2.1 → 307 redirect (OK)
// - DeepSeek-V3.2: deepseek-ai/DeepSeek-V3.2 → 307 redirect (OK)
// - DeepSeek-V3.1: deepseek-ai/DeepSeek-V3.1 → 307 redirect (OK)

// describe("HuggingFace Tokenizer URLs", () => {
//   it("GLM-5 tokenizer URL is accessible", async () => {
//     const { verifyTokenizerUrl } = await import("../src/tokenizers/huggingface.js");
//     const result = await verifyTokenizerUrl("zai-org/GLM-5");
//     expect(result).toBe(true);
//   }, 30000);
// });

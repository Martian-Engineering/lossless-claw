import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../src/openclaw-bridge.js";
import lcmPlugin from "../index.js";
import { closeLcmConnection } from "../src/db/connection.js";
import { clearAllSharedInit } from "../src/plugin/shared-init.js";
import { resetStartupBannerLogsForTests } from "../src/startup-banner-log.js";

type HookHandler = (event: unknown, context: unknown) => unknown;

function buildApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  getHook: (hookName: string) => HookHandler | undefined;
} {
  const hooks = new Map<string, HookHandler[]>();

  const api = {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: "/tmp/lossless-claw",
    config: {},
    pluginConfig,
    runtime: {
      subagent: {
        run: vi.fn(),
        waitForRun: vi.fn(),
        getSession: vi.fn(),
        deleteSession: vi.fn(),
      },
      modelAuth: {
        getApiKeyForModel: vi.fn(async () => undefined),
        resolveApiKeyForProvider: vi.fn(async () => undefined),
      },
      config: {
        loadConfig: vi.fn(() => ({})),
      },
      channel: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nonexistent-session-store.json"),
        },
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerContextEngine: vi.fn(),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn(() => "/tmp/fake-agent"),
    on: vi.fn((hookName: string, handler: HookHandler) => {
      const existing = hooks.get(hookName) ?? [];
      existing.push(handler);
      hooks.set(hookName, existing);
    }),
  } as unknown as OpenClawPluginApi;

  return {
    api,
    getHook: (hookName: string) => hooks.get(hookName)?.[0],
  };
}

describe("lcm plugin prompt hook", () => {
  const dbPaths = new Set<string>();

  afterEach(() => {
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    clearAllSharedInit();
    resetStartupBannerLogsForTests();
  });

  it("registers before_prompt_build static recall policy through system prompt context", async () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const { api, getHook } = buildApi({
      enabled: true,
      dbPath,
    });

    lcmPlugin.register(api);

    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));

    const handler = getHook("before_prompt_build");
    expect(handler).toBeTypeOf("function");

    const result = (await handler?.(
      {
        prompt: "What changed earlier in this conversation?",
        messages: [],
      },
      {},
    )) as {
      prependContext?: string;
      prependSystemContext?: string;
      systemPrompt?: string;
    };

    expect(result).toMatchObject({
      prependSystemContext: expect.any(String),
    });
    expect(result.prependContext).toBeUndefined();
    expect(result.systemPrompt).toBeUndefined();
    expect(result.prependSystemContext).toContain("The lossless-claw plugin is active");
    expect(result.prependSystemContext).toContain(
      "these instructions supersede generic memory-recall guidance",
    );
    expect(result.prependSystemContext).toContain(
      "If facts seem contradictory or uncertain, verify with lossless-claw recall tools before answering",
    );
    expect(result.prependSystemContext).toContain("Recall order for compacted conversation history:");
    expect(result.prependSystemContext).toContain("1. `lcm_grep` — search by regex or full-text");
    expect(result.prependSystemContext).toContain("`lcm_grep` routing guidance");
    expect(result.prependSystemContext).toContain('Prefer `mode: "full_text"` for keyword or topical recall');
    expect(result.prependSystemContext).toContain("FTS5 defaults to AND matching");
    expect(result.prependSystemContext).toContain("Prefer 1-3 distinctive full-text terms or one quoted phrase");
    expect(result.prependSystemContext).toContain('Wrap exact multi-word phrases in quotes');
    expect(result.prependSystemContext).toContain('Use `sort: "relevance"` when hunting for the best older match');
    expect(result.prependSystemContext).toContain('Use `sort: "hybrid"` when relevance matters but newer context should still get a boost');
    expect(result.prependSystemContext).toContain("2. `lcm_describe` — inspect a specific summary");
    expect(result.prependSystemContext).toContain(
      "3. `lcm_expand_query` — deep recall: spawns bounded sub-agent",
    );
    expect(result.prependSystemContext).toContain(
      "`lcm_expand_query` usage",
    );
    expect(result.prependSystemContext).toContain(
      "lcm_expand_query(summaryIds: [\"sum_xxx\"], prompt: \"What config changes were discussed?\")",
    );
    expect(result.prependSystemContext).toContain(
      "`query` uses the same FTS5 full-text search path as `lcm_grep`",
    );
    expect(result.prependSystemContext).toContain(
      "`query` is for matching candidate summaries; `prompt` is the natural-language question or task",
    );
    expect(result.prependSystemContext).toContain(
      "For `query`, use 1-3 distinctive terms or a quoted phrase",
    );
    expect(result.prependSystemContext).toContain("## Compacted Conversation Context");
    expect(result.prependSystemContext).toContain(
      "If compacted summaries appear above, treat them as compressed recall cues rather than proof of exact wording or exact values.",
    );
    expect(result.prependSystemContext).toContain(
      'If a summary includes an "Expand for details about:" footer, use it as a cue to expand before asserting specifics.',
    );
    expect(result.prependSystemContext).toContain(
      "For exact commands, SHAs, paths, timestamps, config values, or causal chains, expand for details before answering.",
    );
    expect(result.prependSystemContext).toContain("**Precision flow:**");
    expect(result.prependSystemContext).toContain("1. `lcm_grep` to find the relevant summaries or messages");
    expect(result.prependSystemContext).toContain("2. `lcm_expand_query` when you need exact evidence before answering");
    expect(result.prependSystemContext).toContain("**Uncertainty checklist:**");
    expect(result.prependSystemContext).toContain("Could compaction have omitted a crucial detail?");
    expect(result.prependSystemContext).toContain(
      "Lossless-claw does not supersede memory tools globally",
    );
    expect(result.prependSystemContext).not.toContain("memory_search");
    expect(result.prependSystemContext).not.toContain("memory_get");
  });
});

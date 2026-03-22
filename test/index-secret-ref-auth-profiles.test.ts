import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import lcmPlugin from "../index.js";
import { closeLcmConnection } from "../src/db/connection.js";

const piAiMock = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  getModel: vi.fn(),
  getModels: vi.fn(),
  getEnvApiKey: vi.fn(),
  getOAuthApiKey: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => piAiMock);

type RegisteredEngineFactory = (() => unknown) | undefined;

function buildApi(params?: {
  config?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
}): {
  api: OpenClawPluginApi;
  getFactory: () => RegisteredEngineFactory;
  dbPath: string;
} {
  let factory: RegisteredEngineFactory;
  const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);

  const api = {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: "/tmp/lossless-claw",
    config: (params?.config ?? {}) as OpenClawPluginApi["config"],
    pluginConfig: {
      enabled: true,
      dbPath,
      ...(params?.pluginConfig ?? {}),
    },
    runtime: {
      subagent: {
        run: vi.fn(),
        waitForRun: vi.fn(),
        getSession: vi.fn(),
        deleteSession: vi.fn(),
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
    registerContextEngine: vi.fn((_id: string, nextFactory: () => unknown) => {
      factory = nextFactory;
    }),
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
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;

  return {
    api,
    getFactory: () => factory,
    dbPath,
  };
}

async function callComplete(params: {
  agentDir: string;
  config?: Record<string, unknown>;
  provider?: string;
  model?: string;
}) {
  const provider = params.provider ?? "lossless-test-provider";
  const model = params.model ?? "test-model";
  const { api, getFactory, dbPath } = buildApi({ config: params.config });

  lcmPlugin.register(api);
  const factory = getFactory();
  if (!factory) {
    throw new Error("Expected LCM engine factory to be registered.");
  }

  const engine = factory() as {
    deps: {
      complete: (input: {
        provider: string;
        model: string;
        agentDir?: string;
        messages: Array<{ role: string; content: string }>;
        maxTokens: number;
      }) => Promise<unknown>;
    };
  };

  try {
    await engine.deps.complete({
      provider,
      model,
      agentDir: params.agentDir,
      messages: [{ role: "user", content: "Summarize this." }],
      maxTokens: 256,
    });
  } finally {
    closeLcmConnection(dbPath);
  }
}

describe("auth-profile SecretRef resolution in complete()", () => {
  const tempDirs = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    piAiMock.completeSimple.mockResolvedValue({
      content: [{ type: "text", text: "summary output" }],
    });
    piAiMock.getModel.mockReturnValue(undefined);
    piAiMock.getModels.mockReturnValue([]);
    piAiMock.getEnvApiKey.mockReturnValue(undefined);
    piAiMock.getOAuthApiKey.mockResolvedValue({
      apiKey: "oauth-helper-api-key",
      newCredentials: {
        access: "oauth-helper-access",
        refresh: "oauth-helper-refresh",
        expires: Date.now() + 60_000,
        accountId: "acct-1",
      },
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("resolves env-backed tokenRef values from auth-profiles.json", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lossless-claw-auth-"));
    tempDirs.add(agentDir);

    writeFileSync(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "lossless-test-provider:env": {
              type: "token",
              provider: "lossless-test-provider",
              tokenRef: {
                source: "env",
                provider: "default",
                id: "LOSSLESS_SECRET_REF_ENV",
              },
            },
          },
          order: {
            "lossless-test-provider": ["lossless-test-provider:env"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    vi.stubEnv("LOSSLESS_SECRET_REF_ENV", "env-secret-value");

    await callComplete({
      agentDir,
    });

    expect(piAiMock.completeSimple).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        apiKey: "env-secret-value",
      }),
    );
  });

  it("resolves file-backed keyRef values through configured secret providers", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "lossless-claw-secret-provider-"));
    tempDirs.add(rootDir);

    const agentDir = join(rootDir, "agent");
    mkdirSync(agentDir, { recursive: true });
    const mountedSecretPath = join(rootDir, "mounted-secret.txt");
    writeFileSync(mountedSecretPath, "single-value-secret\n", "utf8");

    writeFileSync(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "lossless-test-provider:file": {
              type: "api_key",
              provider: "lossless-test-provider",
              keyRef: {
                source: "file",
                provider: "rawfile",
                id: "value",
              },
            },
          },
          order: {
            "lossless-test-provider": ["lossless-test-provider:file"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await callComplete({
      agentDir,
      config: {
        secrets: {
          providers: {
            rawfile: {
              source: "file",
              path: mountedSecretPath,
              mode: "singleValue",
            },
          },
        },
      },
    });

    expect(piAiMock.completeSimple).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        apiKey: "single-value-secret",
      }),
    );
  });

  it("prefers the OAuth helper for openai-codex auth profiles even when the cached token is unexpired", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "lossless-claw-openai-codex-auth-"));
    tempDirs.add(agentDir);
    vi.stubEnv("HOME", agentDir);
    vi.stubEnv("OPENCLAW_AGENT_DIR", "");
    vi.stubEnv("PI_CODING_AGENT_DIR", "");

    writeFileSync(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              access: "cached-access-token",
              refresh: "cached-refresh-token",
              expires: Date.now() + 60_000,
              accountId: "acct-cached",
            },
          },
          order: {
            "openai-codex": ["openai-codex:default"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await callComplete({
      agentDir,
      provider: "openai-codex",
      model: "gpt-5.4",
    });

    expect(piAiMock.getOAuthApiKey).toHaveBeenCalledWith("openai-codex", {
      "openai-codex": expect.objectContaining({
        access: "cached-access-token",
        refresh: "cached-refresh-token",
        accountId: "acct-cached",
      }),
    });
    expect(piAiMock.completeSimple).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({
        apiKey: "oauth-helper-api-key",
      }),
    );
  });
});

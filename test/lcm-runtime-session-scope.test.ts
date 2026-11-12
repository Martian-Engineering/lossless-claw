import { describe, expect, it, vi } from "vitest";
import { resolveLcmConversationScope } from "../src/tools/lcm-conversation-scope.js";

describe("runtime session recall identity", () => {
  const requestedKey = "agent:fixture:main";

  async function resolve(input: {
    runtimeKey: string | null;
    runtimeActive?: boolean;
    keyedActive?: boolean;
    sameConversation?: boolean;
    missingRuntime?: boolean;
  }) {
    const keyed = {
      conversationId: 101,
      sessionId: "keyed-runtime",
      sessionKey: requestedKey,
      active: input.keyedActive ?? true,
    };
    const runtime = {
      conversationId: input.sameConversation ? 101 : 202,
      sessionId: "shared-runtime",
      sessionKey: input.runtimeKey,
      active: input.runtimeActive ?? true,
    };
    const store = {
      getConversationBySessionKey: vi.fn(async () => keyed),
      getConversationBySessionId: vi.fn(async () => input.missingRuntime ? null : runtime),
      getConversationFamilyIds: vi.fn(async ({ conversationId }: { conversationId: number }) =>
        conversationId === 101 ? [101, 100] : [202, 201]),
    };
    const warn = vi.fn();
    const scope = await resolveLcmConversationScope({
      lcm: { getConversationStore: () => store } as never,
      sessionKey: " " + requestedKey + " ",
      sessionId: "shared-runtime",
      params: {},
      deps: {
        isSubagentSessionKey: () => false,
        log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      },
    });
    return { scope, store, warn };
  }

  it.each([true, false])("keeps the requested key when an active runtime ID collides (keyed active=%s)", async (keyedActive) => {
    const { scope, store, warn } = await resolve({
      runtimeKey: "agent:fixture:internal-review",
      keyedActive,
    });
    expect(scope).toMatchObject({ conversationId: 101, conversationIds: [101, 100], delegated: false });
    expect(store.getConversationFamilyIds).toHaveBeenCalledWith({
      conversationId: 101, sessionId: undefined, sessionKey: requestedKey,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([requestedKey, " " + requestedKey + " ", null, "", "  "])("preserves active runtime preference for a matching or absent key (%s)", async (runtimeKey) => {
    const { scope, warn } = await resolve({ runtimeKey });
    expect(scope).toMatchObject({ conversationId: 202, conversationIds: [202, 201] });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not prefer an inactive runtime generation", async () => {
    const { scope, warn } = await resolve({ runtimeKey: requestedKey, runtimeActive: false });
    expect(scope.conversationId).toBe(101);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when both identities select the same conversation", async () => {
    const { scope, warn } = await resolve({ runtimeKey: requestedKey, sameConversation: true });
    expect(scope.conversationId).toBe(101);
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves keyed lookup when the runtime ID is not found", async () => {
    const { scope, warn } = await resolve({ runtimeKey: requestedKey, missingRuntime: true });
    expect(scope.conversationId).toBe(101);
    expect(warn).not.toHaveBeenCalled();
  });
});

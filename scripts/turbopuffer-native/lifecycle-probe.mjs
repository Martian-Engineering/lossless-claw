import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { randomUUID } from "node:crypto";
import {
  NativeDatabase,
  NativeHttpIo,
  resolveLcmConfig,
} from "../../dist/experimental/turbopuffer-native.js";
import { FakeTranscriptHost } from "../../dist/experimental/turbopuffer-fake-host.js";
// Run in a fresh, short-lived process: hook both ESM and CommonJS before loading the engine.
const sqliteGuard = registerHooks({
  resolve(specifier, context, next) {
    return specifier === "node:sqlite"
      ? { url: "lcm-denied:sqlite", shortCircuit: true }
      : next(specifier, context);
  },
  load(url, context, next) {
    return url === "lcm-denied:sqlite"
      ? {
          format: "module",
          source:
            'export class DatabaseSync { constructor() { throw new Error("Native lifecycle attempted to open SQLite"); } }',
          shortCircuit: true,
        }
      : next(url, context);
  },
});
const sqlite = await import("node:sqlite");
assert.throws(
  () => new sqlite.DatabaseSync(":memory:"),
  /attempted to open SQLite/
);
assert.throws(
  () =>
    new (createRequire(import.meta.url)("node:sqlite").DatabaseSync)(
      ":memory:"
    ),
  /attempted to open SQLite/
);
const { LcmContextEngine } = await import(
  "../../dist/experimental/turbopuffer-engine.js"
);
export async function lifecycle(apiKey) {
  const db = await NativeDatabase.open({
      organizationId: "synthetic",
      agentId: "main",
      namespacePrefix: `lcm-e2e-${randomUUID()}`,
      apiKey,
      region: "aws-us-east-1",
    }),
    host = new FakeTranscriptHost("native-e2e"),
    key = "agent:main:e2e";
  const log = { info() {}, warn() {}, error() {}, debug() {} },
    config = resolveLcmConfig({}, {}),
    deps = {
      config,
      complete: async () => ({
        content: [{ type: "text", text: "Deterministic fake summary" }],
      }),
      callGateway: async () => ({}),
      resolveModel: () => ({ provider: "test", model: "fake" }),
      parseAgentSessionKey: (s) => ({
        agentId: s.split(":")[1],
        suffix: s.split(":").slice(2).join(":"),
      }),
      normalizeAgentId: (id) => id ?? "main",
      isSubagentSessionKey: (s) => s.includes(":subagent:"),
      buildSubagentSystemPrompt: () => "",
      readLatestAssistantReply: () => undefined,
      resolveAgentDir: () => "/unused",
      agentLaneSubagent: "subagent",
      readSessionTranscriptVisibleMessageDelta: host.readVisibleDelta,
      readSessionTranscriptRawDelta: host.readRawDelta,
      readVisibleSessionTranscriptMessageEntries: host.readVisibleEntries,
      log,
    };
  let passed = false;
  try {
    const e = new LcmContextEngine(deps, db),
      u = host.append({ role: "user", content: "native lifecycle question" }),
      a = host.append({
        role: "assistant",
        content: [{ type: "text", text: "native lifecycle answer" }],
      });
    const anchor = (id) => ({
      agentId: "main",
      sessionId: host.sessionId,
      sessionKey: key,
      storePath: "/host-transcript-only",
      generation: host.generation,
      entryId: id,
      rawSeq: host.positionOf(id),
      effectiveParentId: null,
      activeMessagePosition: host.positionOf(id),
    });
    const params = {
      advancementKey: "one",
      admission: { ...anchor(u), logicalTurnId: "one", role: "user" },
      terminal: anchor(a),
      messages: host.visibleMessages().map((r) => r.message),
      sessionId: host.sessionId,
      sessionKey: key,
    };
    await e.bootstrap({
      sessionId: host.sessionId,
      sessionKey: key,
      sessionTarget: {
        agentId: "main",
        sessionId: host.sessionId,
        sessionKey: key,
      },
    });
    assert.equal((await e.commitTurn(params)).status, "committed");
    assert.equal((await e.commitTurn(params)).status, "duplicate");
    const result = await e.assemble({
      sessionId: host.sessionId,
      sessionKey: key,
      messages: [],
      tokenBudget: 4000,
    });
    assert.match(JSON.stringify(result.messages), /native lifecycle answer/);
    const fresh = new LcmContextEngine(deps, db);
    assert.equal((await fresh.commitTurn(params)).status, "duplicate");
    const conversation = await fresh
        .getConversationStore()
        .getConversationBySessionKey(key),
      grant = await fresh.createExpansionGrant({
        delegatedSessionKey: "agent:main:subagent:child",
        issuerSessionId: key,
        allowedConversationIds: [conversation.conversationId],
      });
    assert.equal(
      await fresh.resolveExpansionGrant("agent:main:subagent:child"),
      grant.grantId
    );
    await fresh.revokeExpansionGrant("agent:main:subagent:child", {
      removeBinding: true,
    });
    passed = true;
  } finally {
    await db.io.client.request("DELETE", "");
    sqliteGuard.deregister();
  }
  return {
    passed,
    sqliteConnectionConstructorBlocked: true,
    esmAndCommonJsGuardVerified: true,
    namespace: db.namespace,
    deleted: true,
    requests: db.io.client.metrics,
  };
}

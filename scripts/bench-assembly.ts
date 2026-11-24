// Synthetic owner-level benchmark, not a Gateway or model-latency measurement.
// npm exec -- esbuild scripts/bench-assembly.ts --bundle --platform=node --format=esm --target=node22 --outfile=.local/bench-assembly.mjs
// node .local/bench-assembly.mjs
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ContextAssembler } from "../src/assembler.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const summarize = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    samples: sorted.length,
    medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0], maxMs: sorted.at(-1),
  };
};

for (const count of [200, 600]) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const features = getLcmDbFeatures(db);
    runLcmMigrations(db, features);
    const conversations = new ConversationStore(db, features);
    const summaries = new SummaryStore(db, features);
    const assembler = new ContextAssembler(conversations, summaries);
    const { conversationId } = await conversations.createConversation({ sessionId: `bench-${count}` });
    const messages = await conversations.createMessagesBulk(Array.from({ length: count }, (_, seq) => ({
      conversationId, seq, role: seq % 2 ? "assistant" as const : "user" as const,
      content: `seed-${count}-${seq}. ok.`, tokenCount: 8,
    })));
    for (const message of messages) {
      await conversations.createMessageParts(message.messageId, [{
        sessionId: `bench-${count}`, partType: "text", ordinal: 0, textContent: message.content,
      }]);
    }
    await summaries.appendContextMessages(conversationId, messages.map((message) => message.messageId));
    let selectPreparations = 0;
    const nativePrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (/\bFROM (messages|message_parts)\b/i.test(sql)) selectPreparations++;
      return nativePrepare(sql);
    };
    const runs = [];
    for (let round = 0; round < 6; round++) {
      selectPreparations = 0;
      const beforeCpu = process.cpuUsage();
      const start = performance.now();
      const result = await assembler.assemble({ conversationId, tokenBudget: 100_000 });
      const elapsedMs = performance.now() - start;
      const cpu = process.cpuUsage(beforeCpu);
      assert.deepEqual(result.messages.map((message) => message.content), messages.map((message) =>
        message.role === "user" ? message.content : [{ type: "text", text: message.content }],
      ));
      runs.push({ round, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, selectPreparations });
    }
    console.log(JSON.stringify({
      node: process.version, platform: process.platform, count,
      scope: "ContextAssembler with real synthetic in-memory SQLite; no Gateway, model, lock-wait or disk-latency claim",
      selectMetric: "message/parts SELECT statement preparations, not all SQLite work",
      cold: runs[0], warm: summarize(runs.slice(1).map((run) => run.elapsedMs)), runs,
    }));
  } finally {
    db.close();
  }
}

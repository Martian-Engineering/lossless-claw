#!/usr/bin/env node
/**
 * v4.2 §B drilldown harness — empirically validate that a real LLM,
 * presented with the v4.2 stub format (`[LCM Tool Output: file_xxx | …]`),
 * actually invokes `lcm_describe(id="file_xxx")` when it needs the
 * elided tool-result content.
 *
 * This closes the gap that adversarial review and unit tests cannot
 * close: the unit tests verify the stub is well-formed and the
 * drilldown path returns the right bytes; only a real model call can
 * verify the agent reaches for the drilldown when needed.
 *
 * What it does:
 *   1. Opens the migrated DB (--db, default audit/v42-bench/lcm-v42-optionc.db)
 *   2. Calls ContextAssembler.assemble(...stubLargeToolPayloads=true) for the
 *      target session, capturing the assembled prompt (which contains stubs)
 *   3. For each of N stub-bearing tool_results in the prompt, constructs
 *      a scenario where the FINAL USER MESSAGE asks specifically about
 *      that tool's output ("In the result of <toolName> on …, what does it
 *      say about X?") — forcing the agent to either drill down or guess
 *   4. Sends the prompt to a real LLM (OpenRouter, configurable model)
 *      with the lcm_describe + lcm_grep tool schemas exposed
 *   5. Observes the response: does the model call lcm_describe with the
 *      correct file_xxx id?
 *   6. (Optional) Round-trips: simulates the tool response by reading
 *      the file from disk, sends a second turn, observes whether the
 *      model uses the content
 *
 * USAGE:
 *   OPENROUTER_API_KEY=$(grep OPENROUTER_API_KEY ~/.openclaw/service-env/ai.openclaw.gateway.env | sed 's/.*=//') \
 *   VOYAGE_API_KEY=$(cat ~/.openclaw/credentials/voyage-api-key) \
 *   LCM_TEST_VEC0_PATH=$HOME/.openclaw/extensions/node_modules/sqlite-vec-darwin-arm64/vec0.dylib \
 *     node scripts/v42-drilldown-harness.mjs --db audit/v42-bench/lcm-v42-optionc.db \
 *       --session-id 0cb8928b-f925-4be1-a995-a30f30938cf4 \
 *       --scenarios 5 --model openai/gpt-4o-mini
 *
 * EXIT CODES:
 *   0 — completed (always 0 unless setup error; report shows PASS/FAIL)
 *   1 — usage / setup error
 *   2 — LLM API error
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// OpenAI rejects tool_call_id > 64 chars. Real production toolCallIds in
// LCM are concatenated forms like `call_X|fc_Y` (83 chars). Hash to a
// stable short id for transport; pairing within the prompt stays consistent
// because we use the SAME hash everywhere.
const idMap = new Map();
function shortenToolCallId(raw) {
  if (typeof raw !== "string" || raw.length === 0) return raw;
  if (raw.length <= 64) return raw;
  let cached = idMap.get(raw);
  if (cached) return cached;
  cached = `call_${createHash("sha1").update(raw).digest("hex").slice(0, 24)}`;
  idMap.set(raw, cached);
  return cached;
}

const args = process.argv.slice(2);
const getArg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i < args.length - 1 ? args[i + 1] : undefined;
};

const dbPath = getArg("db") ?? "/Volumes/LEXAR/repos/lossless-claw/audit/v42-bench/lcm-v42-optionc.db";
const sessionId = getArg("session-id") ?? "0cb8928b-f925-4be1-a995-a30f30938cf4";
const sessionKey = getArg("session-key") ?? "agent:main:main";
const tokenBudget = Number(getArg("budget") ?? 258000);
const scenarios = Number(getArg("scenarios") ?? 3);
const model = getArg("model") ?? "openai/gpt-4o-mini";
const apiKey = process.env.OPENROUTER_API_KEY?.trim();

if (!apiKey) {
  console.error("OPENROUTER_API_KEY env var required");
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}
const VEC0 = process.env.LCM_TEST_VEC0_PATH ??
  join(homedir(), ".openclaw", "extensions", "node_modules", "sqlite-vec-darwin-arm64", "vec0.dylib");
if (!existsSync(VEC0)) { console.error(`vec0 not found: ${VEC0}`); process.exit(1); }
if (!process.env.VOYAGE_API_KEY?.trim()) {
  console.error("VOYAGE_API_KEY env var required");
  process.exit(1);
}

const cwd = process.cwd();
if (!existsSync(`${cwd}/src/db/migration.ts`)) {
  console.error(`Run from repo root. cwd=${cwd}`);
  process.exit(1);
}

// ── Open DB + load schema ──
const db = new DatabaseSync(dbPath, { allowExtension: true });
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

const { tryLoadSqliteVec } = await import(`${cwd}/src/embeddings/store.ts`);
tryLoadSqliteVec(db, { path: VEC0 });
const { runLcmMigrations } = await import(`${cwd}/src/db/migration.ts`);
runLcmMigrations(db, { fts5Available: true, seedDefaultPrompts: false });

// ── Resolve conversation + assemble ──
const convRow = db
  .prepare(`SELECT conversation_id FROM conversations WHERE session_id = ? AND session_key = ? AND active = 1 ORDER BY conversation_id DESC LIMIT 1`)
  .get(sessionId, sessionKey)
  ?? db
  .prepare(`SELECT conversation_id FROM conversations WHERE session_id = ? ORDER BY conversation_id DESC LIMIT 1`)
  .get(sessionId);
if (!convRow) { console.error(`No conversation for session ${sessionId}`); process.exit(2); }
const conversationId = convRow.conversation_id;

const { ContextAssembler } = await import(`${cwd}/src/assembler.ts`);
const { ConversationStore } = await import(`${cwd}/src/store/conversation-store.ts`);
const { SummaryStore } = await import(`${cwd}/src/store/summary-store.ts`);
const conversationStore = new ConversationStore(db);
const summaryStore = new SummaryStore(db);
const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC");

const assembled = await assembler.assemble({
  conversationId,
  tokenBudget,
  freshTailCount: 64,
  freshTailMaxTokens: 24000,
  promptAwareEviction: false,
  stubLargeToolPayloads: true,
});

console.error(`[harness] assembled ${assembled.messages.length} items, stubs=${assembled.debug?.stubStats?.stubbedCount ?? 0}`);

// ── Find stub-bearing toolResult messages we can interrogate ──
// A stub is a toolResult whose content includes `[LCM Tool Output: file_xxx`.
const stubsInPrompt = [];
for (let i = 0; i < assembled.messages.length; i++) {
  const m = assembled.messages[i];
  if (m?.role !== "toolResult") continue;
  const c = typeof m.content === "string"
    ? m.content
    : Array.isArray(m.content) ? (m.content[0]?.text ?? JSON.stringify(m.content)) : "";
  const match = c.match(/\[LCM Tool Output: (file_[a-f0-9]+) \| tool=(\S+) \| ([\d,]+) bytes\]/);
  if (match) {
    stubsInPrompt.push({
      index: i,
      fileId: match[1],
      toolName: match[2],
      bytesStr: match[3],
      toolCallId: m.toolCallId,
      stubText: c,
    });
  }
}
console.error(`[harness] found ${stubsInPrompt.length} stubs in assembled prompt`);
if (stubsInPrompt.length === 0) {
  console.error("No stubs in assembled prompt; nothing to test. Try a different session/budget.");
  process.exit(1);
}

// ── Tool schemas (mirror src/tools/lcm-describe-tool.ts + lcm-grep-tool.ts) ──
const tools = [
  {
    type: "function",
    function: {
      name: "lcm_describe",
      description: "Look up an LCM item by ID, with optional one-hop drilldown. Inspects summaries (sum_xxx) or stored files (file_xxx). Use to inspect the full output of an elided tool result that was replaced with a [LCM Tool Output: file_xxx …] reference in the conversation.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The LCM ID to look up. Use sum_xxx for summaries, file_xxx for files.",
          },
          allConversations: {
            type: "boolean",
            description: "Set true to allow lookups across all conversations.",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lcm_grep",
      description: "Search messages or summaries for a pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          mode: { type: "string", enum: ["regex", "full_text", "verbatim"] },
          scope: { type: "string", enum: ["messages", "summaries", "both"] },
          allConversations: { type: "boolean" },
        },
        required: ["pattern"],
      },
    },
  },
];

// ── Convert assembler output to OpenAI/OpenRouter chat format ──
// We sanitize down to {role, content} and {role:tool, tool_call_id, content}
// for tool results. Strip non-tool-call assistant content into single text.
function toOpenAIFormat(msgs) {
  const out = [];
  // Hard cap: send at most ~80K tokens worth of context to keep cost bounded.
  // We slice from the END (most recent) since the stubs we want to test are
  // typically toward the end of the assembled prompt.
  const MAX_BYTES = 320_000; // ~80K tokens
  let bytes = 0;
  const tail = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    let entry;
    if (m?.role === "user") {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      entry = { role: "user", content: c };
    } else if (m?.role === "assistant") {
      // Convert assistant tool_use blocks into OpenAI tool_calls.
      const content = m.content;
      if (Array.isArray(content)) {
        const textParts = [];
        const toolCalls = [];
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
          } else if (block?.type === "tool_use" && block.id) {
            toolCalls.push({
              id: shortenToolCallId(String(block.id)),
              type: "function",
              function: {
                name: String(block.name ?? "unknown"),
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          }
        }
        entry = {
          role: "assistant",
          content: textParts.join("\n").trim() || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        };
      } else {
        entry = { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) };
      }
    } else if (m?.role === "toolResult") {
      const c = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content) ? (m.content[0]?.text ?? JSON.stringify(m.content)) : JSON.stringify(m.content);
      entry = {
        role: "tool",
        tool_call_id: shortenToolCallId(String(m.toolCallId ?? "unknown")),
        content: c,
      };
    } else {
      continue;
    }
    const size = JSON.stringify(entry).length;
    if (bytes + size > MAX_BYTES) break;
    bytes += size;
    tail.unshift(entry);
  }
  // OpenAI strict pairing: every "tool" message must be preceded by an
  // assistant message with matching tool_calls. Drop orphan tool messages
  // anywhere in the sequence, AND drop assistant tool_calls whose tool
  // responses are missing.
  const valid = [];
  for (const e of tail) {
    if (e.role === "tool") {
      // Find most recent preceding assistant in `valid` with matching tool_call_id.
      let paired = false;
      for (let i = valid.length - 1; i >= 0; i--) {
        const prev = valid[i];
        if (prev.role === "assistant" && Array.isArray(prev.tool_calls)) {
          if (prev.tool_calls.some((tc) => tc.id === e.tool_call_id)) paired = true;
          break;
        }
        if (prev.role !== "tool") break; // any non-tool, non-assistant breaks the chain
      }
      if (paired) valid.push(e);
      // else drop the orphan tool message
      continue;
    }
    if (e.role === "assistant" && Array.isArray(e.tool_calls) && e.tool_calls.length > 0) {
      // Provisionally include — we'll drop it later if its responses don't follow.
      valid.push(e);
      continue;
    }
    valid.push(e);
  }
  // Final pass: drop assistant entries with tool_calls whose responses
  // didn't make it into `valid` immediately after.
  const finalSeq = [];
  for (let i = 0; i < valid.length; i++) {
    const e = valid[i];
    if (e.role === "assistant" && Array.isArray(e.tool_calls) && e.tool_calls.length > 0) {
      const expected = new Set(e.tool_calls.map((tc) => tc.id));
      const found = new Set();
      let j = i + 1;
      while (j < valid.length && valid[j].role === "tool") {
        found.add(valid[j].tool_call_id);
        j++;
      }
      const allPresent = [...expected].every((id) => found.has(id));
      if (!allPresent) {
        // Drop the assistant tool_calls but keep its text content if any.
        if (e.content && typeof e.content === "string" && e.content.trim()) {
          finalSeq.push({ role: "assistant", content: e.content });
        }
        // Skip the dangling tool messages too.
        i = j - 1;
        continue;
      }
    }
    finalSeq.push(e);
  }
  return finalSeq;
}

// ── LLM call via OpenRouter ──
async function llmCall(messages, opts = {}) {
  const body = {
    model,
    messages,
    tools,
    tool_choice: opts.toolChoice ?? "auto",
    max_tokens: 1024,
    temperature: 0,
  };
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "v4.2 drilldown harness",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LLM API ${res.status}: ${t.slice(0, 500)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message ?? {};
}

// ── Run scenarios ──
const results = [];
const sample = stubsInPrompt.slice(0, scenarios);

for (let s = 0; s < sample.length; s++) {
  const stub = sample[s];
  console.error(`\n[harness] scenario ${s + 1}/${sample.length}: testing drilldown for ${stub.fileId} (tool=${stub.toolName}, ${stub.bytesStr} bytes)`);

  const baseMsgs = toOpenAIFormat(assembled.messages);
  // Append the test question. We deliberately ask for specifics that
  // could ONLY be answered by inspecting the elided content. The model
  // either drills down via lcm_describe(file_xxx) or admits it can't.
  // Three question modes:
  //   --explicit (default): names the fileId, forces the agent to act
  //   --medium: references the elided form but doesn't say "use tools"
  //   --soft: pure user question, no hint that elision happened
  const mode = args.includes("--soft") ? "soft" : args.includes("--medium") ? "medium" : "explicit";
  const userQuestion = mode === "soft"
    ? `Earlier in this session you ran a ${stub.toolName} call. What did it actually return? I need the specifics, not a summary.`
    : mode === "medium"
      ? `Looking at the conversation, one of your ${stub.toolName} tool results is shown as a [LCM Tool Output: ${stub.fileId} | …] reference instead of the actual output. What did the tool actually return?`
      : `I'm reviewing what happened earlier in this session. In the tool call where you ran ${stub.toolName} (the result is currently elided as ${stub.fileId} — see the [LCM Tool Output: ${stub.fileId} …] reference above), what was actually in the output? I need to see the actual content. Use the available tools to get it if needed, then summarize what was returned.`;
  baseMsgs.push({ role: "user", content: userQuestion });

  let drilldown = null;
  let llmError = null;
  let response;
  try {
    response = await llmCall(baseMsgs);
  } catch (err) {
    llmError = String(err?.message ?? err);
    console.error(`[harness]   LLM error: ${llmError}`);
    results.push({ stub: stub.fileId, toolCalled: null, drilledDown: false, llmError });
    continue;
  }

  // Check tool calls
  const toolCalls = response.tool_calls ?? [];
  for (const tc of toolCalls) {
    const fnName = tc.function?.name;
    let argsObj = {};
    try { argsObj = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* */ }
    if (fnName === "lcm_describe" && typeof argsObj.id === "string") {
      drilldown = argsObj.id;
      break;
    }
  }
  const correctId = drilldown === stub.fileId;
  console.error(`[harness]   tool_calls: ${toolCalls.map((t) => `${t.function?.name}(${t.function?.arguments})`).join(", ") || "(none)"}`);
  console.error(`[harness]   drilldown invoked: ${drilldown ?? "no"} ${correctId ? "✓ (correct id)" : drilldown ? "✗ (wrong id)" : ""}`);

  results.push({
    stub: stub.fileId,
    toolName: stub.toolName,
    bytes: stub.bytesStr,
    toolCalled: toolCalls.map((t) => t.function?.name) ?? [],
    drilledDown: drilldown != null,
    correctId,
    drilldownId: drilldown,
    llmError,
    contentSnippet: typeof response.content === "string" ? response.content.slice(0, 300) : null,
  });
}

// ── Report ──
const passed = results.filter((r) => r.drilledDown && r.correctId).length;
const total = results.length;
const passRate = total > 0 ? (passed / total) : 0;
const report = {
  db: dbPath,
  sessionId,
  conversationId,
  model,
  totalScenarios: total,
  passed,
  passRate,
  passThreshold: 0.7,
  passVerdict: passRate >= 0.7 ? "PASS" : "FAIL",
  scenarios: results,
};

console.log(JSON.stringify(report, null, 2));
db.close();
process.exit(0);

import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LiteralMessageSearchInput, MessageRecord } from "../store/conversation-store.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import {
  resolveLcmConversationScope,
  type LcmConversationScope,
} from "./lcm-conversation-scope.js";

const EXACT_KEY_PATTERN = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const MAX_EXACT_KEYS = 4;
const DEFAULT_LIMIT_PER_KEY = 2;
const MAX_LIMIT_PER_KEY = 5;
const CANDIDATE_BATCH_SIZE = 50;
const MAX_CANDIDATES_PER_KEY = 500;
const MAX_SNIPPET_CHARS = 800;
const SENSITIVE_KEY_IDENTIFIER_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:ACCESS_?KEY|API_?KEY|AUTH|CREDENTIALS?|DEPLOY_?KEY|KEY|PASS(?:WORD)?|PRIVATE_?KEY|SECRET|TOKEN)(?=$|[^A-Za-z0-9])/i;
const SENSITIVE_SNIPPET_IDENTIFIER_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:ACCESS_?KEY|API_?KEY|AUTH|CREDENTIALS?|DEPLOY_?KEY|PASS(?:WORD)?|PRIVATE_?KEY|SECRET|TOKEN)(?=$|[^A-Za-z0-9])/i;
const SENSITIVE_VALUE_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\b(?:sk|rk|pk)[_-][A-Za-z0-9_-]{10,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b)/i;
const ELIGIBLE_MESSAGE_ROLES: MessageRecord["role"][] = ["user", "assistant"];

type RecallCandidateStore = ReturnType<LcmContextEngine["getConversationStore"]> & {
  findMessagesContainingLiteral?: (input: LiteralMessageSearchInput) => Promise<MessageRecord[]>;
};

const LcmRecallKeysSchema = Type.Object({
  keys: Type.Array(
    Type.String({
      description:
        "Exact all-caps identifier to recover from stored raw messages, for example CRABPOT_LCM_FACT. Secret-shaped identifiers such as API_KEY or TOKEN are refused.",
    }),
    {
      description: `Exact identifier keys to recall. At most ${MAX_EXACT_KEYS} keys are searched per call.`,
      minItems: 1,
      maxItems: MAX_EXACT_KEYS,
    },
  ),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Physical conversation ID to search within. If omitted, defaults to the current session family.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to explicitly search across all conversations. Ignored when conversationId is provided.",
    }),
  ),
  limitPerKey: Type.Optional(
    Type.Number({
      description: `Maximum evidence snippets per key. Default: ${DEFAULT_LIMIT_PER_KEY}.`,
      minimum: 1,
      maximum: MAX_LIMIT_PER_KEY,
    }),
  ),
});

type RecallKeysMatch = {
  key: string;
  messageId: number;
  conversationId: number;
  role: MessageRecord["role"];
  createdAt: string;
  snippet: string;
};

type SkippedKey = {
  key: string;
  reason: "duplicate" | "not_exact_key" | "sensitive_identifier";
};

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function exactKeyRegex(key: string): string {
  return `(^|[^A-Za-z0-9_])${escapeRegexLiteral(key)}($|[^A-Za-z0-9_])`;
}

function isSensitiveIdentifier(value: string): boolean {
  return SENSITIVE_KEY_IDENTIFIER_PATTERN.test(value);
}

function containsSensitiveMaterial(value: string): boolean {
  return SENSITIVE_SNIPPET_IDENTIFIER_PATTERN.test(value) || SENSITIVE_VALUE_PATTERN.test(value);
}

function findExactKeyIndex(content: string, key: string): number {
  const match = new RegExp(exactKeyRegex(key)).exec(content);
  return match ? match.index + (match[1]?.length ?? 0) : -1;
}

function lineBounds(content: string, keyIndex: number): { start: number; end: number } {
  const searchStart = Math.max(0, keyIndex - 1);
  const previousLineBreak = Math.max(
    content.lastIndexOf("\n", searchStart),
    content.lastIndexOf("\r", searchStart),
  );
  const start = previousLineBreak >= 0 ? previousLineBreak + 1 : 0;
  const nextLineFeed = content.indexOf("\n", keyIndex);
  const nextCarriageReturn = content.indexOf("\r", keyIndex);
  let end = content.length;
  if (nextLineFeed >= 0 && nextCarriageReturn >= 0) {
    end = Math.min(nextLineFeed, nextCarriageReturn);
  } else if (nextLineFeed >= 0) {
    end = nextLineFeed;
  } else if (nextCarriageReturn >= 0) {
    end = nextCarriageReturn;
  }
  return { start, end };
}

function sentenceStart(line: string, keyIndex: number): number {
  let start = 0;
  for (const match of line.slice(0, keyIndex).matchAll(/[.!?](?:\s+|$)/g)) {
    start = (match.index ?? 0) + match[0].length;
  }
  return start;
}

function sentenceEnd(line: string, keyIndex: number, keyLength: number): number {
  const afterKey = keyIndex + keyLength;
  const match = /[.!?](?:\s|$)/.exec(line.slice(afterKey));
  return match ? afterKey + match.index + 1 : line.length;
}

function clipSnippet(snippet: string, key: string): string {
  if (snippet.length <= MAX_SNIPPET_CHARS) {
    return snippet;
  }
  const keyIndex = findExactKeyIndex(snippet, key);
  if (keyIndex < 0) {
    return snippet.slice(0, MAX_SNIPPET_CHARS);
  }
  const contextBeforeKey = Math.floor(MAX_SNIPPET_CHARS * 0.75);
  const start = Math.max(0, keyIndex - contextBeforeKey);
  const end = Math.min(snippet.length, start + MAX_SNIPPET_CHARS);
  return `${start > 0 ? "..." : ""}${snippet.slice(start, end)}${end < snippet.length ? "..." : ""}`;
}

function normalizeSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function extractExactKeySnippet(content: string, key: string): string | null {
  const keyIndex = findExactKeyIndex(content, key);
  if (keyIndex < 0) {
    return null;
  }
  const bounds = lineBounds(content, keyIndex);
  const line = content.slice(bounds.start, bounds.end);
  const relativeKeyIndex = keyIndex - bounds.start;
  const rawSnippet = clipSnippet(
    line.slice(sentenceStart(line, relativeKeyIndex), sentenceEnd(line, relativeKeyIndex, key.length)),
    key,
  );
  if (containsSensitiveMaterial(rawSnippet)) {
    return null;
  }
  const snippet = normalizeSnippet(rawSnippet);
  return snippet.length > 0 ? snippet : null;
}

function isEligibleMessageRole(role: MessageRecord["role"]): boolean {
  return ELIGIBLE_MESSAGE_ROLES.includes(role);
}

function normalizeKeys(rawKeys: unknown): {
  keys: string[];
  skippedKeys: SkippedKey[];
} {
  const inputKeys = Array.isArray(rawKeys) ? rawKeys : [];
  const seen = new Set<string>();
  const keys: string[] = [];
  const skippedKeys: SkippedKey[] = [];

  for (const rawKey of inputKeys.slice(0, MAX_EXACT_KEYS)) {
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    if (!EXACT_KEY_PATTERN.test(key)) {
      skippedKeys.push({ key, reason: "not_exact_key" });
      continue;
    }
    if (isSensitiveIdentifier(key)) {
      skippedKeys.push({ key, reason: "sensitive_identifier" });
      continue;
    }
    if (seen.has(key)) {
      skippedKeys.push({ key, reason: "duplicate" });
      continue;
    }
    seen.add(key);
    keys.push(key);
  }
  return { keys, skippedKeys };
}

async function loadCandidateMessages(input: {
  store: RecallCandidateStore;
  conversationScope: LcmConversationScope;
  key: string;
  limit: number;
  offset: number;
}): Promise<MessageRecord[]> {
  if (typeof input.store.findMessagesContainingLiteral === "function") {
    return input.store.findMessagesContainingLiteral({
      conversationId: input.conversationScope.conversationId,
      conversationIds: input.conversationScope.conversationIds,
      literal: input.key,
      roles: ELIGIBLE_MESSAGE_ROLES,
      limit: input.limit,
      offset: input.offset,
    });
  }

  if (input.offset > 0) {
    return [];
  }

  const candidates = await input.store.searchMessages({
    conversationId: input.conversationScope.conversationId,
    conversationIds: input.conversationScope.conversationIds,
    query: exactKeyRegex(input.key),
    mode: "regex",
    limit: MAX_CANDIDATES_PER_KEY,
    sort: "recency",
  });
  const storedMessages: MessageRecord[] = [];
  for (const candidate of candidates) {
    const stored = await input.store.getMessageById(candidate.messageId);
    if (stored) {
      storedMessages.push(stored);
    }
  }
  return storedMessages;
}

export function createLcmRecallKeysTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_recall_keys",
    label: "LCM Recall Keys",
    description:
      "Recover exact all-caps identifier facts from stored raw LCM messages without mutating assembled context. " +
      "Use this before broader grep/expand when the user asks for a named key such as PROJECT_FLAG or RELEASE_NOTE_ID and the active summary/tail does not show the value. " +
      "Returns bounded evidence snippets with source message IDs. Refuses secret-shaped keys and snippets.",
    parameters: LcmRecallKeysSchema,
    async execute(_toolCallId: string, params: unknown) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }

      const p = params as Record<string, unknown>;
      const { keys, skippedKeys } = normalizeKeys(p.keys);
      if (keys.length === 0) {
        return jsonResult({
          error: "No usable exact recall keys were provided.",
          skippedKeys,
          matches: [],
          matchCount: 0,
        });
      }

      const limitPerKey = Math.max(
        1,
        Math.min(
          MAX_LIMIT_PER_KEY,
          typeof p.limitPerKey === "number" && Number.isFinite(p.limitPerKey)
            ? Math.trunc(p.limitPerKey)
            : DEFAULT_LIMIT_PER_KEY,
        ),
      );
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });
      if (!conversationScope.allConversations && conversationScope.conversationId == null) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
          keys,
          skippedKeys,
          matches: [],
          matchCount: 0,
        });
      }

      const store = lcm.getConversationStore() as RecallCandidateStore;
      const matches: RecallKeysMatch[] = [];
      const seenMatches = new Set<string>();
      for (const key of keys) {
        let acceptedForKey = 0;
        let scannedForKey = 0;
        let offset = 0;
        while (acceptedForKey < limitPerKey && scannedForKey < MAX_CANDIDATES_PER_KEY) {
          const candidates = await loadCandidateMessages({
            store,
            conversationScope,
            key,
            limit: Math.min(CANDIDATE_BATCH_SIZE, MAX_CANDIDATES_PER_KEY - scannedForKey),
            offset,
          });
          if (candidates.length === 0) {
            break;
          }
          scannedForKey += candidates.length;
          offset += candidates.length;
          for (const stored of candidates) {
            if (acceptedForKey >= limitPerKey) {
              break;
            }
            const seenKey = `${key}:${stored.messageId}`;
            if (seenMatches.has(seenKey) || !isEligibleMessageRole(stored.role)) {
              continue;
            }
            const snippet = extractExactKeySnippet(stored.content, key);
            if (!snippet) {
              continue;
            }
            seenMatches.add(seenKey);
            acceptedForKey++;
            matches.push({
              key,
              messageId: stored.messageId,
              conversationId: stored.conversationId,
              role: stored.role,
              createdAt: stored.createdAt.toISOString(),
              snippet,
            });
          }
        }
      }

      return jsonResult({
        keys,
        skippedKeys,
        conversationScope: {
          allConversations: conversationScope.allConversations,
          conversationId: conversationScope.conversationId,
          conversationIds: conversationScope.conversationIds,
        },
        matches,
        matchCount: matches.length,
      });
    },
  };
}

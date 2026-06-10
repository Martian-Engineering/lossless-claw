/**
 * Prompt-recall cue helpers: sensitive-identifier detection and snippet extraction for surfacing prior-context recall hints.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { extractMessageContent, type StoredMessage } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const PROMPT_RECALL_IDENTIFIER_PATTERN = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

export const PROMPT_RECALL_MAX_IDENTIFIERS = 4;

export const PROMPT_RECALL_MAX_MESSAGES = 4;

export const PROMPT_RECALL_MAX_MESSAGE_CHARS = 1200;

export const PROMPT_RECALL_SEARCH_LIMIT = PROMPT_RECALL_MAX_MESSAGES * 2;

export const PROMPT_RECALL_SEARCH_CANDIDATE_LIMIT = PROMPT_RECALL_SEARCH_LIMIT * 4;

export const PROMPT_RECALL_SENSITIVE_IDENTIFIER_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:ACCESS_?KEY|API_?KEY|AUTH|CREDENTIALS?|DEPLOY_?KEY|KEY|PASS(?:WORD)?|PRIVATE_?KEY|SECRET|TOKEN)(?=$|[^A-Za-z0-9])/i;

export const PROMPT_RECALL_SENSITIVE_VALUE_PATTERN =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{10,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b|\b(?:sk|rk|pk)_[A-Za-z0-9_]{10,}\b)/i;

export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isPromptRecallSensitiveIdentifier(identifier: string): boolean {
  return PROMPT_RECALL_SENSITIVE_IDENTIFIER_PATTERN.test(identifier);
}

export function containsPromptRecallSensitiveMaterial(value: string): boolean {
  return (
    PROMPT_RECALL_SENSITIVE_IDENTIFIER_PATTERN.test(value) ||
    PROMPT_RECALL_SENSITIVE_VALUE_PATTERN.test(value)
  );
}

export function findPromptRecallIdentifierIndex(content: string, identifier: string): number {
  const match = new RegExp(
    `(^|[^A-Za-z0-9_])${escapeRegexLiteral(identifier)}($|[^A-Za-z0-9_])`,
  ).exec(content);
  return match ? match.index + (match[1]?.length ?? 0) : -1;
}

export function findPromptRecallLineStart(content: string, identifierIndex: number): number {
  const searchStart = Math.max(0, identifierIndex - 1);
  const previousLineBreak = Math.max(
    content.lastIndexOf("\n", searchStart),
    content.lastIndexOf("\r", searchStart),
  );
  return previousLineBreak >= 0 ? previousLineBreak + 1 : 0;
}

export function findPromptRecallLineEnd(content: string, identifierIndex: number): number {
  const nextLineFeed = content.indexOf("\n", identifierIndex);
  const nextCarriageReturn = content.indexOf("\r", identifierIndex);
  if (nextLineFeed < 0) {
    return nextCarriageReturn >= 0 ? nextCarriageReturn : content.length;
  }
  if (nextCarriageReturn < 0) {
    return nextLineFeed;
  }
  return Math.min(nextLineFeed, nextCarriageReturn);
}

export function findPromptRecallSentenceStart(line: string, relativeIdentifierIndex: number): number {
  let sentenceStart = 0;
  for (const match of line.slice(0, relativeIdentifierIndex).matchAll(/[.!?](?:\s+|$)/g)) {
    sentenceStart = (match.index ?? 0) + match[0].length;
  }
  return sentenceStart;
}

export function findPromptRecallSentenceEnd(
  line: string,
  relativeIdentifierIndex: number,
  identifierLength: number,
): number {
  const afterIdentifierStart = relativeIdentifierIndex + identifierLength;
  const match = /[.!?](?:\s|$)/.exec(line.slice(afterIdentifierStart));
  return match ? afterIdentifierStart + match.index + 1 : line.length;
}

export function clipPromptRecallSnippet(snippet: string, identifier: string): string {
  if (snippet.length <= PROMPT_RECALL_MAX_MESSAGE_CHARS) {
    return snippet;
  }
  const identifierIndex = findPromptRecallIdentifierIndex(snippet, identifier);
  if (identifierIndex < 0) {
    return snippet.slice(0, PROMPT_RECALL_MAX_MESSAGE_CHARS);
  }
  const preferredContextBeforeIdentifier = Math.floor(PROMPT_RECALL_MAX_MESSAGE_CHARS * 0.75);
  const start = Math.max(0, identifierIndex - preferredContextBeforeIdentifier);
  const end = Math.min(snippet.length, start + PROMPT_RECALL_MAX_MESSAGE_CHARS);
  return `${start > 0 ? "..." : ""}${snippet.slice(start, end)}${end < snippet.length ? "..." : ""}`;
}

export function extractPromptRecallSnippet(content: string, identifier: string): string | null {
  const identifierIndex = findPromptRecallIdentifierIndex(content, identifier);
  if (identifierIndex < 0) {
    return null;
  }
  const lineStart = findPromptRecallLineStart(content, identifierIndex);
  const lineEnd = findPromptRecallLineEnd(content, identifierIndex);
  const line = content.slice(lineStart, lineEnd);
  const relativeIdentifierIndex = identifierIndex - lineStart;
  const sentenceStart = findPromptRecallSentenceStart(line, relativeIdentifierIndex);
  const sentenceEnd = findPromptRecallSentenceEnd(line, relativeIdentifierIndex, identifier.length);
  const rawSnippet = clipPromptRecallSnippet(line.slice(sentenceStart, sentenceEnd), identifier);
  if (containsPromptRecallSensitiveMaterial(rawSnippet)) {
    return null;
  }
  const snippet = normalizePromptRecallText(rawSnippet);
  return snippet.length > 0 ? snippet : null;
}

export function isPromptRecallEligibleRole(role: StoredMessage["role"]): boolean {
  return role === "user" || role === "assistant";
}

export function extractPromptRecallIdentifiers(prompt?: string): string[] {
  if (typeof prompt !== "string" || !prompt.trim()) {
    return [];
  }
  return [...new Set(prompt.match(PROMPT_RECALL_IDENTIFIER_PATTERN) ?? [])]
    .filter((identifier) => !isPromptRecallSensitiveIdentifier(identifier))
    .slice(
      0,
      PROMPT_RECALL_MAX_IDENTIFIERS,
    );
}

export function renderPromptRecallMessage(params: {
  identifier: string;
  role: StoredMessage["role"];
  content: string;
}): string {
  const singleLine = normalizePromptRecallText(params.content);
  const clipped =
    singleLine.length > PROMPT_RECALL_MAX_MESSAGE_CHARS
      ? `${singleLine.slice(0, PROMPT_RECALL_MAX_MESSAGE_CHARS)}...`
      : singleLine;
  return `- ${params.role} matched ${params.identifier}: ${JSON.stringify(clipped)}`;
}

export function normalizePromptRecallText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizePromptRecallCoverageText(value: string): string {
  return normalizePromptRecallText(value).replace(/[.!?]$/, "");
}

export function buildPromptRecallProjectionFingerprint(message: AgentMessage): string {
  const content = "content" in message ? extractMessageContent(message.content) : JSON.stringify(message);
  return [
    "prompt-recall-v1",
    createHash("sha256").update(content).digest("hex").slice(0, 32),
  ].join(":");
}

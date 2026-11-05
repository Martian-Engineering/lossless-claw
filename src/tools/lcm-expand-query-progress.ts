import { createHash } from "node:crypto";

// These bound navigation work, independently of the source-token grant.
const MAX_RETRIEVAL_CALLS = 24;
const MAX_NO_PROGRESS_RESULTS = 3;
const MAX_EVIDENCE_CHARS = 32_000;

export class ExpandQueryProgress {
  private seenMessages = new Set<string>();
  private seenEvidence = new Set<string>();
  private calls = 0;
  private noProgress = 0;
  private evidenceChars = 0;
  readonly evidence: string[] = [];
  modelRef?: string;
  hasResults = false;

  observe(messages: unknown[]): "tool_limit" | "no_progress" | undefined {
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const m = message as Record<string, unknown>;
      const encoded = JSON.stringify(m);
      const key = createHash("sha256").update(encoded).digest("hex");
      if (this.seenMessages.has(key)) continue;
      this.seenMessages.add(key);
      if (m.role === "assistant" && Array.isArray(m.content)) {
        if (typeof m.provider === "string" && m.provider !== "openclaw" && typeof m.model === "string") {
          this.modelRef = m.model.startsWith(`${m.provider}/`) ? m.model : `${m.provider}/${m.model}`;
        }
        this.calls += m.content.filter((block) =>
          block && typeof block === "object" && ["toolCall", "tool_use", "function_call"].includes(block.type),
        ).length;
      }
      if (m.role !== "toolResult" && m.role !== "tool") continue;
      this.hasResults = true;
      const text = typeof m.content === "string" ? m.content : Array.isArray(m.content)
        ? m.content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "";
      const metrics: number[] = [];
      collectProgressMetrics(m.details, metrics);
      collectProgressMetrics(m.content, metrics);
      const empty = metrics.length > 0 && metrics.every((value) => value === 0);
      const evidenceKey = createHash("sha256").update(text).digest("hex");
      if (m.isError || empty || !text.trim() || this.seenEvidence.has(evidenceKey)) {
        this.noProgress++;
      } else {
        this.noProgress = 0;
        this.seenEvidence.add(evidenceKey);
        const bounded = text.slice(0, Math.max(0, MAX_EVIDENCE_CHARS - this.evidenceChars));
        if (bounded) {
          this.evidence.push(bounded);
          this.evidenceChars += bounded.length;
        }
      }
    }
    if (this.calls >= MAX_RETRIEVAL_CALLS) return "tool_limit";
    if (this.noProgress >= MAX_NO_PROGRESS_RESULTS) return "no_progress";
    return undefined;
  }
}

// Code Mode can wrap native result details in JSON text blocks.
function collectProgressMetrics(value: unknown, metrics: number[], depth = 0): void {
  if (depth > 12 || value == null) return;
  if (typeof value === "string") {
    if (value.length <= MAX_EVIDENCE_CHARS && /^[\s]*[\[{]/.test(value)) {
      try { collectProgressMetrics(JSON.parse(value), metrics, depth + 1); } catch { /* Plain tool text. */ }
    }
  } else if (Array.isArray(value)) {
    for (const child of value) collectProgressMetrics(child, metrics, depth + 1);
  } else if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "summary" && record.summary) return;
    // Only native result counters indicate empty retrieval, not counters inside source data.
    if (typeof record.expansionCount === "number" && typeof record.totalTokens === "number") {
      if (Number.isFinite(record.totalTokens)) metrics.push(record.totalTokens);
      return;
    }
    if (typeof record.totalMatches === "number" && ("messageCount" in record || "messages" in record)) {
      if (Number.isFinite(record.totalMatches)) metrics.push(record.totalMatches);
      return;
    }
    for (const child of Object.values(record)) collectProgressMetrics(child, metrics, depth + 1);
  }
}

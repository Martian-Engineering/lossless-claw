import crypto from "node:crypto";
import {
  createDelegatedExpansionGrant,
  revokeDelegatedExpansionGrantForSession,
} from "./expansion-auth.js";
import { estimateTokens } from "./estimate-tokens.js";
import type { ActiveFocusSummaryRecord } from "./store/focus-brief-store.js";
import type { LcmDependencies } from "./types.js";
import {
  clearDelegatedExpansionContext,
  resolveExpansionRequestId,
  stampDelegatedExpansionContext,
} from "./tools/lcm-expansion-recursion-guard.js";

const DEFAULT_FOCUS_BRIEF_TARGET_TOKENS = 12_000;
const MAX_FOCUS_BRIEF_TARGET_TOKENS = 30_000;
const FOCUS_BRIEF_TARGET_TOKEN_MULTIPLIER = 10;
const FOCUS_BRIEF_MINIMUM_TOKEN_RATIO = 0.6;
const MIN_FOCUS_BRIEF_TARGET_TOKENS = 12_000;

/** A future recall question that would help deepen a generated focus brief. */
export type FocusBriefExpansionPrompt = {
  prompt: string;
  summaryIds: string[];
};

/** Structured result returned by the delegated focus brief generator. */
export type FocusBriefGeneration = {
  status: "ok" | "timeout" | "error";
  runId: string;
  childSessionKey: string;
  briefMarkdown: string;
  citedSummaryIds: string[];
  expandedSummaryIds: string[];
  irrelevantSummaryIds: string[];
  expansionPrompts: FocusBriefExpansionPrompt[];
  confidenceNotes: string[];
  tokenCount: number;
  targetTokens: number;
  truncated: boolean;
  rawReply?: string;
  rawResultJson?: string;
  error?: string;
};

type ParsedFocusBriefReply = {
  briefMarkdown: string;
  citedSummaryIds: string[];
  expandedSummaryIds: string[];
  irrelevantSummaryIds: string[];
  expansionPrompts: FocusBriefExpansionPrompt[];
  confidenceNotes: string[];
  truncated: boolean;
  rawResultJson?: string;
};

type FocusBriefDeps = Pick<
  LcmDependencies,
  | "agentLaneSubagent"
  | "buildSubagentSystemPrompt"
  | "callGateway"
  | "config"
  | "normalizeAgentId"
  | "parseAgentSessionKey"
  | "readLatestAssistantReply"
>;

type FocusBriefAttemptResult =
  | {
      status: "ok";
      runId: string;
      parsed: ParsedFocusBriefReply;
      tokenCount: number;
      rawReply?: string;
    }
  | {
      status: "timeout" | "error";
      runId: string;
      error: string;
    };

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function normalizeExpansionPrompts(value: unknown): FocusBriefExpansionPrompt[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: FocusBriefExpansionPrompt[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { prompt?: unknown; summaryIds?: unknown };
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!prompt) {
      continue;
    }
    output.push({
      prompt,
      summaryIds: normalizeStringArray(record.summaryIds),
    });
  }
  return output;
}

function parseFocusBriefReply(rawReply: string | undefined): ParsedFocusBriefReply {
  const reply = rawReply?.trim();
  if (!reply) {
    throw new Error("Focus brief subagent returned an empty reply.");
  }

  const candidates: string[] = [reply];
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.unshift(fenced[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const briefMarkdown =
        typeof parsed.briefMarkdown === "string"
          ? parsed.briefMarkdown.trim()
          : typeof parsed.brief === "string"
            ? parsed.brief.trim()
            : "";
      if (!briefMarkdown) {
        throw new Error("Focus brief JSON did not include briefMarkdown.");
      }
      return {
        briefMarkdown,
        citedSummaryIds: normalizeStringArray(parsed.citedSummaryIds),
        expandedSummaryIds: normalizeStringArray(parsed.expandedSummaryIds),
        irrelevantSummaryIds: normalizeStringArray(parsed.irrelevantSummaryIds),
        expansionPrompts: normalizeExpansionPrompts(parsed.expansionPrompts),
        confidenceNotes: normalizeStringArray(parsed.confidenceNotes),
        truncated: parsed.truncated === true,
        rawResultJson: candidate,
      };
    } catch {
      // Keep trying alternate candidates before surfacing a parse failure.
    }
  }

  throw new Error("Focus brief subagent did not return valid JSON.");
}

function truncatePreview(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }
  return `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
}

function buildActiveSummaryManifest(summaries: ActiveFocusSummaryRecord[]): string {
  return summaries
    .map((summary) => {
      const preview = truncatePreview(summary.content, 600);
      return [
        `<summary_ref ordinal="${summary.ordinal}" id="${summary.summaryId}" kind="${summary.kind}" depth="${summary.depth}" token_count="${summary.tokenCount}" latest_at="${summary.latestAt ?? ""}">`,
        preview,
        "</summary_ref>",
      ].join("\n");
    })
    .join("\n\n");
}

function resolveFocusTargetTokens(summaryTokens: number): number {
  if (!Number.isFinite(summaryTokens) || summaryTokens <= 0) {
    return DEFAULT_FOCUS_BRIEF_TARGET_TOKENS;
  }
  const expandedTarget = Math.floor(summaryTokens * FOCUS_BRIEF_TARGET_TOKEN_MULTIPLIER);
  return Math.min(
    MAX_FOCUS_BRIEF_TARGET_TOKENS,
    Math.max(MIN_FOCUS_BRIEF_TARGET_TOKENS, expandedTarget),
  );
}

function resolveFocusMinimumTokens(targetTokens: number): number {
  return Math.max(1_000, Math.floor(targetTokens * FOCUS_BRIEF_MINIMUM_TOKEN_RATIO));
}

function resolveFocusExpansionTokenCap(params: {
  summaryTokens: number;
  targetTokens: number;
  defaultExpandTokens: number;
}): number {
  const configured = Math.max(1, Math.floor(params.defaultExpandTokens));
  const summaryDerived = Math.max(configured, Math.floor(params.summaryTokens * 10));
  const targetDerived = Math.max(configured, Math.floor(params.targetTokens * 2));
  return Math.min(120_000, Math.max(configured, summaryDerived, targetDerived, 40_000));
}

function buildFocusBriefTask(params: {
  focusPrompt: string;
  conversationId: number;
  summaries: ActiveFocusSummaryRecord[];
  targetTokens: number;
  requestId: string;
  originSessionKey: string;
}): string {
  const minimumTokens = resolveFocusMinimumTokens(params.targetTokens);
  // The prompt is deliberately prescriptive because this artifact is meant to
  // occupy context budget as working memory, not summarize the topic briefly.
  return [
    "Generate a Lossless focus context brief.",
    "",
    "You are a delegated subagent. Your job is to build a rich, evidence-oriented brief that a future model can use as task-shaped memory. This is not a concise summary.",
    "",
    "Focus prompt:",
    `<focus_prompt>${params.focusPrompt}</focus_prompt>`,
    "",
    `Conversation ID: ${params.conversationId}`,
    `Target brief length: ${minimumTokens}-${params.targetTokens} tokens`,
    `Minimum acceptable length: ${minimumTokens} tokens`,
    `Request ID: ${params.requestId}`,
    `Origin session key: ${params.originSessionKey}`,
    "",
    "Length and density requirements:",
    "- Use the available budget aggressively. Prefer dense, specific working memory over a short overview.",
    "- If the brief would be shorter than the minimum acceptable length, continue searching and expanding relevant summaries before finalizing.",
    "- Include concrete decisions, file paths, command names, issue IDs, summary IDs, constraints, rejected options, unresolved questions, and handoff details when relevant.",
    "- Do not pad with generic prose. Add detail by expanding evidence, recording provenance, and spelling out useful operational context.",
    "",
    "Required recall workflow:",
    "1. Use lcm_grep with mode='full_text', scope='summaries', and this conversationId to discover relevant summaries.",
    "2. Use lcm_describe on promising summary IDs to inspect metadata, parent/child relationships, and expansion costs.",
    "3. Use lcm_expand directly on high-value summary IDs to recover key details. Expand enough evidence to support a long brief. You are in delegated context, so do NOT call lcm_expand_query.",
    "4. Synthesize the brief from evidence. Mark uncertainty when you only inferred something from summaries.",
    "",
    "Active summary context at generation time:",
    "<active_summary_context>",
    buildActiveSummaryManifest(params.summaries),
    "</active_summary_context>",
    "",
    "Return ONLY JSON with this shape:",
    "{",
    '  "briefMarkdown": "markdown context brief",',
    '  "citedSummaryIds": ["sum_xxx"],',
    '  "expandedSummaryIds": ["sum_xxx"],',
    '  "irrelevantSummaryIds": ["sum_xxx"],',
    '  "expansionPrompts": [{"prompt": "question to ask later", "summaryIds": ["sum_xxx"]}],',
    '  "confidenceNotes": ["what is expanded evidence vs inferred synthesis"],',
    '  "truncated": false',
    "}",
    "",
    "The markdown brief must include:",
    "- Focused Narrative: about 25% of the brief, chronological and decision-rich.",
    "- Current Working State: about 25%, including active branches, files, tests, commands, blockers, and next actions.",
    "- Evidence Map with summary IDs: about 20%, tying claims to summary IDs and expanded material.",
    "- Expansion Guide with concrete future recall prompts: about 15%, including exact lcm_grep or lcm_expand follow-ups.",
    "- Risks And Gaps: about 10%, including contradictions, stale assumptions, and unknowns.",
    "- Likely Irrelevant Context: brief but explicit, with summary IDs when possible.",
    "- Confidence Notes: separate expanded evidence from inferred synthesis.",
  ].join("\n");
}

function buildFocusBriefExpansionTask(params: {
  focusPrompt: string;
  previousBrief: string;
  tokenCount: number;
  targetTokens: number;
}): string {
  const minimumTokens = resolveFocusMinimumTokens(params.targetTokens);
  // Retry in the same child session so the agent can reuse its earlier recall
  // work while being forced to produce a denser final JSON payload.
  return [
    "The previous focus brief was too short. Expand it substantially.",
    "",
    "Focus prompt:",
    `<focus_prompt>${params.focusPrompt}</focus_prompt>`,
    "",
    `Previous estimated length: ${params.tokenCount} tokens`,
    `Required minimum length: ${minimumTokens} tokens`,
    `Target length: ${params.targetTokens} tokens`,
    "",
    "Instructions:",
    "- Preserve the useful material from the previous brief, but produce a new complete final brief.",
    "- Use more lcm_grep, lcm_describe, and lcm_expand calls before finalizing.",
    "- Add concrete details, provenance, edge cases, unresolved questions, commands, file paths, issue IDs, and summary IDs.",
    "- Do NOT call lcm_expand_query from this delegated context.",
    "- Return ONLY the same JSON shape requested previously.",
    "",
    "Previous brief:",
    "<previous_brief>",
    params.previousBrief,
    "</previous_brief>",
  ].join("\n");
}

function buildFocusAgentParams(params: {
  deps: FocusBriefDeps;
  childSessionKey: string;
  message: string;
}): Record<string, unknown> {
  // Keep provider/model and subagent-lane handling identical across initial and
  // retry turns so length enforcement does not change runtime policy.
  const agentParams: Record<string, unknown> = {
    message: params.message,
    sessionKey: params.childSessionKey,
    deliver: false,
    lane: params.deps.agentLaneSubagent,
    extraSystemPrompt: params.deps.buildSubagentSystemPrompt({
      depth: 1,
      maxDepth: 8,
      taskSummary: "Generate a Lossless focus brief using lcm_grep, lcm_describe, and lcm_expand.",
    }),
  };
  if (params.deps.config.expansionProvider.trim()) {
    agentParams.provider = params.deps.config.expansionProvider.trim();
  }
  if (params.deps.config.expansionModel.trim()) {
    agentParams.model = params.deps.config.expansionModel.trim();
  }
  return agentParams;
}

// Run one child-session turn and parse its JSON focus brief response.
async function runFocusBriefAttempt(params: {
  deps: FocusBriefDeps;
  childSessionKey: string;
  message: string;
  timeoutMs: number;
}): Promise<FocusBriefAttemptResult> {
  let runId = "";
  try {
    const response = (await params.deps.callGateway({
      method: "agent",
      params: buildFocusAgentParams({
        deps: params.deps,
        childSessionKey: params.childSessionKey,
        message: params.message,
      }),
      timeoutMs: 10_000,
    })) as { runId?: string };
    runId =
      typeof response?.runId === "string" && response.runId ? response.runId : crypto.randomUUID();

    // Wait for the subagent turn, then read the latest assistant response from
    // the session. Reusing the session key for retries keeps the previous brief
    // and recall work visible to the child.
    const wait = (await params.deps.callGateway({
      method: "agent.wait",
      params: { runId, timeoutMs: params.timeoutMs },
      timeoutMs: params.timeoutMs,
    })) as { status?: string; error?: string };
    const status = typeof wait?.status === "string" ? wait.status : "error";
    if (status === "timeout") {
      return {
        status: "timeout",
        runId,
        error: "delegated focus brief generation timed out",
      };
    }
    if (status !== "ok") {
      return {
        status: "error",
        runId,
        error: typeof wait?.error === "string" ? wait.error : "delegated focus brief generation failed",
      };
    }

    const replyPayload = (await params.deps.callGateway({
      method: "sessions.get",
      params: { key: params.childSessionKey, limit: 80 },
      timeoutMs: 10_000,
    })) as { messages?: unknown[] };
    const rawReply = params.deps.readLatestAssistantReply(
      Array.isArray(replyPayload.messages) ? replyPayload.messages : [],
    );
    const parsed = parseFocusBriefReply(rawReply);
    return {
      status: "ok",
      runId,
      parsed,
      tokenCount: estimateTokens(parsed.briefMarkdown),
      rawReply,
    };
  } catch (err) {
    return {
      status: "error",
      runId: runId || crypto.randomUUID(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Spawn a delegated subagent to build an evidence-oriented focus brief from the
 * current active summary context without mutating canonical Lossless state.
 */
export async function runDelegatedFocusBrief(params: {
  deps: FocusBriefDeps;
  requesterSessionKey: string;
  conversationId: number;
  focusPrompt: string;
  summaries: ActiveFocusSummaryRecord[];
}): Promise<FocusBriefGeneration> {
  const summaryTokens = params.summaries.reduce((sum, summary) => sum + Math.max(0, summary.tokenCount), 0);
  const targetTokens = resolveFocusTargetTokens(summaryTokens);
  const tokenCap = resolveFocusExpansionTokenCap({
    summaryTokens,
    targetTokens,
    defaultExpandTokens: params.deps.config.maxExpandTokens,
  });
  const minimumTokens = resolveFocusMinimumTokens(targetTokens);
  const timeoutMs = Math.max(1, Math.floor(params.deps.config.delegationTimeoutMs));
  const requestId = resolveExpansionRequestId(params.requesterSessionKey);
  const requesterAgentId = params.deps.normalizeAgentId(
    params.deps.parseAgentSessionKey(params.requesterSessionKey)?.agentId,
  );
  const childSessionKey = `agent:${requesterAgentId}:subagent:${crypto.randomUUID()}`;
  let runId = "";

  createDelegatedExpansionGrant({
    delegatedSessionKey: childSessionKey,
    issuerSessionId: params.requesterSessionKey,
    allowedConversationIds: [params.conversationId],
    tokenCap,
    ttlMs: timeoutMs + 60_000,
  });
  stampDelegatedExpansionContext({
    sessionKey: childSessionKey,
    requestId,
    expansionDepth: 1,
    originSessionKey: params.requesterSessionKey,
    stampedBy: "runDelegatedFocusBrief",
  });

  try {
    const message = buildFocusBriefTask({
      focusPrompt: params.focusPrompt,
      conversationId: params.conversationId,
      summaries: params.summaries,
      targetTokens,
      requestId,
      originSessionKey: params.requesterSessionKey,
    });
    let attempt = await runFocusBriefAttempt({
      deps: params.deps,
      childSessionKey,
      message,
      timeoutMs,
    });
    runId = attempt.runId;
    if (attempt.status === "timeout") {
      return {
        status: "timeout",
        runId: attempt.runId,
        childSessionKey,
        briefMarkdown: "",
        citedSummaryIds: [],
        expandedSummaryIds: [],
        irrelevantSummaryIds: [],
        expansionPrompts: [],
        confidenceNotes: [],
        tokenCount: 0,
        targetTokens,
        truncated: true,
        error: attempt.error,
      };
    }
    if (attempt.status !== "ok") {
      return {
        status: "error",
        runId: attempt.runId,
        childSessionKey,
        briefMarkdown: "",
        citedSummaryIds: [],
        expandedSummaryIds: [],
        irrelevantSummaryIds: [],
        expansionPrompts: [],
        confidenceNotes: [],
        tokenCount: 0,
        targetTokens,
        truncated: true,
        error: attempt.error,
      };
    }

    let shortRetryError: string | undefined;
    if (attempt.tokenCount < minimumTokens) {
      const retry = await runFocusBriefAttempt({
        deps: params.deps,
        childSessionKey,
        message: buildFocusBriefExpansionTask({
          focusPrompt: params.focusPrompt,
          previousBrief: attempt.parsed.briefMarkdown,
          tokenCount: attempt.tokenCount,
          targetTokens,
        }),
        timeoutMs,
      });
      if (retry.status === "ok") {
        attempt = retry;
      } else {
        shortRetryError = `Short-output retry failed: ${retry.error}`;
      }
      runId = retry.runId;
    }

    const parsed = attempt.parsed;
    const stillShort = attempt.tokenCount < minimumTokens;
    return {
      status: "ok",
      runId: attempt.runId,
      childSessionKey,
      briefMarkdown: parsed.briefMarkdown,
      citedSummaryIds: parsed.citedSummaryIds,
      expandedSummaryIds: parsed.expandedSummaryIds,
      irrelevantSummaryIds: parsed.irrelevantSummaryIds,
      expansionPrompts: parsed.expansionPrompts,
      confidenceNotes: parsed.confidenceNotes,
      tokenCount: attempt.tokenCount,
      targetTokens,
      truncated: parsed.truncated,
      rawReply: attempt.rawReply,
      rawResultJson: parsed.rawResultJson,
      error:
        shortRetryError ??
        (stillShort
          ? `Focus brief remained below the ${minimumTokens}-token minimum after retry.`
          : undefined),
    };
  } catch (err) {
    return {
      status: "error",
      runId: runId || crypto.randomUUID(),
      childSessionKey,
      briefMarkdown: "",
      citedSummaryIds: [],
      expandedSummaryIds: [],
      irrelevantSummaryIds: [],
      expansionPrompts: [],
      confidenceNotes: [],
      tokenCount: 0,
      targetTokens,
      truncated: true,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      await params.deps.callGateway({
        method: "sessions.delete",
        params: { key: childSessionKey, deleteTranscript: true },
        timeoutMs: 10_000,
      });
    } catch {
      // Cleanup is best-effort.
    }
    revokeDelegatedExpansionGrantForSession(childSessionKey, { removeBinding: true });
    clearDelegatedExpansionContext(childSessionKey);
  }
}

export const __focusBriefTesting = {
  buildActiveSummaryManifest,
  buildFocusBriefTask,
  parseFocusBriefReply,
  resolveFocusMinimumTokens,
  resolveFocusTargetTokens,
};

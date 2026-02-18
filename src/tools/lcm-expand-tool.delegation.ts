import crypto from "node:crypto";
import type { LcmContextEngine } from "../engine.js";
import {
  createDelegatedExpansionGrant,
  revokeDelegatedExpansionGrantForSession,
} from "../expansion-auth.js";
import type { LcmDependencies } from "../types.js";

const MAX_GATEWAY_TIMEOUT_MS = 2_147_483_647;

type DelegatedPassStatus = "ok" | "timeout" | "error";

type DelegatedExpansionPassResult = {
  pass: number;
  status: DelegatedPassStatus;
  runId: string;
  childSessionKey: string;
  summary: string;
  citedIds: string[];
  followUpSummaryIds: string[];
  totalTokens: number;
  truncated: boolean;
  rawReply?: string;
  error?: string;
};

export type DelegatedExpansionLoopResult = {
  status: DelegatedPassStatus;
  passes: DelegatedExpansionPassResult[];
  citedIds: string[];
  totalTokens: number;
  truncated: boolean;
  text: string;
  error?: string;
};

export function normalizeSummaryIds(input: string[] | undefined): string[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function parseDelegatedExpansionReply(rawReply: string | undefined): {
  summary: string;
  citedIds: string[];
  followUpSummaryIds: string[];
  totalTokens: number;
  truncated: boolean;
} {
  const fallback = {
    summary: (rawReply ?? "").trim(),
    citedIds: [] as string[],
    followUpSummaryIds: [] as string[],
    totalTokens: 0,
    truncated: false,
  };
  const reply = rawReply?.trim();
  if (!reply) {
    return fallback;
  }

  const candidates: string[] = [reply];
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.unshift(fenced[1].trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        summary?: unknown;
        citedIds?: unknown;
        followUpSummaryIds?: unknown;
        totalTokens?: unknown;
        truncated?: unknown;
      };
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      const citedIds = normalizeSummaryIds(
        Array.isArray(parsed.citedIds)
          ? parsed.citedIds.filter((value): value is string => typeof value === "string")
          : undefined,
      );
      const followUpSummaryIds = normalizeSummaryIds(
        Array.isArray(parsed.followUpSummaryIds)
          ? parsed.followUpSummaryIds.filter((value): value is string => typeof value === "string")
          : undefined,
      );
      const totalTokens =
        typeof parsed.totalTokens === "number" && Number.isFinite(parsed.totalTokens)
          ? Math.max(0, Math.floor(parsed.totalTokens))
          : 0;
      const truncated = parsed.truncated === true;
      return {
        summary: summary || fallback.summary,
        citedIds,
        followUpSummaryIds,
        totalTokens,
        truncated,
      };
    } catch {
      // Keep parsing candidates until one succeeds.
    }
  }

  return fallback;
}

function formatDelegatedExpansionText(passes: DelegatedExpansionPassResult[]): string {
  const lines: string[] = [];
  const allCitedIds = new Set<string>();

  for (const pass of passes) {
    for (const summaryId of pass.citedIds) {
      allCitedIds.add(summaryId);
    }
    if (!pass.summary.trim()) {
      continue;
    }
    if (passes.length > 1) {
      lines.push(`Pass ${pass.pass}: ${pass.summary.trim()}`);
    } else {
      lines.push(pass.summary.trim());
    }
  }

  if (lines.length === 0) {
    lines.push("Delegated expansion completed with no textual summary.");
  }

  if (allCitedIds.size > 0) {
    lines.push("", "Cited IDs:", ...Array.from(allCitedIds).map((value) => `- ${value}`));
  }

  return lines.join("\n");
}

function buildDelegatedExpansionTask(params: {
  summaryIds: string[];
  conversationId: number;
  maxDepth?: number;
  tokenCap?: number;
  includeMessages: boolean;
  pass: number;
  query?: string;
}) {
  const payload: {
    summaryIds: string[];
    conversationId: number;
    maxDepth?: number;
    tokenCap?: number;
    includeMessages: boolean;
  } = {
    summaryIds: params.summaryIds,
    conversationId: params.conversationId,
    maxDepth: params.maxDepth,
    includeMessages: params.includeMessages,
  };
  if (typeof params.tokenCap === "number" && Number.isFinite(params.tokenCap)) {
    payload.tokenCap = params.tokenCap;
  }
  return [
    "Run LCM expansion and report distilled findings.",
    params.query ? `Original query: ${params.query}` : undefined,
    `Pass ${params.pass}`,
    "",
    "Call `lcm_expand` using exactly this JSON payload:",
    JSON.stringify(payload, null, 2),
    "",
    "Then return ONLY JSON with this shape:",
    "{",
    '  "summary": "string concise findings",',
    '  "citedIds": ["sum_xxx"],',
    '  "followUpSummaryIds": ["sum_xxx"],',
    '  "totalTokens": 0,',
    '  "truncated": false',
    "}",
    "",
    "Rules:",
    "- Keep summary concise and factual.",
    "- citedIds/followUpSummaryIds must contain unique summary IDs only.",
    "- If no follow-up is needed, return an empty followUpSummaryIds array.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * Resolve the requester's active LCM conversation ID from the session store.
 * This allows delegated expansion to stay scoped even when conversationId
 * wasn't passed explicitly in the tool call.
 */
export async function resolveRequesterConversationScopeId(params: {
  deps: Pick<LcmDependencies, "resolveSessionIdFromSessionKey">;
  requesterSessionKey: string;
  lcm: LcmContextEngine;
}): Promise<number | undefined> {
  const requesterSessionKey = params.requesterSessionKey.trim();
  if (!requesterSessionKey) {
    return undefined;
  }

  try {
    const runtimeSessionId = await params.deps.resolveSessionIdFromSessionKey(requesterSessionKey);
    if (!runtimeSessionId) {
      return undefined;
    }
    const conversation = await params.lcm
      .getConversationStore()
      .getConversationBySessionId(runtimeSessionId);
    return conversation?.conversationId;
  } catch {
    return undefined;
  }
}

/**
 * Execute one delegated pass via a scoped sub-agent session.
 * Each pass creates its own grant/session and always performs cleanup.
 */
async function runDelegatedExpansionPass(params: {
  deps: Pick<
    LcmDependencies,
    | "callGateway"
    | "parseAgentSessionKey"
    | "normalizeAgentId"
    | "buildSubagentSystemPrompt"
    | "readLatestAssistantReply"
    | "agentLaneSubagent"
  >;
  requesterSessionKey: string;
  conversationId: number;
  summaryIds: string[];
  maxDepth?: number;
  tokenCap?: number;
  includeMessages: boolean;
  query?: string;
  pass: number;
}): Promise<DelegatedExpansionPassResult> {
  const requesterAgentId = params.deps.normalizeAgentId(
    params.deps.parseAgentSessionKey(params.requesterSessionKey)?.agentId,
  );
  const childSessionKey = `agent:${requesterAgentId}:subagent:${crypto.randomUUID()}`;
  let runId = "";

  createDelegatedExpansionGrant({
    delegatedSessionKey: childSessionKey,
    issuerSessionId: params.requesterSessionKey,
    allowedConversationIds: [params.conversationId],
    ttlMs: MAX_GATEWAY_TIMEOUT_MS,
  });

  try {
    const message = buildDelegatedExpansionTask({
      summaryIds: params.summaryIds,
      conversationId: params.conversationId,
      maxDepth: params.maxDepth,
      tokenCap: params.tokenCap,
      includeMessages: params.includeMessages,
      pass: params.pass,
      query: params.query,
    });
    const response = (await params.deps.callGateway({
      method: "agent",
      params: {
        message,
        sessionKey: childSessionKey,
        deliver: false,
        lane: params.deps.agentLaneSubagent,
        extraSystemPrompt: params.deps.buildSubagentSystemPrompt({
          depth: 1,
          maxDepth: 8,
          taskSummary: "Run lcm_expand and return JSON findings",
        }),
      },
      timeoutMs: 10_000,
    })) as { runId?: string };
    runId =
      typeof response?.runId === "string" && response.runId ? response.runId : crypto.randomUUID();

    const wait = (await params.deps.callGateway({
      method: "agent.wait",
      params: {
        runId,
        timeoutMs: MAX_GATEWAY_TIMEOUT_MS,
      },
      timeoutMs: MAX_GATEWAY_TIMEOUT_MS,
    })) as { status?: string; error?: string };
    const status = typeof wait?.status === "string" ? wait.status : "error";
    if (status === "timeout") {
      return {
        pass: params.pass,
        status: "timeout",
        runId,
        childSessionKey,
        summary: "",
        citedIds: [],
        followUpSummaryIds: [],
        totalTokens: 0,
        truncated: true,
        error: "delegated expansion pass timed out",
      };
    }
    if (status !== "ok") {
      return {
        pass: params.pass,
        status: "error",
        runId,
        childSessionKey,
        summary: "",
        citedIds: [],
        followUpSummaryIds: [],
        totalTokens: 0,
        truncated: true,
        error: typeof wait?.error === "string" ? wait.error : "delegated expansion pass failed",
      };
    }

    const replyPayload = (await params.deps.callGateway({
      method: "sessions.get",
      params: { key: childSessionKey, limit: 80 },
      timeoutMs: 10_000,
    })) as { messages?: unknown[] };
    const reply = params.deps.readLatestAssistantReply(
      Array.isArray(replyPayload.messages) ? replyPayload.messages : [],
    );
    const parsed = parseDelegatedExpansionReply(reply);
    return {
      pass: params.pass,
      status: "ok",
      runId,
      childSessionKey,
      summary: parsed.summary,
      citedIds: parsed.citedIds,
      followUpSummaryIds: parsed.followUpSummaryIds,
      totalTokens: parsed.totalTokens,
      truncated: parsed.truncated,
      rawReply: reply,
    };
  } catch (err) {
    return {
      pass: params.pass,
      status: "error",
      runId: runId || crypto.randomUUID(),
      childSessionKey,
      summary: "",
      citedIds: [],
      followUpSummaryIds: [],
      totalTokens: 0,
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
  }
}

export async function runDelegatedExpansionLoop(params: {
  deps: Pick<
    LcmDependencies,
    | "callGateway"
    | "parseAgentSessionKey"
    | "normalizeAgentId"
    | "buildSubagentSystemPrompt"
    | "readLatestAssistantReply"
    | "agentLaneSubagent"
  >;
  requesterSessionKey: string;
  conversationId: number;
  summaryIds: string[];
  maxDepth?: number;
  tokenCap?: number;
  includeMessages: boolean;
  query?: string;
}): Promise<DelegatedExpansionLoopResult> {
  const passes: DelegatedExpansionPassResult[] = [];
  const visited = new Set<string>();
  const cited = new Set<string>();
  let queue = normalizeSummaryIds(params.summaryIds);

  let pass = 1;
  while (queue.length > 0) {
    for (const summaryId of queue) {
      visited.add(summaryId);
    }
    const result = await runDelegatedExpansionPass({
      deps: params.deps,
      requesterSessionKey: params.requesterSessionKey,
      conversationId: params.conversationId,
      summaryIds: queue,
      maxDepth: params.maxDepth,
      tokenCap: params.tokenCap,
      includeMessages: params.includeMessages,
      query: params.query,
      pass,
    });
    passes.push(result);

    if (result.status !== "ok") {
      const okPasses = passes.filter((entry) => entry.status === "ok");
      for (const okPass of okPasses) {
        for (const summaryId of okPass.citedIds) {
          cited.add(summaryId);
        }
      }
      const text =
        okPasses.length > 0
          ? formatDelegatedExpansionText(okPasses)
          : "Delegated expansion failed before any pass completed.";
      return {
        status: result.status,
        passes,
        citedIds: Array.from(cited),
        totalTokens: okPasses.reduce((sum, entry) => sum + entry.totalTokens, 0),
        truncated: true,
        text,
        error: result.error,
      };
    }

    for (const summaryId of result.citedIds) {
      cited.add(summaryId);
    }

    const nextQueue = result.followUpSummaryIds.filter((summaryId) => !visited.has(summaryId));
    queue = nextQueue;
    pass += 1;
  }

  return {
    status: "ok",
    passes,
    citedIds: Array.from(cited),
    totalTokens: passes.reduce((sum, entry) => sum + entry.totalTokens, 0),
    truncated: passes.some((entry) => entry.truncated),
    text: formatDelegatedExpansionText(passes),
  };
}

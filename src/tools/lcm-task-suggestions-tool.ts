import { createHash } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type {
  ObservedWorkDensityItem,
  ObservedWorkKind,
  ObservedWorkStatus,
} from "../store/observed-work-store.js";
import type {
  TaskBridgeSuggestionKind,
  TaskBridgeSuggestionStatus,
} from "../store/task-bridge-suggestion-store.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

const STATUS_VALUES = [
  "observed_completed",
  "observed_unfinished",
  "observed_ambiguous",
  "decision_recorded",
  "dismissed",
] as const;

const KIND_VALUES = [
  "implementation",
  "review",
  "blocker",
  "decision",
  "question",
  "follow_up",
  "test",
  "deploy",
  "research",
  "other",
] as const;

const REVIEW_STATUS_VALUES = ["accepted", "rejected", "dismissed", "expired"] as const;

const LcmTaskSuggestionsSchema = Type.Object({
  conversationId: Type.Optional(Type.Number({ description: "Conversation ID to inspect. Defaults to the current session conversation." })),
  allConversations: Type.Optional(Type.Boolean({ description: "Explicitly inspect all conversations. Defaults to false." })),
  since: Type.Optional(Type.String({ description: "Only include observed items last seen at or after this ISO timestamp." })),
  before: Type.Optional(Type.String({ description: "Only include observed items first seen before this ISO timestamp." })),
  topic: Type.Optional(Type.String({ description: "Exact observed-work topic_key filter." })),
  statuses: Type.Optional(Type.Array(Type.String({ enum: [...STATUS_VALUES] }), { description: "Observed statuses to turn into suggestions. Defaults to unfinished and ambiguous." })),
  kinds: Type.Optional(Type.Array(Type.String({ enum: [...KIND_VALUES] }), { description: "Observed work kinds to include." })),
  minConfidence: Type.Optional(Type.Number({ description: "Minimum observed confidence. Default 0.6.", minimum: 0, maximum: 1 })),
  includeSources: Type.Optional(Type.Boolean({ description: "Include source IDs in output. Defaults to false." })),
  mode: Type.Optional(Type.String({ enum: ["preview", "record"], description: "preview returns suggestions without writing; record stores pending suggestions in the LCM suggestion ledger." })),
  limit: Type.Optional(Type.Number({ description: "Maximum suggestions to return. Default 10.", minimum: 1, maximum: 50 })),
});

const LcmTaskSuggestionReviewSchema = Type.Object({
  suggestionId: Type.String({ description: "Suggestion ID to review." }),
  status: Type.String({ enum: [...REVIEW_STATUS_VALUES], description: "Review state to record in the LCM suggestion ledger." }),
  reviewedBy: Type.Optional(Type.String({ description: "Reviewer identifier for audit metadata." })),
});

function stableSuggestionId(workItemId: string, suggestionKind: TaskBridgeSuggestionKind): string {
  return `sug_${createHash("sha256").update(`${workItemId}:${suggestionKind}`).digest("hex").slice(0, 24)}`;
}

function parseTimestamp(value: unknown, key: string): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${key} must be a valid ISO timestamp.`);
  }
  return parsed.toISOString();
}

function arrayParam<T extends string>(value: unknown, allowed: readonly T[], key: string): T[] | undefined {
  if (value == null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array.`);
  }
  const allowedSet = new Set<string>(allowed);
  return value.map((entry) => {
    if (typeof entry !== "string" || !allowedSet.has(entry)) {
      throw new Error(`${key} contains an unsupported value: ${String(entry)}`);
    }
    return entry as T;
  });
}

function suggestionKindFor(item: ObservedWorkDensityItem): TaskBridgeSuggestionKind {
  void item;
  // Observed-work items do not carry an authoritative external task id. Until a
  // later opt-in linker supplies one, suggestions stay task-creation previews
  // rather than targeted mutations such as mark_task_blocked or add_task_evidence.
  return "create_task";
}

function sourceIdsFor(item: ObservedWorkDensityItem): string[] {
  return [
    ...new Set(
      (item.sources ?? [])
        .map((source) => source.sourceId.trim())
        .filter((sourceId) => sourceId.length > 0)
    ),
  ];
}

function suggestionFor(item: ObservedWorkDensityItem, includeSources: boolean): {
  suggestionId: string;
  workItemId: string;
  suggestionKind: TaskBridgeSuggestionKind;
  confidence: number;
  rationale: string;
  title: string;
  observedStatus: ObservedWorkStatus;
  kind: ObservedWorkKind;
  sourceIds?: string[];
} | null {
  const sourceIds = sourceIdsFor(item);
  if (sourceIds.length === 0) {
    return null;
  }
  const suggestionKind = suggestionKindFor(item);
  return {
    suggestionId: stableSuggestionId(item.workItemId, suggestionKind),
    workItemId: item.workItemId,
    suggestionKind,
    confidence: Math.min(0.98, Math.max(0, item.confidence)),
    rationale:
      `Suggestion only from observed LCM evidence (${item.observedStatus}/${item.kind}); user or task system must approve any real task action.`,
    title: item.title,
    observedStatus: item.observedStatus,
    kind: item.kind,
    ...(includeSources ? { sourceIds } : {}),
  };
}

export function createLcmTaskSuggestionsTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_task_suggestions",
    label: "LCM Task Suggestions",
    description:
      "Preview or record pending suggestion-ledger entries from observed LCM work. This never creates, closes, assigns, or edits external tasks.",
    parameters: LcmTaskSuggestionsSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const p = params as Record<string, unknown>;
      const scope = await resolveLcmConversationScope({
        lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });
      if (!scope.allConversations && scope.conversationId == null) {
        return jsonResult({ error: "No LCM conversation found for this session. Provide conversationId or set allConversations=true." });
      }
      if (scope.allConversations) {
        return jsonResult({
          error:
            "lcm_task_suggestions does not support allConversations=true yet. Provide a conversationId so suggestion generation stays bounded.",
        });
      }
      let since: string | undefined;
      let before: string | undefined;
      let statuses: ObservedWorkStatus[] | undefined;
      let kinds: ObservedWorkKind[] | undefined;
      try {
        since = parseTimestamp(p.since, "since");
        before = parseTimestamp(p.before, "before");
        statuses = arrayParam(p.statuses, STATUS_VALUES, "statuses") ?? [
          "observed_unfinished",
          "observed_ambiguous",
        ];
        kinds = arrayParam(p.kinds, KIND_VALUES, "kinds");
      } catch (error) {
        return jsonResult({ error: error instanceof Error ? error.message : "Invalid lcm_task_suggestions parameters." });
      }
      if (since && before && since >= before) {
        return jsonResult({ error: "since must be earlier than before." });
      }
      const limit = typeof p.limit === "number" ? Math.trunc(p.limit) : 10;
      const includeSources = p.includeSources === true;
      const topic = typeof p.topic === "string" && p.topic.trim() ? p.topic.trim() : undefined;
      const minConfidence = typeof p.minConfidence === "number" ? p.minConfidence : 0.6;
      const mode = p.mode === "record" ? "record" : "preview";
      const density = lcm.getObservedWorkStore().getDensity({
        conversationId: scope.conversationId,
        since,
        before,
        statuses,
        kinds,
        topic,
        minConfidence,
        includeSources: true,
        limit,
      });
      const items = [
        ...density.topUnfinished,
        ...density.ambiguous,
        ...density.completedHighlights,
      ].slice(0, Math.max(1, Math.min(limit, 50)));
      const suggestions = items
        .map((item) => suggestionFor(item, includeSources))
        .filter((suggestion): suggestion is NonNullable<typeof suggestion> => suggestion != null);
      const recordAccounting = {
        inserted: 0,
        refreshed: 0,
        preservedReviewed: 0,
      };
      if (mode === "record") {
        const store = lcm.getTaskBridgeSuggestionStore();
        for (const suggestion of suggestions) {
          const sourceIds = sourceIdsFor(items.find((item) => item.workItemId === suggestion.workItemId)!);
          const result = store.upsertSuggestion({
            suggestionId: suggestion.suggestionId,
            workItemId: suggestion.workItemId,
            suggestionKind: suggestion.suggestionKind,
            confidence: suggestion.confidence,
            rationale: suggestion.rationale,
            sourceIds,
          });
          if (result === "inserted") {
            recordAccounting.inserted += 1;
          } else if (result === "refreshed") {
            recordAccounting.refreshed += 1;
          } else {
            recordAccounting.preservedReviewed += 1;
          }
        }
      }
      return jsonResult({
        mode,
        conversationScope: scope.allConversations ? "all" : scope.conversationId,
        suggestions,
        accounting: {
          candidatesSeen: items.length,
          suggestionsIncluded: suggestions.length,
          sourceFreeCandidatesOmitted: items.length - suggestions.length,
          recorded:
            mode === "record"
              ? recordAccounting.inserted + recordAccounting.refreshed
              : 0,
          preservedReviewed:
            mode === "record" ? recordAccounting.preservedReviewed : 0,
        },
        disclaimer:
          "Suggestions are inert LCM ledger records. They do not create, close, assign, remind, wake, or sync external tasks.",
      });
    },
  };
}

export function createLcmTaskSuggestionReviewTool(input: {
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
}): AnyAgentTool {
  return {
    name: "lcm_task_suggestion_review",
    label: "LCM Task Suggestion Review",
    description:
      "Record review state on an LCM task suggestion. This only updates the inert LCM suggestion ledger and never writes to an external task system.",
    parameters: LcmTaskSuggestionReviewSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const p = params as Record<string, unknown>;
      const suggestionId = typeof p.suggestionId === "string" ? p.suggestionId.trim() : "";
      if (!suggestionId) {
        return jsonResult({ error: "suggestionId is required." });
      }
      const status = typeof p.status === "string" ? p.status : "";
      if (!REVIEW_STATUS_VALUES.includes(status as (typeof REVIEW_STATUS_VALUES)[number])) {
        return jsonResult({ error: "status must be accepted, rejected, dismissed, or expired." });
      }
      const reviewedBy = typeof p.reviewedBy === "string" && p.reviewedBy.trim()
        ? p.reviewedBy.trim()
        : undefined;
      const changed = lcm.getTaskBridgeSuggestionStore().reviewSuggestion({
        suggestionId,
        status: status as Exclude<TaskBridgeSuggestionStatus, "pending">,
        reviewedBy,
      });
      return jsonResult({
        suggestionId,
        status,
        changed,
        disclaimer:
          "Review state changed only inside the LCM suggestion ledger. No external task mutation was attempted.",
      });
    },
  };
}

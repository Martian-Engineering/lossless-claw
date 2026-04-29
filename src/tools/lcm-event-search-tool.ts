import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { EventObservationKind } from "../store/event-observation-store.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

const EVENT_KIND_VALUES = [
  "primary",
  "retelling",
  "memory_injection",
  "echo",
  "imported",
  "operational_incident",
  "decision",
] as const;

const LcmEventSearchSchema = Type.Object({
  conversationId: Type.Optional(Type.Number({ description: "Conversation ID to inspect. Defaults to the current session conversation." })),
  allConversations: Type.Optional(Type.Boolean({ description: "Not supported; event search is scoped to one conversation unless a future admin/debug surface is added." })),
  query: Type.Optional(Type.String({ description: "Deterministic query/topic filter over observed event titles and keys." })),
  eventKinds: Type.Optional(Type.Array(Type.String({ enum: [...EVENT_KIND_VALUES] }), { description: "Event kinds to include." })),
  since: Type.Optional(Type.String({ description: "Only include events at or after this ISO timestamp." })),
  before: Type.Optional(Type.String({ description: "Only include events before this ISO timestamp." })),
  first: Type.Optional(Type.Boolean({ description: "Return earliest matching events first. Defaults to latest first." })),
  includeSources: Type.Optional(Type.Boolean({ description: "Include event source IDs. Defaults to false." })),
  includeEpisodes: Type.Optional(Type.Boolean({ description: "Also return cross-summary event episodes grouped by deterministic topic key and event kind. Defaults to false." })),
  limit: Type.Optional(Type.Number({ description: "Maximum events to return. Default 20.", minimum: 1, maximum: 100 })),
});

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

export function createLcmEventSearchTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_event_search",
    label: "LCM Event Search",
    description:
      "Search deterministic LCM event observations such as primary events, retellings, imported memories, decisions, and operational incidents. Read-only and not authoritative without source expansion.",
    parameters: LcmEventSearchSchema,
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
        return jsonResult({ error: "No LCM conversation found for this session. Provide conversationId." });
      }
      if (scope.allConversations) {
        return jsonResult({
          error:
            "lcm_event_search does not support allConversations; provide a conversationId or use the current session scope.",
        });
      }
      let since: string | undefined;
      let before: string | undefined;
      let eventKinds: EventObservationKind[] | undefined;
      try {
        since = parseTimestamp(p.since, "since");
        before = parseTimestamp(p.before, "before");
        eventKinds = arrayParam(p.eventKinds, EVENT_KIND_VALUES, "eventKinds");
      } catch (error) {
        return jsonResult({ error: error instanceof Error ? error.message : "Invalid lcm_event_search parameters." });
      }
      if (since && before && since >= before) {
        return jsonResult({ error: "since must be earlier than before." });
      }
      const query = typeof p.query === "string" && p.query.trim() ? p.query.trim() : undefined;
      const store = lcm.getEventObservationStore();
      const limit = typeof p.limit === "number" ? Math.trunc(p.limit) : 20;
      const includeEpisodes = p.includeEpisodes === true;
      const reservedEpisodeLimit = includeEpisodes
        ? Math.max(1, Math.min(limit, Math.ceil(limit / 2)))
        : 0;
      const episodes = includeEpisodes
        ? store.listEpisodes({
            conversationId: scope.conversationId,
            eventKinds,
            query,
            since,
            before,
            first: p.first === true,
            includeSources: p.includeSources === true,
            limit: reservedEpisodeLimit,
          })
        : undefined;
      const observationLimit = includeEpisodes
        ? Math.max(0, limit - (episodes?.length ?? 0))
        : limit;
      const observations = observationLimit > 0
        ? store.listObservations({
            conversationId: scope.conversationId,
            eventKinds,
            query,
            since,
            before,
            first: p.first === true,
            includeSources: p.includeSources === true,
            limit: observationLimit,
          })
        : [];
      return jsonResult({
        conversationScope: scope.allConversations ? "all" : scope.conversationId,
        query,
        window: since || before ? { since, before } : undefined,
        observations,
        ...(episodes ? { episodes } : {}),
        accounting: {
          eventsIncluded: observations.length,
          episodesIncluded: episodes?.length ?? 0,
          includeSources: p.includeSources === true,
        },
        disclaimer:
          "Event observations are deterministic LCM evidence cues. Verify exact chronology, causality, and first-occurrence claims with lcm_describe or lcm_expand_query.",
      });
    },
  };
}

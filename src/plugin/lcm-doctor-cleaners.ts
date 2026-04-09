import type { DatabaseSync } from "node:sqlite";

export type DoctorCleanerId =
  | "archived_subagents"
  | "cron_sessions"
  | "null_subagent_context";

export type DoctorCleanerExample = {
  conversationId: number;
  sessionKey: string | null;
  messageCount: number;
  firstMessagePreview: string | null;
};

export type DoctorCleanerFilterStat = {
  id: DoctorCleanerId;
  label: string;
  description: string;
  conversationCount: number;
  messageCount: number;
  examples: DoctorCleanerExample[];
};

export type DoctorCleanerScan = {
  filters: DoctorCleanerFilterStat[];
  totalDistinctConversations: number;
  totalDistinctMessages: number;
};

type CleanerDefinition = {
  id: DoctorCleanerId;
  label: string;
  description: string;
  predicateSql: string;
};

type CleanerCountRow = {
  filter_id?: DoctorCleanerId;
  conversation_count: number | null;
  message_count: number | null;
};

type CleanerExampleRow = {
  filter_id: DoctorCleanerId;
  conversation_id: number;
  session_key: string | null;
  message_count: number | null;
  first_message_preview: string | null;
};

const CLEANER_DEFINITIONS: CleanerDefinition[] = [
  {
    id: "archived_subagents",
    label: "Archived subagents",
    description: "Archived subagent conversations keyed as agent:main:subagent:*.",
    predicateSql: "(c.active = 0 AND c.session_key LIKE 'agent:main:subagent:%')",
  },
  {
    id: "cron_sessions",
    label: "Cron sessions",
    description: "Background cron conversations keyed as agent:main:cron:*.",
    predicateSql: "(c.session_key LIKE 'agent:main:cron:%')",
  },
  {
    id: "null_subagent_context",
    label: "NULL-key subagent context",
    description:
      "Conversations with NULL session_key whose first stored message begins with [Subagent Context].",
    predicateSql: "(c.session_key IS NULL AND fm.content LIKE '[Subagent Context]%')",
  },
];

function getCleanerDefinitions(filterIds?: DoctorCleanerId[]): CleanerDefinition[] {
  if (!filterIds || filterIds.length === 0) {
    return CLEANER_DEFINITIONS;
  }
  const requested = new Set(filterIds);
  return CLEANER_DEFINITIONS.filter((definition) => requested.has(definition.id));
}

function truncatePreview(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length <= 120 ? normalized : `${normalized.slice(0, 117)}...`;
}

function buildMatchedConversationsSql(definitions: CleanerDefinition[]): string {
  if (definitions.length === 0) {
    return `SELECT NULL AS filter_id, NULL AS conversation_id WHERE 0`;
  }
  return definitions
    .map(
      (definition) =>
        `SELECT '${definition.id}' AS filter_id, c.conversation_id
         FROM conversations c
         LEFT JOIN first_messages fm ON fm.conversation_id = c.conversation_id
         WHERE ${definition.predicateSql}`,
    )
    .join(`\nUNION ALL\n`);
}

function buildCleanerScanCtes(definitions: CleanerDefinition[]): string {
  const matchedConversationsSql = buildMatchedConversationsSql(definitions);
  return `WITH ranked_messages AS (
            SELECT
              m.conversation_id,
              m.content,
              ROW_NUMBER() OVER (
                PARTITION BY m.conversation_id
                ORDER BY m.seq ASC, m.created_at ASC, m.message_id ASC
              ) AS row_num
            FROM messages m
          ),
          first_messages AS (
            SELECT conversation_id, content
            FROM ranked_messages
            WHERE row_num = 1
          ),
          message_counts AS (
            SELECT conversation_id, COUNT(*) AS message_count
            FROM messages
            GROUP BY conversation_id
          ),
          matched_conversations AS (
            ${matchedConversationsSql}
          )`;
}

export function getDoctorCleanerFilters(): Array<Pick<DoctorCleanerFilterStat, "id" | "label" | "description">> {
  return CLEANER_DEFINITIONS.map(({ id, label, description }) => ({
    id,
    label,
    description,
  }));
}

export function scanDoctorCleaners(
  db: DatabaseSync,
  filterIds?: DoctorCleanerId[],
): DoctorCleanerScan {
  const definitions = getCleanerDefinitions(filterIds);
  const ctes = buildCleanerScanCtes(definitions);
  const counts = db
    .prepare(
      `${ctes},
       filter_counts AS (
         SELECT
           mc.filter_id,
           COUNT(*) AS conversation_count,
           COALESCE(SUM(COALESCE(msg.message_count, 0)), 0) AS message_count
         FROM matched_conversations mc
         LEFT JOIN message_counts msg ON msg.conversation_id = mc.conversation_id
         GROUP BY mc.filter_id
       ),
       distinct_conversations AS (
         SELECT DISTINCT conversation_id
         FROM matched_conversations
       )
       SELECT
         fc.filter_id,
         fc.conversation_count,
         fc.message_count,
         COALESCE((SELECT COUNT(*) FROM distinct_conversations), 0) AS total_conversation_count,
         COALESCE((
           SELECT SUM(COALESCE(msg.message_count, 0))
           FROM distinct_conversations dc
           LEFT JOIN message_counts msg ON msg.conversation_id = dc.conversation_id
         ), 0) AS total_message_count
       FROM filter_counts fc`,
    )
    .all() as Array<
      CleanerCountRow & {
        filter_id: DoctorCleanerId;
        total_conversation_count: number | null;
        total_message_count: number | null;
      }
    >;

  const examples = db
    .prepare(
      `${ctes},
       ranked_examples AS (
         SELECT
           mc.filter_id,
           c.conversation_id,
           c.session_key,
           COALESCE(msg.message_count, 0) AS message_count,
           fm.content AS first_message_preview,
           ROW_NUMBER() OVER (
             PARTITION BY mc.filter_id
             ORDER BY COALESCE(msg.message_count, 0) DESC, c.created_at DESC, c.conversation_id DESC
           ) AS example_rank
         FROM matched_conversations mc
         JOIN conversations c ON c.conversation_id = mc.conversation_id
         LEFT JOIN message_counts msg ON msg.conversation_id = mc.conversation_id
         LEFT JOIN first_messages fm ON fm.conversation_id = mc.conversation_id
       )
       SELECT
         filter_id,
         conversation_id,
         session_key,
         message_count,
         first_message_preview
       FROM ranked_examples
       WHERE example_rank <= 3
       ORDER BY filter_id, example_rank`,
    )
    .all() as CleanerExampleRow[];

  const countsById = new Map(counts.map((row) => [row.filter_id, row]));
  const examplesById = new Map<DoctorCleanerId, CleanerExampleRow[]>();
  for (const row of examples) {
    const rows = examplesById.get(row.filter_id) ?? [];
    rows.push(row);
    examplesById.set(row.filter_id, rows);
  }

  const filters = definitions.map((definition) => {
    const countRow = countsById.get(definition.id);
    const exampleRows = examplesById.get(definition.id) ?? [];
    return {
      id: definition.id,
      label: definition.label,
      description: definition.description,
      conversationCount: countRow?.conversation_count ?? 0,
      messageCount: countRow?.message_count ?? 0,
      examples: exampleRows.map((row) => ({
        conversationId: row.conversation_id,
        sessionKey: row.session_key ?? null,
        messageCount: row.message_count ?? 0,
        firstMessagePreview: truncatePreview(row.first_message_preview ?? null),
      })),
    };
  });

  const totals = counts[0];

  return {
    filters,
    totalDistinctConversations: totals?.total_conversation_count ?? 0,
    totalDistinctMessages: totals?.total_message_count ?? 0,
  };
}

import { NativeDatabase } from "./database.js";
import { NativeConversationStore } from "./conversations.js";
import { NativeSummaryStore } from "./summaries.js";
import { parseUtcTimestampOrNull } from "../../store/parse-utc-timestamp.js";
import { parseOpenClawSenderMetadata } from "../../openclaw-sender-metadata.js";
import { encode, decode } from "./codec.js";
type SqlRow = Record<string, any>;
const date = (value: any) => (value ? parseUtcTimestampOrNull(value) : null);
/** Explicit synthetic/archive importer. No automatic migration or source mutation.
 * Active SQLite auxiliary state is rejected rather than silently dropped.
 */
export async function importCanonicalTables(
  database: NativeDatabase,
  tables: Record<string, SqlRow[]>
): Promise<void> {
  const supported = new Set([
    "conversations",
    "messages",
    "summaries",
    "summary_messages",
    "summary_parents",
    "context_items",
    "large_files",
    "lcm_migration_state",
  ]);
  for (const [name, rows] of Object.entries(tables))
    if (rows.length && !supported.has(name))
      throw new Error(
        `SQLite archive contains ${name}; export complete native state or migrate this table explicitly`
      );
  if ((await database.head()).revision !== 0)
    throw new Error("Archive import requires a new namespace");
  const c = new NativeConversationStore(database),
    s = new NativeSummaryStore(database);
  await database.transaction(
    async () => {
      for (const row of tables.conversations ?? [])
        await c.restoreConversation({
          conversationId: row.conversation_id,
          sessionId: row.session_id,
          sessionKey: row.session_key ?? null,
          active: !!row.active,
          archivedAt: date(row.archived_at),
          archiveCause: row.archive_cause ?? null,
          title: row.title ?? null,
          bootstrappedAt: date(row.bootstrapped_at),
          createdAt: date(row.created_at)!,
          updatedAt: date(row.updated_at)!,
        });
      await c.restoreMessages(
        (tables.messages ?? []).map((row) => ({
          messageId: row.message_id,
          conversationId: row.conversation_id,
          seq: row.seq,
          role: row.role,
          content: row.content,
          tokenCount: row.token_count,
          identityHash: row.identity_hash,
          stableEventKey: row.stable_event_key ?? null,
          largeContent: row.large_content ?? null,
          transcriptEntryId: row.transcript_entry_id ?? null,
          openClawSenderMetadata: parseOpenClawSenderMetadata(
            row.openclaw_sender_metadata
          ),
          createdAt: date(row.created_at)!,
        }))
      );
      for (const row of tables.summaries ?? [])
        await s.restoreSummary({
          summaryId: row.summary_id,
          conversationId: row.conversation_id,
          kind: row.kind,
          depth: row.depth,
          content: row.content,
          tokenCount: row.token_count,
          fileIds: JSON.parse(row.file_ids ?? "[]"),
          earliestAt: date(row.earliest_at),
          latestAt: date(row.latest_at),
          descendantCount: row.descendant_count ?? 0,
          descendantTokenCount: row.descendant_token_count ?? 0,
          sourceMessageTokenCount: row.source_message_token_count ?? 0,
          model: row.model ?? "unknown",
          createdAt: date(row.created_at)!,
        });
      const group = (rows: SqlRow[], field: string) => {
        const groups = new Map<string, SqlRow[]>();
        for (const row of rows) {
          const list = groups.get(row[field]) ?? [];
          list.push(row);
          groups.set(row[field], list);
        }
        for (const list of groups.values())
          list.sort((a, b) => a.ordinal - b.ordinal);
        return groups;
      };
      for (const [id, rows] of group(
        tables.summary_messages ?? [],
        "summary_id"
      ))
        await s.linkSummaryToMessages(
          id,
          rows.map((row) => row.message_id)
        );
      for (const [id, rows] of group(
        tables.summary_parents ?? [],
        "summary_id"
      ))
        await s.linkSummaryToParents(
          id,
          rows.map((row) => row.parent_summary_id)
        );
      const contexts = [...(tables.context_items ?? [])].sort(
        (a, b) => a.conversation_id - b.conversation_id || a.ordinal - b.ordinal
      );
      for (const row of contexts)
        if (row.item_type === "message")
          await s.appendContextMessage(row.conversation_id, row.message_id);
        else await s.appendContextSummary(row.conversation_id, row.summary_id);
      for (const row of tables.large_files ?? [])
        await s.insertLargeFile({
          fileId: row.file_id,
          conversationId: row.conversation_id,
          fileName: row.file_name ?? undefined,
          mimeType: row.mime_type ?? undefined,
          byteSize: row.byte_size ?? undefined,
          lineCount: row.line_count ?? undefined,
          storageUri: row.storage_uri,
          explorationSummary: row.exploration_summary ?? undefined,
        });
    },
    { token: "canonical-archive-import-v1" }
  );
}
/** Pinned keyset export includes every native lifecycle record, not just active context. */
export async function* exportNative(
  database: NativeDatabase
): AsyncGenerator<string> {
  const view = await database.snapshot();
  yield JSON.stringify({
    format: "lossless-turbopuffer-native-v1",
    organizationId: database.organizationId,
    agentId: database.agentId,
    revision: view.head.revision,
  }) + "\n";
  for await (const row of view.scan({}))
    yield JSON.stringify({ key: row.key, value: encode(row.value) }) + "\n";
}
/** Import an operator-provided native export into an empty namespace of the same authority. */
export async function restoreNative(
  database: NativeDatabase,
  lines: AsyncIterable<string>
): Promise<void> {
  if ((await database.head()).revision !== 0)
    throw new Error("Native restore requires a new namespace");
  let header = false;
  await database.transaction(
    async (tx) => {
      for await (const line of lines) {
        if (!line.trim()) continue;
        const row = JSON.parse(line);
        if (!header) {
          if (
            row.format !== "lossless-turbopuffer-native-v1" ||
            row.organizationId !== database.organizationId ||
            row.agentId !== database.agentId
          )
            throw new Error("Native export authority or format mismatch");
          header = true;
          continue;
        }
        if (typeof row.key !== "string" || typeof row.value !== "string")
          throw new Error("Invalid native export record");
        // Journals belong to the new publication history. User/entity receipts,
        // cursors, pending state, authorization and historical records are retained.
        if (!row.key.startsWith("!journal/"))
          await tx.put(row.key, decode(row.value));
      }
      if (!header) throw new Error("Native export header missing");
    },
    { token: "native-restore-v1" }
  );
}

import { extractRawIdsFromPartMetadata } from "../../replay-metadata.js";
import { randomUUID } from "node:crypto";
import type {
  ConversationStore,
  ConversationRecord,
  CreateConversationInput,
  ArchiveCause,
  CreateMessageInput,
  MessageRecord,
  MessageRole,
  CreateMessagePartInput,
  MessagePartRecord,
  UpsertMessageTranscriptAnchorTrustInput,
  MessageSearchInput,
  MessageSearchResult,
} from "../../store/conversation-store.js";
import { buildMessageIdentityHash } from "../../store/message-identity.js";
import { parseUtcTimestampOrNull } from "../../store/parse-utc-timestamp.js";
import {
  serializeOpenClawSenderMetadata,
  parseOpenClawSenderMetadata,
  type OpenClawSenderMetadata,
} from "../../openclaw-sender-metadata.js";
import { NativeDatabase, NativeView, NativeTransaction } from "./database.js";
import { NativeRepository, collect, nextId, n, h } from "./repository.js";
import { searchRecords } from "./search.js";

type StoredMessage = MessageRecord & {
  identityHash: string;
  stableEventKey: string | null;
};
type StoredConversation = ConversationRecord & {
  archiveCause: ArchiveCause | null;
};
const ck = (id: number) => `conversations/${n(id)}`;
const mk = (id: number) => `messages/${n(id)}`;
const seqPrefix = (cid: number) => `message-seq/${n(cid)}/`;
const identityPrefix = (cid: number, role: string, hash: string) =>
  `message-identity/${n(cid)}/${role}/${h(hash)}/`;
const entryKey = (cid: number, id: string) =>
  `message-entry/${n(cid)}/${h(id)}`;
const stableKey = (cid: number, id: string) =>
  `message-stable/${n(cid)}/${h(id)}`;
const partPrefix = (id: number) => `message-parts/${n(id)}/`;
const date = (value?: Date | string) => {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === "string"
      ? parseUtcTimestampOrNull(value)
      : null;
  return new Date(
    Math.floor(
      (parsed && Number.isFinite(parsed.getTime())
        ? parsed.getTime()
        : Date.now()) / 1000
    ) * 1000
  );
};
const publicConversation = (row: StoredConversation): ConversationRecord => {
  const { archiveCause, ...value } = row;
  return value;
};
const publicMessage = (row: StoredMessage): MessageRecord => ({
  largeContent: row.largeContent,
  transcriptEntryId: row.transcriptEntryId,
  openClawSenderMetadata: row.openClawSenderMetadata,
  messageId: row.messageId,
  conversationId: row.conversationId,
  seq: row.seq,
  role: row.role,
  content: row.content,
  tokenCount: row.tokenCount,
  createdAt: row.createdAt,
});
type Options = {
  replayFloodThresholdExternal?: number;
  replayFloodThresholdInternal?: number;
  onStableEventKeyConflict?: (info: {
    conversationId: number;
    stableEventKey: string;
  }) => void;
};
/** Native entities, ordered indexes and provenance. No SQL emulation or local history. */
export class NativeConversationStore
  extends NativeRepository
  implements Pick<ConversationStore, keyof ConversationStore>
{
  constructor(database: NativeDatabase, private options: Options = {}) {
    super(database);
  }
  private assertSession(key?: string | null): void {
    const match = key?.match(/^agent:([^:]+):/);
    if (match && match[1] !== this.database.agentId)
      throw new Error("Session belongs to a different native agent");
  }
  private async aliases(
    tx: NativeTransaction,
    row: StoredConversation,
    remove = false
  ): Promise<void> {
    const keys = [
      `conversation-session/${h(row.sessionId)}/${n(row.conversationId)}`,
    ];
    if (row.sessionKey)
      keys.push(
        `conversation-key/${h(row.sessionKey)}/${n(row.conversationId)}`
      );
    if (row.active)
      keys.push(
        `conversation-active/${row.updatedAt.toISOString()}/${n(
          row.conversationId
        )}`
      );
    for (const key of keys)
      if (remove) await tx.remove(key);
      else await tx.put(key, row.conversationId);
  }
  private async saveConversation(
    tx: NativeTransaction,
    row: StoredConversation
  ): Promise<void> {
    const old = await tx.get<StoredConversation>(ck(row.conversationId));
    if (old) await this.aliases(tx, old, true);
    await tx.put(ck(row.conversationId), row);
    await this.aliases(tx, row);
  }
  private async family(
    view: NativeView,
    kind: "key" | "session",
    key: string
  ): Promise<StoredConversation[]> {
    const ids = await collect<number>(view, `conversation-${kind}/${h(key)}/`),
      rows: StoredConversation[] = [];
    for (const id of ids) {
      const row = await view.get<StoredConversation>(ck(id));
      if (row) rows.push(row);
    }
    return rows.sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        b.createdAt.getTime() - a.createdAt.getTime() ||
        b.conversationId - a.conversationId
    );
  }
  createConversation(
    input: CreateConversationInput
  ): Promise<ConversationRecord> {
    return this.write(async (tx) => {
      this.assertSession(input.sessionKey);
      if (input.active !== false) {
        const rows = await this.family(
          tx,
          input.sessionKey ? "key" : "session",
          input.sessionKey ?? input.sessionId
        );
        const existing = rows.find((r) => r.active);
        if (existing) return publicConversation(existing);
      }
      const now = date(),
        row: StoredConversation = {
          conversationId: await nextId(tx, "conversations"),
          sessionId: input.sessionId,
          sessionKey: input.sessionKey ?? null,
          active: input.active ?? true,
          archivedAt: input.archivedAt ?? null,
          title: input.title ?? null,
          bootstrappedAt: null,
          createdAt: now,
          updatedAt: now,
          archiveCause: null,
        };
      await this.saveConversation(tx, row);
      return publicConversation(row);
    });
  }
  /** Operator-only restore into a new native namespace; IDs and dates stay exact. */
  restoreConversation(
    row: ConversationRecord & { archiveCause?: ArchiveCause | null }
  ): Promise<void> {
    return this.write(async (tx) => {
      this.assertSession(row.sessionKey);
      if (await tx.get(ck(row.conversationId)))
        throw new Error("Restore requires an empty conversation ID");
      await this.saveConversation(tx, {
        ...row,
        archiveCause: row.archiveCause ?? null,
      });
      const counter = (await tx.get<number>("!counter/conversations")) ?? 0;
      await tx.put(
        "!counter/conversations",
        Math.max(counter, row.conversationId)
      );
    });
  }
  restoreMessages(rows: StoredMessage[]): Promise<void> {
    return this.write(async (tx) => {
      let maximum = (await tx.get<number>("!counter/messages")) ?? 0;
      for (const row of rows) {
        if (await tx.get(mk(row.messageId)))
          throw new Error("Restore requires an empty message ID");
        if (!(await tx.get(ck(row.conversationId))))
          throw new Error("Restore message conversation missing");
        await tx.put(mk(row.messageId), row);
        await this.messageIndexes(tx, row);
        maximum = Math.max(maximum, row.messageId);
        const key = `message-count/${n(row.conversationId)}`;
        await tx.put(key, ((await tx.get<number>(key)) ?? 0) + 1);
      }
      await tx.put("!counter/messages", maximum);
    });
  }
  getConversation(cid: number): Promise<ConversationRecord | null> {
    return this.read(async (v) => {
      const row = await v.get<StoredConversation>(ck(cid));
      return row ? publicConversation(row) : null;
    });
  }
  getConversationBySessionId(id: string): Promise<ConversationRecord | null> {
    return this.read(async (v) => {
      const [row] = await this.family(v, "session", id);
      return row ? publicConversation(row) : null;
    });
  }
  getConversationBySessionKey(key: string): Promise<ConversationRecord | null> {
    this.assertSession(key);
    return this.read(async (v) => {
      const row = (await this.family(v, "key", key)).find((r) => r.active);
      return row ? publicConversation(row) : null;
    });
  }
  getConversationFamilyIds(input: {
    conversationId?: number;
    sessionId?: string;
    sessionKey?: string;
  }): Promise<number[]> {
    return this.read(async (v) => {
      const row = input.conversationId
        ? await v.get<StoredConversation>(ck(input.conversationId))
        : null;
      const key = input.sessionKey ?? row?.sessionKey,
        sid = input.sessionId ?? row?.sessionId;
      if (key) this.assertSession(key);
      return key
        ? (await this.family(v, "key", key)).map((r) => r.conversationId)
        : sid
        ? (await this.family(v, "session", sid)).map((r) => r.conversationId)
        : [];
    });
  }
  async getConversationForSession(input: {
    sessionId?: string;
    sessionKey?: string;
  }): Promise<ConversationRecord | null> {
    const key = input.sessionKey?.trim();
    if (key) {
      const row = await this.getConversationBySessionKey(key);
      if (row) return row;
    }
    if (!input.sessionId) return null;
    return this.read(async (v) => {
      const row = (await this.family(v, "session", input.sessionId!)).find(
        (r) => r.active
      );
      return row ? publicConversation(row) : null;
    });
  }
  listActiveConversations(limit = 1000): Promise<ConversationRecord[]> {
    return this.read(async (v) => {
      const ids = await collect<number>(v, "conversation-active/", {
          reverse: true,
          limit: Math.max(0, limit),
        }),
        rows: ConversationRecord[] = [];
      for (const id of ids) {
        const row = await v.get<StoredConversation>(ck(id));
        if (row) rows.push(publicConversation(row));
      }
      return rows;
    });
  }
  getOrCreateConversation(
    sid: string,
    titleOrOptions?: string | { title?: string; sessionKey?: string }
  ): Promise<ConversationRecord> {
    return this.write(async () => {
      const options =
        typeof titleOrOptions === "string"
          ? { title: titleOrOptions }
          : titleOrOptions ?? {};
      this.assertSession(options.sessionKey);
      const byKey = options.sessionKey
        ? await this.getConversationBySessionKey(options.sessionKey)
        : null;
      if (byKey) {
        if (byKey.sessionId !== sid)
          await this.rebindConversationSession(
            byKey.conversationId,
            sid,
            options.sessionKey
          );
        return (await this.getConversation(byKey.conversationId))!;
      }
      const active = await this.getConversationForSession({ sessionId: sid });
      if (
        active &&
        (!options.sessionKey ||
          !active.sessionKey ||
          active.sessionKey === options.sessionKey)
      ) {
        if (options.sessionKey && !active.sessionKey)
          await this.rebindConversationSession(
            active.conversationId,
            sid,
            options.sessionKey
          );
        return (await this.getConversation(active.conversationId))!;
      }
      return this.createConversation({ sessionId: sid, ...options });
    });
  }
  markConversationBootstrapped(cid: number): Promise<void> {
    return this.write(async (tx) => {
      const row = await tx.get<StoredConversation>(ck(cid));
      if (row)
        await this.saveConversation(tx, {
          ...row,
          bootstrappedAt: row.bootstrappedAt ?? date(),
          updatedAt: date(),
        });
    });
  }
  archiveConversation(cid: number, cause: ArchiveCause): Promise<void> {
    return this.write(async (tx) => {
      const row = await tx.get<StoredConversation>(ck(cid));
      if (row)
        await this.saveConversation(tx, {
          ...row,
          active: false,
          archivedAt: row.archivedAt ?? date(),
          archiveCause: row.archiveCause ?? cause,
          updatedAt: date(),
        });
    });
  }
  rebindConversationSession(
    cid: number,
    sid: string,
    key?: string | null
  ): Promise<ConversationRecord | null> {
    sid = sid.trim();
    key = key?.trim() || null;
    if (!sid) return this.getConversation(cid);
    return this.write(async (tx) => {
      this.assertSession(key);
      const row = await tx.get<StoredConversation>(ck(cid));
      if (!row) return null;
      const conflict = (
        await this.family(tx, key ? "key" : "session", key ?? sid)
      ).find((r) => r.active && r.conversationId !== cid);
      if (conflict)
        throw new Error("Active conversation session is already bound");
      await this.saveConversation(tx, {
        ...row,
        sessionId: sid,
        sessionKey: key ?? row.sessionKey,
        active: true,
        archivedAt: null,
        updatedAt: date(),
      });
      return (await this.getConversation(cid))!;
    });
  }
  private async matching(
    view: NativeView,
    cid: number,
    role: MessageRole,
    content: string
  ): Promise<StoredMessage[]> {
    const ids = await collect<number>(
        view,
        identityPrefix(cid, role, buildMessageIdentityHash(role, content))
      ),
      rows: StoredMessage[] = [];
    for (const id of ids) {
      const row = await view.get<StoredMessage>(mk(id));
      if (row && row.content === content) rows.push(row);
    }
    return rows;
  }
  private async messageIndexes(
    tx: NativeTransaction,
    row: StoredMessage,
    remove = false
  ): Promise<void> {
    const keys = [
      `${seqPrefix(row.conversationId)}${n(row.seq)}/${n(row.messageId)}`,
      `${identityPrefix(
        row.conversationId,
        row.role,
        row.identityHash
      )}${row.createdAt.toISOString()}/${n(row.messageId)}`,
      `message-time/${row.createdAt.toISOString()}/${n(row.messageId)}`,
    ];
    if (row.transcriptEntryId)
      keys.push(entryKey(row.conversationId, row.transcriptEntryId));
    if (row.stableEventKey)
      keys.push(stableKey(row.conversationId, row.stableEventKey));
    if (row.largeContent)
      keys.push(`message-file/${h(row.largeContent)}/${n(row.messageId)}`);
    for (const key of keys)
      if (remove) await tx.remove(key);
      else await tx.put(key, row.messageId);
  }
  createMessage(input: CreateMessageInput): Promise<MessageRecord> {
    return this.createMessagesBulk([input]).then((rows) => rows[0]);
  }
  createMessagesBulk(inputs: CreateMessageInput[]): Promise<MessageRecord[]> {
    if (!inputs.length) return Promise.resolve([]);
    return this.write(async (tx) => {
      const now = date(),
        prepared = inputs.map((input) => ({
          ...input,
          createdAt:
            input.createdAt === undefined ? now : date(input.createdAt),
        }));
      const groups = new Map<
        string,
        { input: (typeof prepared)[number]; count: number }
      >();
      for (const input of prepared) {
        if (input.skipReplayTimestampFloodGuard || !input.content) continue;
        if (
          !(
            await this.matching(
              tx,
              input.conversationId,
              input.role,
              input.content
            )
          ).some((r) => r.createdAt < input.createdAt)
        )
          continue;
        const key = JSON.stringify([
          input.conversationId,
          input.role,
          input.createdAt,
          input.role === "user" ? null : input.content,
        ]);
        const group = groups.get(key);
        if (group) group.count++;
        else groups.set(key, { input, count: 1 });
      }
      for (const { input, count } of groups.values()) {
        const sameSecond = await this.messagesAtSecond(
            tx,
            input.conversationId,
            input.createdAt
          ),
          candidates = sameSecond.filter(
            (r) =>
              r.role === input.role &&
              (input.role === "user" || r.content === input.content)
          );
        let existing = 0;
        for (const row of candidates)
          if (
            (
              await this.matching(tx, row.conversationId, row.role, row.content)
            ).some((r) => r.createdAt < row.createdAt)
          )
            existing++;
        const threshold =
          input.role === "user"
            ? this.options.replayFloodThresholdExternal ?? 3
            : this.options.replayFloodThresholdInternal ?? 32;
        if (existing + count >= threshold)
          throw new Error(
            `[lcm] refused replay-like message batch: conversation=${
              input.conversationId
            } role=${input.role} createdAt=${input.createdAt
              .toISOString()
              .replace("T", " ")
              .slice(0, 19)} replicatedRows=${
              existing + count
            } threshold=${threshold}`
          );
      }
      const result: MessageRecord[] = [];
      for (const input of prepared) {
        if (!(await tx.get(ck(input.conversationId))))
          throw new Error("Conversation does not exist");
        const seq = await collect<number>(
          tx,
          `${seqPrefix(input.conversationId)}${n(input.seq)}/`,
          { limit: 1 }
        );
        if (seq.length)
          throw new Error(
            "UNIQUE constraint failed: messages.conversation_id, messages.seq"
          );
        if (
          input.transcriptEntryId &&
          (await tx.get(
            entryKey(input.conversationId, input.transcriptEntryId)
          ))
        )
          throw new Error(
            "UNIQUE constraint failed: messages.conversation_id, messages.transcript_entry_id"
          );
        let stableEventKey = input.stableEventKey ?? null;
        if (
          stableEventKey &&
          (await tx.get(stableKey(input.conversationId, stableEventKey)))
        ) {
          this.options.onStableEventKeyConflict?.({
            conversationId: input.conversationId,
            stableEventKey,
          });
          stableEventKey = null;
        }
        const sender =
          input.role === "user"
            ? parseOpenClawSenderMetadata(
                serializeOpenClawSenderMetadata(input.openClawSenderMetadata)
              )
            : null;
        const row: StoredMessage = {
          messageId: await nextId(tx, "messages"),
          conversationId: input.conversationId,
          seq: input.seq,
          role: input.role,
          content: input.content,
          tokenCount: input.tokenCount,
          createdAt: input.createdAt,
          largeContent: null,
          transcriptEntryId: input.transcriptEntryId ?? null,
          openClawSenderMetadata: sender,
          identityHash:
            input.identityHash ??
            buildMessageIdentityHash(input.role, input.content),
          stableEventKey,
        };
        await tx.put(mk(row.messageId), row);
        await this.messageIndexes(tx, row);
        const countKey = `message-count/${n(row.conversationId)}`;
        await tx.put(countKey, ((await tx.get<number>(countKey)) ?? 0) + 1);
        result.push(publicMessage(row));
      }
      return result;
    });
  }
  private async messagesAtSecond(
    view: NativeView,
    cid: number,
    time: Date
  ): Promise<StoredMessage[]> {
    const ids = await collect<number>(
        view,
        `message-time/${time.toISOString()}/`
      ),
      rows: StoredMessage[] = [];
    for (const id of ids) {
      const row = await view.get<StoredMessage>(mk(id));
      if (row?.conversationId === cid) rows.push(row);
    }
    return rows;
  }
  getMessages(
    cid: number,
    options: { afterSeq?: number; limit?: number } = {}
  ): Promise<MessageRecord[]> {
    return this.read(async (v) => {
      const rows: MessageRecord[] = [];
      for await (const item of v.scan<number>({
        prefix: seqPrefix(cid),
        gt: `${seqPrefix(cid)}${n(Math.max(0, options.afterSeq ?? 0))}/`,
      })) {
        const row = await v.get<StoredMessage>(mk(item.value));
        if (row && row.seq > (options.afterSeq ?? -1))
          rows.push(publicMessage(row));
        if (options.limit !== undefined && rows.length >= options.limit) break;
      }
      return options.limit === 0 ? [] : rows;
    });
  }
  getLastMessages(cid: number, count: number): Promise<MessageRecord[]> {
    if (count <= 0) return Promise.resolve([]);
    return this.read(async (v) => {
      const ids = await collect<number>(v, seqPrefix(cid), {
          reverse: true,
          limit: count,
        }),
        rows: MessageRecord[] = [];
      for (const row of await v.getMany<StoredMessage>(ids.map(mk)))
        if (row) rows.push(publicMessage(row));
      return rows.reverse();
    });
  }
  /** Hydrate only the newest messages whose public JSON fits the requested window. */
  recentTail(
    cid: number,
    count = 80,
    maxBytes = 256 * 1024
  ): Promise<MessageRecord[]> {
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 2
    )
      throw new Error("Invalid native tail window");
    return this.read(async (view) => {
      const mids = await collect<number>(view, seqPrefix(cid), {
        reverse: true,
        limit: count,
      });
      const refs = await view.tree.getMany(mids.map(mk)),
        ids = refs.filter((id): id is string => id !== null);
      const metadata = await (view.io.readMetadata?.(ids) ?? view.io.read(ids)),
        sizes = new Map(metadata.map((row) => [row.id, row.public_bytes]));
      let bytes = 2;
      const selected: number[] = [];
      for (let at = 0; at < mids.length; at++) {
        const size = refs[at] ? sizes.get(refs[at]!) : undefined;
        if (!Number.isSafeInteger(size) || size! < 0)
          throw new Error("Native tail size metadata missing");
        const next = bytes + size! + (selected.length ? 1 : 0);
        if (next > maxBytes) break;
        bytes = next;
        selected.push(mids[at]);
      }
      return (await view.getMany<StoredMessage>(selected.map(mk)))
        .filter((row): row is StoredMessage => row !== null)
        .map(publicMessage)
        .reverse();
    });
  }
  async getLastMessage(cid: number): Promise<MessageRecord | null> {
    return (await this.getLastMessages(cid, 1))[0] ?? null;
  }
  getLastMessageIdentityHash(cid: number): Promise<string | null> {
    return this.getRecentMessageIdentityHashes(cid, 1).then(
      (rows) => rows[0] ?? null
    );
  }
  getRecentMessageIdentityHashes(
    cid: number,
    limit: number
  ): Promise<string[]> {
    return this.read(async (v) => {
      const ids = await collect<number>(v, seqPrefix(cid), {
          reverse: true,
          limit: Math.max(0, limit),
        }),
        hashes: string[] = [];
      for (const id of ids) {
        const row = await v.get<StoredMessage>(mk(id));
        if (row) hashes.push(row.identityHash);
      }
      return hashes.reverse();
    });
  }
  hasMessage(
    cid: number,
    role: MessageRole,
    content: string
  ): Promise<boolean> {
    return this.read(
      async (v) => (await this.matching(v, cid, role, content)).length > 0
    );
  }
  hasMessageByTranscriptEntryId(cid: number, id: string): Promise<boolean> {
    return this.read(async (v) => (await v.get(entryKey(cid, id))) !== null);
  }
  getTranscriptEntryAnchorCandidate(cid: number, id: string) {
    return this.read(async (v) => {
      const mid = await v.get<number>(entryKey(cid, id));
      const row = mid ? await v.get<StoredMessage>(mk(mid)) : null;
      return row
        ? {
            messageId: row.messageId,
            conversationId: cid,
            transcriptEntryId: id,
            role: row.role,
            content: row.content,
          }
        : null;
    });
  }
  clearTranscriptEntryIdForMessage(cid: number, id: number): Promise<boolean> {
    return this.write(async (tx) => {
      const row = await tx.get<StoredMessage>(mk(id));
      if (!row || row.conversationId !== cid) return false;
      if (row.transcriptEntryId)
        await tx.remove(entryKey(cid, row.transcriptEntryId));
      await tx.put(mk(id), { ...row, transcriptEntryId: null });
      return true;
    });
  }
  hasMessageByStableEventKey(cid: number, key: string): Promise<boolean> {
    return this.read(async (v) => (await v.get(stableKey(cid, key))) !== null);
  }
  hasPersistedIdentityAtCreatedAtSecond(
    cid: number,
    role: MessageRole,
    content: string,
    createdAt: Date | string | undefined
  ): Promise<boolean> {
    if (
      createdAt === undefined ||
      !Number.isFinite(
        (createdAt instanceof Date
          ? createdAt
          : parseUtcTimestampOrNull(createdAt)
        )?.getTime()
      )
    )
      return Promise.resolve(false);
    return this.read(async (v) =>
      (await this.matching(v, cid, role, content)).some(
        (r) => r.createdAt.getTime() === date(createdAt).getTime()
      )
    );
  }
  restampTranscriptEntryId(
    id: number,
    entry: string,
    sender?: OpenClawSenderMetadata | null
  ): Promise<boolean> {
    return this.write(async (tx) => {
      const row = await tx.get<StoredMessage>(mk(id));
      if (!row) return false;
      const existing = await tx.get<number>(
        entryKey(row.conversationId, entry)
      );
      if (existing !== null && existing !== id) return false;
      if (row.transcriptEntryId)
        await tx.remove(entryKey(row.conversationId, row.transcriptEntryId));
      await tx.put(entryKey(row.conversationId, entry), id);
      await tx.put(mk(id), {
        ...row,
        transcriptEntryId: entry,
        openClawSenderMetadata:
          row.role === "user"
            ? row.openClawSenderMetadata ??
              parseOpenClawSenderMetadata(
                serializeOpenClawSenderMetadata(sender)
              )
            : row.openClawSenderMetadata,
      });
      return true;
    });
  }
  filterExistingTranscriptEntryIds(
    cid: number,
    ids: readonly string[]
  ): Promise<Set<string>> {
    return this.read(async (v) => {
      const found = new Set<string>();
      for (const id of ids) if (await v.get(entryKey(cid, id))) found.add(id);
      return found;
    });
  }
  countMessagesByIdentity(
    cid: number,
    role: MessageRole,
    content: string
  ): Promise<number> {
    return this.read(
      async (v) => (await this.matching(v, cid, role, content)).length
    );
  }
  upsertMessageTranscriptAnchorTrust(
    input: UpsertMessageTranscriptAnchorTrustInput
  ): Promise<void> {
    return this.write(async (tx) => {
      const row = await tx.get<StoredMessage>(mk(input.messageId));
      if (!row || row.conversationId !== input.conversationId)
        throw new Error("Anchor message does not belong to conversation");
      const old = await tx.get<UpsertMessageTranscriptAnchorTrustInput>(
        `message-trust/${n(input.messageId)}`
      );
      if (
        old?.transcriptEntryId !== undefined &&
        old.transcriptEntryId !== null
      )
        await tx.remove(
          `message-trust-entry/${n(old.conversationId)}/${h(
            old.transcriptEntryId
          )}/${n(input.messageId)}`
        );
      await tx.put(`message-trust/${n(input.messageId)}`, {
        ...input,
        verifiedAt: input.verifiedAt ?? null,
      });
      if (
        input.transcriptEntryId !== undefined &&
        input.transcriptEntryId !== null
      )
        await tx.put(
          `message-trust-entry/${n(input.conversationId)}/${h(
            input.transcriptEntryId
          )}/${n(input.messageId)}`,
          input.trustState
        );
    });
  }
  isTrustedTranscriptAnchor(cid: number, entry: string): Promise<boolean> {
    const normalized = entry.trim();
    if (!normalized) return Promise.resolve(false);
    return this.read(async (view) => {
      for await (const { value } of view.scan<string>({
        prefix: `message-trust-entry/${n(cid)}/${h(normalized)}/`,
      }))
        if (["verified", "repaired"].includes(value)) return true;
      return false;
    });
  }
  async hasPreviousReasonedMessageByIdentity(
    cid: number,
    role: MessageRole,
    content: string
  ): Promise<boolean> {
    return this.read(async (view) => {
      const last = await this.getLastMessage(cid);
      if (!last || last.role !== role || last.content !== content) return false;
      const stored = await view.get<StoredMessage>(mk(last.messageId));
      if (stored?.identityHash !== buildMessageIdentityHash(role, content))
        return false;
      return (await this.getMessageParts(last.messageId)).some((part) => {
        if (part.partType === "reasoning") return true;
        try {
          const m = JSON.parse(part.metadata ?? "null");
          return (
            m?.topLevelReasoningField === "reasoning_content" &&
            typeof m.topLevelReasoningContent === "string" &&
            m.topLevelReasoningContent.length > 0
          );
        } catch {
          return false;
        }
      });
    });
  }
  countMessagesByIdentityHash(
    cid: number,
    role: MessageRole,
    hash: string
  ): Promise<number> {
    return this.read(
      async (view) =>
        (await collect(view, identityPrefix(cid, role, hash))).length
    );
  }
  countMessagesByIdentityBeforeTimestamp(input: {
    conversationId: number;
    role: MessageRole;
    content: string;
    beforeCreatedAt: Date | string;
  }): Promise<number> {
    return this.read(
      async (v) =>
        (
          await this.matching(
            v,
            input.conversationId,
            input.role,
            input.content
          )
        ).filter((row) => row.createdAt < date(input.beforeCreatedAt)).length
    );
  }
  getMessageById(id: number): Promise<MessageRecord | null> {
    return this.read(async (v) => {
      const row = await v.get<StoredMessage>(mk(id));
      return row ? publicMessage(row) : null;
    });
  }
  getMessageByLargeContent(fileId: string): Promise<MessageRecord | null> {
    return this.read(async (v) => {
      const [id] = await collect<number>(v, `message-file/${h(fileId)}/`, {
        limit: 1,
      });
      return id ? this.getMessageById(id) : null;
    });
  }
  createMessageParts(
    id: number,
    parts: CreateMessagePartInput[]
  ): Promise<void> {
    if (!parts.length) return Promise.resolve();
    return this.write(async (tx) => {
      if (!(await tx.get(mk(id)))) throw new Error("Message does not exist");
      for (const part of parts) {
        const row: MessagePartRecord = {
          partId: randomUUID(),
          messageId: id,
          sessionId: part.sessionId,
          partType: part.partType,
          ordinal: part.ordinal,
          textContent: part.textContent ?? null,
          toolCallId: part.toolCallId ?? null,
          toolName: part.toolName ?? null,
          toolInput: part.toolInput ?? null,
          toolOutput: part.toolOutput ?? null,
          metadata: part.metadata ?? null,
        };
        await tx.put(`${partPrefix(id)}${n(part.ordinal)}/${row.partId}`, row);
        const message = (await tx.get<StoredMessage>(mk(id)))!;
        let parsed: any;
        try {
          parsed = JSON.parse(part.metadata ?? "null");
        } catch {}
        const ids = new Set([
          ...extractRawIdsFromPartMetadata(part.metadata ?? null),
          ...(part.toolCallId ? [part.toolCallId] : []),
        ]);
        for (const rawId of ids)
          await tx.put(
            `raw-part/${n(message.conversationId)}/${message.role}/${h(
              rawId
            )}/${n(id)}/${row.partId}`,
            {
              messageId: id,
              identityHash: message.identityHash,
              metadata: row.metadata,
              fileId:
                parsed?.externalizationReason === "large_tool_result"
                  ? parsed.externalizedFileId
                  : null,
              originalByteSize: parsed?.originalByteSize ?? null,
            }
          );
      }
    });
  }
  getMessageParts(id: number): Promise<MessagePartRecord[]> {
    return this.read((v) => collect(v, partPrefix(id)));
  }
  getMessageCount(cid: number): Promise<number> {
    return this.read(
      async (v) => (await v.get<number>(`message-count/${n(cid)}`)) ?? 0
    );
  }
  async getMaxSeq(cid: number): Promise<number> {
    return (await this.getLastMessage(cid))?.seq ?? 0;
  }
  deleteMessages(ids: number[]): Promise<number> {
    return this.write(async (tx) => {
      let count = 0;
      for (const id of ids) {
        const row = await tx.get<StoredMessage>(mk(id));
        if (!row) continue;
        if (
          (await collect(tx, `message-summary/${n(id)}/`, { limit: 1 }))
            .length ||
          (await collect(tx, `pending-message/${n(id)}/`, { limit: 1 })).length
        )
          continue;
        await this.messageIndexes(tx, row, true);
        await tx.remove(mk(id));
        const trust = await tx.get<UpsertMessageTranscriptAnchorTrustInput>(
          `message-trust/${n(id)}`
        );
        if (
          trust?.transcriptEntryId !== undefined &&
          trust.transcriptEntryId !== null
        )
          await tx.remove(
            `message-trust-entry/${n(trust.conversationId)}/${h(
              trust.transcriptEntryId
            )}/${n(id)}`
          );
        await tx.remove(`message-trust/${n(id)}`);
        for await (const part of tx.scan({ prefix: partPrefix(id) }))
          await tx.remove(part.key);
        for await (const item of tx.scan<{ messageId: number | null }>({
          prefix: `context/${n(row.conversationId)}/`,
        }))
          if (item.value.messageId === id) await tx.remove(item.key);
        const key = `message-count/${n(row.conversationId)}`;
        await tx.put(key, ((await tx.get<number>(key)) ?? 1) - 1);
        count++;
      }
      return count;
    });
  }
  async searchMessages(
    input: MessageSearchInput
  ): Promise<MessageSearchResult[]> {
    return (
      await searchRecords<StoredMessage>(this.database, "messages", input)
    ).map(({ value, snippet, rank }) => ({
      messageId: value.messageId,
      conversationId: value.conversationId,
      role: value.role,
      snippet,
      createdAt: value.createdAt,
      rank,
    }));
  }
}

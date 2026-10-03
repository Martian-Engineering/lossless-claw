import { constants, type Dirent } from "node:fs";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { closeLcmConnection, createLcmDatabaseConnection } from "./db/connection.js";
import { runLcmMigrations } from "./db/migration.js";
import { buildMessageParts, filterPersistableMessages, toStoredMessage, type StoredMessage } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import {
  extractOpenClawSenderMetadata,
  type OpenClawSenderMetadata,
} from "./openclaw-sender-metadata.js";
import { ConversationStore, type MessageRecord } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { withDatabaseTransaction } from "./transaction-mutex.js";
import {
  hashCodexSource,
  hashCodexSourcePrefix,
  readCodexTranscript,
  type CodexTranscript,
  type CodexTranscriptMessage,
} from "./codex-transcript.js";
import {
  getTranscriptEntryId,
  readLeafPathMessages,
  readTranscriptHeader,
  resolveTranscriptMessageCreatedAt,
} from "./transcript.js";

export type MigrationFileStatus = "would-import" | "imported" | "up-to-date" | "skipped" | "error";
export type SessionSourceFormat = "openclaw" | "codex";

export type MigrationFileResult = {
  file: string;
  status: MigrationFileStatus;
  sessionId: string | null;
  candidateMessages: number;
  importedMessages: number;
  skippedMessages: number;
  reason?: string;
  warnings: string[];
  error?: string;
};

export type SessionMigrationOptions = {
  sourceFormat?: SessionSourceFormat;
  /** Required Codex destination binding. */
  sessionId?: string;
  /** Required Codex destination binding. */
  sessionKey?: string;
  dbPath?: string;
  stateDir?: string;
  sessionDirs?: string[];
  files?: string[];
  apply?: boolean;
  limit?: number;
  since?: string | Date;
  verbose?: boolean;
};

export type SessionMigrationResult = {
  apply: boolean;
  dbPath: string;
  stateDir: string;
  backupPath: string | null;
  scannedFiles: number;
  importedFiles: number;
  skippedFiles: number;
  errorFiles: number;
  importedMessages: number;
  files: MigrationFileResult[];
};

type PreparedSessionFile = {
  file: string;
  sessionId: string;
  sessionHeaderId: string | null;
  messages: AgentMessage[];
  sessionKey?: string;
  sourceFormat: SessionSourceFormat;
  codex?: CodexTranscript;
  warnings: string[];
  stat: {
    size: number;
    mtimeMs: number;
  };
};

type ImportableMessage = {
  message: AgentMessage;
  stored: StoredMessage;
  transcriptEntryId: string | null;
  openClawSenderMetadata: OpenClawSenderMetadata | null;
  codexSource?: CodexTranscriptMessage;
};

export function defaultStateDir(): string {
  return process.env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
}

export function defaultDbPath(stateDir = defaultStateDir()): string {
  return join(stateDir, "lcm.db");
}

export function expandHomePath(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }
  if (pathValue.startsWith("~/")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function normalizePathInput(pathValue: string): string {
  return resolve(expandHomePath(pathValue));
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error(`Invalid --limit value: ${limit}`);
  }
  return Math.floor(limit);
}

function normalizeSince(since: string | Date | undefined): Date | undefined {
  if (since === undefined) {
    return undefined;
  }
  const value = since instanceof Date ? since : new Date(since);
  if (!Number.isFinite(value.getTime())) {
    throw new Error(`Invalid --since value: ${String(since)}`);
  }
  return value;
}

async function safeStat(file: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const fileStat = await stat(file);
    if (!fileStat.isFile()) {
      return null;
    }
    await access(file, constants.R_OK);
    return { size: fileStat.size, mtimeMs: fileStat.mtimeMs };
  } catch {
    return null;
  }
}

async function listJsonlFilesInDirectory(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

async function listDefaultSessionFiles(stateDir: string): Promise<string[]> {
  const agentsDir = join(stateDir, "agents");
  let agents: Dirent<string>[];
  try {
    agents = await readdir(agentsDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const agent of agents) {
    if (!agent.isDirectory()) {
      continue;
    }
    files.push(...await listJsonlFilesInDirectory(join(agentsDir, agent.name, "sessions")));
  }
  return files;
}

export async function discoverSessionFiles(options: SessionMigrationOptions = {}): Promise<string[]> {
  const stateDir = normalizePathInput(options.stateDir ?? defaultStateDir());
  const since = normalizeSince(options.since);
  const limit = normalizeLimit(options.limit);
  if (limit === 0) {
    return [];
  }
  const discovered = new Set<string>();

  for (const file of options.files ?? []) {
    discovered.add(normalizePathInput(file));
  }

  for (const sessionDir of options.sessionDirs ?? []) {
    for (const file of await listJsonlFilesInDirectory(normalizePathInput(sessionDir))) {
      discovered.add(resolve(file));
    }
  }

  if ((options.files?.length ?? 0) === 0 && (options.sessionDirs?.length ?? 0) === 0) {
    for (const file of await listDefaultSessionFiles(stateDir)) {
      discovered.add(resolve(file));
    }
  }

  const files = [...discovered].sort((left, right) => left.localeCompare(right));
  const filtered: string[] = [];
  for (const file of files) {
    const fileStat = await safeStat(file);
    if (!fileStat) {
      filtered.push(file);
      continue;
    }
    if (since && fileStat.mtimeMs < since.getTime()) {
      continue;
    }
    filtered.push(file);
    if (limit !== undefined && filtered.length >= limit) {
      break;
    }
  }
  return filtered;
}

async function prepareSessionFile(
  file: string,
  options: SessionMigrationOptions,
): Promise<PreparedSessionFile | MigrationFileResult> {
  const fileStat = await safeStat(file);
  if (!fileStat) {
    return {
      file,
      status: "error",
      sessionId: null,
      candidateMessages: 0,
      importedMessages: 0,
      skippedMessages: 0,
      reason: "unreadable-file",
      warnings: [],
      error: "File does not exist, is not readable, or is not a regular file.",
    };
  }

  if (options.sourceFormat === "codex") {
    try {
      const codex = await readCodexTranscript(file);
      const sessionId = options.sessionId!.trim();
      return {
        file,
        sessionId,
        sessionHeaderId: codex.threadId,
        sessionKey: options.sessionKey!.trim(),
        sourceFormat: "codex",
        codex,
        messages: codex.messages.map((record) => record.message),
        stat: fileStat,
        warnings: [
          ...codex.warnings,
          "Codex provenance ids are not OpenClaw transcript anchors. Native LCM continuation requires a later OpenClaw transcript tail with matching user/assistant text; tool-only or nonmatching overlap may start a fresh conversation.",
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        file,
        status: "error",
        sessionId: options.sessionId?.trim() || null,
        candidateMessages: 0,
        importedMessages: 0,
        skippedMessages: 0,
        reason: "invalid-codex-source",
        warnings: [],
        error: message,
      };
    }
  }

  const [header, rawMessages] = await Promise.all([
    readTranscriptHeader(file),
    readLeafPathMessages(file),
  ]);
  const messages = filterPersistableMessages(rawMessages);
  const sessionId = header.sessionHeaderId ?? basename(file, extname(file));

  if (messages.length === 0) {
    return {
      file,
      status: "skipped",
      sessionId,
      candidateMessages: 0,
      importedMessages: 0,
      skippedMessages: 0,
      reason: "no-persistable-messages",
      warnings: [`No persistable messages were found in ${file}.`],
    };
  }

  return {
    file,
    sessionId,
    sessionHeaderId: header.sessionHeaderId,
    messages,
    stat: fileStat,
    sourceFormat: "openclaw",
    warnings: [],
  };
}

function isPreparedSessionFile(
  value: PreparedSessionFile | MigrationFileResult,
): value is PreparedSessionFile {
  return "messages" in value;
}

async function createDatabaseBackup(dbPath: string): Promise<string | null> {
  try {
    await access(dbPath, constants.R_OK);
  } catch {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const backupPath = `${dbPath}.migrate-sessions-${timestamp}.bak`;
  await mkdir(dirname(backupPath), { recursive: true });
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    source.exec("PRAGMA busy_timeout = 30000");
    source.exec(`VACUUM INTO ${sqliteStringLiteral(backupPath)}`);
  } finally {
    source.close();
  }
  return backupPath;
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function toImportableMessages(prepared: PreparedSessionFile): ImportableMessage[] {
  if (prepared.codex) {
    return prepared.codex.messages.map((codexSource) => ({
      message: codexSource.message,
      stored: toStoredMessage(codexSource.message),
      transcriptEntryId: null,
      openClawSenderMetadata: null,
      codexSource,
    }));
  }
  return prepared.messages.map((message) => ({
    message,
    stored: toStoredMessage(message),
    transcriptEntryId: getTranscriptEntryId(message),
    openClawSenderMetadata: extractOpenClawSenderMetadata(message),
  }));
}

function buildDryRunResult(prepared: PreparedSessionFile | MigrationFileResult): MigrationFileResult {
  if (!isPreparedSessionFile(prepared)) {
    return prepared;
  }
  return {
    file: prepared.file,
    status: "would-import",
    sessionId: prepared.sessionId,
    candidateMessages: prepared.messages.length,
    importedMessages: 0,
    skippedMessages: 0,
    warnings: [...prepared.warnings],
  };
}

class MigrationImportError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
  }
}

type PersistedCodexSourceRow = {
  source_id: string;
  thread_id: string;
  source_line: number;
  line_hash: string;
};

type PersistedCodexPrefixReceipt = {
  partId: string;
  metadata: string;
  byteLength: number;
  sha256: string;
};

function readPersistedCodexSourceRows(
  db: DatabaseSync,
  conversationId: number,
  threadId: string,
): Map<string, PersistedCodexSourceRow> {
  const rows = db
    .prepare(
      `SELECT DISTINCT
         json_extract(p.metadata, '$.codexSource.id') AS source_id,
         json_extract(p.metadata, '$.codexSource.threadId') AS thread_id,
         json_extract(p.metadata, '$.codexSource.line') AS source_line,
         json_extract(p.metadata, '$.codexSource.lineHash') AS line_hash
       FROM message_parts AS p
       JOIN messages AS m ON m.message_id = p.message_id
       WHERE m.conversation_id = ?
         AND json_valid(p.metadata)
         AND json_extract(p.metadata, '$.codexSource.threadId') = ?`,
    )
    .all(conversationId, threadId);
  const result = new Map<string, PersistedCodexSourceRow>();
  for (const row of rows) {
    if (
      typeof row.source_id !== "string" ||
      typeof row.thread_id !== "string" ||
      typeof row.source_line !== "number" ||
      !Number.isSafeInteger(row.source_line) ||
      typeof row.line_hash !== "string"
    ) {
      throw new MigrationImportError(
        "invalid-codex-provenance",
        `Conversation ${conversationId} contains incomplete Codex source provenance; refusing to append.`,
      );
    }
    const previous = result.get(row.source_id);
    if (previous && (previous.source_line !== row.source_line || previous.line_hash !== row.line_hash)) {
      throw new MigrationImportError(
        "invalid-codex-provenance",
        `Conversation ${conversationId} contains conflicting Codex source provenance; refusing to append.`,
      );
    }
    result.set(row.source_id, {
      source_id: row.source_id,
      thread_id: row.thread_id,
      source_line: row.source_line,
      line_hash: row.line_hash,
    });
  }
  return result;
}

function readPersistedCodexThreadIds(db: DatabaseSync, conversationId: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT json_extract(p.metadata, '$.codexSource.threadId') AS thread_id
       FROM message_parts AS p
       JOIN messages AS m ON m.message_id = p.message_id
       WHERE m.conversation_id = ?
         AND json_valid(p.metadata)
         AND json_extract(p.metadata, '$.codexSource.threadId') IS NOT NULL`,
    )
    .all(conversationId);
  return new Set(rows.flatMap((row) => typeof row.thread_id === "string" ? [row.thread_id] : []));
}

function readCodexProvenanceMessageCount(db: DatabaseSync, conversationId: number, threadId: string): number {
  const row = db.prepare(
    `SELECT COUNT(DISTINCT m.message_id) AS message_count
     FROM messages AS m
     WHERE m.conversation_id = ?
       AND EXISTS (
         SELECT 1
         FROM message_parts AS p
         WHERE p.message_id = m.message_id
           AND json_valid(p.metadata)
           AND json_extract(p.metadata, '$.codexSource.threadId') = ?
       )`,
  ).get(conversationId, threadId) as { message_count: number } | undefined;
  return row?.message_count ?? 0;
}

function readPersistedCodexPrefixReceipt(
  db: DatabaseSync,
  conversationId: number,
  threadId: string,
): PersistedCodexPrefixReceipt | null {
  const row = db.prepare(
    `SELECT p.part_id, p.metadata
     FROM message_parts AS p
     JOIN messages AS m ON m.message_id = p.message_id
     WHERE m.conversation_id = ?
       AND json_valid(p.metadata)
       AND json_extract(p.metadata, '$.codexSource.threadId') = ?
     ORDER BY m.seq, p.ordinal
     LIMIT 1`,
  ).get(conversationId, threadId) as { part_id: string; metadata: string | null } | undefined;
  if (!row || typeof row.metadata !== "string") {
    return null;
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(row.metadata);
  } catch {
    return null;
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const codexSource = (metadata as Record<string, unknown>).codexSource;
  if (!codexSource || typeof codexSource !== "object" || Array.isArray(codexSource)) {
    return null;
  }
  const acceptedPrefix = (codexSource as Record<string, unknown>).acceptedPrefix;
  if (!acceptedPrefix || typeof acceptedPrefix !== "object" || Array.isArray(acceptedPrefix)) {
    return null;
  }
  const { byteLength, sha256 } = acceptedPrefix as Record<string, unknown>;
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) <= 0 || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
    return null;
  }
  return { partId: row.part_id, metadata: row.metadata, byteLength: byteLength as number, sha256 };
}

function updateCodexPrefixReceipt(
  db: DatabaseSync,
  conversationId: number,
  threadId: string,
  byteLength: number,
  sha256: string,
): void {
  const receipt = readPersistedCodexPrefixReceipt(db, conversationId, threadId);
  if (!receipt) {
    throw new MigrationImportError(
      "codex-source-checkpoint-missing",
      `Conversation ${conversationId} has no valid Codex source-prefix receipt; refusing to accept a changed source without an integrity checkpoint.`,
    );
  }
  const metadata = JSON.parse(receipt.metadata) as Record<string, unknown>;
  const codexSource = metadata.codexSource as Record<string, unknown>;
  codexSource.acceptedPrefix = { byteLength, sha256 };
  const result = db.prepare(`UPDATE message_parts SET metadata = ? WHERE part_id = ?`).run(
    JSON.stringify(metadata),
    receipt.partId,
  );
  if (result.changes !== 1) {
    throw new MigrationImportError(
      "codex-source-checkpoint-write-failed",
      `Conversation ${conversationId} Codex source-prefix receipt could not be updated.`,
    );
  }
}

function assertCodexDestinationBinding(
  bySessionId: Awaited<ReturnType<ConversationStore["getConversationForSession"]>>,
  bySessionKey: Awaited<ReturnType<ConversationStore["getConversationForSession"]>>,
  sessionId: string,
  sessionKey: string,
): void {
  if (bySessionId && bySessionKey && bySessionId.conversationId !== bySessionKey.conversationId) {
    throw new MigrationImportError(
      "destination-binding-mismatch",
      `The target session id ${sessionId} and session key ${sessionKey} already resolve to different conversations.`,
    );
  }
  if (bySessionId?.sessionKey && bySessionId.sessionKey !== sessionKey) {
    throw new MigrationImportError(
      "destination-binding-mismatch",
      `The target session id ${sessionId} is already bound to session key ${bySessionId.sessionKey}.`,
    );
  }
  if (bySessionKey && bySessionKey.sessionId !== sessionId) {
    throw new MigrationImportError(
      "destination-binding-mismatch",
      `The target session key ${sessionKey} is already bound to session id ${bySessionKey.sessionId}.`,
    );
  }
}

function addCodexSourceProvenance(
  parts: ReturnType<typeof buildMessageParts>,
  source: CodexTranscriptMessage,
  sessionId: string,
  acceptedPrefix?: { byteLength: number; sha256: string },
): ReturnType<typeof buildMessageParts> {
  const provenance = {
    version: 1,
    id: source.sourceId,
    threadId: source.threadId,
    line: source.line,
    lineHash: source.lineHash,
    sourceRecord: source.sourceRecord,
    ...(source.sessionMeta ? { sessionMeta: source.sessionMeta } : {}),
    ...(source.sessionMeta && acceptedPrefix ? { acceptedPrefix } : {}),
  };
  const firstPart = parts.find((part) => part.ordinal === 0);
  if (!firstPart) {
    return [{
      sessionId,
      partType: "agent",
      ordinal: 0,
      textContent: null,
      metadata: JSON.stringify({ originalRole: source.message.role, codexSource: provenance }),
    }];
  }
  let existing: Record<string, unknown> = {};
  if (typeof firstPart.metadata === "string") {
    try {
      const parsed: unknown = JSON.parse(firstPart.metadata);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      } else {
        existing = { previousMetadata: firstPart.metadata };
      }
    } catch {
      existing = { previousMetadata: firstPart.metadata };
    }
  }
  firstPart.metadata = JSON.stringify({ ...existing, codexSource: provenance });
  return parts;
}

async function importPreparedFile(
  db: DatabaseSync,
  conversationStore: ConversationStore,
  summaryStore: SummaryStore,
  prepared: PreparedSessionFile,
): Promise<MigrationFileResult> {
  const importable = toImportableMessages(prepared);
  const warnings: string[] = [...prepared.warnings];
  return withDatabaseTransaction(db, "BEGIN IMMEDIATE", async () => {
    let conversation;
    let existingCount: number;
    if (prepared.codex) {
      const sessionKey = prepared.sessionKey!;
      const bySessionId = await conversationStore.getConversationForSession({ sessionId: prepared.sessionId });
      const bySessionKey = await conversationStore.getConversationForSession({ sessionKey });
      assertCodexDestinationBinding(bySessionId, bySessionKey, prepared.sessionId, sessionKey);
      conversation = await conversationStore.getOrCreateConversation(prepared.sessionId, {
        title: `Imported Codex thread ${prepared.codex.threadId}`,
        sessionKey,
      });

      existingCount = await conversationStore.getMessageCount(conversation.conversationId);
      const existingThreads = readPersistedCodexThreadIds(db, conversation.conversationId);
      if (existingCount > 0 && existingThreads.size === 0) {
        throw new MigrationImportError(
          "codex-destination-not-empty",
          "The target conversation already contains messages without Codex source provenance. Import the rollout into a fresh or not-yet-used LCM destination before its first LCM turn.",
        );
      }
      if (existingThreads.size > 0 && (existingThreads.size !== 1 || !existingThreads.has(prepared.codex.threadId))) {
        throw new MigrationImportError(
          "codex-thread-mismatch",
          "The target conversation already contains a different Codex thread; importing multiple Codex threads into one destination is not supported.",
        );
      }

      if (
        existingCount > 0 &&
        readCodexProvenanceMessageCount(db, conversation.conversationId, prepared.codex.threadId) !== existingCount
      ) {
        throw new MigrationImportError(
          "codex-destination-not-empty",
          "The target conversation contains native or otherwise unmarked messages alongside the Codex import. Refusing to append source history after live turns.",
        );
      }

      if (existingCount > 0) {
        const receipt = readPersistedCodexPrefixReceipt(db, conversation.conversationId, prepared.codex.threadId);
        if (!receipt) {
          throw new MigrationImportError(
            "codex-source-checkpoint-missing",
            "The existing Codex import has no accepted source-prefix receipt. Refusing to replay without proof that omitted source records are unchanged.",
          );
        }
        const prefixHash = receipt.byteLength <= prepared.codex.sourceSize
          ? await hashCodexSourcePrefix(prepared.file, receipt.byteLength)
          : null;
        if (prefixHash !== receipt.sha256) {
          throw new MigrationImportError(
            "codex-source-changed-or-truncated",
            `Codex source no longer preserves its previously accepted ${receipt.byteLength}-byte prefix from thread ${prepared.codex.threadId}; refusing to rewrite the archive.`,
          );
        }
      }

      const persistedSources = readPersistedCodexSourceRows(db, conversation.conversationId, prepared.codex.threadId);
      const currentByLine = new Map(prepared.codex.messages.map((record) => [record.line, record.sourceId]));
      for (const previous of persistedSources.values()) {
        if (currentByLine.get(previous.source_line) !== previous.source_id) {
          throw new MigrationImportError(
            "codex-source-changed-or-truncated",
            `Codex source no longer contains previously imported line ${previous.source_line} from thread ${prepared.codex.threadId}; refusing to rewrite the archive.`,
          );
        }
      }
      const sourceCheck = await hashCodexSource(prepared.file);
      if (sourceCheck.hash !== prepared.codex.sourceHash) {
        throw new MigrationImportError(
          "codex-source-changed-during-import",
          "Codex source changed after preflight; no messages were committed.",
        );
      }
    } else {
      conversation = await conversationStore.getOrCreateConversation(prepared.sessionId, {
        title: `Imported OpenClaw session ${prepared.sessionId}`,
      });
      existingCount = await conversationStore.getMessageCount(conversation.conversationId);
    }
    const hasMissingTranscriptEntryIds = importable.some((entry) => !entry.transcriptEntryId);
    if (prepared.sourceFormat === "openclaw" && existingCount > 0 && hasMissingTranscriptEntryIds) {
      warnings.push(
        `Conversation ${prepared.sessionId} already has messages but the transcript lacks stable entry ids; skipping to avoid duplicates.`,
      );
      return {
        file: prepared.file,
        status: "skipped",
        sessionId: prepared.sessionId,
        candidateMessages: importable.length,
        importedMessages: 0,
        skippedMessages: importable.length,
        reason: "existing-conversation-without-transcript-entry-ids",
        warnings,
      };
    }

    const existingEntryIds =
      existingCount > 0 && prepared.sourceFormat === "openclaw"
        ? await conversationStore.filterExistingTranscriptEntryIds(
            conversation.conversationId,
            importable
              .map((entry) => entry.transcriptEntryId)
              .filter((entryId): entryId is string => entryId !== null),
          )
        : new Set<string>();
    const seenEntryIds = new Set<string>();
    const toImport: ImportableMessage[] = [];
    let skippedMessages = 0;
    const persistedCodexIds = prepared.codex
      ? readPersistedCodexSourceRows(db, conversation.conversationId, prepared.codex.threadId)
      : new Map<string, PersistedCodexSourceRow>();
    for (const entry of importable) {
      if (entry.codexSource) {
        if (persistedCodexIds.has(entry.codexSource.sourceId)) {
          skippedMessages += 1;
          continue;
        }
        toImport.push(entry);
        continue;
      }
      if (entry.transcriptEntryId) {
        if (existingEntryIds.has(entry.transcriptEntryId)) {
          skippedMessages += 1;
          continue;
        }
        if (seenEntryIds.has(entry.transcriptEntryId)) {
          skippedMessages += 1;
          warnings.push(`Duplicate transcript entry id ${entry.transcriptEntryId} was skipped within ${prepared.file}.`);
          continue;
        }
        seenEntryIds.add(entry.transcriptEntryId);
      }
      toImport.push(entry);
    }

    const createdMessages: MessageRecord[] = [];
    let nextSeq = (await conversationStore.getMaxSeq(conversation.conversationId)) + 1;
    for (const entry of toImport) {
      const message = await conversationStore.createMessage({
        conversationId: conversation.conversationId,
        seq: nextSeq,
        role: entry.stored.role,
        content: entry.stored.content,
        tokenCount: entry.stored.tokenCount,
        openClawSenderMetadata: entry.openClawSenderMetadata,
        transcriptEntryId: entry.transcriptEntryId,
        createdAt: resolveTranscriptMessageCreatedAt(entry.message),
        skipReplayTimestampFloodGuard: true,
      });
      if (entry.transcriptEntryId) {
        await conversationStore.upsertMessageTranscriptAnchorTrust({
          messageId: message.messageId,
          conversationId: conversation.conversationId,
          transcriptEntryId: entry.transcriptEntryId,
          trustState: "verified",
          source: "migrate-sessions",
          reason: "message imported from transcript entry",
          verifiedAt: new Date(),
        });
      }
      nextSeq += 1;
      const parts = buildMessageParts({
        sessionId: prepared.sessionId,
        message: entry.message,
        fallbackContent: entry.stored.content,
      });
      await conversationStore.createMessageParts(
        message.messageId,
        entry.codexSource
          ? addCodexSourceProvenance(
              parts,
              entry.codexSource,
              prepared.sessionId,
              entry.codexSource.sessionMeta && prepared.codex
                ? { byteLength: prepared.codex.sourceSize, sha256: prepared.codex.sourceHash }
                : undefined,
            )
          : parts,
      );
      createdMessages.push(message);
    }

    await summaryStore.appendContextMessages(
      conversation.conversationId,
      createdMessages.map((message) => message.messageId),
    );
    if (prepared.codex) {
      const sourceCheck = await hashCodexSource(prepared.file);
      if (sourceCheck.hash !== prepared.codex.sourceHash) {
        throw new MigrationImportError(
          "codex-source-changed-during-import",
          "Codex source changed before the database transaction committed; all imported rows were rolled back.",
        );
      }
      updateCodexPrefixReceipt(
        db,
        conversation.conversationId,
        prepared.codex.threadId,
        prepared.codex.sourceSize,
        prepared.codex.sourceHash,
      );
    }
    await conversationStore.markConversationBootstrapped(conversation.conversationId);

    if (createdMessages.length === 0) {
      return {
        file: prepared.file,
        status: "up-to-date",
        sessionId: prepared.sessionId,
        candidateMessages: importable.length,
        importedMessages: 0,
        skippedMessages,
        warnings,
      };
    }

    return {
      file: prepared.file,
      status: "imported",
      sessionId: prepared.sessionId,
      candidateMessages: importable.length,
      importedMessages: createdMessages.length,
      skippedMessages,
      warnings,
    };
  });
}

function summarizeResult(params: {
  apply: boolean;
  dbPath: string;
  stateDir: string;
  backupPath: string | null;
  files: MigrationFileResult[];
}): SessionMigrationResult {
  const files = params.files;
  return {
    apply: params.apply,
    dbPath: params.dbPath,
    stateDir: params.stateDir,
    backupPath: params.backupPath,
    scannedFiles: files.length,
    importedFiles: files.filter((file) => file.status === "imported").length,
    skippedFiles: files.filter((file) => file.status === "skipped" || file.status === "up-to-date").length,
    errorFiles: files.filter((file) => file.status === "error").length,
    importedMessages: files.reduce((total, file) => total + file.importedMessages, 0),
    files,
  };
}

function validateSessionMigrationOptions(options: SessionMigrationOptions): SessionSourceFormat {
  const sourceFormat = options.sourceFormat ?? "openclaw";
  if (sourceFormat !== "openclaw" && sourceFormat !== "codex") {
    throw new Error(`Invalid source format: ${String(sourceFormat)}`);
  }
  if (sourceFormat === "openclaw") {
    if (options.sessionId !== undefined || options.sessionKey !== undefined) {
      throw new Error("--session-id and --session-key are only valid with --source-format codex.");
    }
    return sourceFormat;
  }
  const sessionId = options.sessionId?.trim();
  const sessionKey = options.sessionKey?.trim();
  if (!sessionId || !sessionKey) {
    throw new Error("Codex import requires explicit --session-id and --session-key destination binding.");
  }
  if ((options.files?.length ?? 0) !== 1 || (options.sessionDirs?.length ?? 0) > 0) {
    throw new Error("Codex import requires exactly one --file and does not accept --sessions-dir.");
  }
  if (options.limit !== undefined || options.since !== undefined) {
    throw new Error("Codex single-file import does not accept --limit or --since.");
  }
  return sourceFormat;
}

export async function runSessionMigration(
  options: SessionMigrationOptions = {},
): Promise<SessionMigrationResult> {
  const sourceFormat = validateSessionMigrationOptions(options);
  const stateDir = normalizePathInput(options.stateDir ?? defaultStateDir());
  const dbPath = normalizePathInput(options.dbPath ?? defaultDbPath(stateDir));
  const apply = options.apply === true;
  const files = await discoverSessionFiles({ ...options, sourceFormat, stateDir });
  let prepared = await Promise.all(files.map((file) => prepareSessionFile(file, { ...options, sourceFormat })));

  if (!apply) {
    return summarizeResult({
      apply,
      dbPath,
      stateDir,
      backupPath: null,
      files: prepared.map(buildDryRunResult),
    });
  }

  prepared = await Promise.all(prepared.map(async (file) => {
    if (!isPreparedSessionFile(file) || !file.codex) {
      return file;
    }
    try {
      const sourceCheck = await hashCodexSource(file.file);
      if (sourceCheck.hash === file.codex.sourceHash) {
        return file;
      }
      return {
        file: file.file,
        status: "error" as const,
        sessionId: file.sessionId,
        candidateMessages: file.messages.length,
        importedMessages: 0,
        skippedMessages: 0,
        reason: "codex-source-changed-before-import",
        warnings: [...file.warnings],
        error: "Codex source changed after preflight; no database changes were made.",
      };
    } catch (error) {
      return {
        file: file.file,
        status: "error" as const,
        sessionId: file.sessionId,
        candidateMessages: file.messages.length,
        importedMessages: 0,
        skippedMessages: 0,
        reason: "codex-source-unavailable-before-import",
        warnings: [...file.warnings],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  if (sourceFormat === "codex" && !prepared.some(isPreparedSessionFile)) {
    return summarizeResult({
      apply,
      dbPath,
      stateDir,
      backupPath: null,
      files: prepared as MigrationFileResult[],
    });
  }

  const backupPath = await createDatabaseBackup(dbPath);
  const db = createLcmDatabaseConnection(dbPath);
  try {
    runLcmMigrations(db);
    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const results: MigrationFileResult[] = [];
    for (const file of prepared) {
      if (!isPreparedSessionFile(file)) {
        results.push(file);
        continue;
      }
      try {
        results.push(await importPreparedFile(db, conversationStore, summaryStore, file));
      } catch (error) {
        const reason = error instanceof MigrationImportError ? error.reason : "import-failed";
        results.push({
          file: file.file,
          status: "error",
          sessionId: file.sessionId,
          candidateMessages: file.messages.length,
          importedMessages: 0,
          skippedMessages: 0,
          reason,
          warnings: [...file.warnings],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return summarizeResult({ apply, dbPath, stateDir, backupPath, files: results });
  } finally {
    closeLcmConnection(db);
  }
}

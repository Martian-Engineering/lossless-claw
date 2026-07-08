import { constants, type Dirent } from "node:fs";
import { access, mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { closeLcmConnection, createLcmDatabaseConnection } from "./db/connection.js";
import { runLcmMigrations } from "./db/migration.js";
import { buildMessageParts, filterPersistableMessages, toStoredMessage, type StoredMessage } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { ConversationStore, type MessageRecord } from "./store/conversation-store.js";
import { SummaryStore } from "./store/summary-store.js";
import { withDatabaseTransaction } from "./transaction-mutex.js";
import {
  getTranscriptEntryId,
  readLeafPathMessages,
  readTranscriptHeader,
  resolveTranscriptMessageCreatedAt,
} from "./transcript.js";

export type MigrationFileStatus = "would-import" | "imported" | "up-to-date" | "skipped" | "error";

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
  stat: {
    size: number;
    mtimeMs: number;
  };
};

type ImportableMessage = {
  message: AgentMessage;
  stored: StoredMessage;
  transcriptEntryId: string | null;
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

async function prepareSessionFile(file: string): Promise<PreparedSessionFile | MigrationFileResult> {
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

function toImportableMessages(messages: AgentMessage[]): ImportableMessage[] {
  return messages.map((message) => ({
    message,
    stored: toStoredMessage(message),
    transcriptEntryId: getTranscriptEntryId(message),
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
    warnings: [],
  };
}

async function importPreparedFile(
  db: DatabaseSync,
  conversationStore: ConversationStore,
  summaryStore: SummaryStore,
  prepared: PreparedSessionFile,
): Promise<MigrationFileResult> {
  const importable = toImportableMessages(prepared.messages);
  const warnings: string[] = [];
  return withDatabaseTransaction(db, "BEGIN IMMEDIATE", async () => {
    const conversation = await conversationStore.getOrCreateConversation(prepared.sessionId, {
      title: `Imported OpenClaw session ${prepared.sessionId}`,
    });
    const existingCount = await conversationStore.getMessageCount(conversation.conversationId);
    const hasMissingTranscriptEntryIds = importable.some((entry) => !entry.transcriptEntryId);
    if (existingCount > 0 && hasMissingTranscriptEntryIds) {
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
      existingCount > 0
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
    for (const entry of importable) {
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
        if (existingCount > 0 && entry.stored.content.trim().length > 0) {
          const adopted = await conversationStore.adoptTranscriptEntryId(
            conversation.conversationId,
            entry.stored.role,
            entry.stored.content,
            entry.transcriptEntryId,
          );
          if (adopted) {
            const anchor = await conversationStore.getTranscriptEntryAnchorCandidate(
              conversation.conversationId,
              entry.transcriptEntryId,
            );
            if (anchor) {
              await conversationStore.upsertMessageTranscriptAnchorTrust({
                messageId: anchor.messageId,
                conversationId: conversation.conversationId,
                transcriptEntryId: entry.transcriptEntryId,
                trustState: "repaired",
                source: "migrate-sessions",
                reason: "identity-matched non-empty transcript migration",
                verifiedAt: new Date(),
              });
            }
            existingEntryIds.add(entry.transcriptEntryId);
            skippedMessages += 1;
            continue;
          }
        }
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
      await conversationStore.createMessageParts(
        message.messageId,
        buildMessageParts({
          sessionId: prepared.sessionId,
          message: entry.message,
          fallbackContent: entry.stored.content,
        }),
      );
      createdMessages.push(message);
    }

    await summaryStore.appendContextMessages(
      conversation.conversationId,
      createdMessages.map((message) => message.messageId),
    );
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

export async function runSessionMigration(
  options: SessionMigrationOptions = {},
): Promise<SessionMigrationResult> {
  const stateDir = normalizePathInput(options.stateDir ?? defaultStateDir());
  const dbPath = normalizePathInput(options.dbPath ?? defaultDbPath(stateDir));
  const apply = options.apply === true;
  const files = await discoverSessionFiles({ ...options, stateDir });
  const prepared = await Promise.all(files.map((file) => prepareSessionFile(file)));

  if (!apply) {
    return summarizeResult({
      apply,
      dbPath,
      stateDir,
      backupPath: null,
      files: prepared.map(buildDryRunResult),
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
        results.push({
          file: file.file,
          status: "error",
          sessionId: file.sessionId,
          candidateMessages: file.messages.length,
          importedMessages: 0,
          skippedMessages: 0,
          reason: "import-failed",
          warnings: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return summarizeResult({ apply, dbPath, stateDir, backupPath, files: results });
  } finally {
    closeLcmConnection(db);
  }
}

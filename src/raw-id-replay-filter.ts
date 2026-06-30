import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { buildMessageParts, toStoredMessage } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import {
  externalizedReplayMetadataMatches,
  extractPlainToolReplayTextsById,
  extractRawBlockIdsFromPartMetadata,
  extractRawBlockSignatureFromPartMetadata,
  extractRawIdsFromPartMetadata,
} from "./replay-metadata.js";
import { buildMessageIdentityHash } from "./store/message-identity.js";
import type { SummaryStore } from "./store/summary-store.js";
import { asRecord, safeString } from "./value-utils.js";

export async function filterPersistedRawIdReplayBatch(params: {
  db: DatabaseSync;
  summaryStore: SummaryStore;
  log: { warn(message: string): void };
  sessionContext: string;
  conversationId: number;
  sessionId: string;
  sessionKey?: string;
  messages: AgentMessage[];
}): Promise<AgentMessage[]> {
  const idMatchPredicate = `(
    json_extract(mp.metadata, '$.raw.id') = ?
    OR json_extract(mp.metadata, '$.raw.call_id') = ?
    OR json_extract(mp.metadata, '$.raw.toolCallId') = ?
    OR json_extract(mp.metadata, '$.raw.tool_call_id') = ?
    OR json_extract(mp.metadata, '$.raw.toolUseId') = ?
    OR json_extract(mp.metadata, '$.raw.tool_use_id') = ?
    OR mp.tool_call_id = ?
    OR json_extract(mp.metadata, '$.id') = ?
    OR json_extract(mp.metadata, '$.call_id') = ?
    OR json_extract(mp.metadata, '$.toolCallId') = ?
    OR json_extract(mp.metadata, '$.tool_call_id') = ?
    OR json_extract(mp.metadata, '$.toolUseId') = ?
    OR json_extract(mp.metadata, '$.tool_use_id') = ?
  )`;
  const rawCoverageStmt = params.db.prepare(
    `SELECT m.message_id AS messageId
     FROM message_parts mp
     JOIN messages m ON m.message_id = mp.message_id
     WHERE m.conversation_id = ?
       AND m.role = ?
       AND mp.metadata IS NOT NULL
       AND json_valid(mp.metadata)
       AND ${idMatchPredicate}`,
  );
  const identityCoverageStmt = params.db.prepare(
    `SELECT m.message_id AS messageId
     FROM message_parts mp
     JOIN messages m ON m.message_id = mp.message_id
     WHERE m.conversation_id = ?
       AND m.role = ?
       AND m.identity_hash = ?
       AND mp.metadata IS NOT NULL
       AND json_valid(mp.metadata)
       AND ${idMatchPredicate}`,
  );
  const externalizedCoverageStmt = params.db.prepare(
    `SELECT
       m.message_id AS messageId,
       json_extract(mp.metadata, '$.externalizedFileId') AS fileId,
       json_extract(mp.metadata, '$.originalByteSize') AS originalByteSize,
       mp.metadata AS metadata
     FROM message_parts mp
     JOIN messages m ON m.message_id = mp.message_id
     WHERE m.conversation_id = ?
       AND m.role = ?
       AND mp.metadata IS NOT NULL
       AND json_valid(mp.metadata)
       AND json_extract(mp.metadata, '$.externalizationReason') = 'large_tool_result'
       AND ${idMatchPredicate}`,
  );
  const rawBlockSignatureStmt = params.db.prepare(
    `SELECT metadata
     FROM message_parts
     WHERE message_id = ?
     ORDER BY ordinal ASC`,
  );

  const filtered: AgentMessage[] = [];
  let replayedMessages = 0;

  for (const message of params.messages) {
    const stored = toStoredMessage(message);
    const replayIds = new Set<string>();
    const rawBlockIds = new Set<string>();
    const rawBlockSignatures: string[] = [];
    const replayIdsByPart: string[][] = [];
    let everyPartHasRawBlockId = true;
    const parts = buildMessageParts({
      sessionId: params.sessionId,
      message,
      fallbackContent: stored.content,
    });
    for (const part of parts) {
      const partRawBlockIds = extractRawBlockIdsFromPartMetadata(part.metadata);
      if (partRawBlockIds.length === 0) {
        everyPartHasRawBlockId = false;
      }
      for (const rawId of partRawBlockIds) {
        rawBlockIds.add(rawId);
      }
      const rawBlockSignature = extractRawBlockSignatureFromPartMetadata(part.metadata);
      if (rawBlockSignature) {
        rawBlockSignatures.push(rawBlockSignature);
      }
      const partReplayIds = extractRawIdsFromPartMetadata(part.metadata);
      replayIdsByPart.push(partReplayIds);
      for (const rawId of partReplayIds) {
        replayIds.add(rawId);
      }
    }

    if (replayIds.size === 0) {
      filtered.push(message);
      continue;
    }

    const canMatchWithoutIdentity = rawBlockIds.size > 0 && everyPartHasRawBlockId;
    const matchedIds = canMatchWithoutIdentity ? rawBlockIds : replayIds;
    const externalizedTextsById = extractPlainToolReplayTextsById(message);
    const coverageByMessageId = new Map<number, Set<string>>();
    for (const rawId of matchedIds) {
      const rawIdArgs = [
        rawId,
        rawId,
        rawId,
        rawId,
        rawId,
        rawId,
        rawId,
        rawId,
        rawId,
        rawId,
        rawId,
        rawId,
        rawId,
      ];
      let rows: Array<{ messageId: number }>;
      if (canMatchWithoutIdentity) {
        rows = rawCoverageStmt.all(
          params.conversationId,
          stored.role,
          ...rawIdArgs,
        ) as Array<{ messageId: number }>;
      } else {
        const identityHash = buildMessageIdentityHash(stored.role, stored.content);
        rows = identityCoverageStmt.all(
          params.conversationId,
          stored.role,
          identityHash,
          ...rawIdArgs,
        ) as Array<{ messageId: number }>;
      }
      for (const row of rows) {
        const matchedRawIds = coverageByMessageId.get(row.messageId) ?? new Set<string>();
        matchedRawIds.add(rawId);
        coverageByMessageId.set(row.messageId, matchedRawIds);
      }
    }

    let alreadyPersisted = false;
    if (canMatchWithoutIdentity) {
      for (const [messageId, rawIds] of coverageByMessageId.entries()) {
        if (rawIds.size !== matchedIds.size) {
          continue;
        }
        const rows = rawBlockSignatureStmt.all(messageId) as Array<{ metadata: string | null }>;
        if (rows.length !== parts.length) {
          continue;
        }
        let allPartsMatch = true;
        for (let index = 0; index < rows.length; index += 1) {
          const persistedMetadata = rows[index]!.metadata;
          const persistedSignature = extractRawBlockSignatureFromPartMetadata(persistedMetadata);
          if (
            persistedSignature === rawBlockSignatures[index] &&
            externalizedReplayMetadataMatches(persistedMetadata, parts[index]?.metadata)
          ) {
            continue;
          }
          let externalizedPartMatches = false;
          for (const rawId of replayIdsByPart[index] ?? []) {
            if (!extractRawIdsFromPartMetadata(persistedMetadata).includes(rawId)) {
              continue;
            }
            const externalizedText = externalizedTextsById.get(rawId);
            if (externalizedText === undefined) {
              continue;
            }
            let persistedParsed: unknown;
            try {
              persistedParsed = persistedMetadata ? JSON.parse(persistedMetadata) : undefined;
            } catch {
              continue;
            }
            const persistedRecord = asRecord(persistedParsed);
            const fileId = safeString(persistedRecord?.externalizedFileId);
            const originalByteSize = persistedRecord?.originalByteSize;
            if (
              !fileId ||
              Number(originalByteSize) !== Buffer.byteLength(externalizedText, "utf8")
            ) {
              continue;
            }
            const largeFile = await params.summaryStore.getLargeFile(fileId);
            if (!largeFile) {
              continue;
            }
            let storedText: string;
            try {
              storedText = readFileSync(largeFile.storageUri, "utf8");
            } catch {
              continue;
            }
            if (
              storedText === externalizedText &&
              externalizedReplayMetadataMatches(persistedMetadata, parts[index]?.metadata)
            ) {
              externalizedPartMatches = true;
              break;
            }
          }
          if (!externalizedPartMatches) {
            allPartsMatch = false;
            break;
          }
        }
        if (allPartsMatch) {
          alreadyPersisted = true;
          break;
        }
      }
    } else {
      for (const [messageId, rawIds] of coverageByMessageId.entries()) {
        if (rawIds.size !== matchedIds.size) {
          continue;
        }
        const rows = rawBlockSignatureStmt.all(messageId) as Array<{ metadata: string | null }>;
        if (
          rows.length === parts.length &&
          rows.every((row, index) => row.metadata === (parts[index]?.metadata ?? null))
        ) {
          alreadyPersisted = true;
          break;
        }
      }
    }

    const canUseExternalizedFallback = parts.length === 1 || everyPartHasRawBlockId;
    if (!alreadyPersisted && canUseExternalizedFallback && externalizedTextsById.size > 0) {
      const externalizedCoverageByMessageId = new Map<number, Set<string>>();
      for (const rawId of matchedIds) {
        const externalizedText = externalizedTextsById.get(rawId);
        if (externalizedText === undefined) {
          continue;
        }
        const externalizedByteSize = Buffer.byteLength(externalizedText, "utf8");
        const rawIdArgs = [
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
        ];
        const rows = externalizedCoverageStmt.all(
          params.conversationId,
          stored.role,
          ...rawIdArgs,
        ) as Array<{
          messageId: number;
          fileId: unknown;
          originalByteSize: unknown;
          metadata: string | null;
        }>;
        for (const row of rows) {
          if (
            typeof row.fileId !== "string" ||
            Number(row.originalByteSize) !== externalizedByteSize
          ) {
            continue;
          }
          const largeFile = await params.summaryStore.getLargeFile(row.fileId);
          if (!largeFile) {
            continue;
          }
          let storedText: string;
          try {
            storedText = readFileSync(largeFile.storageUri, "utf8");
          } catch {
            continue;
          }
          if (
            storedText !== externalizedText ||
            !externalizedReplayMetadataMatches(row.metadata, parts[0]?.metadata)
          ) {
            continue;
          }
          const matchedRawIds =
            externalizedCoverageByMessageId.get(row.messageId) ?? new Set<string>();
          matchedRawIds.add(rawId);
          externalizedCoverageByMessageId.set(row.messageId, matchedRawIds);
        }
      }
      alreadyPersisted = Array.from(externalizedCoverageByMessageId.values()).some(
        (rawIds) => rawIds.size === matchedIds.size,
      );
    }

    if (alreadyPersisted) {
      replayedMessages += 1;
    } else {
      filtered.push(message);
    }
  }

  if (replayedMessages > 0) {
    params.log.warn(
      `[lcm] ingestBatch: dropped ${replayedMessages}/${params.messages.length} raw-id replay messages for ${params.sessionContext}`,
    );
  }

  return filtered;
}

export function batchHasRawReplayIds(params: {
  sessionId: string;
  messages: AgentMessage[];
}): boolean {
  for (const message of params.messages) {
    const stored = toStoredMessage(message);
    const parts = buildMessageParts({
      sessionId: params.sessionId,
      message,
      fallbackContent: stored.content,
    });
    if (parts.some((part) => extractRawIdsFromPartMetadata(part.metadata).length > 0)) {
      return true;
    }
  }
  return false;
}

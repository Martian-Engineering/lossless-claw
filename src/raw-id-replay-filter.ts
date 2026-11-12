import type { SummaryRepository as SummaryStore } from "./store/ports.js";
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
import { asRecord, safeString } from "./value-utils.js";

export type RawReplayCoverage = {
  find(
    conversationId: number,
    role: string,
    rawId: string,
    identityHash?: string,
  ): Promise<Array<{ messageId: number }>>;
  externalized(
    conversationId: number,
    role: string,
    rawId: string,
  ): Promise<
    Array<{
      messageId: number;
      fileId: unknown;
      originalByteSize: unknown;
      metadata: string | null;
    }>
  >;
  parts(messageId: number): Promise<Array<{ metadata: string | null }>>;
};
function sqliteCoverage(db: DatabaseSync): RawReplayCoverage {
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
  const rawCoverageStmt = db.prepare(
    `SELECT m.message_id AS messageId
     FROM message_parts mp
     JOIN messages m ON m.message_id = mp.message_id
     WHERE m.conversation_id = ?
       AND m.role = ?
       AND mp.metadata IS NOT NULL
       AND json_valid(mp.metadata)
       AND ${idMatchPredicate}`,
  );
  const identityCoverageStmt = db.prepare(
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
  const externalizedCoverageStmt = db.prepare(
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
  const rawBlockSignatureStmt = db.prepare(
    `SELECT metadata
     FROM message_parts
     WHERE message_id = ?
     ORDER BY ordinal ASC`,
  );

  const ids = (id: string) => Array.from({ length: 13 }, () => id);
  return {
    async find(cid, role, id, identityHash) {
      return (
        identityHash === undefined
          ? rawCoverageStmt.all(cid, role, ...ids(id))
          : identityCoverageStmt.all(cid, role, identityHash, ...ids(id))
      ) as Array<{ messageId: number }>;
    },
    async externalized(cid, role, id) {
      return externalizedCoverageStmt.all(cid, role, ...ids(id)) as Array<{
        messageId: number;
        fileId: unknown;
        originalByteSize: unknown;
        metadata: string | null;
      }>;
    },
    async parts(id) {
      return rawBlockSignatureStmt.all(id) as Array<{
        metadata: string | null;
      }>;
    },
  };
}

export async function filterPersistedRawIdReplayBatch(params: {
  db?: DatabaseSync;
  coverage?: RawReplayCoverage;
  summaryStore: SummaryStore;
  largeFilesDir: string;
  log: { warn(message: string): void };
  sessionContext: string;
  conversationId: number;
  sessionId: string;
  sessionKey?: string;
  messages: AgentMessage[];
}): Promise<AgentMessage[]> {
  if(!params.coverage&&!params.db)throw new Error("Replay coverage storage is required");
  const coverage=params.coverage??sqliteCoverage(params.db!);

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
      const rows = await coverage.find(
        params.conversationId,
        stored.role,
        rawId,
        canMatchWithoutIdentity
          ? undefined
          : buildMessageIdentityHash(stored.role, stored.content),
      );
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
        const rows = await coverage.parts(messageId);
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
            let contentMatches = false;
            try {
              contentMatches = await params.summaryStore.largeFileContentEquals(
                fileId,
                externalizedText,
                { largeFilesDir: params.largeFilesDir },
              );
            } catch {
              continue;
            }
            if (
              contentMatches &&
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
        const rows = await coverage.parts(messageId);
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
        const incomingPartIndex = replayIdsByPart.findIndex((partRawIds) =>
          partRawIds.includes(rawId),
        );
        if (incomingPartIndex < 0) {
          continue;
        }
        const incomingPartMetadata = parts[incomingPartIndex]?.metadata;
        const externalizedByteSize = Buffer.byteLength(externalizedText, "utf8");
        const rows=await coverage.externalized(params.conversationId,stored.role,rawId);
        for (const row of rows) {
          if (
            typeof row.fileId !== "string" ||
            Number(row.originalByteSize) !== externalizedByteSize
          ) {
            continue;
          }
          let contentMatches = false;
          try {
            contentMatches = await params.summaryStore.largeFileContentEquals(
              row.fileId,
              externalizedText,
              { largeFilesDir: params.largeFilesDir },
            );
          } catch {
            continue;
          }
          if (
            !contentMatches ||
            !externalizedReplayMetadataMatches(row.metadata, incomingPartMetadata)
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

/**
 * Persisted-anchor matching: decides whether an incoming message is a replay
 * of one stored row, accepting exact content, proven large-file
 * externalization, and provenance-gated host redaction.
 */
import { createRequire } from "node:module";
import {
  formatFileReference,
  formatRawPayloadReference,
  formatToolOutputReference,
  parseFileBlocks,
  type FileBlock,
} from "./large-files.js";
import {
  buildMessageParts,
  extractStructuredText,
  RAW_PAYLOAD_EXTERNALIZATION_REASON,
  serializeRawPayloadContent,
  toStoredMessage,
  type StoredMessage,
} from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import type { ConversationStore, MessageRecord } from "./store/conversation-store.js";
import { buildMessageIdentityHash } from "./store/message-identity.js";
import type { LargeFileRecord, SummaryStore } from "./store/summary-store.js";
import {
  extractAssistantToolCallIdsForPairing,
  extractToolPairingIdFromRecord,
  extractToolResultIdForPairing,
} from "./tool-pairing.js";
import { structuredPartsIdentity } from "./structured-anchor-identity.js";

type RedactSensitiveText = (content: string) => string;
type StoredIncomingMatch =
  | "exact"
  | "externalized"
  | "unproven-externalized"
  | "redacted";

/** Load the host redactor without making the optional OpenClaw peer mandatory. */
function loadOpenClawRedactor(): RedactSensitiveText | undefined {
  try {
    const require = createRequire(import.meta.url);
    const loggingCore = require("openclaw/plugin-sdk/logging-core") as {
      redactSensitiveText?: unknown;
    };
    return typeof loggingCore.redactSensitiveText === "function"
      ? (loggingCore.redactSensitiveText as RedactSensitiveText)
      : undefined;
  } catch {
    return undefined;
  }
}

function incomingToolCallIds(message: AgentMessage): Set<string> {
  const ids = extractAssistantToolCallIdsForPairing(message);
  const toolResultId = extractToolResultIdForPairing(message);
  if (toolResultId) ids.push(toolResultId);
  return new Set(ids);
}

function sameNonEmptyIds(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size > 0 && left.size === right.size && [...left].every((id) => right.has(id));
}

export class BatchDeduplicator {
  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly summaryStore: SummaryStore,
    private readonly largeFilesDir: string,
    private readonly redactSensitiveText: RedactSensitiveText | undefined = loadOpenClawRedactor(),
  ) {}

  /**
   * Accept host redaction only when both faces carry the same complete set of
   * tool-call ids and applying redaction to one complete message produces the
   * other. The provenance gate keeps different secret-bearing tool calls from
   * collapsing; redactor failure degrades to exact-only dedup.
   */
  private async messagesDifferOnlyByHostRedaction(
    persisted: MessageRecord,
    incoming: StoredMessage,
    incomingMessage: AgentMessage,
  ): Promise<boolean> {
    if (persisted.role !== incoming.role || !this.redactSensitiveText) return false;
    const incomingIds = incomingToolCallIds(incomingMessage);
    if (incomingIds.size === 0) return false;
    const storedIds = await this.storedToolCallIds(persisted.messageId);
    if (!sameNonEmptyIds(storedIds, incomingIds)) return false;
    try {
      const redactedPersisted = this.redactSensitiveText(persisted.content);
      if (redactedPersisted !== persisted.content && redactedPersisted === incoming.content) {
        return true;
      }
      const redactedIncoming = this.redactSensitiveText(incoming.content);
      return redactedIncoming !== incoming.content && redactedIncoming === persisted.content;
    } catch {
      return false;
    }
  }

  /** Read stable tool-call provenance from the stored message parts. */
  private async storedToolCallIds(messageId: number): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const part of await this.conversationStore.getMessageParts(messageId)) {
      if (part.toolCallId) ids.add(part.toolCallId);
      const metadata = parsePartMetadata(part.metadata);
      const metadataId = metadata ? extractToolPairingIdFromRecord(metadata) : undefined;
      if (metadataId) ids.add(metadataId);
    }
    return ids;
  }

  private async matchStoredMessageToIncoming(
    storedMessage: MessageRecord,
    incoming: StoredMessage,
    incomingMessage: AgentMessage,
    incomingHash: string,
    storedHash: string,
    incomingRawPayloadContent?: string | null,
  ): Promise<StoredIncomingMatch | null> {
    const storedParts = await this.conversationStore.getMessageParts(storedMessage.messageId);
    const storedStructured = structuredPartsIdentity(storedParts);
    const incomingStructured = structuredPartsIdentity(
      buildMessageParts({
        sessionId: "",
        message: incomingMessage,
        fallbackContent: incoming.content,
      }),
    );
    const externalizedMatch = await this.messagesAreExternalizedEquivalent(
      storedMessage,
      incoming,
      incomingRawPayloadContent,
    );
    if (externalizedMatch === "externalized") {
      const storedIds = await this.storedToolCallIds(storedMessage.messageId);
      const incomingIds = incomingToolCallIds(incomingMessage);
      if (
        (storedIds.size === 0 && incomingIds.size === 0) ||
        sameNonEmptyIds(storedIds, incomingIds)
      ) {
        return "externalized";
      }
    }
    // Text hashes are only candidate indexes. Never equate unrelated tool events.
    if (
      (storedStructured !== null || incomingStructured !== null) &&
      storedStructured !== incomingStructured
    ) {
      // Preserve the separately proven, provenance-gated host-redaction path.
      return (await this.messagesDifferOnlyByHostRedaction(
        storedMessage,
        incoming,
        incomingMessage,
      ))
        ? "redacted"
        : null;
    }
    if (incoming.content.trim() === "" && incomingStructured === null) return null;
    if (
      storedHash === incomingHash &&
      storedMessage.role === incoming.role &&
      storedMessage.content === incoming.content
    ) {
      return "exact";
    }
    if (externalizedMatch === "unproven-externalized") return externalizedMatch;
    return (await this.messagesDifferOnlyByHostRedaction(
      storedMessage,
      incoming,
      incomingMessage,
    ))
      ? "redacted"
      : null;
  }

  /** Verify replay payloads, including proven externalization and host redaction. */
  async matchesPersistedAnchor(messageId: number, message: AgentMessage): Promise<boolean> {
    const persisted = await this.conversationStore.getMessageById(messageId);
    if (!persisted) return false;
    const incoming = toStoredMessage(message);
    const match = await this.matchStoredMessageToIncoming(
      persisted,
      incoming,
      message,
      storedMessageIdentityHash(incoming),
      buildMessageIdentityHash(persisted.role, persisted.content),
      serializeRawPayloadContent(message, incoming.content)?.content ?? null,
    );
    return match !== null && match !== "unproven-externalized";
  }

  private async messagesAreExternalizedEquivalent(
    storedMessage: MessageRecord,
    incoming: StoredMessage,
    incomingRawPayloadContent?: string | null,
  ): Promise<"externalized" | "unproven-externalized" | null> {
    if (storedMessage.role !== incoming.role) {
      return null;
    }
    let references = extractExternalizedReferences(storedMessage.content);
    if (references.length === 0) {
      return null;
    }
    const proofKeys = await this.getStoredExternalizedReferenceProofKeys(
      storedMessage,
      references,
    );
    if (proofKeys.size > 0) {
      references = references.filter((reference) => proofKeys.has(referenceProofKey(reference)));
      if (references.length === 0) {
        return null;
      }
    }
    const provenanceBacked =
      proofKeys.size > 0 &&
      references.every((reference) => proofKeys.has(referenceProofKey(reference)));

    if (
      references.length === 1 &&
      isWholeIncomingReference(references[0]!) &&
      (await this.referenceMatchesWholeIncoming(
        storedMessage,
        incoming,
        references[0]!,
        incomingRawPayloadContent,
      ))
    ) {
      return provenanceBacked ? "externalized" : "unproven-externalized";
    }

    const fileBlocks = parseFileBlocks(incoming.content);
    if (fileBlocks.length === 0) {
      if (
        await this.incomingNativeImagesMatchStoredContent(
          storedMessage.content,
          references,
          incomingRawPayloadContent,
        )
      ) {
        return provenanceBacked ? "externalized" : "unproven-externalized";
      }
      return (
        references.length === 1 &&
        isWholeIncomingReference(references[0]!) &&
        (await this.referenceMatchesWholeIncoming(
          storedMessage,
          incoming,
          references[0]!,
          incomingRawPayloadContent,
        ))
      )
        ? provenanceBacked ? "externalized" : "unproven-externalized"
        : null;
    }

    let rewritten = "";
    let cursor = 0;
    const usedReferenceIndexes = new Set<number>();
    for (const block of fileBlocks) {
      const referenceIndex = await this.findMatchingReferenceIndex(
        references,
        block,
        usedReferenceIndexes,
      );
      rewritten += incoming.content.slice(cursor, block.start);
      if (referenceIndex < 0) {
        rewritten += incoming.content.slice(block.start, block.end);
      } else {
        usedReferenceIndexes.add(referenceIndex);
        rewritten += references[referenceIndex]!.formattedReference;
      }
      cursor = block.end;
    }
    rewritten += incoming.content.slice(cursor);
    if (usedReferenceIndexes.size === references.length && rewritten === storedMessage.content) {
      return provenanceBacked ? "externalized" : "unproven-externalized";
    }
    return null;
  }

  private async incomingNativeImagesMatchStoredContent(
    storedContent: string,
    references: ExternalizedReference[],
    incomingRawPayloadContent?: string | null,
  ): Promise<boolean> {
    if (incomingRawPayloadContent == null || !references.every(isImageReference)) {
      return false;
    }
    const blocks = extractNativeImageReplayBlocks(incomingRawPayloadContent);
    if (!blocks) {
      return false;
    }

    let referenceIndex = 0;
    const rewritten: string[] = [];
    for (const block of blocks) {
      // Mirror extractStructuredText's array join while replacing each replayed
      // native image with the exact stored reference after byte proof.
      if (block.kind === "text") {
        rewritten.push(block.text);
        continue;
      }
      const reference = references[referenceIndex];
      if (!reference || !(await this.referenceMatchesNativeImage(reference, block.buffer))) {
        return false;
      }
      rewritten.push(reference.reference);
      referenceIndex += 1;
    }
    return referenceIndex === references.length && rewritten.join("\n") === storedContent;
  }

  private async getStoredExternalizedReferenceProofKeys(
    storedMessage: MessageRecord,
    references: ExternalizedReference[],
  ): Promise<Set<string>> {
    const proofKeys = new Set<string>();
    if (storedMessage.largeContent) {
      for (const reference of references) {
        if (reference.fileId === storedMessage.largeContent) {
          proofKeys.add(referenceProofKey(reference));
        }
      }
    }

    const parts = await this.conversationStore.getMessageParts(storedMessage.messageId);
    for (const part of parts) {
      const metadata = parsePartMetadata(part.metadata);
      if (!metadata) {
        continue;
      }
      if (
        metadata.rawPayloadExternalized === true &&
        metadata.externalizationReason === RAW_PAYLOAD_EXTERNALIZATION_REASON &&
        typeof metadata.externalizedFileId === "string"
      ) {
        proofKeys.add(`raw:${metadata.externalizedFileId}`);
      }
      if (
        metadata.fileBlocksExternalized === true &&
        metadata.externalizationReason === "large_file_block" &&
        Array.isArray(metadata.externalizedFileIds)
      ) {
        for (const fileId of metadata.externalizedFileIds) {
          if (typeof fileId === "string") {
            proofKeys.add(`file:${fileId}`);
          }
        }
      }
      if (
        metadata.toolOutputExternalized === true &&
        metadata.externalizationReason === "large_tool_result" &&
        typeof metadata.externalizedFileId === "string"
      ) {
        proofKeys.add(`tool:${metadata.externalizedFileId}`);
      }
      if (
        metadata.imageExternalized === true &&
        metadata.externalizationReason === "native_image" &&
        typeof metadata.externalizedFileId === "string"
      ) {
        proofKeys.add(`image:${metadata.externalizedFileId}`);
      }
    }

    return proofKeys;
  }

  private async referenceMatchesWholeIncoming(
    storedMessage: MessageRecord,
    incoming: StoredMessage,
    reference: ExternalizedReference,
    incomingRawPayloadContent?: string | null,
  ): Promise<boolean> {
    const largeFile = await this.summaryStore.getLargeFile(reference.fileId);
    if (!largeFile) {
      return false;
    }
    if (this.formatExternalizedReference(reference, largeFile, storedMessage) !== storedMessage.content) {
      return false;
    }
    if (isImageReference(reference)) {
      const incomingImage = extractSingleNativeImageBuffer(incomingRawPayloadContent ?? incoming.content);
      return incomingImage
        ? this.referenceMatchesNativeImage(reference, incomingImage)
        : false;
    }
    const contentToCompare =
      reference.reference.startsWith("[LCM Raw Payload:") && incomingRawPayloadContent != null
        ? incomingRawPayloadContent
        : incoming.content;
    if (
      await this.summaryStore.largeFileContentEquals(reference.fileId, contentToCompare, {
        largeFilesDir: this.largeFilesDir,
      })
    ) {
      return true;
    }
    if (
      !reference.reference.startsWith("[LCM Raw Payload:") ||
      incomingRawPayloadContent == null
    ) {
      return false;
    }
    const hasFileBlocks = parseFileBlocks(incomingRawPayloadContent).length > 0;
    const hasNativeImages = rawPayloadHasNativeImages(incomingRawPayloadContent);
    if (!hasFileBlocks && !hasNativeImages) {
      return false;
    }

    const storedPayload = await this.summaryStore.getLargeFileContent(reference.fileId, {
      largeFilesDir: this.largeFilesDir,
      maxBytes: largeFile.byteSize ?? Buffer.byteLength(incomingRawPayloadContent, "utf8"),
    });
    if (!storedPayload) {
      return false;
    }
    if (hasFileBlocks) {
      const rewrittenPayload = await this.rewriteIncomingFileBlocksFromStoredPayload(
        incomingRawPayloadContent,
        storedPayload,
      );
      if (rewrittenPayload === storedPayload) {
        return true;
      }
    }
    return hasNativeImages
      ? this.incomingNativeImageRawPayloadMatchesStoredPayload(
          incomingRawPayloadContent,
          storedPayload,
        )
      : false;
  }

  private async referenceMatchesNativeImage(
    reference: ExternalizedReference,
    incomingImage: Buffer,
  ): Promise<boolean> {
    const largeFile = await this.summaryStore.getLargeFile(reference.fileId);
    if (!largeFile?.mimeType?.toLowerCase().startsWith("image/")) {
      return false;
    }
    return this.summaryStore.largeFileBufferEquals(reference.fileId, incomingImage, {
      largeFilesDir: this.largeFilesDir,
    });
  }

  private async incomingNativeImageRawPayloadMatchesStoredPayload(
    incomingRawPayloadContent: string,
    storedPayload: string,
  ): Promise<boolean> {
    const incoming = parseJsonPayload(incomingRawPayloadContent);
    const stored = parseJsonPayload(storedPayload);
    if (!Array.isArray(incoming) || !Array.isArray(stored) || incoming.length !== stored.length) {
      return false;
    }

    for (let index = 0; index < incoming.length; index += 1) {
      const incomingEntry = incoming[index];
      const storedEntry = stored[index];
      const incomingImage = extractSingleNativeImageBufferFromValue(incomingEntry);
      if (!incomingImage) {
        // Non-image raw blocks must remain byte-for-byte JSON equivalent.
        if (isNativeImageEntry(incomingEntry) || JSON.stringify(incomingEntry) !== JSON.stringify(storedEntry)) {
          return false;
        }
        continue;
      }
      if (!(await this.storedRawPayloadImageEntryMatches(storedEntry, incomingImage))) {
        return false;
      }
    }
    return true;
  }

  private async storedRawPayloadImageEntryMatches(
    storedEntry: unknown,
    incomingImage: Buffer,
  ): Promise<boolean> {
    if (!storedEntry || typeof storedEntry !== "object" || Array.isArray(storedEntry)) {
      return false;
    }
    const record = storedEntry as Record<string, unknown>;
    if (
      record.type !== "text" ||
      record.imageExternalized !== true ||
      record.externalizationReason !== "native_image" ||
      typeof record.text !== "string" ||
      typeof record.externalizedFileId !== "string"
    ) {
      return false;
    }
    const references = extractExternalizedReferences(record.text);
    if (references.length !== 1 || references[0]!.fileId !== record.externalizedFileId) {
      return false;
    }
    return this.referenceMatchesNativeImage(references[0]!, incomingImage);
  }

  private async rewriteIncomingFileBlocksFromStoredPayload(
    incomingContent: string,
    storedPayload: string,
  ): Promise<string | null> {
    const references = extractExternalizedReferences(storedPayload);
    const fileBlocks = parseFileBlocks(incomingContent);
    if (references.length === 0 || fileBlocks.length === 0) {
      return null;
    }

    let rewritten = "";
    let cursor = 0;
    const usedReferenceIndexes = new Set<number>();
    for (const block of fileBlocks) {
      const referenceIndex = await this.findMatchingReferenceIndex(
        references,
        block,
        usedReferenceIndexes,
      );
      rewritten += incomingContent.slice(cursor, block.start);
      if (referenceIndex < 0) {
        rewritten += incomingContent.slice(block.start, block.end);
      } else {
        usedReferenceIndexes.add(referenceIndex);
        rewritten += references[referenceIndex]!.formattedReference;
      }
      cursor = block.end;
    }
    rewritten += incomingContent.slice(cursor);
    return usedReferenceIndexes.size === references.length ? rewritten : null;
  }

  private async findMatchingReferenceIndex(
    references: ExternalizedReference[],
    block: FileBlock,
    usedReferenceIndexes: Set<number>,
  ): Promise<number> {
    for (let index = 0; index < references.length; index += 1) {
      if (usedReferenceIndexes.has(index)) {
        continue;
      }
      const reference = references[index]!;
      const largeFile = await this.summaryStore.getLargeFile(reference.fileId);
      if (!largeFile) {
        continue;
      }
      if (
        (largeFile.fileName ?? undefined) !== block.fileName ||
        (largeFile.mimeType ?? undefined) !== block.mimeType
      ) {
        continue;
      }
      if (
        await this.summaryStore.largeFileContentEquals(reference.fileId, block.text, {
          largeFilesDir: this.largeFilesDir,
        })
      ) {
        reference.formattedReference = this.formatFileReference(largeFile);
        return index;
      }
    }
    return -1;
  }

  private formatExternalizedReference(
    reference: ExternalizedReference,
    largeFile: LargeFileRecord,
    storedMessage: MessageRecord,
  ): string {
    if (isImageReference(reference)) {
      return reference.reference;
    }

    if (reference.reference.startsWith("[LCM Tool Output:")) {
      return formatToolOutputReference({
        fileId: largeFile.fileId,
        toolName: extractReferenceField(reference.reference, "tool"),
        byteSize: largeFile.byteSize ?? 0,
        summary: largeFile.explorationSummary ?? "",
      });
    }

    if (reference.reference.startsWith("[LCM Raw Payload:")) {
      return formatRawPayloadReference({
        fileId: largeFile.fileId,
        role: extractReferenceField(reference.reference, "role") ?? storedMessage.role,
        reason:
          extractReferenceField(reference.reference, "reason") ??
          RAW_PAYLOAD_EXTERNALIZATION_REASON,
        byteSize: largeFile.byteSize ?? 0,
        summary: largeFile.explorationSummary ?? "",
      });
    }

    return this.formatFileReference(largeFile);
  }

  private formatFileReference(largeFile: LargeFileRecord): string {
    return formatFileReference({
      fileId: largeFile.fileId,
      fileName: largeFile.fileName ?? undefined,
      mimeType: largeFile.mimeType ?? undefined,
      byteSize: largeFile.byteSize ?? 0,
      summary: largeFile.explorationSummary ?? "",
    });
  }
}

function storedMessageIdentityHash(stored: StoredMessage): string {
  return buildMessageIdentityHash(stored.role, stored.content);
}

type ExternalizedReference = {
  fileId: string;
  reference: string;
  formattedReference: string;
  end: number;
};

type NativeImageReplayBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; buffer: Buffer };

function extractExternalizedReferences(content: string): ExternalizedReference[] {
  const references: ExternalizedReference[] = [];
  const summaryMarker = "\n\nExploration Summary:";
  const referencePattern = /\[LCM (?:File|Raw Payload|Tool Output):\s*(file_[a-f0-9]{16})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = referencePattern.exec(content)) !== null) {
    const fileId = match[1]?.toLowerCase();
    if (!fileId) continue;
    const markerIndex = content.indexOf(summaryMarker, referencePattern.lastIndex);
    if (markerIndex < 0 || content[markerIndex - 1] !== "]") {
      continue;
    }
    const headerRemainder = content.slice(referencePattern.lastIndex, markerIndex);
    if (/\][\s\S]*\[LCM (?:File|Raw Payload|Tool Output):\s*file_[a-f0-9]{16}\b/i.test(headerRemainder)) {
      continue;
    }
    references.push({
      fileId,
      reference: content.slice(match.index, markerIndex),
      formattedReference: content.slice(match.index, markerIndex),
      end: markerIndex,
    });
    referencePattern.lastIndex = markerIndex;
  }
  const imageReferencePattern =
    /\[(?:(?:User|System|Tool|Assistant) image|Image): [^\]]*?\bLCM file:\s*(file_[a-f0-9]{16})\]/gi;
  while ((match = imageReferencePattern.exec(content)) !== null) {
    const fileId = match[1]?.toLowerCase();
    if (!fileId) continue;
    references.push({
      fileId,
      reference: match[0],
      formattedReference: match[0],
      end: imageReferencePattern.lastIndex,
    });
  }
  return references;
}

function extractReferenceField(reference: string, field: "tool" | "role" | "reason"): string | undefined {
  const match = new RegExp(`\\b${field}=([^|\\]]+)`).exec(reference);
  return match?.[1]?.trim() || undefined;
}

function referenceProofKey(reference: ExternalizedReference): string {
  if (reference.reference.startsWith("[LCM Raw Payload:")) {
    return `raw:${reference.fileId}`;
  }
  if (reference.reference.startsWith("[LCM File:")) {
    return `file:${reference.fileId}`;
  }
  if (reference.reference.startsWith("[LCM Tool Output:")) {
    return `tool:${reference.fileId}`;
  }
  if (isImageReference(reference)) {
    return `image:${reference.fileId}`;
  }
  return `other:${reference.fileId}`;
}

function isWholeIncomingReference(reference: ExternalizedReference): boolean {
  return (
    reference.reference.startsWith("[LCM Raw Payload:") ||
    reference.reference.startsWith("[LCM Tool Output:") ||
    isImageReference(reference)
  );
}

function isImageReference(reference: ExternalizedReference): boolean {
  return /^\[(?:(?:User|System|Tool|Assistant) image|Image): /i.test(reference.reference);
}

function extractSingleNativeImageBuffer(content: string): Buffer | null {
  const parsed = parseJsonPayload(content);
  const imageBlocks = parsed === undefined
    ? extractNativeImageBuffersFromValue(content)
    : extractNativeImageBuffersFromValue(parsed);
  return imageBlocks.length === 1 ? imageBlocks[0]! : null;
}

function extractNativeImageReplayBlocks(content: string): NativeImageReplayBlock[] | null {
  const parsed = parseJsonPayload(content);
  if (!Array.isArray(parsed)) {
    return null;
  }

  const blocks: NativeImageReplayBlock[] = [];
  let sawImage = false;
  for (const entry of parsed) {
    const image = extractSingleNativeImageBufferFromValue(entry);
    if (image) {
      blocks.push({ kind: "image", buffer: image });
      sawImage = true;
      continue;
    }
    if (isNativeImageEntry(entry)) {
      return null;
    }
    const text = extractStructuredText(entry);
    if (typeof text === "string" && text.trim().length > 0) {
      blocks.push({ kind: "text", text });
    }
  }

  return sawImage ? blocks : null;
}

function rawPayloadHasNativeImages(content: string): boolean {
  const parsed = parseJsonPayload(content);
  return Array.isArray(parsed) && parsed.some((entry) => extractSingleNativeImageBufferFromValue(entry));
}

function extractSingleNativeImageBufferFromValue(value: unknown): Buffer | null {
  const images = extractNativeImageBuffersFromValue(value);
  return images.length === 1 ? images[0]! : null;
}

function isNativeImageEntry(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "image"
  );
}

function extractNativeImageBuffersFromValue(value: unknown): Buffer[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractNativeImageBuffersFromValue(entry));
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (record.type === "image") {
    const data = typeof record.data === "string" ? record.data : undefined;
    const decoded = data ? decodeBase64ImageData(data) : null;
    return decoded ? [decoded] : [];
  }

  return [];
}

function decodeBase64ImageData(rawData: string): Buffer | null {
  const dataUrlMatch = rawData.match(/^data:([^;,]+);base64,(.*)$/s);
  const base64Data = (dataUrlMatch?.[2] ?? rawData).replace(/\s+/g, "");
  if (!base64Data || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data)) {
    return null;
  }
  try {
    return Buffer.from(base64Data, "base64");
  } catch {
    return null;
  }
}

function parseJsonPayload(content: string): unknown {
  const trimmed = content.trim();
  if (
    !((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")))
  ) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parsePartMetadata(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Large-payload interception at ingest time: oversized <file> blocks, inline
 * and native image content, oversized tool results, and generic raw payloads
 * are externalized to the per-conversation large-files directory and replaced
 * with compact references backed by large_files records.
 *
 * Extracted from engine.ts (Phase 2 of the engine decomposition).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { LcmConfig } from "./db/config.js";
import type { SummaryStore } from "./store/summary-store.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { estimateTokens } from "./estimate-tokens.js";
import {
  extensionFromNameOrMime,
  formatFileReference,
  formatRawPayloadReference,
  formatToolOutputReference,
  generateExplorationSummary,
  parseFileBlocks,
} from "./large-files.js";
import {
  extractStructuredText,
  hasReplayCriticalRawBlock,
  RAW_PAYLOAD_EXTERNALIZATION_REASON,
  serializeRawPayloadContent,
  type StoredMessage,
} from "./message-content.js";
import { resolveLiveToolResultExternalization } from "./read-tool-recovery.js";
import { buildExternalizedToolResultBlock } from "./tool-result-blocks.js";
import { asRecord, safeBoolean, safeString } from "./value-utils.js";

/** Resolves the optional model-backed summarizer used for large-file exploration summaries. */
export type LargeFileTextSummarizerResolver = (params?: {
  conversationId?: number;
}) => Promise<((prompt: string) => Promise<string | null>) | undefined>;

export class LargeFileInterceptor {
  constructor(
    private readonly config: LcmConfig,
    private readonly summaryStore: SummaryStore,
    private readonly resolveLargeFileTextSummarizer: LargeFileTextSummarizerResolver,
  ) {}

  private static readonly BASE64_IMAGE_MAGIC: ReadonlyArray<{
    prefix: string;
    extension: string;
    mimeType: string;
  }> = [
    { prefix: "/9j/", extension: "jpg", mimeType: "image/jpeg" },
    { prefix: "iVBOR", extension: "png", mimeType: "image/png" },
    { prefix: "R0lGOD", extension: "gif", mimeType: "image/gif" },
    { prefix: "UklGR", extension: "webp", mimeType: "image/webp" },
    { prefix: "PHN2Zy", extension: "svg", mimeType: "image/svg+xml" },
  ];

  private static detectBase64ImageType(
    base64Data: string,
  ): { extension: string; mimeType: string } | null {
    for (const sig of LargeFileInterceptor.BASE64_IMAGE_MAGIC) {
      if (base64Data.startsWith(sig.prefix)) {
        return { extension: sig.extension, mimeType: sig.mimeType };
      }
    }
    return null;
  }

  private static extensionForImageMimeType(mimeType: string): string | null {
    switch (mimeType.toLowerCase()) {
      case "image/jpeg":
      case "image/jpg":
        return "jpg";
      case "image/png":
        return "png";
      case "image/gif":
        return "gif";
      case "image/webp":
        return "webp";
      case "image/svg+xml":
        return "svg";
      case "image/heic":
        return "heic";
      case "image/avif":
        return "avif";
      case "image/bmp":
        return "bmp";
      default:
        return null;
    }
  }

  private static normalizeNativeImageBlock(value: unknown): {
    base64Data: string;
    extension: string;
    mimeType: string;
  } | null {
    const record = asRecord(value);
    if (!record || record.type !== "image") {
      return null;
    }

    const rawData = safeString(record.data);
    if (!rawData) {
      return null;
    }

    const dataUrlMatch = rawData.match(/^data:([^;,]+);base64,(.*)$/s);
    const declaredMimeType =
      dataUrlMatch?.[1] ??
      safeString(record.mimeType) ??
      safeString(record.mime_type) ??
      safeString(record.mediaType) ??
      safeString(record.media_type);
    const base64Data = (dataUrlMatch?.[2] ?? rawData).replace(/\s+/g, "");
    if (!base64Data || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data)) {
      return null;
    }

    const detected = LargeFileInterceptor.detectBase64ImageType(base64Data);
    const mimeType = detected?.mimeType ?? declaredMimeType;
    if (!mimeType?.toLowerCase().startsWith("image/")) {
      return null;
    }

    const extension = detected?.extension ?? LargeFileInterceptor.extensionForImageMimeType(mimeType);
    return extension ? { base64Data, extension, mimeType } : null;
  }

  private static basenameForImageReference(pathLike: string): string | null {
    const baseName = pathLike.trim().split(/[\\/]/).filter(Boolean).pop();
    if (!baseName) {
      return null;
    }
    return baseName.replace(/[^\w.\-@]+/g, "_") || null;
  }

  private static inferNativeImageFileName(params: {
    content: unknown[];
    imageIndex: number;
    extension: string;
    role?: string;
  }): string {
    for (let index = params.imageIndex - 1; index >= 0; index -= 1) {
      const entry = asRecord(params.content[index]);
      const text = entry?.type === "text" ? safeString(entry.text) : undefined;
      if (!text) {
        continue;
      }

      const mediaMatch = text.match(/\[media attached(?:\s+\d+\/\d+)?:\s*([^\s\]|()]+)/i);
      const fileName = mediaMatch?.[1]
        ? LargeFileInterceptor.basenameForImageReference(mediaMatch[1])
        : null;
      if (fileName) {
        return fileName;
      }
    }

    const rolePrefix =
      params.role === "assistant"
        ? "assistant"
        : params.role === "system"
          ? "system"
          : params.role === "tool" || params.role === "toolResult"
            ? "tool"
            : "user";
    return `${rolePrefix}-image.${params.extension}`;
  }

  private static isExternalizedImageReference(value: string): boolean {
    if (typeof value !== "string") return false;
    return LargeFileInterceptor.IMAGE_REFERENCE_REGEX.test(value.trim());
  }

  private static isExternalizedReferenceContent(value: string): boolean {
    const trimmed = value.trim();
    return (
      trimmed.startsWith("[LCM File:") ||
      trimmed.startsWith("[LCM Tool Output:") ||
      trimmed.includes("LCM file: file_") ||
      LargeFileInterceptor.IMAGE_REFERENCE_REGEX_GLOBAL.test(trimmed)
    );
  }

  /** Image references emitted by `externalizeImage` can use either role-specific
   *  labels (`User image`, `Assistant image`, `System image`, `Tool image`) or
   *  the generic `Image` label used by pure-base64 user/system content. */
  private static readonly IMAGE_REFERENCE_REGEX =
    /^\[(?:(?:User|System|Tool|Assistant) image|Image): [^\]]*LCM file: file_[a-f0-9]{16}\]$/;
  private static readonly IMAGE_REFERENCE_REGEX_GLOBAL =
    /\[(?:(?:User|System|Tool|Assistant) image|Image): [^\]]*LCM file: file_[a-f0-9]{16}\]/;

  /** Stricter form of `isExternalizedReferenceContent` used by the
   *  raw-payload externalizer's skip gate. Returns true when the message's
   *  stored content was produced by a *wholesale-replacement* externalizer
   *  (large-file / tool-output / raw-payload — each emits content that
   *  starts with the canonical reference header, optionally followed by an
   *  exploration-summary preamble), or when the whole trimmed content is a
   *  single image-only reference (rare).
   *
   *  Mixed content like `"...intro... [User image: file_xyz] ... long body
   *  text..."` is NOT considered wholly externalized — those messages must
   *  remain eligible for raw-payload externalization when they exceed the
   *  size threshold. */
  private static isWhollyExternalizedReferenceContent(value: string): boolean {
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    if (
      trimmed.startsWith("[LCM File:") ||
      trimmed.startsWith("[LCM Tool Output:") ||
      trimmed.startsWith("[LCM Raw Payload:")
    ) {
      return true;
    }
    return LargeFileInterceptor.IMAGE_REFERENCE_REGEX.test(trimmed);
  }

  /** Resolve the configured externalized-payload directory for one conversation. */
  private largeFilesDirForConversation(conversationId: number): string {
    return join(this.config.largeFilesDir, String(conversationId));
  }

  private async storeImageFileContent(params: {
    conversationId: number;
    fileId: string;
    extension: string;
    base64Data: string;
  }): Promise<string> {
    const dir = this.largeFilesDirForConversation(params.conversationId);
    await mkdir(dir, { recursive: true });
    const normalized = params.extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
    const filePath = join(dir, `${params.fileId}.${normalized}`);
    const buffer = Buffer.from(params.base64Data, "base64");
    await writeFile(filePath, buffer);
    return filePath;
  }

  private async externalizeImage(params: {
    conversationId: number;
    base64Data: string;
    fileName?: string;
    extension: string;
    mimeType: string;
    label: string;
  }): Promise<{ fileId: string; byteSize: number; summary: string; reference: string }> {
    const fileId = `file_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const byteSize = Buffer.from(params.base64Data, "base64").byteLength;
    const storageUri = await this.storeImageFileContent({
      conversationId: params.conversationId,
      fileId,
      extension: params.extension,
      base64Data: params.base64Data,
    });
    const fileName = params.fileName ?? `image.${params.extension}`;
    const summary = `Image file (${params.extension.toUpperCase()}, ${byteSize.toLocaleString("en-US")} bytes)${params.fileName ? ` — ${params.fileName}` : ""}`;

    await this.summaryStore.insertLargeFile({
      fileId,
      conversationId: params.conversationId,
      fileName,
      mimeType: params.mimeType,
      byteSize,
      storageUri,
      explorationSummary: summary,
    });

    const reference = `[${params.label}: ${fileName} (${params.mimeType}, ${byteSize.toLocaleString("en-US")} bytes) | LCM file: ${fileId}]`;
    return { fileId, byteSize, summary, reference };
  }

  async interceptNativeImageBlocks(params: {
    conversationId: number;
    message: AgentMessage;
  }): Promise<{ rewrittenMessage: AgentMessage; fileIds: string[] } | null> {
    if (!("content" in params.message)) {
      return null;
    }
    const role = (params.message as { role?: unknown }).role;
    // Cover every persistable role — `hasPersistableMessageRole` accepts
    // user/assistant/system/tool/toolResult, so this gate must too. A system
    // message carrying native `{type:"image"}` blocks would otherwise fall
    // through to the generic raw-payload externalizer and be stored as a
    // `raw-system-payload.json` blob with embedded base64.
    if (
      role !== "user" &&
      role !== "assistant" &&
      role !== "system" &&
      role !== "tool" &&
      role !== "toolResult"
    ) {
      return null;
    }
    if (!Array.isArray(params.message.content)) {
      return null;
    }

    const label =
      role === "assistant"
        ? "Assistant image"
        : role === "system"
          ? "System image"
          : role === "tool" || role === "toolResult"
            ? "Tool image"
            : "User image";

    const rewrittenContent: unknown[] = [];
    const fileIds: string[] = [];
    let changed = false;

    for (let index = 0; index < params.message.content.length; index += 1) {
      const block = params.message.content[index];
      const image = LargeFileInterceptor.normalizeNativeImageBlock(block);
      if (!image) {
        rewrittenContent.push(block);
        continue;
      }

      const externalized = await this.externalizeImage({
        conversationId: params.conversationId,
        base64Data: image.base64Data,
        fileName: LargeFileInterceptor.inferNativeImageFileName({
          content: params.message.content,
          imageIndex: index,
          extension: image.extension,
          role: typeof role === "string" ? role : undefined,
        }),
        extension: image.extension,
        mimeType: image.mimeType,
        label,
      });

      rewrittenContent.push({
        type: "text",
        text: externalized.reference,
        externalizedFileId: externalized.fileId,
        originalByteSize: externalized.byteSize,
        imageExternalized: true,
        externalizationReason: "native_image",
      });
      fileIds.push(externalized.fileId);
      changed = true;
    }

    if (!changed) {
      return null;
    }

    return {
      rewrittenMessage: {
        ...params.message,
        content: rewrittenContent,
      } as AgentMessage,
      fileIds,
    };
  }

  async interceptInlineImages(params: {
    conversationId: number;
    content: string;
    role: string;
  }): Promise<{ rewrittenContent: string; fileIds: string[] } | null> {
    const mediaResult = await this.interceptUserMediaBase64(params);
    if (mediaResult) {
      return mediaResult;
    }
    return this.interceptPureBase64Image(params);
  }

  private async interceptUserMediaBase64(params: {
    conversationId: number;
    content: string;
  }): Promise<{ rewrittenContent: string; fileIds: string[] } | null> {
    const prefix = "[media attached:";
    if (!params.content.startsWith(prefix)) {
      return null;
    }

    const base64LineRe = /\n([A-Za-z0-9+/]{20,}={0,2})\n/m;
    const base64Match = base64LineRe.exec(params.content);
    if (!base64Match) {
      return null;
    }

    const headerEnd = base64Match.index + 1;
    const header = params.content.slice(0, headerEnd).trim();
    const base64Data = params.content.slice(headerEnd);

    if (estimateTokens(base64Data) < 100) {
      return null;
    }

    const detected = LargeFileInterceptor.detectBase64ImageType(base64Data);
    if (!detected) {
      return null;
    }

    const pathMatch = header.match(/\[media attached:\s*([^\s(]+)/);
    const fileName = pathMatch ? pathMatch[1] : `user-image.${detected.extension}`;

    const externalized = await this.externalizeImage({
      conversationId: params.conversationId,
      base64Data,
      fileName,
      extension: detected.extension,
      mimeType: detected.mimeType,
      label: "User image",
    });

    return {
      rewrittenContent: `${header}\n\n${externalized.reference}`,
      fileIds: [externalized.fileId],
    };
  }

  private async interceptPureBase64Image(params: {
    conversationId: number;
    content: string;
    role: string;
  }): Promise<{ rewrittenContent: string; fileIds: string[] } | null> {
    const trimmed = params.content.trim();
    if (estimateTokens(trimmed) < 100) {
      return null;
    }

    const detected = LargeFileInterceptor.detectBase64ImageType(trimmed);
    if (!detected) {
      return null;
    }

    const b64Chars = trimmed.replace(/[^A-Za-z0-9+/=\s]/g, "");
    if (b64Chars.length / trimmed.length < 0.8) {
      return null;
    }

    const label = params.role === "tool" ? "Tool image" :
                  params.role === "assistant" ? "Assistant image" : "Image";
    const fileName = `${params.role}-image.${detected.extension}`;

    const externalized = await this.externalizeImage({
      conversationId: params.conversationId,
      base64Data: trimmed,
      fileName,
      extension: detected.extension,
      mimeType: detected.mimeType,
      label,
    });

    return {
      rewrittenContent: externalized.reference,
      fileIds: [externalized.fileId],
    };
  }

  /**
   * Walk tool-result payload blocks and replace pure inline image strings with
   * compact references before generic text-output externalization runs.
   */
  private async rewriteToolInlineImageValue(params: {
    conversationId: number;
    value: unknown;
  }): Promise<{ rewrittenValue: unknown; fileIds: string[]; changed: boolean }> {
    if (typeof params.value === "string") {
      const intercepted = await this.interceptPureBase64Image({
        conversationId: params.conversationId,
        content: params.value,
        role: "tool",
      });
      if (!intercepted) {
        return { rewrittenValue: params.value, fileIds: [], changed: false };
      }
      return {
        rewrittenValue: intercepted.rewrittenContent,
        fileIds: intercepted.fileIds,
        changed: true,
      };
    }

    if (Array.isArray(params.value)) {
      const rewrittenValues: unknown[] = [];
      const fileIds: string[] = [];
      let changed = false;

      for (const entry of params.value) {
        const rewritten = await this.rewriteToolInlineImageValue({
          conversationId: params.conversationId,
          value: entry,
        });
        rewrittenValues.push(rewritten.rewrittenValue);
        fileIds.push(...rewritten.fileIds);
        changed ||= rewritten.changed;
      }

      return changed
        ? { rewrittenValue: rewrittenValues, fileIds, changed: true }
        : { rewrittenValue: params.value, fileIds: [], changed: false };
    }

    if (!params.value || typeof params.value !== "object") {
      return { rewrittenValue: params.value, fileIds: [], changed: false };
    }

    const record = params.value as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      const intercepted = await this.interceptPureBase64Image({
        conversationId: params.conversationId,
        content: record.text,
        role: "tool",
      });
      if (!intercepted) {
        return { rewrittenValue: params.value, fileIds: [], changed: false };
      }
      return {
        rewrittenValue: {
          ...record,
          text: intercepted.rewrittenContent,
        },
        fileIds: intercepted.fileIds,
        changed: true,
      };
    }

    const nestedKeys = ["output", "content", "result"] as const;
    const rewrittenRecord: Record<string, unknown> = { ...record };
    const fileIds: string[] = [];
    let changed = false;

    for (const key of nestedKeys) {
      if (!(key in record)) {
        continue;
      }
      const rewritten = await this.rewriteToolInlineImageValue({
        conversationId: params.conversationId,
        value: record[key],
      });
      if (!rewritten.changed) {
        continue;
      }
      rewrittenRecord[key] = rewritten.rewrittenValue;
      fileIds.push(...rewritten.fileIds);
      changed = true;
    }

    return changed
      ? { rewrittenValue: rewrittenRecord, fileIds, changed: true }
      : { rewrittenValue: params.value, fileIds: [], changed: false };
  }

  async interceptInlineImagesInToolMessage(params: {
    conversationId: number;
    message: AgentMessage;
  }): Promise<{ rewrittenMessage: AgentMessage; fileIds: string[] } | null> {
    if (
      (params.message.role !== "toolResult" && params.message.role !== "tool") ||
      !("content" in params.message)
    ) {
      return null;
    }

    if (typeof params.message.content === "string") {
      const intercepted = await this.interceptPureBase64Image({
        conversationId: params.conversationId,
        content: params.message.content,
        role: "tool",
      });
      if (!intercepted) {
        return null;
      }
      return {
        rewrittenMessage: {
          ...params.message,
          content: intercepted.rewrittenContent,
        } as AgentMessage,
        fileIds: intercepted.fileIds,
      };
    }

    if (!Array.isArray(params.message.content)) {
      return null;
    }

    const rewrittenContent: unknown[] = [];
    const fileIds: string[] = [];
    let changed = false;

    for (const item of params.message.content) {
      const rewritten = await this.rewriteToolInlineImageValue({
        conversationId: params.conversationId,
        value: item,
      });
      rewrittenContent.push(rewritten.rewrittenValue);
      fileIds.push(...rewritten.fileIds);
      changed ||= rewritten.changed;
    }

    if (!changed) {
      return null;
    }

    return {
      rewrittenMessage: {
        ...params.message,
        content: rewrittenContent,
      } as AgentMessage,
      fileIds,
    };
  }

  /** Persist intercepted large-file text payloads to the configured lcm-files directory. */
  private async storeLargeFileContent(params: {
    conversationId: number;
    fileId: string;
    extension: string;
    content: string;
  }): Promise<string> {
    const dir = this.largeFilesDirForConversation(params.conversationId);
    await mkdir(dir, { recursive: true });

    const normalizedExtension = params.extension.replace(/[^a-z0-9]/gi, "").toLowerCase() || "txt";
    const filePath = join(dir, `${params.fileId}.${normalizedExtension}`);
    await writeFile(filePath, params.content, "utf8");
    return filePath;
  }

  /** Persist a large text payload and return the resulting compact placeholder. */
  private async externalizeLargeTextPayload(params: {
    conversationId: number;
    content: string;
    fileId?: string;
    fileName?: string;
    mimeType?: string;
    formatReference: (input: { fileId: string; byteSize: number; summary: string }) => string;
  }): Promise<{ fileId: string; byteSize: number; summary: string; reference: string }> {
    if (params.fileId) {
      const existing = await this.summaryStore.getLargeFile(params.fileId);
      if (existing) {
        const byteSize = existing.byteSize ?? Buffer.byteLength(params.content, "utf8");
        const summary =
          existing.explorationSummary ??
          `${params.fileName ?? "large payload"} (${byteSize.toLocaleString("en-US")} bytes)`;
        return {
          fileId: existing.fileId,
          byteSize,
          summary,
          reference: params.formatReference({
            fileId: existing.fileId,
            byteSize,
            summary,
          }),
        };
      }
    }

    const summarizeText = await this.resolveLargeFileTextSummarizer({
      conversationId: params.conversationId,
    });
    const fileId = params.fileId ?? `file_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const extension = extensionFromNameOrMime(params.fileName, params.mimeType);
    const storageUri = await this.storeLargeFileContent({
      conversationId: params.conversationId,
      fileId,
      extension,
      content: params.content,
    });
    const byteSize = Buffer.byteLength(params.content, "utf8");
    const explorationSummary = await generateExplorationSummary({
      content: params.content,
      fileName: params.fileName,
      mimeType: params.mimeType,
      summarizeText,
    });

    await this.summaryStore.insertLargeFile({
      fileId,
      conversationId: params.conversationId,
      fileName: params.fileName,
      mimeType: params.mimeType,
      byteSize,
      storageUri,
      explorationSummary,
    });

    return {
      fileId,
      byteSize,
      summary: explorationSummary,
      reference: params.formatReference({
        fileId,
        byteSize,
        summary: explorationSummary,
      }),
    };
  }

  /**
   * Intercept oversized <file> blocks before persistence and replace them with
   * compact file references backed by large_files records.
   */
  async interceptLargeFiles(params: {
    conversationId: number;
    content: string;
  }): Promise<{ rewrittenContent: string; fileIds: string[] } | null> {
    const blocks = parseFileBlocks(params.content);
    if (blocks.length === 0) {
      return null;
    }

    const threshold = Math.max(1, this.config.largeFileTokenThreshold);
    const fileIds: string[] = [];
    const rewrittenSegments: string[] = [];
    let cursor = 0;
    let interceptedAny = false;

    for (const block of blocks) {
      const blockTokens = estimateTokens(block.text);
      if (blockTokens < threshold) {
        continue;
      }

      interceptedAny = true;
      const externalized = await this.externalizeLargeTextPayload({
        conversationId: params.conversationId,
        content: block.text,
        fileName: block.fileName,
        mimeType: block.mimeType,
        formatReference: ({ fileId, byteSize, summary }) =>
          formatFileReference({
            fileId,
            fileName: block.fileName,
            mimeType: block.mimeType,
            byteSize,
            summary,
          }),
      });

      rewrittenSegments.push(params.content.slice(cursor, block.start));
      rewrittenSegments.push(externalized.reference);
      cursor = block.end;
      fileIds.push(externalized.fileId);
    }

    if (!interceptedAny) {
      return null;
    }

    rewrittenSegments.push(params.content.slice(cursor));
    return {
      rewrittenContent: rewrittenSegments.join(""),
      fileIds,
    };
  }

  /** Externalize oversized textual tool outputs before they are persisted inline. */
  async interceptLargeToolResults(params: {
    conversationId: number;
    message: AgentMessage;
    toolCallInputMap?: ReadonlyMap<string, { name?: string; input?: Record<string, unknown> }>;
    getFileId?: (input: { content: string; toolName: string; callId?: string }) => string;
  }): Promise<{ rewrittenMessage: AgentMessage; fileIds: string[] } | null> {
    if (
      (params.message.role !== "toolResult" && params.message.role !== "tool") ||
      !("content" in params.message)
    ) {
      return null;
    }

    // Convert string content to array format for unified processing.
    if (typeof params.message.content === "string") {
      params = {
        ...params,
        message: {
          ...params.message,
          content: [{ type: "text", text: params.message.content }],
        } as AgentMessage,
      };
    }

    if (!Array.isArray(params.message.content)) {
      return null;
    }

    const threshold = Math.max(1, this.config.largeFileTokenThreshold);
    const rewrittenContent: unknown[] = [];
    const fileIds: string[] = [];
    let interceptedAny = false;
    const topLevel = params.message as Record<string, unknown>;
    const topLevelToolCallId =
      safeString(topLevel.toolCallId) ??
      safeString(topLevel.tool_call_id) ??
      safeString(topLevel.toolUseId) ??
      safeString(topLevel.tool_use_id) ??
      safeString(topLevel.call_id) ??
      safeString(topLevel.id);
    const topLevelToolName =
      safeString(topLevel.toolName) ??
      safeString(topLevel.tool_name);
    const topLevelIsError =
      safeBoolean(topLevel.isError) ??
      safeBoolean(topLevel.is_error);

    for (const item of params.message.content) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        rewrittenContent.push(item);
        continue;
      }

      const record = item as Record<string, unknown>;
      const rawType = safeString(record.type);
      const isStructuredToolResult =
        rawType !== "tool_result" &&
        rawType !== "toolResult" &&
        rawType !== "function_call_output";
      const isPlainTextToolResult =
        rawType === "text" &&
        typeof record.text === "string";
      if (isStructuredToolResult && !isPlainTextToolResult) {
        rewrittenContent.push(item);
        continue;
      }

      const textSource =
        isPlainTextToolResult
          ? record.text
          : record.output !== undefined
          ? record.output
          : record.content !== undefined
            ? record.content
            : record;
      const extractedText = extractStructuredText(textSource);
      if (
        typeof extractedText === "string" &&
        LargeFileInterceptor.isExternalizedImageReference(extractedText)
      ) {
        rewrittenContent.push(item);
        continue;
      }
      if (typeof extractedText !== "string") {
        rewrittenContent.push(item);
        continue;
      }

      const toolName =
        safeString(record.name) ??
        topLevelToolName ??
        "tool-result";
      const callId =
        safeString(record.tool_use_id) ??
        safeString(record.toolUseId) ??
        safeString(record.tool_call_id) ??
        safeString(record.toolCallId) ??
        safeString(record.call_id) ??
        safeString(record.id) ??
        topLevelToolCallId;

      // lcm_describe is already a drilldown response; re-stubbing adds another hop.
      if (toolName === "lcm_describe") {
        rewrittenContent.push(item);
        continue;
      }

      const externalizedPayload = resolveLiveToolResultExternalization({
        toolName,
        callId,
        extractedText,
        toolCallInputMap: params.toolCallInputMap,
      });
      if (estimateTokens(externalizedPayload.content) < threshold) {
        if (externalizedPayload.content !== extractedText) {
          const recoveredBlock = { ...record };
          if (isPlainTextToolResult) {
            recoveredBlock.text = externalizedPayload.content;
          } else if ("output" in recoveredBlock || !("content" in recoveredBlock)) {
            recoveredBlock.output = externalizedPayload.content;
          } else {
            recoveredBlock.content = externalizedPayload.content;
          }
          interceptedAny = true;
          rewrittenContent.push(recoveredBlock);
        } else {
          rewrittenContent.push(item);
        }
        continue;
      }

      interceptedAny = true;

      const externalized = await this.externalizeLargeTextPayload({
        conversationId: params.conversationId,
        content: externalizedPayload.content,
        fileId: params.getFileId?.({
          content: externalizedPayload.content,
          toolName: externalizedPayload.toolName,
          callId,
        }),
        fileName: `${externalizedPayload.toolName}.txt`,
        mimeType: "text/plain",
        formatReference: ({ fileId, byteSize, summary }) =>
          formatToolOutputReference({
            fileId,
            toolName: externalizedPayload.toolName,
            byteSize,
            summary,
          }),
      });

      const normalizedRawType =
        rawType === "function_call_output" ? "function_call_output" : "tool_result";
      const compactBlock = buildExternalizedToolResultBlock({
        isPlainTextToolResult,
        normalizedRawType,
        reference: externalized.reference,
        fileId: externalized.fileId,
        byteSize: externalized.byteSize,
        callId,
        recordIsError: record.is_error,
        recordIsErrorCamel: record.isError,
        topLevelIsError,
        toolName: externalizedPayload.toolName,
      });

      rewrittenContent.push(compactBlock);
      fileIds.push(externalized.fileId);
    }

    if (!interceptedAny) {
      return null;
    }

    return {
      rewrittenMessage: {
        ...params.message,
        content: rewrittenContent,
      } as AgentMessage,
      fileIds,
    };
  }

  /** Externalize oversized raw messages that survived role-specific interceptors. */
  async interceptLargeRawPayload(params: {
    conversationId: number;
    message: AgentMessage;
    stored: StoredMessage;
  }): Promise<{ rewrittenMessage: AgentMessage; stored: StoredMessage } | null> {
    const threshold = Math.max(1, this.config.largeFileTokenThreshold);
    if (params.stored.tokenCount < threshold) {
      return null;
    }
    if (params.stored.role === "tool") {
      return null;
    }
    // Skip when this message has already been raw-payload-externalized, or
    // when its whole stored content is just an externalized reference.
    // Mixed content that embeds an image reference alongside other oversized
    // content remains eligible for raw-payload externalization.
    const externalizedFlag = (
      params.message as { rawPayloadExternalized?: unknown }
    ).rawPayloadExternalized;
    if (externalizedFlag === true) {
      return null;
    }
    if (LargeFileInterceptor.isWhollyExternalizedReferenceContent(params.stored.content)) {
      return null;
    }
    if ("content" in params.message && hasReplayCriticalRawBlock(params.message.content)) {
      return null;
    }

    const rawPayload = serializeRawPayloadContent(params.message, params.stored.content);
    if (!rawPayload || rawPayload.content.length === 0) {
      return null;
    }

    const role = typeof params.message.role === "string" ? params.message.role : params.stored.role;
    const externalized = await this.externalizeLargeTextPayload({
      conversationId: params.conversationId,
      content: rawPayload.content,
      fileName: `raw-${role}-payload.${rawPayload.mimeType === "application/json" ? "json" : "txt"}`,
      mimeType: rawPayload.mimeType,
      formatReference: ({ fileId, byteSize, summary }) =>
        formatRawPayloadReference({
          fileId,
          role,
          byteSize,
          reason: RAW_PAYLOAD_EXTERNALIZATION_REASON,
          summary,
        }),
    });

    const rewrittenMessage = {
      ...params.message,
      content: externalized.reference,
      rawPayloadExternalized: true,
      externalizedFileId: externalized.fileId,
      originalByteSize: externalized.byteSize,
      externalizationReason: RAW_PAYLOAD_EXTERNALIZATION_REASON,
    } as AgentMessage;

    return {
      rewrittenMessage,
      stored: {
        ...params.stored,
        content: externalized.reference,
        tokenCount: estimateTokens(externalized.reference),
      },
    };
  }
}

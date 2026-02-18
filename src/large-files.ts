const FILE_BLOCK_RE = /<file\b([^>]*)>([\s\S]*?)<\/file>/gi;
const FILE_ID_RE = /\bfile_[a-f0-9]{16}\b/gi;

const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "cs",
  "go",
  "h",
  "hpp",
  "java",
  "js",
  "jsx",
  "kt",
  "m",
  "php",
  "py",
  "rb",
  "rs",
  "scala",
  "sh",
  "sql",
  "swift",
  "ts",
  "tsx",
]);

const STRUCTURED_EXTENSIONS = new Set(["csv", "json", "tsv", "xml", "yaml", "yml"]);

const MIME_EXTENSION_MAP: Record<string, string> = {
  "application/json": "json",
  "application/xml": "xml",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "application/x-ndjson": "json",
  "application/csv": "csv",
  "application/javascript": "js",
  "application/typescript": "ts",
  "application/x-python-code": "py",
  "application/x-rust": "rs",
  "application/x-sh": "sh",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt",
  "text/tab-separated-values": "tsv",
  "text/x-c": "c",
  "text/x-c++": "cpp",
  "text/x-go": "go",
  "text/x-java": "java",
  "text/x-python": "py",
  "text/x-rust": "rs",
  "text/x-script.python": "py",
  "text/x-shellscript": "sh",
  "text/x-typescript": "ts",
  "text/xml": "xml",
};

const STRUCTURED_MIME_PREFIXES = [
  "application/json",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/x-ndjson",
  "text/csv",
  "text/tab-separated-values",
  "text/xml",
];

const CODE_MIME_PREFIXES = [
  "application/javascript",
  "application/typescript",
  "application/x-python-code",
  "application/x-rust",
  "text/javascript",
  "text/x-c",
  "text/x-c++",
  "text/x-go",
  "text/x-java",
  "text/x-python",
  "text/x-rust",
  "text/x-script.python",
  "text/x-shellscript",
  "text/x-typescript",
];

const TEXT_SUMMARY_SLICE_CHARS = 2_400;
const TEXT_HEADER_LIMIT = 18;

export type FileBlock = {
  fullMatch: string;
  start: number;
  end: number;
  attributes: Record<string, string>;
  fileName?: string;
  mimeType?: string;
  text: string;
};

export type ExplorationSummaryInput = {
  content: string;
  fileName?: string;
  mimeType?: string;
  summarizeText?: (prompt: string) => Promise<string | null | undefined>;
};

function parseFileAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z_:][A-Za-z0-9_:\-.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(raw)) !== null) {
    const key = match[1].trim().toLowerCase();
    const value = (match[3] ?? match[4] ?? match[5] ?? "").trim();
    if (key.length > 0 && value.length > 0) {
      attrs[key] = value;
    }
  }

  return attrs;
}

function normalizeTextForLine(text: string, maxLen: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) {
    return compact;
  }
  return `${compact.slice(0, maxLen)}...`;
}

function collectFileNameExtension(fileName?: string): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const base = fileName.trim().split(/[\\/]/).pop() ?? "";
  const idx = base.lastIndexOf(".");
  if (idx <= 0 || idx === base.length - 1) {
    return undefined;
  }

  const ext = base.slice(idx + 1).toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(ext)) {
    return undefined;
  }
  return ext;
}

function guessMimeExtension(mimeType?: string): string | undefined {
  if (!mimeType) {
    return undefined;
  }
  const normalized = mimeType.trim().toLowerCase();
  return MIME_EXTENSION_MAP[normalized];
}

function isStructured(params: { mimeType?: string; extension?: string }): boolean {
  const mime = params.mimeType?.trim().toLowerCase();
  if (mime && STRUCTURED_MIME_PREFIXES.some((candidate) => mime.startsWith(candidate))) {
    return true;
  }
  return params.extension ? STRUCTURED_EXTENSIONS.has(params.extension) : false;
}

function isCode(params: { mimeType?: string; extension?: string }): boolean {
  const mime = params.mimeType?.trim().toLowerCase();
  if (mime && CODE_MIME_PREFIXES.some((candidate) => mime.startsWith(candidate))) {
    return true;
  }
  return params.extension ? CODE_EXTENSIONS.has(params.extension) : false;
}

function uniqueOrdered(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function exploreJson(content: string): string {
  const parsed = JSON.parse(content) as unknown;

  const describe = (value: unknown, depth = 0): string => {
    if (depth >= 2) {
      return "...";
    }
    if (Array.isArray(value)) {
      const sample = value.slice(0, 3).map((item) => describe(item, depth + 1));
      return `array(len=${value.length}${sample.length > 0 ? `, sample=[${sample.join(", ")}]` : ""})`;
    }
    if (!value || typeof value !== "object") {
      return typeof value;
    }

    const keys = Object.keys(value as Record<string, unknown>);
    const preview = keys.slice(0, 10).join(", ");
    return `object(keys=${keys.length}${preview ? `: ${preview}` : ""})`;
  };

  const topLevel = Array.isArray(parsed) ? "array" : typeof parsed;
  return [
    `Structured summary (JSON):`,
    `Top-level type: ${topLevel}.`,
    `Shape: ${describe(parsed)}.`,
  ].join("\n");
}

function parseDelimitedLine(line: string, delimiter: "," | "\t"): string[] {
  return line
    .split(delimiter)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function exploreDelimited(content: string, delimiter: "," | "\t", kind: "CSV" | "TSV"): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return `Structured summary (${kind}): no rows found.`;
  }

  const headers = parseDelimitedLine(lines[0], delimiter);
  const rowCount = Math.max(0, lines.length - 1);
  const firstData = lines[1] ? normalizeTextForLine(lines[1], 180) : "(no data rows)";

  return [
    `Structured summary (${kind}):`,
    `Rows: ${rowCount.toLocaleString("en-US")}.`,
    `Columns (${headers.length}): ${headers.join(", ") || "(none detected)"}.`,
    `First row sample: ${firstData}.`,
  ].join("\n");
}

function exploreYaml(content: string): string {
  const topLevelKeys = uniqueOrdered(
    content
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^([A-Za-z0-9_.-]+):\s*(?:#.*)?$/);
        return match ? match[1] : "";
      })
      .filter((key) => key.length > 0),
  );

  return [
    "Structured summary (YAML):",
    `Top-level keys (${topLevelKeys.length}): ${topLevelKeys.slice(0, 30).join(", ") || "(none detected)"}.`,
  ].join("\n");
}

function exploreXml(content: string): string {
  const rootMatch = content.match(/<([A-Za-z0-9_:-]+)(\s|>)/);
  const rootTag = rootMatch?.[1] ?? "unknown";
  const childTags = uniqueOrdered(
    [...content.matchAll(/<([A-Za-z0-9_:-]+)(\s|>)/g)]
      .map((match) => match[1])
      .filter((tag) => tag !== rootTag)
      .slice(0, 30),
  );

  return [
    "Structured summary (XML):",
    `Root element: ${rootTag}.`,
    `Child elements seen: ${childTags.join(", ") || "(none detected)"}.`,
  ].join("\n");
}

export function exploreStructuredData(
  content: string,
  mimeType?: string,
  fileName?: string,
): string {
  const extension = collectFileNameExtension(fileName) ?? guessMimeExtension(mimeType);
  const normalizedMime = mimeType?.trim().toLowerCase() ?? "";

  if (extension === "json" || normalizedMime.startsWith("application/json")) {
    try {
      return exploreJson(content);
    } catch {
      return "Structured summary (JSON): failed to parse as valid JSON.";
    }
  }

  if (extension === "csv" || normalizedMime.startsWith("text/csv")) {
    return exploreDelimited(content, ",", "CSV");
  }

  if (extension === "tsv" || normalizedMime.startsWith("text/tab-separated-values")) {
    return exploreDelimited(content, "\t", "TSV");
  }

  if (
    extension === "xml" ||
    normalizedMime.startsWith("text/xml") ||
    normalizedMime.startsWith("application/xml")
  ) {
    return exploreXml(content);
  }

  if (extension === "yaml" || extension === "yml" || normalizedMime.includes("yaml")) {
    return exploreYaml(content);
  }

  return [
    "Structured summary:",
    `Characters: ${content.length.toLocaleString("en-US")}.`,
    `Lines: ${content.split(/\r?\n/).length.toLocaleString("en-US")}.`,
  ].join("\n");
}

export function exploreCode(content: string, fileName?: string): string {
  const lines = content.split(/\r?\n/);
  const imports = uniqueOrdered(
    lines
      .filter((line) =>
        /^\s*(import\s+|from\s+\S+\s+import\s+|const\s+\w+\s*=\s*require\()/.test(line),
      )
      .map((line) => normalizeTextForLine(line, 180))
      .slice(0, 12),
  );

  const signatures = uniqueOrdered(
    lines
      .map((line) => line.trim())
      .filter((line) =>
        /^(export\s+)?(async\s+)?(function|class|interface|type|const\s+\w+\s*=\s*\(|def\s+\w+\(|struct\s+\w+)/.test(
          line,
        ),
      )
      .map((line) => normalizeTextForLine(line, 200))
      .slice(0, 24),
  );

  return [
    `Code exploration summary${fileName ? ` (${fileName})` : ""}:`,
    `Lines: ${lines.length.toLocaleString("en-US")}.`,
    `Imports/dependencies (${imports.length}): ${imports.join(" | ") || "none detected"}.`,
    `Top-level definitions (${signatures.length}): ${signatures.join(" | ") || "none detected"}.`,
  ].join("\n");
}

function extractTextHeaders(content: string): string[] {
  const headers = uniqueOrdered(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 1)
      .filter((line) => /^#{1,6}\s+/.test(line) || /^[A-Z0-9][A-Z0-9\s:_-]{6,}$/.test(line))
      .map((line) => normalizeTextForLine(line, 160))
      .slice(0, TEXT_HEADER_LIMIT),
  );
  return headers;
}

function buildTextSample(content: string): string {
  if (content.length <= TEXT_SUMMARY_SLICE_CHARS * 2) {
    return content;
  }

  const middleStart = Math.max(
    0,
    Math.floor(content.length / 2) - Math.floor(TEXT_SUMMARY_SLICE_CHARS / 2),
  );
  const middleEnd = middleStart + TEXT_SUMMARY_SLICE_CHARS;
  const head = content.slice(0, TEXT_SUMMARY_SLICE_CHARS);
  const mid = content.slice(middleStart, middleEnd);
  const tail = content.slice(-TEXT_SUMMARY_SLICE_CHARS);

  return ["[Document Start]", head, "[Document Middle]", mid, "[Document End]", tail].join("\n\n");
}

function buildTextPrompt(params: {
  content: string;
  fileName?: string;
  mimeType?: string;
  headers: string[];
}): string {
  const sample = buildTextSample(params.content);
  return [
    `Summarize this large file for retrieval-time context references.`,
    `File name: ${params.fileName ?? "unknown"}`,
    `Mime type: ${params.mimeType ?? "unknown"}`,
    `Length: ${params.content.length.toLocaleString("en-US")} chars`,
    `Line count: ${params.content.split(/\r?\n/).length.toLocaleString("en-US")}`,
    params.headers.length > 0
      ? `Detected section headers: ${params.headers.join(" | ")}`
      : "Detected section headers: none",
    "Produce 200-300 words with:",
    "- What the document is about",
    "- Key sections and topics",
    "- Important names, dates, and numbers",
    "- Any action items or constraints",
    "Do not quote long passages verbatim.",
    "",
    "Document sample:",
    sample,
  ].join("\n");
}

function exploreTextDeterministicFallback(content: string, fileName?: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  const headers = extractTextHeaders(content);
  const lineCount = content.split(/\r?\n/).length;
  const wordCount = normalized.length > 0 ? normalized.split(/\s+/).length : 0;
  const first = normalizeTextForLine(content.slice(0, 500), 500);
  const last = normalizeTextForLine(content.slice(-500), 500);

  return [
    `Text exploration summary${fileName ? ` (${fileName})` : ""}:`,
    `Characters: ${content.length.toLocaleString("en-US")}.`,
    `Words: ${wordCount.toLocaleString("en-US")}.`,
    `Lines: ${lineCount.toLocaleString("en-US")}.`,
    `Detected section headers: ${headers.join(" | ") || "none detected"}.`,
    `Opening excerpt: ${first || "(empty)"}.`,
    `Closing excerpt: ${last || "(empty)"}.`,
  ].join("\n");
}

async function exploreText(params: ExplorationSummaryInput): Promise<string> {
  const headers = extractTextHeaders(params.content);

  if (params.summarizeText) {
    const prompt = buildTextPrompt({
      content: params.content,
      fileName: params.fileName,
      mimeType: params.mimeType,
      headers,
    });

    try {
      const summary = await params.summarizeText(prompt);
      if (typeof summary === "string" && summary.trim().length > 0) {
        return summary.trim();
      }
    } catch {
      // Use deterministic fallback if model summarization fails.
    }
  }

  return exploreTextDeterministicFallback(params.content, params.fileName);
}

export function parseFileBlocks(content: string): FileBlock[] {
  const blocks: FileBlock[] = [];
  let match: RegExpExecArray | null;

  FILE_BLOCK_RE.lastIndex = 0;
  while ((match = FILE_BLOCK_RE.exec(content)) !== null) {
    const fullMatch = match[0];
    const rawAttrs = match[1] ?? "";
    const text = match[2] ?? "";
    const start = match.index;
    const end = start + fullMatch.length;
    const attributes = parseFileAttributes(rawAttrs);

    blocks.push({
      fullMatch,
      start,
      end,
      attributes,
      fileName: attributes.name,
      mimeType: attributes.mime,
      text,
    });
  }

  return blocks;
}

export function extensionFromNameOrMime(fileName?: string, mimeType?: string): string {
  const fromName = collectFileNameExtension(fileName);
  if (fromName) {
    return fromName;
  }

  const fromMime = guessMimeExtension(mimeType);
  if (fromMime) {
    return fromMime;
  }

  return "txt";
}

export function extractFileIdsFromContent(content: string): string[] {
  const matches = content.match(FILE_ID_RE) ?? [];
  return uniqueOrdered(matches.map((id) => id.toLowerCase()));
}

export function formatFileReference(input: {
  fileId: string;
  fileName?: string;
  mimeType?: string;
  byteSize: number;
  summary: string;
}): string {
  const name = input.fileName?.trim() || "unknown";
  const mime = input.mimeType?.trim() || "unknown";
  const byteSize = Math.max(0, input.byteSize);

  return [
    `[LCM File: ${input.fileId} | ${name} | ${mime} | ${byteSize.toLocaleString("en-US")} bytes]`,
    "",
    "Exploration Summary:",
    input.summary.trim() || "(no summary available)",
  ].join("\n");
}

export async function generateExplorationSummary(input: ExplorationSummaryInput): Promise<string> {
  const extension = extensionFromNameOrMime(input.fileName, input.mimeType);

  if (isStructured({ mimeType: input.mimeType, extension })) {
    return exploreStructuredData(input.content, input.mimeType, input.fileName);
  }

  if (isCode({ mimeType: input.mimeType, extension })) {
    return exploreCode(input.content, input.fileName);
  }

  return exploreText(input);
}

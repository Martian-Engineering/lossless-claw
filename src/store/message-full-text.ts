/** Normalize persisted message text before indexing it in the message FTS table. */
export function normalizeMessageContentForFullTextIndex(
  content: string
): string | null {
  if (typeof content !== "string") return null;
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const isExternalizedReference =
    trimmed.startsWith("[LCM File:") || trimmed.startsWith("[LCM Tool Output:");
  if (!isExternalizedReference) {
    return content;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const header = lines[0] ?? "";
  const summaryLines: string[] = [];
  let inSummary = false;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line === "Exploration Summary:") {
      inSummary = true;
      continue;
    }
    // Filter both legacy "Use lcm_describe …" and v4.2 "Call lcm_describe(…)"
    // hint lines so they don't pollute the FTS index for unrelated queries.
    if (
      line.startsWith("Use lcm_describe") ||
      line.startsWith("Call lcm_describe")
    ) {
      continue;
    }
    if (inSummary) {
      summaryLines.push(line);
    }
  }

  const normalized = [header, ...summaryLines]
    .filter((line) => line.length > 0)
    .join("\n");
  return normalized || null;
}

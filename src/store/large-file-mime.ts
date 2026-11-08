export function isTextLikeMimeType(mimeType: string | null): boolean {
  if (mimeType == null) {
    return true;
  }
  const lower = mimeType.toLowerCase();
  if (lower.startsWith("text/")) {
    return true;
  }
  if (
    lower.includes("json") ||
    lower.includes("javascript") ||
    lower.includes("xml") ||
    lower.includes("yaml") ||
    lower.includes("yml") ||
    lower.includes("toml")
  ) {
    return true;
  }
  return false;
}

import { createHash } from "node:crypto";

/**
 * Strip host-injected decoration before computing message identity.
 * OpenClaw >=2026.5.26 "cleaned user-turn persistence"
 * stores the transcript copy of a user turn RAW while the afterTurn/model-facing
 * copy keeps its decoration (inline "[Wkdy YYYY-MM-DD HH:MM GMT+N]" timestamp on
 * dashboard, "Conversation info (untrusted metadata): {...}" wrapper on Slack).
 * Verbatim hashing makes the two copies distinct identities, so every user turn
 * persists twice (lossless-claw #889; the #854/#866 entry-id rework does not cover
 * this because its convergence still matches by content). Normalizing both copies
 * to the same core text lets dedup collapse them to one row, while the
 * user-visible timestamp stays intact (injected live at prompt-build).
 */
export function normalizeIdentityContent(content: string): string {
  if (typeof content !== "string") return content;
  let s = content;
  s = s.replace(/^\s*\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}[^\]]*GMT[^\]]*\]\s*/, "");
  s = s.replace(/Conversation info \(untrusted metadata\):\s*\{[\s\S]*?\}\s*/g, "");
  s = s.replace(/Sender \(untrusted metadata\):\s*\{[\s\S]*?\}\s*/g, "");
  s = s.replace(/\[message_id:[^\]]*\]\s*/g, "");
  return s.trim();
}

const IDENTITY_SEP = String.fromCharCode(0);

export function buildMessageIdentityKey(role: string, content: string): string {
  return role + IDENTITY_SEP + normalizeIdentityContent(content);
}

export function buildMessageIdentityHash(role: string, content: string): string {
  return createHash("sha256")
    .update(role)
    .update(IDENTITY_SEP)
    .update(normalizeIdentityContent(content))
    .digest("hex");
}

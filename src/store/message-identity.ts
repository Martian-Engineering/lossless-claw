import { createHash } from "node:crypto";
import { canonicalizeOpenClawInboundMetadataIdentityContent } from "../openclaw-inbound-metadata.js";

export function buildMessageIdentityKey(role: string, content: string): string {
  return `${role}\u0000${canonicalizeOpenClawInboundMetadataIdentityContent(role, content)}`;
}

export function buildMessageIdentityHash(role: string, content: string): string {
  const identityContent = canonicalizeOpenClawInboundMetadataIdentityContent(role, content);
  return createHash("sha256")
    .update(role)
    .update("\u0000")
    .update(identityContent)
    .digest("hex");
}

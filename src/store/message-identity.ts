import { createHash } from "node:crypto";

export function buildMessageIdentityKey(role: string, content: string): string {
  return `${role}\u0000${content}`;
}

export function buildMessageIdentityHash(role: string, content: string): string {
  return createHash("sha256")
    .update(role)
    .update("\u0000")
    .update(content)
    .digest("hex");
}

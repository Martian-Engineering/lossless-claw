import type { RawReplayCoverage } from "../../raw-id-replay-filter.js";
import { NativeDatabase } from "./database.js";
import { collect, n, h } from "./repository.js";
import { NativeConversationStore } from "./conversations.js";
type CoverageRow = {
  messageId: number;
  identityHash: string;
  metadata: string | null;
  fileId: unknown;
  originalByteSize: unknown;
};
export function nativeReplayCoverage(db: NativeDatabase): RawReplayCoverage {
  const rows = (cid: number, role: string, id: string) =>
    db.read(async (view) => {
      const candidates = await collect<CoverageRow>(
        view,
        `raw-part/${n(cid)}/${role}/${h(id)}/`
      );
      const ids = [...new Set(candidates.map((row) => row.messageId))],
        current = await view.getMany<{ conversationId: number }>(
          ids.map((id) => `messages/${n(id)}`)
        );
      const visible = new Set(
        ids.filter((_, i) => current[i]?.conversationId === cid)
      );
      return candidates.filter((row) => visible.has(row.messageId));
    });
  return {
    async find(cid, role, id, identity) {
      return (await rows(cid, role, id))
        .filter(
          (row) => identity === undefined || row.identityHash === identity
        )
        .map(({ messageId }) => ({ messageId }));
    },
    async externalized(cid, role, id) {
      return (await rows(cid, role, id)).filter((row) => row.fileId !== null);
    },
    async parts(id) {
      return (await new NativeConversationStore(db).getMessageParts(id)).map(
        ({ metadata }) => ({ metadata })
      );
    },
  };
}

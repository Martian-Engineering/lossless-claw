import { randomBytes, createHash } from "node:crypto";
import type {
  FocusBriefStore,
  FocusBriefRecord,
  FocusBriefSourceRecord,
  FocusBriefDiagnostics,
  ActiveFocusSummaryRecord,
  CreateFocusBriefInput,
} from "../../store/focus-brief-store.js";
import { parseUtcTimestampOrNull } from "../../store/parse-utc-timestamp.js";
import { NativeRepository, collect, n, h, nextId } from "./repository.js";
import { NativeSummaryStore } from "./summaries.js";
import { NativeConversationStore } from "./conversations.js";
const key = (id: string) => `focus/${h(id)}`;
const now = () => new Date(Math.floor(Date.now() / 1000) * 1000);
export class NativeFocusBriefStore
  extends NativeRepository
  implements Pick<FocusBriefStore, keyof FocusBriefStore>
{
  getActiveContextSummaries(cid: number): Promise<ActiveFocusSummaryRecord[]> {
    return this.read(async () => {
      const summaries = new NativeSummaryStore(this.database),
        conversations = new NativeConversationStore(this.database),
        result: ActiveFocusSummaryRecord[] = [];
      for (const item of await summaries.getContextItems(cid))
        if (item.summaryId) {
          const row = await summaries.getSummary(item.summaryId);
          if (!row) continue;
          let maxSourceSeq: number | null = null;
          for (const id of await summaries.getSummaryMessages(row.summaryId)) {
            const message = await conversations.getMessageById(id);
            if (message)
              maxSourceSeq = Math.max(maxSourceSeq ?? message.seq, message.seq);
          }
          result.push({
            ordinal: item.ordinal,
            summaryId: row.summaryId,
            kind: row.kind,
            depth: row.depth,
            tokenCount: row.tokenCount,
            createdAt: row.createdAt
              .toISOString()
              .replace("T", " ")
              .slice(0, 19),
            latestAt: row.latestAt?.toISOString() ?? null,
            maxSourceSeq,
            content: row.content,
          });
        }
      return result;
    });
  }
  getCoveredWatermark(cid: number): Promise<{
    coveredLatestAt: string | null;
    coveredMessageSeq: number | null;
  }> {
    return this.read(async () => {
      const summaries = new NativeSummaryStore(this.database),
        conversations = new NativeConversationStore(this.database),
        pending = (await summaries.getContextItems(cid)).flatMap((item) =>
          item.summaryId ? [item.summaryId] : []
        ),
        seen = new Set<string>();
      let latest: number | null = null,
        seq: number | null = null;
      while (pending.length) {
        const id = pending.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const row = await summaries.getSummary(id);
        if (!row) continue;
        if (row.latestAt)
          latest = Math.max(latest ?? 0, row.latestAt.getTime());
        for (const mid of await summaries.getSummaryMessages(id)) {
          const message = await conversations.getMessageById(mid);
          if (message) {
            seq = Math.max(seq ?? message.seq, message.seq);
            if (!row.latestAt)
              latest = Math.max(latest ?? 0, message.createdAt.getTime());
          }
        }
        pending.push(
          ...(await summaries.getSummaryParents(id)).map((row) => row.summaryId)
        );
      }
      return {
        coveredLatestAt:
          latest === null ? null : new Date(latest).toISOString(),
        coveredMessageSeq: seq,
      };
    });
  }
  createFocusBrief(input: CreateFocusBriefInput): Promise<FocusBriefRecord> {
    return this.write(async (tx) => {
      if (!(await tx.get(`conversations/${n(input.conversationId)}`)))
        throw new Error("Conversation does not exist");
      if (input.supersedeCurrentDrafts)
        for (const row of await this.listFocusBriefs(
          input.conversationId,
          Number.MAX_SAFE_INTEGER
        ))
          if (["draft", "active"].includes(row.status))
            await tx.put(key(row.briefId), {
              ...row,
              status: "superseded",
              supersededAt: now(),
              updatedAt: now(),
            });
      const briefId = `focus_${randomBytes(8).toString("hex")}`,
        row: FocusBriefRecord = {
          briefId,
          conversationId: input.conversationId,
          sessionKey: input.sessionKey ?? null,
          prompt: input.prompt,
          content: input.content,
          status: input.status,
          tokenCount: Math.max(0, Math.floor(input.tokenCount ?? 0)),
          targetTokens: Math.max(0, Math.floor(input.targetTokens ?? 0)),
          coveredLatestAt: parseUtcTimestampOrNull(input.coveredLatestAt),
          coveredMessageSeq: input.coveredMessageSeq ?? null,
          sourceContextHash: input.sourceContextHash ?? "",
          generatorRunId: input.generatorRunId ?? null,
          generatorSessionKey: input.generatorSessionKey ?? null,
          rawResultJson: input.rawResultJson ?? null,
          error: input.error ?? null,
          createdAt: now(),
          updatedAt: now(),
          supersededAt: null,
        };
      await tx.put(key(briefId), row);
      await tx.put(
        `focus-conversation/${n(row.conversationId)}/${n(
          await nextId(tx, "focus")
        )}`,
        briefId
      );
      for (const source of input.sources ?? []) {
        const summary = await new NativeSummaryStore(this.database).getSummary(
          source.summaryId
        );
        if (summary?.conversationId !== row.conversationId)
          throw new Error("Focus source belongs to another conversation");
        await tx.put(
          `focus-source/${h(briefId)}/${source.role}/${
            source.ordinal === undefined || source.ordinal === null
              ? "null"
              : n(source.ordinal)
          }/${h(source.summaryId)}`,
          {
            briefId,
            summaryId: source.summaryId,
            ordinal: source.ordinal ?? null,
            role: source.role,
            createdAt: now(),
          }
        );
      }
      return row;
    });
  }
  getFocusBrief(id: string): Promise<FocusBriefRecord | null> {
    return this.read((v) => v.get(key(id)));
  }
  getLatestFocusBrief(cid: number): Promise<FocusBriefRecord | null> {
    return this.read(
      async () => (await this.listFocusBriefs(cid, 1))[0] ?? null
    );
  }
  getActiveFocusBrief(cid: number): Promise<FocusBriefRecord | null> {
    return this.read(async () => {
      for (const row of await this.listFocusBriefs(
        cid,
        Number.MAX_SAFE_INTEGER
      ))
        if (row.status === "active") return row;
      return null;
    });
  }
  deactivateActiveFocusBriefs(cid: number): Promise<number> {
    return this.write(async (tx) => {
      let count = 0;
      for (const row of await this.listFocusBriefs(
        cid,
        Number.MAX_SAFE_INTEGER
      ))
        if (row.status === "active") {
          await tx.put(key(row.briefId), {
            ...row,
            status: "inactive",
            updatedAt: now(),
          });
          count++;
        }
      return count;
    });
  }
  listFocusBriefs(cid: number, limit = 20): Promise<FocusBriefRecord[]> {
    return this.read(async (v) => {
      const ids = await collect<string>(v, `focus-conversation/${n(cid)}/`, {
        reverse: true,
        limit: Math.max(1, Math.floor(limit)),
      });
      return (await v.getMany<FocusBriefRecord>(ids.map(key))).filter(
        (r): r is FocusBriefRecord => r !== null
      );
    });
  }
  getFocusBriefSources(id: string): Promise<FocusBriefSourceRecord[]> {
    return this.read((v) => collect(v, `focus-source/${h(id)}/`));
  }
  getFocusBriefDiagnostics(
    brief: FocusBriefRecord
  ): Promise<FocusBriefDiagnostics> {
    return this.read(async () => {
      const conversations = new NativeConversationStore(this.database),
        summaries = new NativeSummaryStore(this.database);
      const messages =
        brief.coveredMessageSeq === null
          ? []
          : await conversations.getMessages(brief.conversationId, {
              afterSeq: brief.coveredMessageSeq,
            });
      const newer = (
        await summaries.getSummariesByConversation(brief.conversationId)
      ).filter((row) =>
        brief.coveredLatestAt !== null
          ? row.latestAt !== null && row.latestAt > brief.coveredLatestAt
          : row.createdAt > brief.createdAt
      );
      const hash = createHash("sha256");
      for (const row of await this.getActiveContextSummaries(
        brief.conversationId
      ))
        hash.update(
          `${row.ordinal}\0${row.summaryId}\0${row.tokenCount}\0${
            row.latestAt ?? ""
          }\n`
        );
      const sourceContextChanged =
        brief.sourceContextHash.trim() !== "" &&
        hash.digest("hex") !== brief.sourceContextHash;
      let truncated = false;
      try {
        truncated =
          JSON.parse(brief.rawResultJson ?? "null")?.truncated === true;
      } catch {}
      return {
        postFocusMessageCount: messages.length,
        postFocusSummaryCount: newer.length,
        postFocusTokenCount: [...messages, ...newer].reduce(
          (sum, row) => sum + row.tokenCount,
          0
        ),
        sourceContextChanged,
        stale: messages.length > 0 || newer.length > 0 || sourceContextChanged,
        truncated,
      };
    });
  }
}

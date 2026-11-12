import { randomUUID } from "node:crypto";
import type {
  ExpansionGrant,
  CreateGrantInput,
  CreateDelegatedExpansionGrantInput,
  ValidationResult,
  ExpansionAuthManager,
} from "../../expansion-auth.js";
import { NativeRepository, n, h } from "./repository.js";
type Stored = ExpansionGrant & { consumed: number };
const key = (id: string) => `grants/${h(id)}`;
export class NativeExpansionAuthorization extends NativeRepository {
  createGrant(input: CreateGrantInput): Promise<ExpansionGrant> {
    return this.write(async (tx) => {
      for (const cid of input.allowedConversationIds)
        if (!(await tx.get(`conversations/${n(cid)}`)))
          throw new Error("Grant conversation is outside this agent");
      const time = new Date(),
        grant: ExpansionGrant = {
          grantId: `grant_${randomUUID().slice(0, 12)}`,
          issuerSessionId: input.issuerSessionId,
          allowedConversationIds: input.allowedConversationIds,
          allowedSummaryIds: input.allowedSummaryIds ?? [],
          maxDepth: input.maxDepth ?? 3,
          tokenCap: input.tokenCap ?? 4000,
          expiresAt: new Date(time.getTime() + (input.ttlMs ?? 300000)),
          revoked: false,
          createdAt: time,
        };
      await tx.put(key(grant.grantId), { ...grant, consumed: 0 });
      return grant;
    });
  }
  getGrant(id: string): Promise<ExpansionGrant | null> {
    return this.read(async (v) => {
      const row = await v.get<Stored>(key(id));
      if (!row || row.revoked || row.expiresAt.getTime() <= Date.now())
        return null;
      const { consumed, ...grant } = row;
      return grant;
    });
  }
  revokeGrant(id: string): Promise<boolean> {
    return this.write(async (tx) => {
      const row = await tx.get<Stored>(key(id));
      if (!row) return false;
      await tx.put(key(id), { ...row, revoked: true });
      return true;
    });
  }
  getRemainingTokenBudget(id: string): Promise<number | null> {
    return this.read(async (v) => {
      if (!(await this.getGrant(id))) return null;
      const row = await v.get<Stored>(key(id));
      return Math.max(
        0,
        Math.floor(row!.tokenCap) - Math.max(0, row!.consumed)
      );
    });
  }
  consumeTokenBudget(id: string, count: number): Promise<number | null> {
    return this.write(async (tx) => {
      if (!(await this.getGrant(id))) return null;
      const row = (await tx.get<Stored>(key(id)))!,
        safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
      await tx.put(key(id), {
        ...row,
        consumed: Math.min(
          Math.max(1, Math.floor(row.tokenCap)),
          Math.max(0, row.consumed) + safe
        ),
      });
      return this.getRemainingTokenBudget(id);
    });
  }
  validateExpansion(
    id: string,
    request: Parameters<ExpansionAuthManager["validateExpansion"]>[1]
  ): Promise<ValidationResult> {
    return this.read(async (v) => {
      const grant = await v.get<Stored>(key(id));
      if (!grant) return { valid: false, reason: "Grant not found" };
      if (grant.revoked)
        return { valid: false, reason: "Grant has been revoked" };
      if (grant.expiresAt.getTime() <= Date.now())
        return { valid: false, reason: "Grant has expired" };
      if (!grant.allowedConversationIds.includes(request.conversationId))
        return {
          valid: false,
          reason: `Conversation ${request.conversationId} is not in the allowed set`,
        };
      const unauthorized = request.summaryIds.filter(
        (id) =>
          grant.allowedSummaryIds.length &&
          !grant.allowedSummaryIds.includes(id)
      );
      return unauthorized.length
        ? {
            valid: false,
            reason: `Summary IDs not authorized: ${unauthorized.join(", ")}`,
          }
        : { valid: true };
    });
  }
  cleanup(): Promise<number> {
    return this.write(async (tx) => {
      let count = 0;
      for await (const { key, value } of tx.scan<Stored>({ prefix: "grants/" }))
        if (value.revoked || value.expiresAt.getTime() <= Date.now()) {
          await tx.remove(key);
          count++;
        }
      return count;
    });
  }
  bindSession(session: string, id: string): Promise<void> {
    return this.write(async (tx) => {
      if (!(await tx.get(key(id)))) throw new Error("Grant not found");
      await tx.put(`grant-binding/${h(session)}`, id);
    });
  }
  resolveSessionGrantId(session: string): Promise<string | null> {
    return this.read((v) => v.get(`grant-binding/${h(session)}`));
  }
  removeSessionBinding(session: string): Promise<boolean> {
    return this.write(async (tx) => {
      const key = `grant-binding/${h(session)}`;
      if (!(await tx.get(key))) return false;
      await tx.remove(key);
      return true;
    });
  }
  clearSessionBindings(): Promise<void> {
    return this.write(async (tx) => {
      for await (const row of tx.scan({ prefix: "grant-binding/" }))
        await tx.remove(row.key);
    });
  }
  createDelegated(
    input: CreateDelegatedExpansionGrantInput
  ): Promise<ExpansionGrant> {
    return this.write(async () => {
      const session = input.delegatedSessionKey.trim();
      if (!session)
        throw new Error(
          "delegatedSessionKey is required for delegated expansion grants"
        );
      const grant = await this.createGrant(input);
      await this.bindSession(session, grant.grantId);
      return grant;
    });
  }
  revokeForSession(
    session: string,
    options?: { removeBinding?: boolean }
  ): Promise<boolean> {
    return this.write(async () => {
      const id = await this.resolveSessionGrantId(session.trim());
      if (!id) return false;
      const revoked = await this.revokeGrant(id);
      if (options?.removeBinding)
        await this.removeSessionBinding(session.trim());
      return revoked;
    });
  }
}

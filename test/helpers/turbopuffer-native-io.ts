import type {
  NativeDocument,
  NativeIo,
  NativeWrite,
  NativeQuery,
} from "../../src/storage/turbopuffer-native/io.js";
export class MemoryIo implements NativeIo {
  rows = new Map<string, NativeDocument>();
  reads = 0;
  writes = 0;
  failBefore?: (body: NativeWrite) => void;
  failAfter?: (body: NativeWrite) => void;
  matches(row: NativeDocument | undefined, condition: any): boolean {
    if (!condition) return true;
    const [field, op, value] = condition;
    if (field === "And") return op.every((c: any) => this.matches(row, c));
    if (field === "Or") return op.some((c: any) => this.matches(row, c));
    const current = (row as any)?.[field] ?? null;
    if (op === "Eq") return current === value;
    if (op === "NotIn") return !value.includes(current);
    if (op === "ContainsTokenSequence") {
      const tokens = (s: string) =>
          s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [],
        source = tokens(String(current ?? "")),
        query = tokens(value);
      return source.some((_, at) =>
        query.every((term, i) => source[at + i] === term)
      );
    }
    if (op === "Gte") return current !== null && current >= value;
    if (op === "Lt") return current !== null && current < value;
    if (op === "Gt") return current !== null && current > value;
    if (op === "Lte") return current !== null && current <= value;
    if (op === "In") return value.includes(current);
    if (op === "Regex") return new RegExp(value).test(current ?? "");
    if (op === "ContainsAllTokens" || op === "ContainsAnyToken") {
      const source: string[] =
          String(current ?? "")
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? [],
        query: string[] =
          String(value)
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? [];
      return op === "ContainsAllTokens"
        ? query.every((term: string) => source.includes(term))
        : query.some((term: string) => source.includes(term));
    }
    throw new Error(`Unimplemented local test operator ${op}`);
  }
  async read(ids: string[]) {
    this.reads++;
    return ids.flatMap((id) =>
      this.rows.has(id) ? [structuredClone(this.rows.get(id)!)] : []
    );
  }
  readPages(ids: string[]) {
    return this.read(ids);
  }
  async query(query: NativeQuery) {
    const rank = query.rank_by as string[];
    let rows = [...this.rows.values()].filter((row) =>
      this.matches(row, query.filters)
    );
    rows.sort(
      (a, b) =>
        String((a as any)[rank[0]] ?? "").localeCompare(
          String((b as any)[rank[0]] ?? "")
        ) * (rank[1] === "desc" ? -1 : 1)
    );
    const limit = query.limit as any;
    return structuredClone(
      rows.slice(0, typeof limit === "number" ? limit : limit?.total ?? 1000)
    );
  }
  async write(body: NativeWrite) {
    this.failBefore?.(body);
    this.writes++;
    const next = new Map(this.rows);
    let upserted = 0,
      patched = 0;
    for (const row of body.upsert_rows ?? [])
      if (
        !next.has(row.id) ||
        this.matches(next.get(row.id), body.upsert_condition)
      ) {
        next.set(row.id, structuredClone(row));
        upserted++;
      }
    for (const patch of body.patch_rows ?? [])
      if (
        next.has(patch.id!) &&
        this.matches(next.get(patch.id!), body.patch_condition)
      ) {
        next.set(patch.id!, {
          ...next.get(patch.id!)!,
          ...structuredClone(patch),
        });
        patched++;
      }
    this.rows = next;
    this.failAfter?.(body);
    return { upserted, patched };
  }
}

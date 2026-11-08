import { NativeDatabase } from "./database.js";
import { compileSafeSearchRegex } from "../../store/search-regex.js";
import {
  buildLikeSearchPlan,
  containsCjk,
  createFallbackSnippet,
} from "../../store/full-text-fallback.js";
import type { MessageSearchInput } from "../../store/conversation-store.js";

type TextRow = {
  content: string;
  conversationId: number;
  createdAt: Date;
  latestAt?: Date | null;
};
/** Native BM25 for normal text; exact regex/CJK semantics scan committed native records.
 * The latter is an intentionally slower path with keyset paging and no corpus cap.
 */
export async function searchRecords<T extends TextRow>(
  database: NativeDatabase,
  table: string,
  input: MessageSearchInput
): Promise<{ value: T; snippet: string; rank: number }[]> {
  if (!input.query.trim() || (input.limit !== undefined && input.limit <= 0))
    return [];
  if (input.conversationIds?.length === 0) return [];
  const ids =
      input.conversationIds ??
      (input.conversationId !== undefined ? [input.conversationId] : undefined),
    limit = input.limit ?? 50;
  const regex =
    input.mode === "regex" ? compileSafeSearchRegex(input.query) : null;
  if (input.mode === "regex" && !regex) return [];
  return database.read(async (view) => {
    const effective = (value: T) => value.latestAt ?? value.createdAt;
    const allowed = (value: T) =>
      (!ids || ids.includes(value.conversationId)) &&
      (!input.since || effective(value) >= input.since) &&
      (!input.before || effective(value) < input.before);
    const results: { value: T; snippet: string; rank: number }[] = [],
      seen = new Set<string>();
    const terms = buildLikeSearchPlan("", input.query).terms;
    const accept = (key: string, value: T, rank: number) => {
      if (seen.has(key) || !allowed(value)) return;
      seen.add(key);
      if (regex) {
        const match = regex.exec(value.content);
        if (match) results.push({ value, snippet: match[0], rank: 0 });
      } else if (
        terms.every((term) => value.content.toLowerCase().includes(term))
      )
        results.push({
          value,
          snippet: createFallbackSnippet(value.content, terms),
          rank,
        });
    };
    if (
      input.mode === "regex" ||
      containsCjk(input.query) ||
      input.query.length > 8192
    ) {
      for await (const { key, value } of view.scan<T>({ prefix: `${table}/` }))
        accept(key, value, 0);
    } else {
      // Provider-side phrase filters prevent post-filter overfetch from hiding hits.
      const phrases = [...input.query.matchAll(/"([^"]+)"|(\S+)/g)].map(
        (match) => [
          "content",
          "ContainsTokenSequence",
          (match[1] ?? match[2]).replace(/"/g, ""),
        ]
      );
      const query = input.query.replace(/"/g, ""),
        exclude: string[] = [];
      while (results.length < limit) {
        const page = await database.search({
          table,
          query,
          mode: "full_text",
          conversationIds: ids,
          limit: Math.min(1000, Math.max(100, limit - results.length)),
          sort:
            input.sort === "relevance"
              ? "relevance"
              : input.sort === "hybrid"
              ? "hybrid"
              : "timestamp",
          head: view.head,
          filters: phrases,
          exclude,
          since: input.since,
          before: input.before,
        });
        if (!page.length) break;
        view.prime(await view.io.read(page.map((row) => row.record_id!)));
        for (const row of page) {
          exclude.push(row.id);
          const value = await view.readRecord<T>(row.record_id!);
          if (!seen.has(row.record_id!) && allowed(value)) {
            seen.add(row.record_id!);
            results.push({
              value,
              snippet: createFallbackSnippet(value.content, terms),
              rank: -((row as any).$dist ?? 0),
            });
          }
        }
        if (page.length < Math.min(1000, Math.max(100, limit - results.length)))
          break;
      }
    }
    // Long records are split for provider attribute limits. Match their whole
    // committed value so AND terms/phrases spanning parts cannot disappear.
    if (
      input.mode === "full_text" &&
      !containsCjk(input.query) &&
      input.query.length <= 8192
    ) {
      for await (const { value: key } of view.scan<string>({
        prefix: `!overflow/${table}/`,
      })) {
        const id = await view.tree.get(key);
        if (!id || seen.has(id)) continue;
        const value = await view.get<T>(key);
        if (
          !value ||
          !allowed(value) ||
          !terms.every((term) => value.content.toLowerCase().includes(term))
        )
          continue;
        const [ranked] = await database.search({
          table,
          query: input.query.replace(/"/g, ""),
          mode: "full_text",
          head: view.head,
          matchAll: false,
          limit: 1,
          filters: [["record_id", "Eq", id]],
          sort: input.sort === "hybrid" ? "hybrid" : "relevance",
        });
        seen.add(id);
        results.push({
          value,
          snippet: createFallbackSnippet(value.content, terms),
          rank: -((ranked as any)?.$dist ?? 0),
        });
      }
    }
    if (input.mode === "regex" || (input.sort ?? "recency") === "recency")
      results.sort(
        (a, b) => effective(b.value).getTime() - effective(a.value).getTime()
      );
    else
      results.sort(
        (a, b) =>
          a.rank - b.rank ||
          effective(b.value).getTime() - effective(a.value).getTime()
      );
    return results.slice(0, limit);
  });
}

import { digest } from "./codec.js";

export type Entry = { key: string; value: string | null };
type Child = { ref: Ref; max: string; count: number };
type Leaf = { entries: Entry[] };
type Branch = { children: Child[] };
type Node = Leaf | Branch;
type Ref = string | Node;
export type Page = { id: string; payload: string };
export interface PageReader {
  readPages(ids: string[]): Promise<Page[]>;
}
export type Range = {
  prefix?: string;
  gte?: string;
  gt?: string;
  lte?: string;
  reverse?: boolean;
  limit?: number;
};
const PAGE_ENTRIES = 64;
const isLeaf = (node: Node): node is Leaf => "entries" in node;
const maximum = (node: Node): string =>
  isLeaf(node)
    ? node.entries.at(-1)?.key ?? ""
    : node.children.at(-1)?.max ?? "";
const count = (node: Node): number =>
  isLeaf(node)
    ? node.entries.filter((e) => e.value !== null).length
    : node.children.reduce((n, c) => n + c.count, 0);

/** Persistent ordered index. Page size is bounded; tree/history size is not. */
export class NativeTree {
  private root: Ref;
  private cache = new Map<string, Node>();
  constructor(private reader: PageReader, root: string | null) {
    this.root = root ?? { entries: [] };
  }
  private async load(ref: Ref): Promise<Node> {
    if (typeof ref !== "string") return ref;
    const cached = this.cache.get(ref);
    if (cached) return cached;
    const [page] = await this.reader.readPages([ref]);
    if (!page || page.id !== `p:${digest(page.payload)}`)
      throw new Error("Native index page missing or corrupt");
    const node: Node = JSON.parse(page.payload);
    if (
      (!isLeaf(node) && !Array.isArray(node.children)) ||
      (isLeaf(node) && !Array.isArray(node.entries))
    )
      throw new Error("Invalid native index page");
    // This is an I/O cache, not a bound on canonical history.
    if (this.cache.size >= 1024)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(ref, node);
    return node;
  }
  async get(key: string): Promise<string | null> {
    let node = await this.load(this.root);
    while (!isLeaf(node)) {
      const child = node.children.find((c) => c.max >= key);
      if (!child) return null;
      node = await this.load(child.ref);
    }
    return node.entries.find((e) => e.key === key)?.value ?? null;
  }
  async getMany(keys: string[]): Promise<(string | null)[]> {
    const output: (string | null)[] = keys.map(() => null);
    let work: { ref: Ref; indices: number[] }[] = [
      { ref: this.root, indices: keys.map((_, i) => i) },
    ];
    while (work.length) {
      const missing = [
        ...new Set(
          work
            .map((item) => item.ref)
            .filter(
              (ref): ref is string =>
                typeof ref === "string" && !this.cache.has(ref)
            )
        ),
      ];
      if (missing.length) {
        const pages = await this.reader.readPages(missing);
        for (const page of pages) {
          if (page.id !== `p:${digest(page.payload)}`)
            throw new Error("Native index page corrupt");
          this.cache.set(page.id, JSON.parse(page.payload));
        }
      }
      const next: { ref: Ref; indices: number[] }[] = [];
      for (const { ref, indices } of work) {
        const node = await this.load(ref);
        if (isLeaf(node))
          for (const i of indices)
            output[i] =
              node.entries.find((entry) => entry.key === keys[i])?.value ??
              null;
        else {
          const groups = new Map<Ref, number[]>();
          for (const i of indices) {
            const child = node.children.find((c) => c.max >= keys[i]);
            if (child) {
              const group = groups.get(child.ref) ?? [];
              group.push(i);
              groups.set(child.ref, group);
            }
          }
          for (const [ref, indices] of groups) next.push({ ref, indices });
        }
      }
      work = next;
    }
    // The caller's batch can exceed the normal cache budget; trim after use.
    while (this.cache.size > 1024)
      this.cache.delete(this.cache.keys().next().value!);
    return output;
  }
  async set(key: string, value: string | null): Promise<void> {
    const edit = async (ref: Ref): Promise<Node[]> => {
      const current = await this.load(ref);
      let next: Node;
      if (isLeaf(current)) {
        const entries = current.entries.map((e) => ({ ...e }));
        let at = entries.findIndex((e) => e.key >= key);
        if (at < 0) at = entries.length;
        if (entries[at]?.key === key) entries[at] = { key, value };
        else entries.splice(at, 0, { key, value });
        next = { entries };
      } else {
        const children = current.children.map((c) => ({ ...c }));
        let at = children.findIndex((c) => c.max >= key);
        if (at < 0) at = children.length - 1;
        const replacement = await edit(children[at].ref);
        children.splice(
          at,
          1,
          ...replacement.map((ref) => ({
            ref,
            max: maximum(ref),
            count: count(ref),
          }))
        );
        next = { children };
      }
      const size = isLeaf(next) ? next.entries.length : next.children.length;
      if (size <= PAGE_ENTRIES) return [next];
      const mid = Math.floor(size / 2);
      return isLeaf(next)
        ? [
            { entries: next.entries.slice(0, mid) },
            { entries: next.entries.slice(mid) },
          ]
        : [
            { children: next.children.slice(0, mid) },
            { children: next.children.slice(mid) },
          ];
    };
    const roots = await edit(this.root);
    this.root =
      roots.length === 1
        ? roots[0]
        : {
            children: roots.map((ref) => ({
              ref,
              max: maximum(ref),
              count: count(ref),
            })),
          };
  }
  async size(): Promise<number> {
    return count(await this.load(this.root));
  }
  async *scan(range: Range = {}): AsyncGenerator<Entry> {
    let remaining = range.limit ?? Infinity;
    if (remaining <= 0) return;
    const lower = range.gte ?? range.prefix;
    const upper =
      range.lte ??
      (range.prefix === undefined ? undefined : range.prefix + "\uffff");
    const walk = async function* (
      this: NativeTree,
      ref: Ref
    ): AsyncGenerator<Entry> {
      const node = await this.load(ref);
      if (isLeaf(node)) {
        const entries = range.reverse
          ? [...node.entries].reverse()
          : node.entries;
        for (const entry of entries) {
          if (remaining <= 0) return;
          if (
            entry.value === null ||
            (lower !== undefined && entry.key < lower) ||
            (range.gt !== undefined && entry.key <= range.gt) ||
            (upper !== undefined && entry.key > upper) ||
            (range.prefix !== undefined && !entry.key.startsWith(range.prefix))
          )
            continue;
          remaining--;
          yield entry;
        }
      } else {
        const children = node.children.map((child, i) => ({
          child,
          previous: node.children[i - 1]?.max,
        }));
        if (range.reverse) children.reverse();
        for (const { child, previous } of children) {
          if (remaining <= 0) return;
          if (lower !== undefined && child.max < lower) continue;
          if (range.gt !== undefined && child.max <= range.gt) continue;
          if (
            upper !== undefined &&
            previous !== undefined &&
            previous >= upper
          )
            continue;
          yield* walk.call(this, child.ref);
        }
      }
    };
    yield* walk.call(this, this.root);
  }
  /** Emit only reachable newly created pages; unchanged subtrees retain their IDs. */
  async seal(): Promise<{ root: string; pages: Page[] }> {
    const pages = new Map<string, Page>();
    const seal = async (ref: Ref): Promise<string> => {
      if (typeof ref === "string") return ref;
      const node = isLeaf(ref)
        ? ref
        : {
            children: await Promise.all(
              ref.children.map(async (c) => ({ ...c, ref: await seal(c.ref) }))
            ),
          };
      const payload = JSON.stringify(node),
        id = `p:${digest(payload)}`;
      pages.set(id, { id, payload });
      return id;
    };
    return { root: await seal(this.root), pages: [...pages.values()] };
  }
}

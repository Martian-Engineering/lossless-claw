import { describe, it, expect } from "vitest";
import {
  NativeTree,
  type Page,
} from "../src/storage/turbopuffer-native/tree.js";
import {
  encode,
  decode,
  numericKey,
} from "../src/storage/turbopuffer-native/codec.js";

class Pages {
  pages = new Map<string, Page>();
  reads = 0;
  async readPages(ids: string[]) {
    this.reads++;
    return ids.flatMap((id) =>
      this.pages.has(id) ? [this.pages.get(id)!] : []
    );
  }
  async persist(tree: NativeTree) {
    const result = await tree.seal();
    for (const p of result.pages) this.pages.set(p.id, p);
    return result;
  }
}
describe("native persistent ordered records", () => {
  it("retains more than ten thousand rows across bounded pages, seeks and resumes without loading history", async () => {
    const pages = new Pages(),
      tree = new NativeTree(pages, null);
    for (let i = 0; i < 12001; i++)
      await tree.set(`message/${numericKey(i)}`, `record:${i}`);
    const sealed = await pages.persist(tree),
      reopened = new NativeTree(pages, sealed.root);
    expect(await reopened.size()).toBe(12001);
    pages.reads = 0;
    const tail = [];
    for await (const entry of reopened.scan({
      prefix: "message/",
      reverse: true,
      limit: 80,
    }))
      tail.push(entry);
    expect(tail).toHaveLength(80);
    expect(tail[0].value).toBe("record:12000");
    expect(pages.reads).toBeLessThan(10);
    const next = [];
    for await (const entry of reopened.scan({
      prefix: "message/",
      gte: `message/${numericKey(11900)}`,
      lte: `message/${numericKey(11999)}`,
      reverse: true,
      limit: 20,
    }))
      next.push(entry);
    expect(next.map((e) => e.value)).toEqual(
      Array.from({ length: 20 }, (_, i) => `record:${11999 - i}`)
    );
    expect(
      Math.max(...sealed.pages.map((p) => Buffer.byteLength(p.payload)))
    ).toBeLessThan(16384);
  });
  it("retains immutable old roots across updates and tombstones", async () => {
    const pages = new Pages(),
      original = new NativeTree(pages, null);
    for (let i = 99; i >= 0; i--)
      await original.set(`key/${numericKey(i)}`, `old:${i}`);
    const before = await pages.persist(original),
      edit = new NativeTree(pages, before.root);
    await edit.set(`key/${numericKey(50)}`, "changed");
    await edit.set(`key/${numericKey(51)}`, null);
    const after = await pages.persist(edit),
      fresh = new NativeTree(pages, after.root),
      old = new NativeTree(pages, before.root);
    expect(await fresh.get(`key/${numericKey(50)}`)).toBe("changed");
    expect(await old.get(`key/${numericKey(50)}`)).toBe("old:50");
    expect(await old.size()).toBe(100);
    expect(await fresh.size()).toBe(99);
  });
  it("preserves typed values without a SQLite round trip", () => {
    const value = {
      when: new Date(0),
      missing: undefined,
      array: ["date", { nested: true }],
    };
    expect(decode(encode(value))).toEqual(value);
  });
});

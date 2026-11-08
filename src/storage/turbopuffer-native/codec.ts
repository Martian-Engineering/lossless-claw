import { createHash } from "node:crypto";

export function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 60);
}
export function encode(value: unknown): string {
  function pack(item: any): any {
    if (item === undefined) return ["undefined"];
    if (item instanceof Map)
      return [
        "map",
        [...item.entries()].map(([key, value]) => [pack(key), pack(value)]),
      ];
    if (item instanceof Set) return ["set", [...item].map(pack)];
    if (typeof item === "bigint") return ["bigint", String(item)];
    if (item instanceof Date) return ["date", item.toISOString()];
    if (Array.isArray(item)) return ["array", item.map(pack)];
    if (item !== null && typeof item === "object")
      return ["object", Object.entries(item).map(([k, v]) => [k, pack(v)])];
    return ["scalar", item];
  }
  return JSON.stringify(pack(value));
}
export function decode<T>(value: string): T {
  function unpack(item: any): any {
    switch (item[0]) {
      case "undefined":
        return undefined;
      case "map":
        return new Map(
          item[1].map(([key, value]: [any, any]) => [
            unpack(key),
            unpack(value),
          ])
        );
      case "set":
        return new Set(item[1].map(unpack));
      case "bigint":
        return BigInt(item[1]);
      case "date":
        return new Date(item[1]);
      case "array":
        return item[1].map(unpack);
      case "object":
        return Object.fromEntries(
          item[1].map(([k, v]: [string, any]) => [k, unpack(v)])
        );
      case "scalar":
        return item[1];
      default:
        throw new Error("Invalid native record encoding");
    }
  }
  return unpack(JSON.parse(value));
}
// Keys remain sortable ASCII even for Unicode session keys or arbitrary opaque cursors.
export const keyPart = (value: string) => Buffer.from(value).toString("hex");
export const numericKey = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid numeric key");
  return String(value).padStart(16, "0");
};

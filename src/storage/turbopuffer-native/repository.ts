import { NativeDatabase, NativeTransaction, NativeView } from "./database.js";
import { numericKey, digest } from "./codec.js";
export const n = numericKey;
export const h = digest;
export async function collect<T>(
  view: NativeView,
  prefix: string,
  options: { limit?: number; reverse?: boolean } = {}
): Promise<T[]> {
  const result: T[] = [];
  for await (const row of view.scan<T>({ prefix, ...options }))
    result.push(row.value);
  return result;
}
export async function nextId(
  tx: NativeTransaction,
  name: string
): Promise<number> {
  const key = `!counter/${name}`,
    value = ((await tx.get<number>(key)) ?? 0) + 1;
  await tx.put(key, value);
  return value;
}
export class NativeRepository {
  constructor(readonly database: NativeDatabase) {}
  withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    return this.database.transaction(async () => operation());
  }
  withReadSnapshot<T>(operation: () => Promise<T>): Promise<T> {
    return this.database.read(() => operation());
  }
  protected read<T>(operation: (view: NativeView) => Promise<T>): Promise<T> {
    return this.database.read(operation);
  }
  protected write<T>(
    operation: (tx: NativeTransaction) => Promise<T>
  ): Promise<T> {
    return this.database.transaction(operation);
  }
}

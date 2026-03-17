import type { DaemonClient } from "../daemon/client.js";

export async function handlePreCompact(stdin: string, client: DaemonClient): Promise<{ exitCode: number; stdout: string }> {
  const health = await client.health();
  if (!health) return { exitCode: 0, stdout: "" };

  try {
    const input = JSON.parse(stdin || "{}");
    const result = await client.post<{ summary: string }>("/compact", input);
    return { exitCode: 2, stdout: result.summary || "" };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}

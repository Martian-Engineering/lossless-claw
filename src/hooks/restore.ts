import type { DaemonClient } from "../daemon/client.js";

export async function handleSessionStart(stdin: string, client: DaemonClient): Promise<{ exitCode: number; stdout: string }> {
  const health = await client.health();
  if (!health) return { exitCode: 0, stdout: "" };
  try {
    const input = JSON.parse(stdin || "{}");
    const result = await client.post<{ context: string }>("/restore", input);
    return { exitCode: 0, stdout: result.context || "" };
  } catch {
    return { exitCode: 0, stdout: "" };
  }
}

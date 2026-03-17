import { DaemonClient } from "../daemon/client.js";

export type SearchResult = { episodic: any[]; semantic: any[] };

export type MemoryApi = {
  store: (text: string, tags: string[], metadata?: Record<string, unknown>) => Promise<void>;
  search: (query: string, options?: { limit?: number; threshold?: number; projectId?: string; layers?: ("episodic" | "semantic")[] }) => Promise<SearchResult>;
  compact: (sessionId: string, transcriptPath: string) => Promise<{ summary: string }>;
  recent: (projectId: string, limit?: number) => Promise<{ summaries: any[] }>;
};

export function createMemoryApi(client: DaemonClient): MemoryApi {
  return {
    async store(text, tags, metadata) {
      await client.post("/store", { text, tags, metadata });
    },
    async search(query, options) {
      return client.post<SearchResult>("/search", { query, ...options });
    },
    async compact(sessionId, transcriptPath) {
      return client.post("/compact", { session_id: sessionId, transcript_path: transcriptPath });
    },
    async recent(projectId, limit = 5) {
      return client.post("/recent", { projectId, limit });
    },
  };
}

// Convenience singleton with default daemon address
const defaultClient = new DaemonClient("http://127.0.0.1:3737");
export const memory: MemoryApi = createMemoryApi(defaultClient);

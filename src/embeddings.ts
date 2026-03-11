/**
 * Embedding generation via OpenAI text-embedding-3-small.
 *
 * Used for semantic search in LCM's pgvector-backed message/summary stores.
 * Resolves the API key from:
 *   1. LCM_EMBEDDING_API_KEY env var
 *   2. OPENAI_API_KEY env var
 *   3. OpenClaw's openai provider config (passed via constructor)
 *
 * Model: text-embedding-3-small (1536 dimensions, $0.02/1M tokens)
 */

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_BASE_URL = "https://api.openai.com/v1";

/** Maximum texts per single API call (OpenAI limit is 2048, we stay conservative) */
const MAX_BATCH_SIZE = 512;

/** Maximum tokens we'll try to embed in one text. Truncate beyond this. */
const MAX_INPUT_TOKENS_APPROX = 8000; // ~32k chars, well within 8191 token limit

export interface EmbeddingConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  dimensions?: number;
}

export class EmbeddingClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private dimensions: number;

  constructor(config?: EmbeddingConfig) {
    this.apiKey =
      config?.apiKey ??
      process.env.LCM_EMBEDDING_API_KEY ??
      process.env.OPENAI_API_KEY ??
      "";
    this.baseUrl = config?.baseUrl ?? EMBEDDING_BASE_URL;
    this.model = config?.model ?? EMBEDDING_MODEL;
    this.dimensions = config?.dimensions ?? EMBEDDING_DIMENSIONS;
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0;
  }

  /**
   * Generate embeddings for one or more texts.
   * Returns an array of float arrays in the same order as input.
   * Automatically batches if input exceeds MAX_BATCH_SIZE.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.isConfigured()) {
      throw new Error(
        "Embedding API key not configured. Set LCM_EMBEDDING_API_KEY or OPENAI_API_KEY.",
      );
    }
    if (texts.length === 0) return [];

    // Truncate overly long texts
    const truncated = texts.map((t) =>
      t.length > MAX_INPUT_TOKENS_APPROX * 4
        ? t.slice(0, MAX_INPUT_TOKENS_APPROX * 4)
        : t,
    );

    const allEmbeddings: number[][] = new Array(truncated.length);

    // Process in batches
    for (let start = 0; start < truncated.length; start += MAX_BATCH_SIZE) {
      const batch = truncated.slice(start, start + MAX_BATCH_SIZE);
      const response = await this.callApi(batch);

      for (let i = 0; i < response.length; i++) {
        allEmbeddings[start + i] = response[i];
      }
    }

    return allEmbeddings;
  }

  /** Embed a single text. Convenience wrapper. */
  async embedOne(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0];
  }

  private async callApi(texts: string[]): Promise<number[][]> {
    const body = {
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
    };

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown error");
      throw new Error(
        `Embedding API error ${res.status}: ${errText}`,
      );
    }

    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // OpenAI returns data sorted by index, but let's be safe
    const sorted = json.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
}

/**
 * Format a float array as a PostgreSQL vector literal: '[0.1,0.2,...]'
 */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/**
 * Parse a PostgreSQL vector literal back to a float array.
 */
export function fromVectorLiteral(literal: string): number[] {
  return literal
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map(Number);
}

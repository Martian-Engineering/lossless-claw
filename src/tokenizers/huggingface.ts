/**
 * HuggingFace Tokenizer implementation for accurate token counting.
 * Supports lazy initialization and caching.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createRequire } from "node:module";
import { ProxyAgent, setGlobalDispatcher } from "undici";

// ESM-compatible require for synchronous imports
const require = createRequire(import.meta.url);

// Dynamic import type
type TokenizerType = {
  encode(text: string): { ids: number[]; length: number };
};

// Model to HuggingFace path mapping
// Only include models where we know the correct tokenizer path
// Unsupported models will return null, causing fallback to heuristic
const MODEL_HF_PATH: Record<string, string> = {
  // GLM (from https://huggingface.co/zai-org)
  // Default: glm-5
  "glm-5": "zai-org/GLM-5",
  "glm-4.7": "zai-org/GLM-4.7",
  
  // MiniMax (from https://huggingface.co/MiniMaxAI)
  // Default: MiniMax-M2.5
  "minimax-m2.1": "MiniMaxAI/MiniMax-M2.1",
  "minimax-m2.5": "MiniMaxAI/MiniMax-M2.5",
  
  // DeepSeek (from https://huggingface.co/deepseek-ai)
  // Only support v3.2 and v3.1, default to v3.2
  "deepseek-v3.1": "deepseek-ai/DeepSeek-V3.1",
  "deepseek-v3.2": "deepseek-ai/DeepSeek-V3.2",
  
  // Qwen - not supported yet
  // Claude, OpenAI - not available on HuggingFace, will fallback to heuristic
};

function mapModelToHuggingFace(modelId: string): string | null {
  const normalizedId = modelId.toLowerCase();
  
  // Try exact match first
  if (MODEL_HF_PATH[modelId]) {
    return MODEL_HF_PATH[modelId];
  }
  // Try case-insensitive match
  for (const [key, value] of Object.entries(MODEL_HF_PATH)) {
    if (normalizedId === key.toLowerCase()) {
      return value;
    }
  }
  // Try prefix match (e.g., "minimax/M2.5" matches "minimax-m2.5")
  for (const [key, value] of Object.entries(MODEL_HF_PATH)) {
    if (normalizedId.includes(key.toLowerCase())) {
      return value;
    }
  }
  
  // Default fallback for MiniMax models (user preference: minimax default to M2.5)
  if (normalizedId.startsWith("minimax")) {
    return "MiniMaxAI/MiniMax-M2.5";
  }
  
  // Default fallback for GLM models (user preference: glm default to glm-5)
  if (normalizedId.startsWith("glm")) {
    return "zai-org/GLM-5";
  }
  
  // Default fallback for DeepSeek models (user preference: deepseek default to v3.2)
  if (normalizedId.startsWith("deepseek")) {
    return "deepseek-ai/DeepSeek-V3.2";
  }
  
  // No mapping found - return null to trigger fallback to heuristic
  return null;
}

/**
 * Verify that a HuggingFace tokenizer URL is accessible (returns 200 OK).
 * Used for testing - does a lightweight HEAD request with redirect following.
 */
/**
 * Verify that a HuggingFace tokenizer URL is accessible (returns 200 OK or redirect).
 * Used for testing - does a lightweight HEAD request without following redirects.
 * 302/307 redirects indicate the resource exists (redirects to cache API).
 */
export async function verifyTokenizerUrl(hfPath: string): Promise<boolean> {
  const url = `https://huggingface.co/${hfPath}/resolve/main/tokenizer.json`;
  try {
    // Don't follow redirects - just check if the resource exists
    // 200 = OK, 302/307 = Redirect to cache (resource exists)
    const response = await fetch(url, { 
      method: "HEAD",
      redirect: "manual"
    });
    const status = response.status;
    return status === 200 || status === 302 || status === 307;
  } catch {
    return false;
  }
}

export class HuggingFaceTokenizer {
  private tokenizer: TokenizerType | null = null;
  private initialized = false;
  private initError: Error | null = null;
  private readonly modelId: string;
  private readonly httpProxy?: string;
  private readonly cacheDir: string;

  constructor(modelId = "", httpProxy?: string) {
    this.modelId = modelId || "glm-5";
    this.httpProxy = httpProxy;
    // Default cache: ~/.openclaw/tokenizers/ (same location as lcm.db)
    this.cacheDir = process.env.TOKENIZER_CACHE_DIR || path.join(os.homedir(), ".openclaw", "tokenizers");
    
    // Try synchronous cache load in constructor (no network, no async)
    this.trySyncCacheLoad();
  }

  /**
   * Try to load tokenizer from cache synchronously in constructor.
   * This allows tokenizer to be ready immediately without async initialize().
   */
  private trySyncCacheLoad(): void {
    try {
      const hfPath = mapModelToHuggingFace(this.modelId);
      if (!hfPath) return; // No mapping, skip
      
      const cachePath = this.getCachePath();
      const cachePathJson = cachePath.replace(/\.json$/, '.tokenizer.json');
      const cachePathConfig = cachePath.replace(/\.json$/, '.config.json');
      
      // Check if cache files exist synchronously
      const fsSync = require('fs');
      if (!fsSync.existsSync(cachePathJson) || !fsSync.existsSync(cachePathConfig)) {
        return; // Cache not available, skip
      }
      
      // Read cache files synchronously
      const rawJson = fsSync.readFileSync(cachePathJson, 'utf-8');
      const rawConfig = fsSync.readFileSync(cachePathConfig, 'utf-8');
      const tokenizerJson = JSON.parse(rawJson);
      const tokenizerConfig = JSON.parse(rawConfig);
      
      // Import Tokenizer class (sync require, not dynamic import)
      const { Tokenizer } = require('@huggingface/tokenizers');
      this.tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
      this.initialized = true;
      console.log(`[lcm] Tokenizer loaded from cache (sync): ${cachePathJson}`);
    } catch (err) {
      // Silent fail - will fallback to heuristic or async init later
      console.warn(`[lcm] Failed to sync load tokenizer from cache: ${err}`);
    }
  }

  isEnabled(): boolean {
    return this.initialized && this.tokenizer !== null;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    // Try lazy load first
    try {
      await this.lazyLoad();
      this.initialized = true;
      return;
    } catch (err) {
      this.initError = err instanceof Error ? err : new Error(String(err));
      throw this.initError;
    }
  }

  private async lazyLoad(): Promise<void> {
    let TokenizerClass: any;
    try {
      const mod = await import("@huggingface/tokenizers");
      TokenizerClass = mod.Tokenizer;
    } catch (err) {
      throw new Error("@huggingface/tokenizers not installed. Run: npm install @huggingface/tokenizers");
    }

    const cachePath = this.getCachePath();
    const hfPath = mapModelToHuggingFace(this.modelId);
    
    // If no mapping found, throw to trigger fallback to heuristic
    if (!hfPath) {
      throw new Error(`No tokenizer mapping for model: ${this.modelId}. Supported: GLM (zai-org/GLM-4.7, zai-org/GLM-5), MiniMax (MiniMaxAI/MiniMax-M2.1, MiniMaxAI/MiniMax-M2.5), DeepSeek (deepseek-ai/DeepSeek-V3.1, deepseek-ai/DeepSeek-V3.2)`);
    }
    
    const proxyUrl = this.httpProxy;

    // Set proxy if provided (using undici ProxyAgent for native fetch)
    if (proxyUrl) {
      setGlobalDispatcher(new ProxyAgent(proxyUrl));
    }

    // Try load from cache
    const cachePathJson = cachePath.replace(/\.json$/, '.tokenizer.json');
    const cachePathConfig = cachePath.replace(/\.json$/, '.config.json');
    
    if (await this.pathExists(cachePathJson) && await this.pathExists(cachePathConfig)) {
      try {
        const rawJson = await fs.readFile(cachePathJson, "utf-8");
        const rawConfig = await fs.readFile(cachePathConfig, "utf-8");
        this.tokenizerJson = JSON.parse(rawJson);
        const tokenizerConfig = JSON.parse(rawConfig);
        this.tokenizer = new TokenizerClass(this.tokenizerJson, tokenizerConfig);
        console.log(`[lcm] Loaded tokenizer from cache: ${cachePathJson}`);
        return;
      } catch (err) {
        console.warn(`[lcm] Failed to load cached tokenizer, re-downloading: ${err}`);
      }
    }

    // Download from HuggingFace
    console.log(`[lcm] Downloading tokenizer from HuggingFace: ${hfPath}`);
    const tokenizerUrl = `https://huggingface.co/${hfPath}/resolve/main/tokenizer.json`;
    const configUrl = `https://huggingface.co/${hfPath}/resolve/main/tokenizer_config.json`;
    
    const [tokenizerResponse, configResponse] = await Promise.all([
      fetch(tokenizerUrl),
      fetch(configUrl),
    ]);
    
    if (!tokenizerResponse.ok) {
      throw new Error(`Failed to download tokenizer from ${tokenizerUrl}: ${tokenizerResponse.status}`);
    }
    if (!configResponse.ok) {
      throw new Error(`Failed to download tokenizer config from ${configUrl}: ${configResponse.status}`);
    }
    
    this.tokenizerJson = await tokenizerResponse.json();
    const tokenizerConfig = await configResponse.json();
    this.tokenizer = new TokenizerClass(this.tokenizerJson, tokenizerConfig);

    // Save to cache
    await this.saveToCache(cachePathJson, cachePathConfig, tokenizerConfig);
    console.log(`[lcm] Saved tokenizer to cache: ${cachePathJson}`);
  }

  private tokenizerJson: any = null;

  private async saveToCache(cachePathJson: string, cachePathConfig: string, tokenizerConfig: any): Promise<void> {
    if (!this.tokenizerJson) return;
    
    await fs.mkdir(path.dirname(cachePathJson), { recursive: true });
    await fs.writeFile(cachePathJson, JSON.stringify(this.tokenizerJson, null, 2), "utf-8");
    await fs.writeFile(cachePathConfig, JSON.stringify(tokenizerConfig, null, 2), "utf-8");
  }

  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  private getCachePath(): string {
    const safeModelId = this.modelId.replace(/[^a-zA-Z0-9]/g, "_");
    return path.join(this.cacheDir, `${safeModelId}.json`);
  }

  countTokens(text: string): number {
    if (!this.initialized || !this.tokenizer) {
      throw new Error("Tokenizer not initialized. Call initialize() first.");
    }
    
    const encoding = this.tokenizer.encode(text);
    // Use ids.length for accurate count (encode is synchronous in @huggingface/tokenizers)
    return encoding.ids?.length ?? encoding.length;
  }
}

/**
 * Create a tokenizer service instance (factory function).
 * Creates and initializes the tokenizer synchronously.
 */
export async function createTokenizerService(modelId?: string, httpProxy?: string): Promise<HuggingFaceTokenizer> {
  const tokenizer = new HuggingFaceTokenizer(modelId, httpProxy);
  await tokenizer.initialize();
  return tokenizer;
}

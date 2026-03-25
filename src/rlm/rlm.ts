/**
 * RLM (Recurrent Language Model) core implementation
 * 
 * Provides pattern recognition across multiple summaries to identify
 * recurrent themes and produce compressed representations.
 */

import { createHash } from "node:crypto";
import type {
  RlmConfig,
  RlmSummaryEntry,
  RlmPattern,
  RlmAnalysisResult,
  RlmSummarizeOptions,
  RlmSummarizeResult,
  PatternDetectionOptions,
  RlmMetrics,
} from "./types.js";

/** Default configuration values */
const DEFAULT_MIN_DEPTH = 2;
const DEFAULT_PATTERN_THRESHOLD = 0.7;
const DEFAULT_MAX_PATTERNS = 5;

/** System prompt for RLM pattern analysis */
const RLM_PATTERN_SYSTEM_PROMPT = `You are a pattern recognition engine analyzing conversation summaries for recurrent themes.
Your task is to identify patterns across multiple summaries that can be compressed into efficient representations.

Look for:
1. Recurring themes - topics that appear across multiple summaries
2. Progressions - evolving states or sequences
3. Decision evolution - how decisions changed over time
4. Task lifecycles - tasks being created, worked on, completed
5. Constraints - persistent limitations or requirements

Output your analysis as JSON with this structure:
{
  "patterns": [
    {
      "type": "recurring_theme|progression|decision_evolution|task_lifecycle|constraint",
      "description": "human-readable description",
      "confidence": 0.0-1.0,
      "sourceSummaryIds": ["id1", "id2"],
      "compressedRepresentation": "concise pattern summary",
      "tokenSavings": estimated number
    }
  ],
  "unpatternedSummaryIds": ["id3"],
  "overallConfidence": 0.0-1.0
}`;

/** System prompt for RLM-based summarization */
const RLM_SUMMARIZE_SYSTEM_PROMPT = `You are a recurrent language model creating compressed memory representations.
You have access to detected patterns across conversation segments.

Your task:
1. Use detected patterns to compress recurring information
2. Reference patterns by description rather than repeating content
3. Focus on what is unique or changed in each segment
4. Maintain chronological flow and causality

When patterns are available, structure output as:
- Pattern references (what patterns apply)
- Unique content (what doesn't fit patterns)
- Synthesis (how patterns and unique content interact)

If patterns are not useful or confidence is low, fall back to standard summarization.`;

/** Estimate tokens from text length */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Generate deterministic pattern ID */
function generatePatternId(description: string): string {
  return (
    "pat_" +
    createHash("sha256")
      .update(description)
      .digest("hex")
      .slice(0, 12)
  );
}

/** Simple pattern detection via content analysis (fallback when LLM unavailable) */
function detectPatternsHeuristically(
  entries: RlmSummaryEntry[],
  options: PatternDetectionOptions,
): RlmPattern[] {
  const patterns: RlmPattern[] = [];
  const contentWords = new Map<string, number>();
  const stopWords = new Set([
    "about", "after", "again", "against", "all", "also", "and", "another", "any", "are", "around",
    "because", "been", "before", "being", "between", "both", "but", "can", "could", "did", "does",
    "doing", "down", "during", "each", "either", "else", "even", "every", "few", "for", "from",
    "further", "had", "has", "have", "having", "her", "here", "hers", "herself", "him", "himself",
    "his", "how", "into", "its", "itself", "just", "more", "most", "much", "myself", "nor", "not",
    "now", "off", "once", "only", "other", "ought", "our", "ours", "ourselves", "out", "over",
    "own", "same", "she", "should", "some", "such", "than", "that", "their", "theirs", "them",
    "themselves", "then", "there", "these", "they", "this", "those", "through", "too", "under",
    "until", "very", "was", "were", "what", "when", "where", "which", "while", "who", "whom",
    "why", "with", "would", "you", "your", "yours", "yourself", "yourselves", "will", "shall",
    "may", "might", "must",
  ]);

  // Simple word frequency analysis for recurring themes
  for (const entry of entries) {
    const words = entry.content
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 4 && !stopWords.has(w));

    const wordSet = new Set(words);
    for (const word of wordSet) {
      contentWords.set(word, (contentWords.get(word) || 0) + 1);
    }
  }

  // Find words that appear in multiple summaries (at least 2, allow up to all entries)
  const minOccurrences = Math.max(2, Math.floor(entries.length * 0.3));
  const maxOccurrences = entries.length;

  const recurringTerms = Array.from(contentWords.entries())
    .filter(([_, count]) => count >= minOccurrences && count <= maxOccurrences)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);

  if (recurringTerms.length >= 2) {
    const relevantSummaries = entries.filter(e =>
      recurringTerms.some(term => e.content.toLowerCase().includes(term))
    );

    if (relevantSummaries.length >= 2) {
      const description = `Recurring themes: ${recurringTerms.slice(0, 5).join(", ")}`;
      const originalTokens = relevantSummaries.reduce((sum, e) => sum + e.tokenCount, 0);
      const compressedTokens = estimateTokens(description) + 50;
      // Calculate confidence based on term frequency and coverage
      const termConfidence = Math.min(0.8, 0.4 + (recurringTerms.length * 0.08));
      const coverageConfidence = relevantSummaries.length / entries.length;
      const confidence = Math.min(0.9, (termConfidence + coverageConfidence) / 2);

      patterns.push({
        patternId: generatePatternId(description),
        type: "recurring_theme",
        description,
        confidence,
        sourceSummaryIds: relevantSummaries.map(e => e.summaryId),
        compressedRepresentation: `Pattern[${recurringTerms.slice(0, 3).join("+")}]: ${description}`,
        tokenSavings: Math.max(0, originalTokens - compressedTokens),
      });
    }
  }

  return patterns.filter(p => p.confidence >= options.minConfidence);
}

/** Parse LLM pattern analysis response */
function parsePatternAnalysisResponse(content: string): RlmAnalysisResult {
  try {
    const parsed = JSON.parse(content);
    const patterns: RlmPattern[] = (parsed.patterns || []).map((p: any) => ({
      patternId: p.patternId || generatePatternId(p.description),
      type: p.type || "recurring_theme",
      description: p.description || "",
      confidence: Math.max(0, Math.min(1, p.confidence || 0)),
      sourceSummaryIds: p.sourceSummaryIds || [],
      compressedRepresentation: p.compressedRepresentation || p.description || "",
      tokenSavings: p.tokenSavings || 0,
    }));
    
    const unpatternedIds = new Set(parsed.unpatternedSummaryIds || []);
    const totalTokenSavings = patterns.reduce((sum, p) => sum + p.tokenSavings, 0);
    
    return {
      patterns,
      unpatternedSummaries: [], // Will be populated by caller
      hasViablePatterns: patterns.length > 0 && parsed.overallConfidence >= 0.5,
      totalTokenSavings,
      overallConfidence: parsed.overallConfidence || 0,
    };
  } catch {
    // Return empty result on parse failure
    return {
      patterns: [],
      unpatternedSummaries: [],
      hasViablePatterns: false,
      totalTokenSavings: 0,
      overallConfidence: 0,
    };
  }
}

/** RLM Engine class */
export class RlmEngine {
  private config: RlmConfig;
  private metrics: RlmMetrics;
  private llmSummarizeFn?: (prompt: string, system: string, maxTokens: number) => Promise<string>;

  constructor(
    config: Partial<RlmConfig>,
    llmSummarizeFn?: (prompt: string, system: string, maxTokens: number) => Promise<string>,
  ) {
    this.config = {
      enabled: config.enabled ?? true,
      provider: config.provider ?? "",
      model: config.model ?? "",
      minDepth: config.minDepth ?? DEFAULT_MIN_DEPTH,
      patternThreshold: config.patternThreshold ?? DEFAULT_PATTERN_THRESHOLD,
    };
    this.llmSummarizeFn = llmSummarizeFn;
    this.metrics = {
      analysesPerformed: 0,
      patternsDetected: 0,
      rlmSummariesGenerated: 0,
      fallbackCount: 0,
      totalTokenSavings: 0,
      averageConfidence: 0,
    };
  }

  /** Check if RLM should be used for given depth */
  shouldUseRlm(depth: number): boolean {
    return this.config.enabled && depth >= this.config.minDepth;
  }

  /** Get current metrics */
  getMetrics(): RlmMetrics {
    return { ...this.metrics };
  }

  /** Analyze summaries for patterns */
  async analyzePatterns(
    entries: RlmSummaryEntry[],
    options?: Partial<PatternDetectionOptions>,
  ): Promise<RlmAnalysisResult> {
    this.metrics.analysesPerformed++;
    
    const opts: PatternDetectionOptions = {
      minConfidence: options?.minConfidence ?? this.config.patternThreshold,
      maxPatterns: options?.maxPatterns ?? DEFAULT_MAX_PATTERNS,
      detectProgressions: options?.detectProgressions ?? true,
      detectDecisionEvolution: options?.detectDecisionEvolution ?? true,
    };

    // Use heuristic detection if no LLM available
    if (!this.llmSummarizeFn || entries.length < 2) {
      const patterns = detectPatternsHeuristically(entries, opts);
      const patternedIds = new Set(patterns.flatMap(p => p.sourceSummaryIds));
      const unpatterned = entries.filter(e => !patternedIds.has(e.summaryId));
      
      const result: RlmAnalysisResult = {
        patterns,
        unpatternedSummaries: unpatterned,
        hasViablePatterns: patterns.length > 0,
        totalTokenSavings: patterns.reduce((sum, p) => sum + p.tokenSavings, 0),
        overallConfidence: patterns.length > 0 
          ? patterns.reduce((sum, p) => sum + p.confidence, 0) / patterns.length 
          : 0,
      };
      
      this.metrics.patternsDetected += patterns.length;
      return result;
    }

    // Use LLM for pattern detection
    try {
      const prompt = this.buildPatternAnalysisPrompt(entries, opts);
      const response = await this.llmSummarizeFn(
        prompt,
        RLM_PATTERN_SYSTEM_PROMPT,
        2000,
      );
      
      const result = parsePatternAnalysisResponse(response);
      
      // Populate unpatterned summaries
      const patternedIds = new Set(result.patterns.flatMap(p => p.sourceSummaryIds));
      result.unpatternedSummaries = entries.filter(e => !patternedIds.has(e.summaryId));
      
      this.metrics.patternsDetected += result.patterns.length;
      return result;
    } catch (error) {
      console.warn(`[rlm] Pattern analysis failed: ${error}`);
      // Fall back to heuristic detection
      const patterns = detectPatternsHeuristically(entries, opts);
      const patternedIds = new Set(patterns.flatMap(p => p.sourceSummaryIds));
      
      return {
        patterns,
        unpatternedSummaries: entries.filter(e => !patternedIds.has(e.summaryId)),
        hasViablePatterns: patterns.length > 0,
        totalTokenSavings: patterns.reduce((sum, p) => sum + p.tokenSavings, 0),
        overallConfidence: patterns.length > 0 ? 0.5 : 0,
      };
    }
  }

  /** Build prompt for pattern analysis */
  private buildPatternAnalysisPrompt(
    entries: RlmSummaryEntry[],
    options: PatternDetectionOptions,
  ): string {
    const entriesText = entries
      .map(e => `[${e.summaryId}] (depth=${e.depth}, tokens=${e.tokenCount}):\n${e.content.slice(0, 500)}`)
      .join("\n\n---\n\n");
    
    return [
      "Analyze the following conversation summaries for recurrent patterns:",
      "",
      entriesText,
      "",
      `Detection options:`,
      `- Minimum confidence: ${options.minConfidence}`,
      `- Maximum patterns: ${options.maxPatterns}`,
      `- Detect progressions: ${options.detectProgressions}`,
      `- Detect decision evolution: ${options.detectDecisionEvolution}`,
      "",
      "Return your analysis as JSON.",
    ].join("\n");
  }

  /** Generate RLM-based summary */
  async summarize(
    entries: RlmSummaryEntry[],
    options?: RlmSummarizeOptions,
  ): Promise<RlmSummarizeResult> {
    const depth = options?.depth ?? 1;
    
    // Check if we should use RLM
    if (!this.shouldUseRlm(depth)) {
      this.metrics.fallbackCount++;
      return {
        content: "",
        usedPatterns: false,
        fallbackToStandard: true,
        confidence: 0,
      };
    }

    // Analyze patterns first
    const analysis = await this.analyzePatterns(entries, {
      minConfidence: options?.patternThreshold ?? this.config.patternThreshold,
      maxPatterns: DEFAULT_MAX_PATTERNS,
      detectProgressions: true,
      detectDecisionEvolution: true,
    });

    // If no viable patterns, fall back to standard summarization
    if (!analysis.hasViablePatterns || analysis.patterns.length === 0) {
      this.metrics.fallbackCount++;
      return {
        content: "",
        usedPatterns: false,
        fallbackToStandard: true,
        confidence: analysis.overallConfidence,
      };
    }

    // If we have patterns but no LLM, create a simple pattern-based summary
    if (!this.llmSummarizeFn) {
      const content = this.buildHeuristicPatternSummary(entries, analysis, options);
      this.metrics.rlmSummariesGenerated++;
      this.metrics.totalTokenSavings += analysis.totalTokenSavings;
      
      return {
        content,
        usedPatterns: true,
        appliedPatterns: analysis.patterns,
        fallbackToStandard: false,
        confidence: analysis.overallConfidence,
      };
    }

    // Use LLM to generate pattern-based summary
    try {
      const prompt = this.buildRlmSummaryPrompt(entries, analysis, options);
      const content = await this.llmSummarizeFn(
        prompt,
        RLM_SUMMARIZE_SYSTEM_PROMPT,
        2000,
      );
      
      this.metrics.rlmSummariesGenerated++;
      this.metrics.totalTokenSavings += analysis.totalTokenSavings;
      
      return {
        content: content.trim(),
        usedPatterns: true,
        appliedPatterns: analysis.patterns,
        fallbackToStandard: false,
        confidence: analysis.overallConfidence,
      };
    } catch (error) {
      console.warn(`[rlm] RLM summarization failed: ${error}`);
      this.metrics.fallbackCount++;
      
      // Try heuristic fallback
      const content = this.buildHeuristicPatternSummary(entries, analysis, options);
      
      return {
        content,
        usedPatterns: true,
        appliedPatterns: analysis.patterns,
        fallbackToStandard: true,
        confidence: analysis.overallConfidence * 0.7,
      };
    }
  }

  /** Build RLM summary prompt */
  private buildRlmSummaryPrompt(
    entries: RlmSummaryEntry[],
    analysis: RlmAnalysisResult,
    options?: RlmSummarizeOptions,
  ): string {
    const patternsText = analysis.patterns
      .map(p => `[${p.patternId}] ${p.type} (confidence=${p.confidence.toFixed(2)}): ${p.description}`)
      .join("\n");
    
    const unpatternedText = analysis.unpatternedSummaries
      .map(e => `[${e.summaryId}]:\n${e.content.slice(0, 400)}`)
      .join("\n\n---\n\n");
    
    const parts: string[] = [
      "Generate a compressed summary using the following detected patterns:",
      "",
      "=== DETECTED PATTERNS ===",
      patternsText,
      "",
      "=== UNPATTERNED CONTENT ===",
      unpatternedText || "(all content fits patterns)",
      "",
    ];
    
    if (options?.previousSummary) {
      parts.push("=== PREVIOUS CONTEXT ===");
      parts.push(options.previousSummary);
      parts.push("");
    }
    
    if (options?.customInstructions) {
      parts.push("=== CUSTOM INSTRUCTIONS ===");
      parts.push(options.customInstructions);
      parts.push("");
    }
    
    parts.push("Generate a concise summary that references patterns where applicable.");
    
    return parts.join("\n");
  }

  /** Build heuristic pattern summary when LLM unavailable */
  private buildHeuristicPatternSummary(
    entries: RlmSummaryEntry[],
    analysis: RlmAnalysisResult,
    options?: RlmSummarizeOptions,
  ): string {
    const parts: string[] = [];
    
    // Add pattern references
    if (analysis.patterns.length > 0) {
      parts.push("Patterns detected:");
      for (const pattern of analysis.patterns) {
        parts.push(`- ${pattern.description}`);
      }
      parts.push("");
    }
    
    // Add unpatterned content summary
    if (analysis.unpatternedSummaries.length > 0) {
      parts.push("Additional content:");
      for (const entry of analysis.unpatternedSummaries.slice(0, 3)) {
        const lines = entry.content.split("\n").slice(0, 3);
        parts.push(...lines.map(l => `- ${l.slice(0, 100)}`));
      }
    }
    
    // Add previous context reference if available
    if (options?.previousSummary) {
      parts.push("");
      parts.push("Context from previous summary maintained.");
    }
    
    return parts.join("\n");
  }
}

/** Create RLM engine with configuration */
export function createRlmEngine(
  config: Partial<RlmConfig>,
  llmSummarizeFn?: (prompt: string, system: string, maxTokens: number) => Promise<string>,
): RlmEngine {
  return new RlmEngine(config, llmSummarizeFn);
}

/** Default export */
export default RlmEngine;

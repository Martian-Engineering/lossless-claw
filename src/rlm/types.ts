/**
 * RLM (Recurrent Language Model) types for LCF compaction
 * 
 * RLM provides pattern recognition across multiple summaries to identify
 * recurrent themes and produce compressed representations that capture
 * these patterns more efficiently than standard summarization.
 */

/** Configuration options for RLM operations */
export interface RlmConfig {
  /** Whether RLM pattern recognition is enabled */
  enabled: boolean;
  /** Provider to use for RLM operations */
  provider: string;
  /** Model to use for RLM pattern analysis */
  model: string;
  /** Minimum depth required before using RLM (default: 2) */
  minDepth: number;
  /** Confidence threshold for pattern detection (0.0 - 1.0, default: 0.7) */
  patternThreshold: number;
}

/** A single summary entry for RLM analysis */
export interface RlmSummaryEntry {
  /** Unique identifier for the summary */
  summaryId: string;
  /** The summary content */
  content: string;
  /** Depth of this summary in the compaction hierarchy */
  depth: number;
  /** When this summary was created */
  createdAt: Date;
  /** Token count of the summary */
  tokenCount: number;
  /** Optional: child summaries this entry contains */
  childSummaryIds?: string[];
}

/** Detected pattern in a set of summaries */
export interface RlmPattern {
  /** Unique identifier for this pattern */
  patternId: string;
  /** Type of pattern detected */
  type: 'recurring_theme' | 'progression' | 'decision_evolution' | 'task_lifecycle' | 'constraint';
  /** Human-readable description of the pattern */
  description: string;
  /** Confidence score (0.0 - 1.0) */
  confidence: number;
  /** Summary IDs that exhibit this pattern */
  sourceSummaryIds: string[];
  /** The compressed representation of this pattern */
  compressedRepresentation: string;
  /** Estimated token savings from using this pattern */
  tokenSavings: number;
}

/** Result of RLM pattern analysis */
export interface RlmAnalysisResult {
  /** Patterns detected across the input summaries */
  patterns: RlmPattern[];
  /** Summaries that don't fit any detected pattern */
  unpatternedSummaries: RlmSummaryEntry[];
  /** Whether RLM produced a viable compressed representation */
  hasViablePatterns: boolean;
  /** Total estimated token savings */
  totalTokenSavings: number;
  /** Confidence score for the overall analysis */
  overallConfidence: number;
}

/** Options for RLM summarization */
export interface RlmSummarizeOptions {
  /** Previous summary context, if available */
  previousSummary?: string;
  /** Target depth for this condensation */
  depth?: number;
  /** Custom instructions for the RLM */
  customInstructions?: string;
  /** Minimum confidence threshold for this operation */
  patternThreshold?: number;
}

/** Result of RLM-based summarization */
export interface RlmSummarizeResult {
  /** The generated summary content */
  content: string;
  /** Whether RLM patterns were used */
  usedPatterns: boolean;
  /** Patterns that contributed to this summary */
  appliedPatterns?: RlmPattern[];
  /** Fallback was used due to low confidence */
  fallbackToStandard: boolean;
  /** Confidence score for this summary */
  confidence: number;
}

/** RLM summarizer function signature */
export type RlmSummarizeFn = (
  entries: RlmSummaryEntry[],
  options?: RlmSummarizeOptions,
) => Promise<RlmSummarizeResult>;

/** Pattern detection options */
export interface PatternDetectionOptions {
  /** Minimum confidence to consider a pattern valid */
  minConfidence: number;
  /** Maximum number of patterns to detect */
  maxPatterns: number;
  /** Whether to look for temporal progressions */
  detectProgressions: boolean;
  /** Whether to analyze decision evolution */
  detectDecisionEvolution: boolean;
}

/** Metrics for RLM performance tracking */
export interface RlmMetrics {
  /** Number of pattern analyses performed */
  analysesPerformed: number;
  /** Number of patterns detected */
  patternsDetected: number;
  /** Number of times RLM was used for summarization */
  rlmSummariesGenerated: number;
  /** Number of times standard fallback was used */
  fallbackCount: number;
  /** Total token savings achieved */
  totalTokenSavings: number;
  /** Average confidence score */
  averageConfidence: number;
}

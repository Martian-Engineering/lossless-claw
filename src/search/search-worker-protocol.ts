import type { MessageSearchInput, MessageSearchResult } from "../store/conversation-store.js";
import type { SearchOutcome, SearchScanLimits } from "../store/search-scan.js";
import type { SummarySearchInput, SummarySearchResult } from "../store/summary-store.js";

/** Startup data for the search worker's own read-only connection. */
export type SearchWorkerData = {
  databasePath: string;
  fts5Available: boolean;
  searchScanLimits?: Partial<SearchScanLimits>;
};

export type SearchWorkerRequest =
  | { id: number; kind: "messages"; input: MessageSearchInput }
  | { id: number; kind: "summaries"; input: SummarySearchInput };

export type SearchWorkerResponse =
  | {
      id: number;
      ok: true;
      outcome: SearchOutcome<MessageSearchResult> | SearchOutcome<SummarySearchResult>;
    }
  | { id: number; ok: false; error: string };

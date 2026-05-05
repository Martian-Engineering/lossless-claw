import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { registerPrompt } from "../src/synthesis/prompt-registry.js";
import {
  DEFAULT_MODEL_BY_TIER,
  dispatchSynthesis,
  PASS_STRATEGY_BY_TIER,
  SynthesisDispatchError,
  type LlmCall,
} from "../src/synthesis/dispatch.js";

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
  // Ensure conversation + summary so target_summary_id FK is valid in audit
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES ('sum_target', 1, 'condensed', 'placeholder', 1, 'sk1')`,
  ).run();
  return db;
}

function mockLlm(
  outputs: Map<string, string> | ((args: { passKind: string; prompt: string }) => string),
): LlmCall {
  return async (args) => {
    let output: string;
    if (typeof outputs === "function") {
      output = outputs({ passKind: args.passKind, prompt: args.prompt });
    } else {
      const key = `${args.passKind}:${args.prompt.slice(0, 100)}`;
      output = outputs.get(key) ?? `mock-${args.passKind}-output`;
    }
    return {
      output,
      latencyMs: 42,
      costCents: 10,
    };
  };
}

describe("synthesis-dispatch — constants", () => {
  it("DEFAULT_MODEL_BY_TIER covers all tiers", () => {
    expect(DEFAULT_MODEL_BY_TIER.daily).toBeDefined();
    expect(DEFAULT_MODEL_BY_TIER.weekly).toBeDefined();
    expect(DEFAULT_MODEL_BY_TIER.monthly).toBeDefined();
    expect(DEFAULT_MODEL_BY_TIER.yearly).toBeDefined();
    expect(DEFAULT_MODEL_BY_TIER.custom).toBeDefined();
    expect(DEFAULT_MODEL_BY_TIER.filtered).toBeDefined();
  });

  it("PASS_STRATEGY_BY_TIER differs by tier", () => {
    expect(PASS_STRATEGY_BY_TIER.daily).toEqual(["single"]);
    expect(PASS_STRATEGY_BY_TIER.weekly).toEqual(["single"]);
    expect(PASS_STRATEGY_BY_TIER.monthly).toEqual(["single", "verify_fidelity"]);
    expect(PASS_STRATEGY_BY_TIER.yearly).toEqual(["best_of_n_judge"]);
  });
});

describe("synthesis-dispatch — single-pass tiers (daily, weekly)", () => {
  it("daily tier: single LLM call, audit row, no verify", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "daily",
      passKind: "single",
      template: "Daily summary of: {{source_text}}",
    });
    const llm = mockLlm(new Map([["single:Daily summary of: hello world", "the daily summary"]]));
    const result = await dispatchSynthesis(db, llm, {
      tier: "daily",
      memoryType: "episodic-condensed",
      sourceText: "hello world",
      passSessionId: "ps1",
      targetSummaryId: "sum_target",
    });
    expect(result.output).toBe("the daily summary");
    expect(result.auditIds).toHaveLength(1);
    expect(result.totalLatencyMs).toBe(42);
    expect(result.totalCostCents).toBe(10);
    expect(result.hallucinationFlagged).toBeUndefined();
    expect(result.bestOfN).toBeUndefined();

    // Verify audit row
    const audit = db.prepare(`SELECT * FROM lcm_synthesis_audit`).get() as Record<string, unknown>;
    expect(audit.status).toBe("completed");
    expect(audit.pass_kind).toBe("single");
    expect(audit.pass_input_truncated).toBe("hello world");
    expect(audit.target_summary_id).toBe("sum_target");
    db.close();
  });

  it("weekly tier: same as daily, different default model", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "weekly",
      passKind: "single",
      template: "Weekly: {{source_text}}",
    });
    let modelUsed = "";
    const llm: LlmCall = async (args) => {
      modelUsed = args.model;
      return { output: "weekly summary", latencyMs: 50 };
    };
    const result = await dispatchSynthesis(db, llm, {
      tier: "weekly",
      memoryType: "episodic-condensed",
      sourceText: "x",
      passSessionId: "ps2",
      targetSummaryId: "sum_target",
    });
    expect(result.output).toBe("weekly summary");
    expect(modelUsed).toBe(DEFAULT_MODEL_BY_TIER.weekly);
    db.close();
  });
});

describe("synthesis-dispatch — monthly (single + verify_fidelity)", () => {
  it("monthly: runs single + verify; flags hallucination if verify says so", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "monthly",
      passKind: "single",
      template: "Monthly: {{source_text}}",
    });
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "monthly",
      passKind: "verify_fidelity",
      template: "Check {{candidate_summary}} vs {{source_text}}",
    });
    const llm: LlmCall = async (args) => {
      if (args.passKind === "single") {
        return { output: "this might be made up", latencyMs: 50, costCents: 5 };
      }
      // verify_fidelity returns "HALLUCINATION: <details>"
      return {
        output: "HALLUCINATION: 'this might be made up' isn't in source",
        latencyMs: 30,
        costCents: 3,
      };
    };
    const result = await dispatchSynthesis(db, llm, {
      tier: "monthly",
      memoryType: "episodic-condensed",
      sourceText: "actual source",
      passSessionId: "ps3",
      targetSummaryId: "sum_target",
    });
    expect(result.output).toBe("this might be made up");
    expect(result.auditIds).toHaveLength(2);
    expect(result.hallucinationFlagged).toBe(true);
    expect(result.totalCostCents).toBe(8);

    // Verify both audit rows
    const audits = db
      .prepare(`SELECT pass_kind, status FROM lcm_synthesis_audit ORDER BY ran_at`)
      .all() as Array<{ pass_kind: string; status: string }>;
    expect(audits.map((a) => a.pass_kind)).toEqual(["single", "verify_fidelity"]);
    expect(audits.every((a) => a.status === "completed")).toBe(true);
    db.close();
  });

  it("monthly: hallucination flag is FALSE when verify returns OK", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "monthly",
      passKind: "single",
      template: "x",
    });
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "monthly",
      passKind: "verify_fidelity",
      template: "y",
    });
    const llm: LlmCall = async (args) =>
      args.passKind === "single"
        ? { output: "good summary", latencyMs: 10 }
        : { output: "OK", latencyMs: 5 };

    const result = await dispatchSynthesis(db, llm, {
      tier: "monthly",
      memoryType: "episodic-condensed",
      sourceText: "x",
      passSessionId: "ps4",
      targetSummaryId: "sum_target",
    });
    expect(result.hallucinationFlagged).toBe(false);
    db.close();
  });

  it("monthly without verify_fidelity prompt: skips silently, no flag set", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "monthly",
      passKind: "single",
      template: "x",
    });
    // NO verify_fidelity prompt registered
    const llm = mockLlm(new Map());
    const result = await dispatchSynthesis(db, llm, {
      tier: "monthly",
      memoryType: "episodic-condensed",
      sourceText: "x",
      passSessionId: "ps5",
      targetSummaryId: "sum_target",
    });
    expect(result.auditIds).toHaveLength(1); // single only
    expect(result.hallucinationFlagged).toBeUndefined();
    db.close();
  });
});

describe("synthesis-dispatch — yearly (best-of-N + judge)", () => {
  it("yearly: runs N candidates + 1 judge, picks selected", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-yearly",
      tierLabel: "yearly",
      passKind: "single",
      template: "Yearly: {{source_text}}",
    });
    registerPrompt(db, {
      memoryType: "episodic-yearly",
      tierLabel: "yearly",
      passKind: "best_of_n_judge",
      template: "Pick best:\n{{candidates}}",
    });

    let candidateCounter = 0;
    const llm: LlmCall = async (args) => {
      if (args.passKind === "single") {
        const n = candidateCounter++;
        return { output: `candidate ${n}`, latencyMs: 100, costCents: 50 };
      }
      // judge — pick candidate 1
      return { output: "1", latencyMs: 30, costCents: 5 };
    };

    const result = await dispatchSynthesis(db, llm, {
      tier: "yearly",
      memoryType: "episodic-yearly",
      sourceText: "the source",
      passSessionId: "ps6",
      targetSummaryId: "sum_target",
    });

    expect(result.bestOfN).toBeDefined();
    expect(result.bestOfN?.n).toBe(3);
    expect(result.bestOfN?.selectedIndex).toBe(1);
    expect(result.bestOfN?.candidates).toEqual(["candidate 0", "candidate 1", "candidate 2"]);
    expect(result.output).toBe("candidate 1");
    expect(result.auditIds).toHaveLength(4); // 3 candidates + 1 judge
    expect(result.totalCostCents).toBe(155); // 50*3 + 5
    db.close();
  });

  it("yearly with bestOfN=5 (override) runs 5 candidates", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-yearly",
      tierLabel: "yearly",
      passKind: "single",
      template: "x",
    });
    registerPrompt(db, {
      memoryType: "episodic-yearly",
      tierLabel: "yearly",
      passKind: "best_of_n_judge",
      template: "y",
    });

    let counter = 0;
    const llm: LlmCall = async (args) => {
      if (args.passKind === "single") return { output: `c${counter++}`, latencyMs: 1 };
      return { output: "0", latencyMs: 1 };
    };
    const result = await dispatchSynthesis(db, llm, {
      tier: "yearly",
      memoryType: "episodic-yearly",
      sourceText: "x",
      passSessionId: "ps7",
      targetSummaryId: "sum_target",
      bestOfN: 5,
    });
    expect(result.bestOfN?.n).toBe(5);
    expect(result.bestOfN?.candidates).toHaveLength(5);
    expect(result.auditIds).toHaveLength(6); // 5 + judge
    db.close();
  });

  it("yearly: judge_failure thrown when judge output has no digit", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-yearly",
      tierLabel: "yearly",
      passKind: "single",
      template: "x",
    });
    registerPrompt(db, {
      memoryType: "episodic-yearly",
      tierLabel: "yearly",
      passKind: "best_of_n_judge",
      template: "y",
    });
    const llm: LlmCall = async (args) => {
      if (args.passKind === "single") return { output: "candidate", latencyMs: 1 };
      return { output: "I cannot decide", latencyMs: 1 };
    };
    await expect(
      dispatchSynthesis(db, llm, {
        tier: "yearly",
        memoryType: "episodic-yearly",
        sourceText: "x",
        passSessionId: "ps8",
        targetSummaryId: "sum_target",
      }),
    ).rejects.toMatchObject({ name: "SynthesisDispatchError", kind: "judge_failure" });
    db.close();
  });

  it("yearly without best_of_n_judge prompt: throws missing_prompt", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-yearly",
      tierLabel: "yearly",
      passKind: "single",
      template: "x",
    });
    // NO judge prompt registered
    const llm: LlmCall = async () => ({ output: "x", latencyMs: 1 });
    await expect(
      dispatchSynthesis(db, llm, {
        tier: "yearly",
        memoryType: "episodic-yearly",
        sourceText: "x",
        passSessionId: "ps9",
        targetSummaryId: "sum_target",
      }),
    ).rejects.toMatchObject({ name: "SynthesisDispatchError", kind: "missing_prompt" });
    db.close();
  });
});

describe("synthesis-dispatch — error handling", () => {
  it("missing primary prompt throws missing_prompt", async () => {
    const db = setupDb();
    const llm = mockLlm(new Map());
    await expect(
      dispatchSynthesis(db, llm, {
        tier: "daily",
        memoryType: "episodic-condensed",
        sourceText: "x",
        passSessionId: "ps10",
        targetSummaryId: "sum_target",
      }),
    ).rejects.toMatchObject({ name: "SynthesisDispatchError", kind: "missing_prompt" });
    db.close();
  });

  it("LLM call failure throws llm_failure AND records failed audit row", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "daily",
      passKind: "single",
      template: "x",
    });
    const llm: LlmCall = async () => {
      throw new Error("API timeout");
    };
    await expect(
      dispatchSynthesis(db, llm, {
        tier: "daily",
        memoryType: "episodic-condensed",
        sourceText: "x",
        passSessionId: "ps11",
        targetSummaryId: "sum_target",
      }),
    ).rejects.toMatchObject({ name: "SynthesisDispatchError", kind: "llm_failure" });

    const audit = db.prepare(`SELECT status, last_error FROM lcm_synthesis_audit`).get() as {
      status: string;
      last_error: string;
    };
    expect(audit.status).toBe("failed");
    expect(audit.last_error).toContain("API timeout");
    db.close();
  });
});

describe("synthesis-dispatch — model resolution", () => {
  it("prompt's model_recommendation overrides tier default", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "daily",
      passKind: "single",
      template: "x",
      modelRecommendation: "specific-model-for-this-prompt",
    });
    let modelUsed = "";
    const llm: LlmCall = async (args) => {
      modelUsed = args.model;
      return { output: "x", latencyMs: 1 };
    };
    await dispatchSynthesis(db, llm, {
      tier: "daily",
      memoryType: "episodic-condensed",
      sourceText: "x",
      passSessionId: "ps12",
      targetSummaryId: "sum_target",
    });
    expect(modelUsed).toBe("specific-model-for-this-prompt");
    db.close();
  });

  it("forceModel + modelOverride wins over prompt recommendation", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "daily",
      passKind: "single",
      template: "x",
      modelRecommendation: "should-not-be-used",
    });
    let modelUsed = "";
    const llm: LlmCall = async (args) => {
      modelUsed = args.model;
      return { output: "x", latencyMs: 1 };
    };
    await dispatchSynthesis(db, llm, {
      tier: "daily",
      memoryType: "episodic-condensed",
      sourceText: "x",
      passSessionId: "ps13",
      targetSummaryId: "sum_target",
      modelOverride: "force-this",
      forceModel: true,
    });
    expect(modelUsed).toBe("force-this");
    db.close();
  });
});

describe("synthesis-dispatch — template rendering", () => {
  it("substitutes {{source_text}}, {{tier}}, {{memory_type}} in primary template", async () => {
    const db = setupDb();
    registerPrompt(db, {
      memoryType: "episodic-leaf",
      tierLabel: "daily",
      passKind: "single",
      template: "Type={{memory_type}} Tier={{tier}} Src={{source_text}}",
    });
    let renderedPrompt = "";
    const llm: LlmCall = async (args) => {
      renderedPrompt = args.prompt;
      return { output: "x", latencyMs: 1 };
    };
    await dispatchSynthesis(db, llm, {
      tier: "daily",
      memoryType: "episodic-leaf",
      sourceText: "the source",
      passSessionId: "ps14",
      targetSummaryId: "sum_target",
    });
    expect(renderedPrompt).toBe("Type=episodic-leaf Tier=daily Src=the source");
    db.close();
  });
});

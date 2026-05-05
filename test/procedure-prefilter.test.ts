import { describe, expect, it } from "vitest";
import {
  prefilterContent,
  prefilterLeaves,
} from "../src/extraction/procedure-prefilter.js";

describe("procedure-prefilter — numbered-steps signal", () => {
  it("fires on 3+ numbered list items in markdown", () => {
    const r = prefilterContent(`
1. Install dependencies with pnpm install
2. Run pnpm build
3. Restart the gateway
4. Verify with curl
`);
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain("numbered-steps");
  });

  it("fires on 'Step 1:' style sequences", () => {
    const r = prefilterContent(`
Step 1: clone the repo
Step 2: cd into the dir
Step 3: run setup
`);
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain("numbered-steps");
  });

  it("fires on '1)' parenthesis-style", () => {
    const r = prefilterContent(`
1) first thing
2) second thing
3) third thing
`);
    expect(r.signals).toContain("numbered-steps");
  });

  it("does NOT fire on 2 numbered items (need 3+)", () => {
    const r = prefilterContent(`
1. only two items
2. is not enough
some other content
`);
    expect(r.signals).not.toContain("numbered-steps");
  });

  it("does NOT fire on prose with embedded numbers", () => {
    const r = prefilterContent(`
There are 3 things to remember. The first is X. The second is Y.
And the third is Z.
`);
    expect(r.signals).not.toContain("numbered-steps");
  });
});

describe("procedure-prefilter — command-block signal", () => {
  it("fires on $-prompt commands (2+)", () => {
    const r = prefilterContent(`
$ git pull
$ pnpm build
`);
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain("command-block");
  });

  it("fires on fenced shell code block", () => {
    const r = prefilterContent(`
\`\`\`bash
git pull
pnpm install
pnpm build
\`\`\`
`);
    expect(r.signals).toContain("command-block");
  });

  it("fires on common CLI tool invocations at start of line (without prompt)", () => {
    // Tool name MUST be at start of line — "Then npm install" doesn't
    // match because "Then " precedes the tool name. Caller's leaves
    // typically have one command per line in pasted output.
    const r = prefilterContent(`
git pull origin main
npm install
pnpm build
`);
    expect(r.signals).toContain("command-block");
  });

  it("does NOT fire on a single command", () => {
    const r = prefilterContent(`
Run \`npm install\` to set up.
`);
    expect(r.signals).not.toContain("command-block");
  });
});

describe("procedure-prefilter — how-to-marker signal", () => {
  it("fires when 2+ markers present", () => {
    const r = prefilterContent(
      "Here is how to deploy. First, you push the branch. Then, run the pipeline.",
    );
    expect(r.signals).toContain("how-to-marker");
  });

  it("does NOT fire on a single marker (too noisy)", () => {
    const r = prefilterContent("How to fix a bug? Read the code carefully.");
    expect(r.signals).not.toContain("how-to-marker");
  });

  it("fires on 'the procedure for' + 'in order to'", () => {
    const r = prefilterContent(
      "The procedure for deployment is documented. In order to deploy successfully, follow it.",
    );
    expect(r.signals).toContain("how-to-marker");
  });
});

describe("procedure-prefilter — composite scoring", () => {
  it("multiple signals stack up score", () => {
    const r = prefilterContent(`
How to deploy:
1. Run \`git pull\`
2. Run \`pnpm install\`
3. Run \`pnpm build\`
Then, restart the gateway.
`);
    // Should have numbered-steps + command-block + maybe how-to-marker
    expect(r.signals.length).toBeGreaterThanOrEqual(2);
    expect(r.score).toBeGreaterThan(0.4);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it("score is capped at 1.0", () => {
    const r = prefilterContent(`
How to deploy: first, second, finally — in order to set up.
1. Step one
2. Step two
3. Step three
$ git pull
$ npm install
\`\`\`bash
pnpm build
pnpm test
\`\`\`
`);
    expect(r.score).toBeLessThanOrEqual(1);
  });

  it("returns isCandidate=false + score=0 for plain conversation", () => {
    const r = prefilterContent(
      "Yeah, I think we should consider trying the new approach. What do you think?",
    );
    expect(r.isCandidate).toBe(false);
    expect(r.score).toBe(0);
    expect(r.signals).toEqual([]);
  });
});

describe("procedure-prefilter — input edge cases", () => {
  it("empty string returns non-candidate", () => {
    expect(prefilterContent("").isCandidate).toBe(false);
  });
  it("non-string input returns non-candidate", () => {
    expect(prefilterContent(undefined as unknown as string).isCandidate).toBe(false);
    expect(prefilterContent(null as unknown as string).isCandidate).toBe(false);
  });
});

describe("procedure-prefilter — prefilterLeaves batch helper", () => {
  it("filters a list of leaf records to candidates only, preserving extras", () => {
    const leaves = [
      { id: "leaf_a", content: "How to deploy: first, then, finally — 1. step\n2. step\n3. step" },
      { id: "leaf_b", content: "Just a casual conversation between agents." },
      {
        id: "leaf_c",
        content: "1. install\n2. build\n3. deploy",
      },
    ];
    const candidates = prefilterLeaves(leaves);
    expect(candidates.map((c) => c.id).sort()).toEqual(["leaf_a", "leaf_c"]);
    expect(candidates[0].signals).toBeDefined();
    expect(candidates[0].score).toBeGreaterThan(0);
  });
});

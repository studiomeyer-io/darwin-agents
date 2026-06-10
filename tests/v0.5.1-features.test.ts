/**
 * V0.5.1 regression tests (S1235).
 *
 * Three new surfaces:
 *   1. `crowdingDistance` (NSGA-II Deb 2002) — density estimator
 *   2. `paretoSelect` `truncationStrategy: "crowding" | "scalarised"`
 *   3. `GepaOptimizer` constructor `reflectionRunPrompt` override +
 *      `GepaOptimizer.merge(parents, opts)` (Paper Appendix F)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  crowdingDistance,
  paretoSelect,
  type ParetoObjective,
} from "../src/evolution/pareto.js";
import {
  GepaOptimizer,
  type ScoredVariant,
} from "../src/evolution/optimizer-gepa.js";

interface V {
  q: number;
  c: number;
  // Index signature so V satisfies the `Record<string, unknown>` constraint
  // on dominates()/paretoSelect()/crowdingDistance().
  [key: string]: number;
}

const objs: ParetoObjective<V>[] = [
  { key: "q", direction: "maximize" },
  { key: "c", direction: "minimize" },
];

// ---------------------------------------------------------------------------
// V0.5.1 #1 — crowdingDistance (NSGA-II Deb 2002)
// ---------------------------------------------------------------------------

describe("crowdingDistance — boundary semantics", () => {
  it("empty input returns empty array", () => {
    assert.deepEqual(crowdingDistance([], objs), []);
  });

  it("single variant returns [+Infinity]", () => {
    const d = crowdingDistance([{ q: 5, c: 5 }], objs);
    assert.equal(d.length, 1);
    assert.equal(d[0], Number.POSITIVE_INFINITY);
  });

  it("two variants both get +Infinity (both are boundaries)", () => {
    const d = crowdingDistance(
      [
        { q: 10, c: 5 },
        { q: 5, c: 10 },
      ],
      objs,
    );
    assert.deepEqual(d, [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);
  });

  it("no objectives returns all zeros", () => {
    const d = crowdingDistance([{ q: 1, c: 1 }, { q: 2, c: 2 }, { q: 3, c: 3 }], []);
    assert.deepEqual(d, [0, 0, 0]);
  });
});

describe("crowdingDistance — three-variant front", () => {
  it("assigns +Infinity to both extreme variants per objective", () => {
    // Three Pareto-front members spread linearly across both objectives.
    const front: V[] = [
      { q: 1, c: 1 }, // best-on-c boundary
      { q: 5, c: 5 }, // interior
      { q: 9, c: 9 }, // best-on-q boundary
    ];
    const d = crowdingDistance(front, objs);
    // Boundaries on q: indices 0 (lowest q after direction-flip = worst) and 2 (highest q).
    // For minimize-c after direction-flip, boundaries swap to the same indices.
    // All three end up as boundaries in this linear spread.
    assert.equal(d[0], Number.POSITIVE_INFINITY);
    assert.equal(d[2], Number.POSITIVE_INFINITY);
    // Interior (index 1) gets finite normalised distance.
    assert.ok(Number.isFinite(d[1]!), "interior variant has finite CD");
    assert.ok(d[1]! > 0, "interior variant CD > 0");
  });

  it("interior variant receives the sum of normalised gaps across objectives", () => {
    // Build a clean 3-variant spread on a single objective so the math is
    // testable. Add a constant on the second objective so it does not
    // pollute the gap calculation.
    const front: V[] = [
      { q: 0, c: 5 },
      { q: 5, c: 5 }, // interior
      { q: 10, c: 5 },
    ];
    const d = crowdingDistance(front, objs);
    // q-objective: range = 10. Interior gap = (10 - 0) / 10 = 1.
    // c-objective: range = 0 (all equal) → skipped per algorithm.
    // Result: interior CD ≈ 1, boundaries Infinity.
    assert.equal(d[0], Number.POSITIVE_INFINITY);
    assert.equal(d[2], Number.POSITIVE_INFINITY);
    assert.equal(d[1], 1);
  });

  it("handles non-finite objective values defensively (skips that objective)", () => {
    const front: V[] = [
      { q: 0, c: NaN },
      { q: 5, c: 5 },
      { q: 10, c: 5 },
    ];
    const d = crowdingDistance(front, objs);
    // c-objective skipped because one value is NaN.
    // q-objective survives: boundaries get Infinity, interior gets 1.
    assert.equal(d[0], Number.POSITIVE_INFINITY);
    assert.equal(d[1], 1);
    assert.equal(d[2], Number.POSITIVE_INFINITY);
  });

  it("scale-safe — per-objective normalisation handles wide value ranges", () => {
    // q ranges 0-10000 (huge), c ranges 0-1 (tiny). Pre-V0.5.1 scalarised
    // truncation would have q dominate. Crowding-distance should split
    // the load evenly across both objectives.
    const front: V[] = [
      { q: 0, c: 0 },
      { q: 5000, c: 0.5 },
      { q: 10000, c: 1 },
    ];
    const d = crowdingDistance(front, objs);
    // Both objectives: range 10000 / range 1. After normalisation each
    // gap is identical → interior CD ≈ 2 (q-gap 1 + c-gap 1).
    assert.equal(d[0], Number.POSITIVE_INFINITY);
    assert.equal(d[2], Number.POSITIVE_INFINITY);
    assert.equal(d[1], 2);
  });
});

// ---------------------------------------------------------------------------
// V0.5.1 #2 — paretoSelect truncationStrategy
// ---------------------------------------------------------------------------

describe("paretoSelect — truncationStrategy", () => {
  it("default behaviour is 'scalarised' (V0.5.0 backward-compat)", () => {
    const front: V[] = [
      { q: 9, c: 1 }, // high quality + low cost — wins scalarised
      { q: 5, c: 5 },
      { q: 1, c: 9 },
    ];
    const r = paretoSelect(front, objs, 1); // omitted strategy
    // Scalarised: q*1 + (-c)*1. Variant 0 = 9 - 1 = 8 wins.
    assert.equal(r.length, 1);
    assert.deepEqual(r[0], { q: 9, c: 1 });
  });

  it("'crowding' strategy keeps the boundaries of the front", () => {
    // Real Pareto trade-off: q maximize, c minimize — each variant
    // trades higher q for higher c. None dominates any other.
    const front: V[] = [
      { q: 9, c: 9 }, // boundary on q-max
      { q: 5, c: 5 },
      { q: 1, c: 1 }, // boundary on c-min
    ];
    const r = paretoSelect(front, objs, 2, "crowding");
    assert.equal(r.length, 2);
    // Both boundaries (q=9 + q=1) get +Infinity CD → both kept.
    const qs = r.map((x) => x.q).sort((a, b) => a - b);
    assert.deepEqual(qs, [1, 9]);
  });

  it("'crowding' on a front of equal size to maxKeep returns the whole front", () => {
    // Real Pareto trade-off — neither dominates the other.
    const front: V[] = [
      { q: 9, c: 9 },
      { q: 5, c: 5 },
    ];
    const r = paretoSelect(front, objs, 2, "crowding");
    assert.equal(r.length, 2);
  });

  it("'scalarised' explicitly produces the same result as the default", () => {
    const variants: V[] = [
      { q: 10, c: 1 },
      { q: 5, c: 5 },
      { q: 1, c: 10 },
    ];
    const r1 = paretoSelect(variants, objs, 1);
    const r2 = paretoSelect(variants, objs, 1, "scalarised");
    assert.deepEqual(r1, r2);
  });
});

// ---------------------------------------------------------------------------
// V0.5.1 #3 — GepaOptimizer.reflectionRunPrompt + .merge
// ---------------------------------------------------------------------------

describe("GepaOptimizer — reflectionRunPrompt override", () => {
  it("routes reflection calls to reflectionRunPrompt when supplied", async () => {
    const calls: Array<{ source: "main" | "reflection"; prompt: string }> = [];
    const mainRunPrompt = async (p: string): Promise<string> => {
      calls.push({ source: "main", prompt: p });
      return "MAIN_RESPONSE";
    };
    const reflectionRunPrompt = async (p: string): Promise<string> => {
      calls.push({ source: "reflection", prompt: p });
      return "REFLECTION_RESPONSE";
    };
    const opt = new GepaOptimizer(mainRunPrompt, { reflectionRunPrompt });
    await opt.generate("current", [
      { variantId: "v1", score: 0.5, textFeedback: "fb" },
    ], { feedbackStrategy: "single" });
    // Reflection (= generate) should route to reflectionRunPrompt, never main.
    assert.equal(
      calls.filter((c) => c.source === "reflection").length,
      1,
      "exactly one reflection-LM call",
    );
    assert.equal(
      calls.filter((c) => c.source === "main").length,
      0,
      "no main-LM calls for reflection path",
    );
  });

  it("falls back to main runPrompt when reflectionRunPrompt is omitted", async () => {
    const calls: string[] = [];
    const runPrompt = async (p: string): Promise<string> => {
      calls.push(p);
      return "OK";
    };
    const opt = new GepaOptimizer(runPrompt);
    await opt.generate("current", [
      { variantId: "v1", score: 0.5, textFeedback: "fb" },
    ], { feedbackStrategy: "single" });
    assert.equal(calls.length, 1);
  });

  it("throws TypeError when reflectionRunPrompt is supplied but not a function", () => {
    const runPrompt = async () => "x";
    assert.throws(
      () =>
        new GepaOptimizer(runPrompt, {
          reflectionRunPrompt: 42 as unknown as (p: string) => Promise<string>,
        }),
      TypeError,
    );
  });

  it("throws TypeError when main runPrompt is not a function", () => {
    assert.throws(
      () => new GepaOptimizer(undefined as unknown as (p: string) => Promise<string>),
      TypeError,
    );
  });
});

describe("GepaOptimizer.merge — GEPA+Merge Paper Appendix F", () => {
  const mkVariant = (id: string, prompt: string, q = 5): ScoredVariant => ({
    id,
    prompt,
    metrics: { q },
  });

  it("returns a merged variant with a deterministic id", async () => {
    const runPrompt = async () => "MERGED_PROMPT";
    const opt = new GepaOptimizer(runPrompt);
    const merged = await opt.merge([
      mkVariant("a", "instruction A"),
      mkVariant("b", "instruction B"),
    ]);
    assert.equal(merged.prompt, "MERGED_PROMPT");
    assert.equal(merged.id, "gepa-merge-a+b");
  });

  it("preserves literal `{ID_B}` inside a parent prompt (template-injection defense)", async () => {
    let observedMetaPrompt = "";
    const runPrompt = async (p: string): Promise<string> => {
      observedMetaPrompt = p;
      return "RESULT";
    };
    const opt = new GepaOptimizer(runPrompt);
    await opt.merge([
      mkVariant("a", "PROMPT_A contains {ID_B} literally"),
      mkVariant("b", "second prompt"),
    ]);
    assert.ok(
      observedMetaPrompt.includes("{ID_B} literally"),
      "literal {ID_B} inside parent prompt is preserved",
    );
  });

  it("R1 P1 fix — preserves literal `{SCORE_A}` AND `{SCORE_B}` inside parent prompts", async () => {
    // R1 P1 finding (S1235): the original substitution order substituted
    // SCORE before PROMPT, so a parent prompt containing literal
    // `{SCORE_A}` or `{SCORE_B}` was double-substituted with the score
    // float. The fix reorders so PROMPT_A/PROMPT_B substitute FIRST,
    // protecting ALL four metadata placeholders.
    let observedMetaPrompt = "";
    const runPrompt = async (p: string): Promise<string> => {
      observedMetaPrompt = p;
      return "RESULT";
    };
    const opt = new GepaOptimizer(runPrompt);
    await opt.merge([
      mkVariant("a", "Reads {SCORE_A} and {SCORE_B} as literals", 0),
      mkVariant("b", "second", 0),
    ]);
    // Both score placeholders inside the parent prompt must survive
    // un-substituted (the score-template-injection class was the R1 P1).
    assert.ok(
      observedMetaPrompt.includes("{SCORE_A} and {SCORE_B} as literals"),
      "literal {SCORE_A}/{SCORE_B} inside parent prompt is preserved",
    );
    // Sanity: the LEGITIMATE score slots in the template ARE still
    // substituted (parent-A score is "0.00" with q=0, q is non-finite
    // fallback path).
    assert.ok(
      observedMetaPrompt.includes("score 0.00"),
      "legitimate score-slots are still substituted",
    );
  });

  it("R1 fix verify — propagates rejection from reflectionRunPrompt in merge", async () => {
    const main = async () => "MAIN_OK";
    const reflection = async () => {
      throw new Error("reflection rejected");
    };
    const opt = new GepaOptimizer(main, { reflectionRunPrompt: reflection });
    await assert.rejects(
      () =>
        opt.merge([
          { id: "a", prompt: "p1", metrics: { q: 1 } },
          { id: "b", prompt: "p2", metrics: { q: 2 } },
        ]),
      /reflection rejected/,
    );
  });

  it("R1 fix verify — nextGeneration 'scalarised' default matches explicit 'scalarised' on truncation path", () => {
    const opt = new GepaOptimizer(async () => "x");
    // Real Pareto trade-off (3 non-dominated), maxCarry=2 forces truncation.
    const scored: ScoredVariant[] = [
      { id: "a", prompt: "p", metrics: { q: 10, c: 10 } },
      { id: "b", prompt: "p", metrics: { q: 5, c: 5 } },
      { id: "c", prompt: "p", metrics: { q: 1, c: 1 } },
    ];
    const optsBase = {
      objectives: [
        { key: "q" as const, direction: "maximize" as const },
        { key: "c" as const, direction: "minimize" as const },
      ],
      maxCarry: 2,
    };
    const r1 = opt.nextGeneration(scored, optsBase);
    const r2 = opt.nextGeneration(scored, {
      ...optsBase,
      truncationStrategy: "scalarised",
    });
    assert.deepEqual(
      r1.map((s) => s.id).sort(),
      r2.map((s) => s.id).sort(),
      "omitted truncationStrategy is byte-equivalent to explicit 'scalarised' on the truncation path",
    );
  });

  it("throws TypeError when parents are not a 2-tuple", async () => {
    const opt = new GepaOptimizer(async () => "x");
    await assert.rejects(
      // @ts-expect-error intentional bad shape
      () => opt.merge([mkVariant("a", "x")]),
      TypeError,
    );
    await assert.rejects(
      // @ts-expect-error intentional bad shape
      () => opt.merge([mkVariant("a", "x"), mkVariant("b", "y"), mkVariant("c", "z")]),
      TypeError,
    );
  });

  it("throws TypeError when parents share the same id", async () => {
    const opt = new GepaOptimizer(async () => "x");
    await assert.rejects(
      () =>
        opt.merge([
          mkVariant("dup", "prompt A"),
          mkVariant("dup", "prompt B"),
        ]),
      TypeError,
    );
  });

  it("throws TypeError when a parent prompt is empty", async () => {
    const opt = new GepaOptimizer(async () => "x");
    await assert.rejects(
      () =>
        opt.merge([
          mkVariant("a", ""),
          mkVariant("b", "non-empty"),
        ]),
      TypeError,
    );
  });

  it("uses reflectionRunPrompt for the merge call when supplied", async () => {
    const calls: Array<"main" | "reflection"> = [];
    const main = async (): Promise<string> => {
      calls.push("main");
      return "MAIN";
    };
    const reflection = async (): Promise<string> => {
      calls.push("reflection");
      return "REFL_MERGE";
    };
    const opt = new GepaOptimizer(main, { reflectionRunPrompt: reflection });
    const merged = await opt.merge([
      { id: "a", prompt: "promptA", metrics: { q: 1 } },
      { id: "b", prompt: "promptB", metrics: { q: 2 } },
    ]);
    assert.equal(merged.prompt, "REFL_MERGE");
    assert.deepEqual(calls, ["reflection"]);
  });

  it("strips markdown fences from the merged output (defensive)", async () => {
    const runPrompt = async () => "```\nfenced merge\n```";
    const opt = new GepaOptimizer(runPrompt);
    const merged = await opt.merge([
      { id: "a", prompt: "p1", metrics: { q: 1 } },
      { id: "b", prompt: "p2", metrics: { q: 2 } },
    ]);
    assert.equal(merged.prompt, "fenced merge");
  });

  it("caps overly-long merge output at sentence boundary", async () => {
    // Generate a long output; default max = max(longerParent.length * 1.3, 3500).
    // We pass parents with reasonable length so the cap kicks in around 3500.
    const longOutput =
      "Sentence one is here. ".repeat(500) + "Final sentence without period";
    const runPrompt = async () => longOutput;
    const opt = new GepaOptimizer(runPrompt);
    const merged = await opt.merge([
      { id: "a", prompt: "short prompt A", metrics: { q: 1 } },
      { id: "b", prompt: "short prompt B", metrics: { q: 2 } },
    ]);
    // Default cap = max(longerParent.length * 1.3, 3500) = 3500.
    assert.ok(
      merged.prompt.length <= 3500,
      `expected truncation; got length ${merged.prompt.length}`,
    );
  });
});

// ---------------------------------------------------------------------------
// V0.5.1 #4 — nextGeneration truncationStrategy passthrough
// ---------------------------------------------------------------------------

describe("GepaOptimizer.nextGeneration — truncationStrategy passthrough", () => {
  it("forwards 'crowding' to paretoSelect (boundaries preserved)", () => {
    const opt = new GepaOptimizer(async () => "x");
    // Real Pareto trade-off: q maximize, c minimize — higher q comes
    // with higher c. None dominates any other.
    const scored: ScoredVariant[] = [
      { id: "a", prompt: "p", metrics: { q: 10, c: 10 } }, // boundary q-max
      { id: "b", prompt: "p", metrics: { q: 5, c: 5 } }, // interior
      { id: "c", prompt: "p", metrics: { q: 1, c: 1 } }, // boundary c-min
    ];
    const survivors = opt.nextGeneration(scored, {
      objectives: [
        { key: "q", direction: "maximize" },
        { key: "c", direction: "minimize" },
      ],
      maxCarry: 2,
      truncationStrategy: "crowding",
    });
    assert.equal(survivors.length, 2);
    const ids = survivors.map((s) => s.id).sort();
    assert.deepEqual(ids, ["a", "c"]);
  });

  it("default truncationStrategy is 'scalarised' (V0.5.0 backward-compat)", () => {
    const opt = new GepaOptimizer(async () => "x");
    // Variant a dominates b and c (q max, c min) so the Pareto front is
    // just [a]. scalarised vs crowding behave identically when there is
    // no truncation choice to make — this asserts the default path.
    const scored: ScoredVariant[] = [
      { id: "a", prompt: "p", metrics: { q: 10, c: 1 } },
      { id: "b", prompt: "p", metrics: { q: 5, c: 5 } },
      { id: "c", prompt: "p", metrics: { q: 1, c: 10 } },
    ];
    const survivors = opt.nextGeneration(scored, {
      objectives: [
        { key: "q", direction: "maximize" },
        { key: "c", direction: "minimize" },
      ],
      maxCarry: 1,
    });
    assert.equal(survivors.length, 1);
    // scalarised: q*1 + (-c)*1. Variant a = 10 - 1 = 9 wins.
    assert.equal(survivors[0]?.id, "a");
  });
});

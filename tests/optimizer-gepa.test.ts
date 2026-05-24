/**
 * Tests for GepaOptimizer (Phase 2 A2, S1185).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  GepaOptimizer,
  type ScoredVariant,
} from "../src/evolution/optimizer-gepa.js";
import type { ReflectiveFeedback, RunPromptFn } from "../src/evolution/reflector.js";
import type { ParetoObjective } from "../src/evolution/pareto.js";

const objectives: ReadonlyArray<ParetoObjective<Record<string, number>>> = [
  { key: "quality", direction: "maximize" },
  { key: "cost", direction: "minimize" },
];

const mkFb = (id: string, score: number, fb: string): ReflectiveFeedback => ({
  variantId: id,
  score,
  textFeedback: fb,
});

describe("GepaOptimizer.generate — strategies", () => {
  it("default split strategy: N variants from N partitioned reflections", async () => {
    let calls = 0;
    const runPrompt: RunPromptFn = async (p) => {
      calls++;
      return `mutated[${p.slice(-3)}]`;
    };
    const opt = new GepaOptimizer(runPrompt);
    const result = await opt.generate(
      "current prompt",
      [mkFb("v1", 0.8, "fb1"), mkFb("v2", 0.6, "fb2"), mkFb("v3", 0.5, "fb3")],
      { numVariants: 3 },
    );
    assert.equal(result.length, 3);
    assert.equal(result[0]!.id, "gepa-cand-0");
    assert.equal(result[1]!.id, "gepa-cand-1");
    assert.equal(result[2]!.id, "gepa-cand-2");
    assert.equal(calls, 3);
  });

  it("clamps numVariants to upper bound 10", async () => {
    let calls = 0;
    const runPrompt: RunPromptFn = async () => {
      calls++;
      return "mut";
    };
    const opt = new GepaOptimizer(runPrompt);
    await opt.generate("p", [mkFb("v", 1, "fb")], { numVariants: 100 });
    assert.equal(calls, 10);
  });

  it("clamps numVariants to lower bound 1", async () => {
    let calls = 0;
    const runPrompt: RunPromptFn = async () => {
      calls++;
      return "mut";
    };
    const opt = new GepaOptimizer(runPrompt);
    await opt.generate("p", [mkFb("v", 1, "fb")], { numVariants: 0 });
    assert.equal(calls, 1);
  });

  it("falls back to default 3 when numVariants is NaN", async () => {
    let calls = 0;
    const runPrompt: RunPromptFn = async () => {
      calls++;
      return "mut";
    };
    const opt = new GepaOptimizer(runPrompt);
    await opt.generate("p", [mkFb("v", 1, "fb")], { numVariants: NaN });
    assert.equal(calls, 3);
  });

  it("single strategy: 1 reflection regardless of N", async () => {
    let calls = 0;
    const runPrompt: RunPromptFn = async () => {
      calls++;
      return "mut";
    };
    const opt = new GepaOptimizer(runPrompt);
    const result = await opt.generate("p", [mkFb("v1", 1, "fb")], {
      numVariants: 5,
      feedbackStrategy: "single",
    });
    assert.equal(result.length, 1);
    assert.equal(calls, 1);
  });

  it("replicate strategy: every variant sees all feedbacks", async () => {
    const captured: string[] = [];
    const runPrompt: RunPromptFn = async (metaPrompt) => {
      captured.push(metaPrompt);
      return "mut";
    };
    const opt = new GepaOptimizer(runPrompt);
    await opt.generate(
      "p",
      [mkFb("v1", 1, "fb-A"), mkFb("v2", 1, "fb-B")],
      { numVariants: 3, feedbackStrategy: "replicate" },
    );
    assert.equal(captured.length, 3);
    for (const meta of captured) {
      assert.ok(meta.includes("fb-A"));
      assert.ok(meta.includes("fb-B"));
    }
  });

  it("split strategy with empty bucket falls back to full feedback set", async () => {
    const captured: string[] = [];
    const runPrompt: RunPromptFn = async (m) => {
      captured.push(m);
      return "mut";
    };
    const opt = new GepaOptimizer(runPrompt);
    await opt.generate(
      "p",
      [mkFb("v1", 1, "fb-A"), mkFb("v2", 1, "fb-B")],
      { numVariants: 3, feedbackStrategy: "split" },
    );
    assert.equal(captured.length, 3);
    const fullMetas = captured.filter((m) => m.includes("fb-A") && m.includes("fb-B"));
    assert.ok(fullMetas.length >= 1);
  });

  it("with 0 feedbacks rejects (Reflector validation)", async () => {
    const runPrompt: RunPromptFn = async () => "mut";
    const opt = new GepaOptimizer(runPrompt);
    await assert.rejects(opt.generate("p", [], { feedbackStrategy: "split" }), TypeError);
  });
});

describe("GepaOptimizer.nextGeneration — Pareto-selection of survivors", () => {
  it("keeps non-dominated variants", () => {
    const opt = new GepaOptimizer(async () => "noop");
    const scored: ScoredVariant[] = [
      { id: "a", prompt: "pa", metrics: { quality: 10, cost: 8 } },
      { id: "b", prompt: "pb", metrics: { quality: 8, cost: 6 } },
      { id: "c", prompt: "pc", metrics: { quality: 6, cost: 7 } },
      { id: "d", prompt: "pd", metrics: { quality: 3, cost: 3 } },
    ];
    const survivors = opt.nextGeneration(scored, { objectives });
    assert.deepEqual(survivors.map((s) => s.id).sort(), ["a", "b", "d"]);
  });

  it("truncates to maxCarry by scalarised score", () => {
    const opt = new GepaOptimizer(async () => "noop");
    const scored: ScoredVariant[] = [
      { id: "a", prompt: "pa", metrics: { quality: 10, cost: 8 } },
      { id: "b", prompt: "pb", metrics: { quality: 8, cost: 6 } },
      { id: "c", prompt: "pc", metrics: { quality: 3, cost: 3 } },
    ];
    const survivors = opt.nextGeneration(scored, { objectives, maxCarry: 1 });
    assert.equal(survivors.length, 1);
    assert.ok(["a", "b"].includes(survivors[0]!.id));
  });

  it("throws if objectives missing", () => {
    const opt = new GepaOptimizer(async () => "noop");
    assert.throws(
      () =>
        opt.nextGeneration([{ id: "a", prompt: "p", metrics: { q: 1 } }], {
          objectives: [],
        }),
      TypeError,
    );
  });

  it("identity-comparison on metrics references avoids id collisions", () => {
    const opt = new GepaOptimizer(async () => "noop");
    const metricsA = { quality: 5, cost: 5 };
    const metricsB = { quality: 5, cost: 5 };
    const survivors = opt.nextGeneration(
      [
        { id: "a", prompt: "pa", metrics: metricsA },
        { id: "b", prompt: "pb", metrics: metricsB },
      ],
      { objectives },
    );
    assert.equal(survivors.length, 2);
    assert.deepEqual(survivors.map((s) => s.id).sort(), ["a", "b"]);
  });
});

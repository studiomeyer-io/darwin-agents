/**
 * Tests for the Pareto-front helpers (Phase 2 A2, S1185).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dominates,
  dominatesEpsilon,
  nonDominatedFront,
  paretoSelect,
  scalarise,
  coverageFrontier,
  coverageWeights,
  selectByCoverage,
  sampleByCoverage,
  type ParetoObjective,
  type CoverageScores,
} from "../src/evolution/pareto.js";

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

describe("dominates", () => {
  it("higher quality + same cost → dominates", () => {
    assert.equal(dominates({ q: 10, c: 5 }, { q: 5, c: 5 }, objs), true);
  });

  it("same quality + lower cost → dominates", () => {
    assert.equal(dominates({ q: 5, c: 3 }, { q: 5, c: 7 }, objs), true);
  });

  it("strictly better on all objectives → dominates", () => {
    assert.equal(dominates({ q: 10, c: 1 }, { q: 5, c: 5 }, objs), true);
  });

  it("equal on all objectives → does NOT dominate (no strict win)", () => {
    assert.equal(dominates({ q: 5, c: 5 }, { q: 5, c: 5 }, objs), false);
  });

  it("trade-off (better q, worse c) → does NOT dominate", () => {
    assert.equal(dominates({ q: 10, c: 8 }, { q: 5, c: 5 }, objs), false);
    assert.equal(dominates({ q: 5, c: 5 }, { q: 10, c: 8 }, objs), false);
  });

  it("empty objectives → no dominance", () => {
    assert.equal(dominates({ q: 10, c: 1 }, { q: 5, c: 5 }, []), false);
  });

  it("NaN/Infinity values → not comparable (false)", () => {
    assert.equal(dominates({ q: NaN, c: 5 }, { q: 5, c: 5 }, objs), false);
    assert.equal(dominates({ q: 10, c: Infinity }, { q: 5, c: 5 }, objs), false);
  });

  it("non-number values → false", () => {
    assert.equal(
      dominates(
        { q: "high" as unknown as number, c: 5 },
        { q: 5, c: 5 },
        objs,
      ),
      false,
    );
  });
});

describe("nonDominatedFront", () => {
  it("returns front of trade-off variants", () => {
    const variants: V[] = [
      { q: 10, c: 8 },
      { q: 8, c: 6 },
      { q: 5, c: 5 },
      { q: 6, c: 7 },
      { q: 3, c: 3 },
    ];
    const front = nonDominatedFront(variants, objs);
    assert.deepEqual(front, [
      { q: 10, c: 8 },
      { q: 8, c: 6 },
      { q: 5, c: 5 },
      { q: 3, c: 3 },
    ]);
  });

  it("single variant always in front", () => {
    assert.deepEqual(nonDominatedFront([{ q: 5, c: 5 }], objs), [{ q: 5, c: 5 }]);
  });

  it("empty → empty", () => {
    assert.deepEqual(nonDominatedFront([], objs), []);
  });

  it("all identical → all kept (no strict dominance)", () => {
    const v = [{ q: 5, c: 5 }, { q: 5, c: 5 }, { q: 5, c: 5 }];
    assert.deepEqual(nonDominatedFront(v, objs), v);
  });

  it("with empty objectives keeps all variants", () => {
    const v = [{ q: 1, c: 1 }, { q: 2, c: 2 }];
    assert.deepEqual(nonDominatedFront(v, []), v);
  });
});

describe("scalarise + paretoSelect", () => {
  it("scalarise applies direction + weight correctly", () => {
    const value = scalarise({ q: 10, c: 5 }, [
      { key: "q", direction: "maximize", weight: 2 },
      { key: "c", direction: "minimize", weight: 1 },
    ]);
    assert.equal(value, 15);
  });

  it("scalarise ignores non-finite values defensively", () => {
    assert.equal(scalarise({ q: NaN, c: 5 }, objs), -5);
  });

  it("paretoSelect returns front when no maxKeep", () => {
    const variants: V[] = [{ q: 10, c: 8 }, { q: 5, c: 5 }, { q: 3, c: 3 }];
    assert.deepEqual(paretoSelect(variants, objs), variants);
  });

  it("paretoSelect truncates front to maxKeep by scalarised score", () => {
    const variants: V[] = [
      { q: 10, c: 8 },
      { q: 5, c: 5 },
      { q: 3, c: 3 },
    ];
    const top1 = paretoSelect(variants, objs, 1);
    assert.equal(top1.length, 1);
    assert.deepEqual(top1[0], { q: 10, c: 8 });
  });

  it("paretoSelect returns full front when maxKeep > front size", () => {
    const variants: V[] = [{ q: 10, c: 8 }, { q: 5, c: 9 }];
    assert.deepEqual(paretoSelect(variants, objs, 5), [{ q: 10, c: 8 }]);
  });
});

// ─── v0.7.0 — ε-dominance ───────────────────────────

describe('dominatesEpsilon (v0.7.0)', () => {
  const obj: ParetoObjective<{ quality: number; duration: number }>[] = [
    { key: 'quality', direction: 'maximize' },
    { key: 'duration', direction: 'minimize' },
  ];

  it('with epsilon=0 behaves exactly like strict dominates', () => {
    const a = { quality: 9, duration: 100 };
    const b = { quality: 8, duration: 120 };
    assert.equal(dominatesEpsilon(a, b, obj, 0), dominates(a, b, obj));
    const c = { quality: 9, duration: 120 }; // c better quality, worse duration vs a
    assert.equal(dominatesEpsilon(c, a, obj, 0), dominates(c, a, obj));
  });

  it('accepts a challenger with a tiny (within-ε) regression + a real gain', () => {
    // B: +12% quality (8→9) but 0.3% slower (100→100.3ms). Strict rejects, ε=2% accepts.
    const a = { quality: 8, duration: 100 };
    const b = { quality: 9, duration: 100.3 };
    assert.equal(dominates(b, a, obj), false); // strict: B regressed on duration
    assert.equal(dominatesEpsilon(b, a, obj, 0.02), true); // ε: forgiven
  });

  it('still rejects a challenger whose regression exceeds ε', () => {
    const a = { quality: 8, duration: 100 };
    const b = { quality: 9, duration: 140 }; // 40% slower — well beyond 2%
    assert.equal(dominatesEpsilon(b, a, obj, 0.02), false);
  });

  it('requires strict improvement on at least one objective', () => {
    const a = { quality: 8, duration: 100 };
    const b = { quality: 8, duration: 100 }; // identical → no improvement
    assert.equal(dominatesEpsilon(b, a, obj, 0.05), false);
  });

  it('a within-ε "gain" does NOT count as domination (symmetric ε)', () => {
    // B is 0.05 better on quality but ε=0.05 → tolerance band is 0.05·8=0.4,
    // so +0.05 is within noise, not a real win. No regression elsewhere, but
    // also no win beyond the band → B does not ε-dominate A.
    const a = { quality: 8, duration: 100 };
    const b = { quality: 8.05, duration: 100 };
    assert.equal(dominatesEpsilon(b, a, obj, 0.05), false);
    // A clearly-beyond-band gain DOES count.
    const c = { quality: 9, duration: 100 };
    assert.equal(dominatesEpsilon(c, a, obj, 0.05), true);
  });

  it('is scale-safe across mixed-unit objectives', () => {
    // duration in ms (large magnitude) vs quality (0-10). ε tolerance scales
    // per objective, so a 1ms regression on a 5000ms baseline is within 2%.
    const a = { quality: 7, duration: 5000 };
    const b = { quality: 8, duration: 5050 }; // +1 quality, +1% duration
    assert.equal(dominatesEpsilon(b, a, obj, 0.02), true);
  });

  it('clamps negative/NaN epsilon to 0 (strict)', () => {
    const a = { quality: 8, duration: 100 };
    const b = { quality: 9, duration: 100.3 };
    assert.equal(dominatesEpsilon(b, a, obj, -5), false);
    assert.equal(dominatesEpsilon(b, a, obj, NaN), false);
  });

  it('returns false on non-finite values (defensive, like dominates)', () => {
    const a = { quality: NaN, duration: 100 };
    const b = { quality: 9, duration: 90 };
    assert.equal(dominatesEpsilon(b, a, obj, 0.1), false);
  });

  it('returns false with no objectives', () => {
    assert.equal(dominatesEpsilon({ quality: 9 }, { quality: 8 }, [], 0.1), false);
  });
});

// ─── v0.7.0 — instance-wise coverage sampling (GEPA Algorithm 2) ─────

describe('coverageFrontier / coverageWeights (v0.7.0)', () => {
  // Three variants over three keys (validation examples k1,k2,k3):
  //   A best on k1,k2 ; B best on k3 ; C best on nothing.
  const scores = [
    { k1: 0.9, k2: 0.8, k3: 0.2 }, // A
    { k1: 0.5, k2: 0.4, k3: 0.95 }, // B
    { k1: 0.6, k2: 0.5, k3: 0.5 }, // C
  ];

  it('frontier maps each key to its best-in-class variant set', () => {
    const f = coverageFrontier(scores);
    assert.deepEqual([...f.get('k1')!], [0]);
    assert.deepEqual([...f.get('k2')!], [0]);
    assert.deepEqual([...f.get('k3')!], [1]);
  });

  it('weights count keys won (A=2, B=1, C=0)', () => {
    const w = coverageWeights(scores);
    assert.equal(w[0], 2);
    assert.equal(w[1], 1);
    assert.equal(w[2], 0);
  });

  it('ties split credit fractionally', () => {
    const tied = [
      { k1: 0.9, k2: 0.5 },
      { k1: 0.9, k2: 0.5 },
    ];
    const w = coverageWeights(tied);
    // both keys tied 2-way → each variant gets 0.5+0.5 = 1
    assert.equal(w[0], 1);
    assert.equal(w[1], 1);
  });

  it('handles missing keys as never-best', () => {
    const sparse: CoverageScores = [{ k1: 0.9 }, { k2: 0.9 }];
    const w = coverageWeights(sparse);
    assert.equal(w[0], 1); // wins k1
    assert.equal(w[1], 1); // wins k2
  });

  it('ignores non-finite scores', () => {
    const f = coverageFrontier([{ k1: NaN }, { k1: 0.5 }]);
    assert.deepEqual([...f.get('k1')!], [1]);
  });
});

describe('selectByCoverage (v0.7.0)', () => {
  const variants = ['A', 'B', 'C'];
  const scores = [
    { k1: 0.9, k2: 0.8, k3: 0.2 }, // A wins k1,k2
    { k1: 0.5, k2: 0.4, k3: 0.95 }, // B wins k3
    { k1: 0.6, k2: 0.5, k3: 0.5 }, // C wins nothing
  ];

  it('keeps the broadest-coverage variants first', () => {
    const kept = selectByCoverage(variants, scores, 2);
    assert.deepEqual(kept, ['A', 'B']); // A(2 keys) + B(1 key), C(0) dropped
  });

  it('returns all when maxKeep >= n', () => {
    assert.deepEqual(selectByCoverage(variants, scores, 5), variants);
  });

  it('returns [] for maxKeep <= 0', () => {
    assert.deepEqual(selectByCoverage(variants, scores, 0), []);
  });

  it('preserves diversity over the aggregate winner', () => {
    // C has the best AVERAGE-ish but wins no single key; coverage drops it.
    const kept = selectByCoverage(variants, scores, 1);
    assert.deepEqual(kept, ['A']); // broadest coverage, not the averager C
  });
});

describe('sampleByCoverage (v0.7.0)', () => {
  const scores = [
    { k1: 0.9, k2: 0.9, k3: 0.9, k4: 0.9 }, // weight 4
    { k1: 0.1, k2: 0.1, k3: 0.1, k4: 0.1 }, // weight 0
  ];

  it('samples proportional to coverage weight (heavy variant for mid draw)', () => {
    // total weight = 4, all on variant 0 → any draw lands on 0
    assert.equal(sampleByCoverage(scores, () => 0.5), 0);
    assert.equal(sampleByCoverage(scores, () => 0.99), 0);
  });

  it('falls back to uniform when no coverage signal', () => {
    const flat = [{ k1: 0.5 }, { k1: 0.5 }]; // tie → fractional, but try all-zero case
    const allZero = [{}, {}, {}];
    assert.equal(sampleByCoverage(allZero, () => 0.0), 0);
    assert.equal(sampleByCoverage(allZero, () => 0.99), 2);
    assert.ok([0, 1].includes(sampleByCoverage(flat, () => 0.4)));
  });

  it('clamps a misbehaving rng', () => {
    assert.equal(sampleByCoverage(scores, () => NaN), 0);
    assert.equal(sampleByCoverage(scores, () => 5), 0);
  });

  it('returns -1 for empty input', () => {
    assert.equal(sampleByCoverage([], () => 0.5), -1);
  });
});

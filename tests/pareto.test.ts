/**
 * Tests for the Pareto-front helpers (Phase 2 A2, S1185).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  dominates,
  nonDominatedFront,
  paretoSelect,
  scalarise,
  type ParetoObjective,
} from "../src/evolution/pareto.js";

interface V {
  q: number;
  c: number;
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

/**
 * Darwin — Pareto-Front Selection (Phase 2 A2, S1185 follow-up).
 *
 * Pure functions for multi-objective optimization in the GEPA-style
 * reflective optimizer. The classic Pareto definition:
 *
 *   A "dominates" B iff:
 *     - For ALL objectives O: A[O] is at least as good as B[O].
 *     - For at LEAST ONE objective O: A[O] is strictly better than B[O].
 *
 *   A "non-dominated" variant is one that is not dominated by any other.
 *   The non-dominated set is the Pareto front.
 *
 * This module is **pure** — no LLM calls, no I/O, no Date.now(). Tests
 * are fully deterministic.
 *
 * Reference: GEPA (Genetic-Pareto) reflective optimizer
 * https://gepa-ai.github.io/gepa/ — Pareto-efficient search over text
 * components with LLM-guided reflection.
 */

/**
 * One objective in a multi-objective Pareto comparison.
 *
 * @example
 *   import type { DarwinMetrics } from "darwin-agents";
 *   const objectives: ParetoObjective<DarwinMetrics>[] = [
 *     { key: "qualityScore", direction: "maximize" },
 *     { key: "sourceCount",  direction: "maximize" },
 *     { key: "durationMs",   direction: "minimize" },
 *     { key: "outputLength", direction: "maximize" },
 *   ];
 *
 * Or use the pre-built {@link DARWIN_DEFAULT_OBJECTIVES} constant.
 */
export interface ParetoObjective<T> {
  /** Field on the variant to compare. Must hold a finite number. */
  key: keyof T;
  /**
   * `"maximize"` if higher = better (qualityScore, sourceCount).
   * `"minimize"` if lower = better (durationMs, cost).
   */
  direction: "maximize" | "minimize";
  /**
   * Optional weight for tie-breaking scalarisation only — does NOT
   * affect strict Pareto dominance. Default 1.
   *
   * **Scale warning (S1185 R1 Critic Finding M4):** weights operate on
   * the raw objective values. If your objectives have very different
   * scales (e.g. cost in dollars 0-10000 vs success-rate 0-1), the
   * larger-scale objective dominates the scalarised sum regardless of
   * weight. Pre-normalise your objectives to comparable ranges before
   * relying on {@link paretoSelect}'s truncation step. Strict
   * dominance ({@link dominates}, {@link nonDominatedFront}) is
   * unaffected — per-dimension comparison handles scale correctly.
   */
  weight?: number;
}

/**
 * Pre-built objective set matching `DarwinMetrics` field names.
 *
 * Drop-in default for `paretoSelect`/`GepaOptimizer.nextGeneration`
 * when you optimise the standard Darwin metrics. Note that
 * `outputLength` is direction `"maximize"` because Darwin uses output
 * length as a proxy for completeness/depth in its existing weight
 * scheme — if your domain treats long outputs as worse, override the
 * direction in a custom array.
 */
export const DARWIN_DEFAULT_OBJECTIVES: ReadonlyArray<ParetoObjective<{
  qualityScore: number;
  sourceCount: number;
  durationMs: number;
  outputLength: number;
}>> = [
  { key: "qualityScore", direction: "maximize", weight: 0.5 },
  { key: "sourceCount", direction: "maximize", weight: 0.15 },
  { key: "outputLength", direction: "maximize", weight: 0.1 },
  { key: "durationMs", direction: "minimize", weight: 0.25 },
];

/**
 * True iff `a` Pareto-dominates `b` over the given objectives.
 *
 * Returns false if either side has a non-finite value for any objective
 * (NaN/Infinity are treated as "not comparable" — defensive against
 * malformed variants poisoning the front).
 */
export function dominates<T extends Record<string, unknown>>(
  a: T,
  b: T,
  objectives: ReadonlyArray<ParetoObjective<T>>,
): boolean {
  if (objectives.length === 0) return false;
  let strictlyBetterSomewhere = false;
  for (const obj of objectives) {
    const av = a[obj.key];
    const bv = b[obj.key];
    if (typeof av !== "number" || typeof bv !== "number") return false;
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return false;
    // Normalise direction so "better" is always ">" in comparison.
    const aNorm = obj.direction === "maximize" ? av : -av;
    const bNorm = obj.direction === "maximize" ? bv : -bv;
    if (aNorm < bNorm) return false; // a is worse on this objective → not dominating
    if (aNorm > bNorm) strictlyBetterSomewhere = true;
  }
  return strictlyBetterSomewhere;
}

/**
 * Return the subset of `variants` that are NOT dominated by any other
 * variant in the set. This is the Pareto front.
 *
 * Empty input → empty output. Single variant → that variant. Naive
 * O(N²) implementation which is fine for the N≤20 variant pools the
 * GEPA optimizer works with.
 *
 * Duplicates (identical objective vectors) are all kept — no variant
 * dominates an identical one (strictlyBetterSomewhere stays false).
 */
export function nonDominatedFront<T extends Record<string, unknown>>(
  variants: ReadonlyArray<T>,
  objectives: ReadonlyArray<ParetoObjective<T>>,
): T[] {
  if (variants.length === 0) return [];
  if (objectives.length === 0) {
    // Without objectives no variant dominates any other — keep all.
    return [...variants];
  }
  const result: T[] = [];
  for (let i = 0; i < variants.length; i++) {
    const candidate = variants[i]!;
    let dominated = false;
    for (let j = 0; j < variants.length; j++) {
      if (i === j) continue;
      if (dominates(variants[j]!, candidate, objectives)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) result.push(candidate);
  }
  return result;
}

/**
 * Scalarise a variant to a single number for tie-breaking. Sum of
 * normalised direction-adjusted values × weight. NOT used for strict
 * Pareto dominance — only when a fixed-size pick is needed after the
 * front is identified (e.g. carrying 3 best forward to next GEPA
 * generation).
 *
 * Non-finite values contribute 0 (defensive).
 */
export function scalarise<T extends Record<string, unknown>>(
  variant: T,
  objectives: ReadonlyArray<ParetoObjective<T>>,
): number {
  let total = 0;
  for (const obj of objectives) {
    const v = variant[obj.key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const weight = obj.weight ?? 1;
    const directionAdjusted = obj.direction === "maximize" ? v : -v;
    total += directionAdjusted * weight;
  }
  return total;
}

/**
 * Pareto-select up to `maxKeep` variants:
 *   1. Compute non-dominated front.
 *   2. If front size ≤ maxKeep: return front.
 *   3. If front size > maxKeep: sort by scalarised score (descending),
 *      keep top maxKeep.
 *
 * Use this when the GEPA generation budget is fixed (e.g. carry exactly
 * 3 variants to the next round) but the Pareto front happens to be
 * larger.
 */
export function paretoSelect<T extends Record<string, unknown>>(
  variants: ReadonlyArray<T>,
  objectives: ReadonlyArray<ParetoObjective<T>>,
  maxKeep?: number,
): T[] {
  const front = nonDominatedFront(variants, objectives);
  if (typeof maxKeep !== "number" || front.length <= maxKeep) return front;
  return [...front]
    .sort((a, b) => scalarise(b, objectives) - scalarise(a, objectives))
    .slice(0, maxKeep);
}

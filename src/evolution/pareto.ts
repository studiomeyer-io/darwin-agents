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
 *   3. If front size > maxKeep: truncate via the configured strategy
 *      (default `"scalarised"` — weighted-sum tie-break).
 *
 * Use this when the GEPA generation budget is fixed (e.g. carry exactly
 * 3 variants to the next round) but the Pareto front happens to be
 * larger.
 *
 * V0.5.1 (S1235) — `truncationStrategy` opens up two new modes that
 * close R1 Research deferrals from V0.5.0-alpha.2:
 *   - `"scalarised"` (default, V0.5.0 behaviour): weighted-sum tie-break.
 *     Scale-sensitive — pre-normalise objectives if their value ranges
 *     differ (see `ParetoObjective.weight` docstring).
 *   - `"crowding"` (NSGA-II Deb 2002): density-estimator that favours
 *     variants in sparsely-populated regions of the front. Per-objective
 *     min-max normalisation makes it scale-safe. Boundary variants
 *     always survive (assigned Infinity). Recommended for diversity-
 *     critical workloads.

 * GEPA Algorithm 2's instance-proportional coverage sampling is the
 * third paper strategy and is NOT implemented in V0.5.1 — the caller-
 * side coverage data needed to drive it varies enough across domains
 * that a one-size-fits-all signature would mislead. Backlog for V0.6.
 */
export type ParetoTruncationStrategy = "scalarised" | "crowding";

export function paretoSelect<T extends Record<string, unknown>>(
  variants: ReadonlyArray<T>,
  objectives: ReadonlyArray<ParetoObjective<T>>,
  maxKeep?: number,
  truncationStrategy: ParetoTruncationStrategy = "scalarised",
): T[] {
  const front = nonDominatedFront(variants, objectives);
  if (typeof maxKeep !== "number" || front.length <= maxKeep) return front;
  if (truncationStrategy === "crowding") {
    // NSGA-II crowding-distance truncation (Deb et al. 2002, IEEE TEVC).
    // Per-objective min-max normalisation makes this scale-safe — the
    // tie-break does NOT inherit `scalarise`'s scale-sensitivity.
    const distances = crowdingDistance(front, objectives);
    return [...front]
      .map((v, i) => ({ v, cd: distances[i]! }))
      .sort((a, b) => b.cd - a.cd)
      .slice(0, maxKeep)
      .map((x) => x.v);
  }
  // Default "scalarised" — preserves V0.5.0 behaviour exactly.
  return [...front]
    .sort((a, b) => scalarise(b, objectives) - scalarise(a, objectives))
    .slice(0, maxKeep);
}

/**
 * Compute the NSGA-II crowding distance for each variant in a
 * non-dominated front. Returns an array of the same length as
 * `variants`, indexed in input order.
 *
 * The classic Deb 2002 algorithm:
 *   1. For each objective `m`: sort the front by `m`.
 *   2. Boundary variants (lowest + highest `m`) get distance `+Infinity`
 *      so they always survive truncation.
 *   3. Interior variants get the normalised gap between neighbours:
 *      `(f_m(x_{i+1}) - f_m(x_{i-1})) / (f_m_max - f_m_min)`
 *   4. Sum across objectives.
 *
 * **Pure**, no I/O, deterministic. Safe to call from the hot path of
 * paretoSelect. Returns `0` for any variant whose objective is non-finite
 * — never returns NaN.
 *
 * NEW V0.5.1 (S1235).
 *
 * @example
 * ```ts
 * import { crowdingDistance, DARWIN_DEFAULT_OBJECTIVES } from "darwin-agents";
 *
 * const front = [
 *   { id: "a", qualityScore: 8, sourceCount: 3, durationMs: 100, outputLength: 500 },
 *   { id: "b", qualityScore: 9, sourceCount: 2, durationMs: 200, outputLength: 400 },
 *   { id: "c", qualityScore: 7, sourceCount: 4, durationMs: 150, outputLength: 600 },
 * ];
 * const distances = crowdingDistance(front, DARWIN_DEFAULT_OBJECTIVES);
 * // distances[i] = sum of per-objective normalised neighbour gaps for variant i
 * ```
 */
export function crowdingDistance<T extends Record<string, unknown>>(
  variants: ReadonlyArray<T>,
  objectives: ReadonlyArray<ParetoObjective<T>>,
): number[] {
  const n = variants.length;
  if (n === 0) return [];
  if (n === 1) return [Number.POSITIVE_INFINITY];
  if (n === 2) {
    // Both are boundaries on every objective — assign Infinity to both
    // so truncation does not pick arbitrarily.
    return [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  }
  if (objectives.length === 0) return Array(n).fill(0);

  const distances: number[] = Array(n).fill(0);

  for (const obj of objectives) {
    // Build [origIndex, value] pairs so we can sort without losing the
    // mapping back to the input order.
    const indexed: Array<{ i: number; v: number }> = [];
    let allFinite = true;
    for (let i = 0; i < n; i++) {
      const raw = variants[i]![obj.key];
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        allFinite = false;
        break;
      }
      // Direction-normalise so "better" is always larger — keeps the
      // boundary assignment symmetric for maximize / minimize.
      indexed.push({ i, v: obj.direction === "maximize" ? raw : -raw });
    }
    if (!allFinite) continue; // Skip objectives with non-finite values.

    indexed.sort((a, b) => a.v - b.v);
    const min = indexed[0]!.v;
    const max = indexed[n - 1]!.v;
    const range = max - min;

    // Boundary variants get +Infinity — assigned BEFORE the range check
    // so degenerate-range fronts still keep their boundaries unique.
    distances[indexed[0]!.i] = Number.POSITIVE_INFINITY;
    distances[indexed[n - 1]!.i] = Number.POSITIVE_INFINITY;

    if (range === 0) continue; // All variants identical on this objective.

    for (let k = 1; k < n - 1; k++) {
      // Skip if we already hit Infinity from a previous objective —
      // adding to Infinity is still Infinity, so no work to do.
      if (distances[indexed[k]!.i] === Number.POSITIVE_INFINITY) continue;
      const gap = (indexed[k + 1]!.v - indexed[k - 1]!.v) / range;
      distances[indexed[k]!.i] += gap;
    }
  }

  return distances;
}

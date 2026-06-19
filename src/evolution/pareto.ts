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
 * True iff `a` ε-dominates `b` over the given objectives (v0.7.0).
 *
 * ε-dominance relaxes strict {@link dominates} with a per-objective relative
 * tolerance applied SYMMETRICALLY: `a` may be worse than `b` on an objective
 * by up to a fraction `epsilon` of that objective's own magnitude and still
 * count as "non-regressing", AND `a` must beat `b` by more than that same band
 * on at least one objective to count as a real improvement. This stops a
 * genuinely better challenger from being rejected over a microscopic
 * regression (e.g. "+12% quality but 0.3% slower"), while not letting a
 * within-noise "gain" masquerade as domination.
 *
 * The tolerance is `epsilon · |bNorm|` per objective, so it is **scale-safe**
 * across mixed-unit objectives (quality 0–10 vs duration in ms) — exactly
 * like strict dominance, no pre-normalisation needed. At `epsilon = 0` this
 * is byte-for-byte equivalent to {@link dominates} (`a < b` ⇒ false, `a > b`
 * ⇒ strictly-better). Degenerate objective values (0) fall back to strict on
 * that axis (zero tolerance) — fail-closed.
 *
 * Returns false if either side has a non-finite value for any objective
 * (same defensive contract as {@link dominates}).
 *
 * @param epsilon Relative tolerance ≥ 0. Negative / NaN inputs clamp to 0.
 */
export function dominatesEpsilon<T extends Record<string, unknown>>(
  a: T,
  b: T,
  objectives: ReadonlyArray<ParetoObjective<T>>,
  epsilon: number,
): boolean {
  if (objectives.length === 0) return false;
  const eps = Number.isFinite(epsilon) && epsilon > 0 ? epsilon : 0;
  let strictlyBetterSomewhere = false;
  for (const obj of objectives) {
    const av = a[obj.key];
    const bv = b[obj.key];
    if (typeof av !== "number" || typeof bv !== "number") return false;
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return false;
    const aNorm = obj.direction === "maximize" ? av : -av;
    const bNorm = obj.direction === "maximize" ? bv : -bv;
    const tol = eps * Math.abs(bNorm);
    // `a` regressed below `b` by more than the tolerance band → not dominating.
    if (aNorm < bNorm - tol) return false;
    // Strictly-better must clear the SAME ε band — a within-ε "gain" is noise,
    // not a real improvement. Applying the tolerance only to the regression
    // side (and counting any `aNorm > bNorm` as a win) would be asymmetric:
    // an infinitesimal gain could classify `a` as dominating while the loss
    // side is forgiven. At ε=0 this reduces exactly to strict `aNorm > bNorm`.
    if (aNorm > bNorm + tol) strictlyBetterSomewhere = true;
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
 * third paper strategy. It is NOT a `paretoSelect` truncation mode
 * (it needs the per-key score matrix, not aggregate metrics) — it
 * SHIPPED in v0.7.0 as its own pure functions {@link coverageFrontier} /
 * {@link selectByCoverage} / {@link sampleByCoverage}, wired into the GEPA
 * loop via `NextGenerationOptions.useCoverage`.
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
/**
 * A "frontier key" in GEPA's instance-level Pareto search — a validation
 * example id, an objective name, or an "example×objective" pair. Coverage is
 * measured per key: a candidate that is best-in-class on many keys is more
 * valuable (it excels on more task subsets) even if no single aggregate score
 * crowns it.
 */
export type FrontierKey = string;

/**
 * Per-variant, per-key score matrix for coverage sampling. Outer index =
 * variant; inner map = `frontierKey → score` (higher is always better — the
 * caller direction-normalises before calling). Variants may carry different
 * key sets; missing keys are treated as −∞ (never best on that key).
 *
 * NEW v0.7.0.
 */
export type CoverageScores = ReadonlyArray<Readonly<Record<FrontierKey, number>>>;

/**
 * GEPA Algorithm 2 — the instance-level Pareto frontier. For each frontier
 * key, returns the set of variant indices that achieve the maximum score on
 * that key (ties keep all winners). This is the structure GEPA's official
 * `pareto` candidate selector is built on: selection probability proportional
 * to the number of keys a candidate wins.
 *
 * Pure, deterministic. `eps` is the float-tie tolerance (a variant counts as
 * a winner on a key if its score ≥ keyMax − eps). Non-finite scores never win.
 *
 * NEW v0.7.0 — closes the "coverage sampling = backlog for V0.6" deferral.
 */
export function coverageFrontier(
  scores: CoverageScores,
  eps = 1e-9,
): Map<FrontierKey, Set<number>> {
  const frontier = new Map<FrontierKey, Set<number>>();
  if (scores.length === 0) return frontier;

  // Collect every key that appears on any variant.
  const allKeys = new Set<FrontierKey>();
  for (const variant of scores) {
    for (const key of Object.keys(variant)) allKeys.add(key);
  }

  for (const key of allKeys) {
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < scores.length; i++) {
      const v = scores[i]![key];
      if (typeof v === "number" && Number.isFinite(v) && v > max) max = v;
    }
    if (!Number.isFinite(max)) continue; // no finite score on this key
    const winners = new Set<number>();
    for (let i = 0; i < scores.length; i++) {
      const v = scores[i]![key];
      if (typeof v === "number" && Number.isFinite(v) && v >= max - eps) {
        winners.add(i);
      }
    }
    frontier.set(key, winners);
  }
  return frontier;
}

/**
 * Coverage weight per variant = how many frontier keys it is best-in-class on
 * (a key shared by K co-winners contributes 1/K to each, so the weights sum
 * to the number of covered keys — fractional credit prevents a duplicate
 * candidate from doubling the population's apparent coverage). Returns an
 * array indexed by variant. This is the GEPA selection weight.
 *
 * NEW v0.7.0.
 */
export function coverageWeights(scores: CoverageScores, eps = 1e-9): number[] {
  const weights = new Array<number>(scores.length).fill(0);
  const frontier = coverageFrontier(scores, eps);
  for (const winners of frontier.values()) {
    if (winners.size === 0) continue;
    const share = 1 / winners.size;
    for (const idx of winners) weights[idx]! += share;
  }
  return weights;
}

/**
 * Deterministically select up to `maxKeep` variants by coverage BREADTH —
 * GEPA's diversity-preserving survivor rule. Ranks by coverage weight desc,
 * tie-broken by total score sum desc, then original index (stable). Unlike
 * `paretoSelect` truncation (which can keep N near-copies of the aggregate
 * winner), this keeps candidates that win on DIFFERENT keys, preserving the
 * spread that makes the next reflection generation productive.
 *
 * Pure — no RNG, so it is the test-friendly survivor selector. For the
 * probabilistic GEPA candidate-to-mutate step, use {@link sampleByCoverage}.
 *
 * NEW v0.7.0.
 */
export function selectByCoverage<T>(
  variants: ReadonlyArray<T>,
  scores: CoverageScores,
  maxKeep: number,
  eps = 1e-9,
): T[] {
  const n = variants.length;
  if (n === 0) return [];
  if (typeof maxKeep !== "number" || maxKeep >= n) return [...variants];
  if (maxKeep <= 0) return [];

  const weights = coverageWeights(scores, eps);
  const totals = scores.map((s) => {
    let sum = 0;
    for (const v of Object.values(s)) {
      if (typeof v === "number" && Number.isFinite(v)) sum += v;
    }
    return sum;
  });

  return [...variants.keys()]
    .sort((i, j) => {
      const dw = (weights[j] ?? 0) - (weights[i] ?? 0);
      if (dw !== 0) return dw;
      const dt = (totals[j] ?? 0) - (totals[i] ?? 0);
      if (dt !== 0) return dt;
      return i - j; // stable
    })
    .slice(0, maxKeep)
    .map((i) => variants[i]!);
}

/**
 * GEPA Algorithm 2 candidate-selection step — pick ONE variant index, sampled
 * with probability proportional to its coverage weight (candidates excelling
 * on more task subsets are mutated more often). Because this module is pure,
 * the randomness is INJECTED: pass an `rng` returning a float in [0,1). When
 * every variant has zero coverage the choice is uniform. Returns a variant
 * index (−1 only for empty input).
 *
 * Mirrors the official GEPA `NonDominatedSelector(rng)` contract — same shape,
 * so a seeded RNG makes runs reproducible.
 *
 * NEW v0.7.0.
 */
export function sampleByCoverage(
  scores: CoverageScores,
  rng: () => number,
  eps = 1e-9,
): number {
  const n = scores.length;
  if (n === 0) return -1;
  if (n === 1) return 0;

  const weights = coverageWeights(scores, eps);
  const total = weights.reduce((a, b) => a + b, 0);

  // Draw a uniform in [0,1); clamp non-finite/out-of-range rng output.
  const raw = rng();
  const u = Number.isFinite(raw) ? Math.min(0.999999999, Math.max(0, raw)) : 0;

  if (!(total > 0)) {
    // No coverage signal anywhere → uniform pick.
    return Math.min(n - 1, Math.floor(u * n));
  }

  let cumulative = 0;
  const target = u * total;
  for (let i = 0; i < n; i++) {
    cumulative += weights[i] ?? 0;
    if (target < cumulative) return i;
  }
  return n - 1; // float-safety fallthrough
}

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

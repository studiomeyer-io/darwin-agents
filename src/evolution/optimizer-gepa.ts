/**
 * Darwin — GEPA-Style Reflective Optimizer (Phase 2 A2, S1185).
 *
 * Generation-loop wrapper around {@link Reflector} + {@link paretoSelect}
 * that produces N variants (default 3) per cycle and carries the
 * non-dominated set forward to the next generation. Opt-in via
 * `useGepa: true` in the evolution loop config.
 *
 * Pipeline per generation:
 *
 *   1. Take a parent variant (current prompt or last gen's winner).
 *   2. Generate N candidate mutations by calling the reflector with
 *      different sliced feedback (forces variation while keeping each
 *      mutation principled — not stochastic-only).
 *   3. Caller scores the candidates against their domain metric(s).
 *   4. paretoSelect keeps the non-dominated set (≤ maxCarry).
 *   5. Next generation reflects from the survivors.
 *
 * This file orchestrates only the GENERATION step. Scoring lives in
 * the caller (loop.ts → evaluator) because Darwin's existing
 * multi-critic pipeline is the authoritative source of variant scores.
 *
 * Why this design and not a full GEPA-engine port:
 *   - Keep the Python lib (`gepa-ai/gepa`) out of our peer-dep graph.
 *   - Reuse Darwin's existing multi-critic + safety + A/B machinery —
 *     GepaOptimizer is purely about variant GENERATION + Pareto SELECTION.
 *   - Smallest-possible-edit reflection is the part that empirically
 *     matters most (per GEPA papers); the multi-objective search is the
 *     other part. Together they cover the GEPA value-prop without a
 *     Python dependency.
 *
 * **Inspired by, not lifted from** the official GEPA Python library /
 * arxiv 2507.19457 paper. Deliberate deviations (R1 Research Finding F1
 * + F4 + F6, S1185):
 *   - **N variants per generate() call:** GEPA Algorithm 1 produces 1
 *     offspring per iteration. We produce N=3-5 per call via three
 *     `feedbackStrategy` modes (split / replicate / single). This is
 *     our structural adaptation to TS-callsite ergonomics — call us
 *     three times to recover the per-iteration GEPA budget.
 *   - **`feedbackStrategy: "split"` is OUR adaptation** — GEPA paper
 *     does not partition feedback across offspring. We do it to force
 *     mutation diversity in a single `Promise.all` batch.
 *   - **paretoSelect truncation uses scalarised tie-break** — GEPA
 *     Algorithm 2 samples Pareto candidates proportional to instance
 *     coverage. We use a simpler weighted-sum tie-break. V0.6 will add
 *     a `truncationStrategy` option for coverage-proportional +
 *     NSGA-II crowding-distance.
 *   - **GEPA+Merge (system-aware crossover from two Pareto-pool
 *     ancestors, paper Appendix F)** is NOT implemented. +5% reported
 *     lift in the paper. Backlog for V0.6.
 *   - **Instance-wise coverage sampling** (paper Algorithm 2) is NOT
 *     implemented. Backlog for V0.6.
 *
 * @example
 * ```ts
 * import { GepaOptimizer, DARWIN_DEFAULT_OBJECTIVES } from "darwin-agents";
 *
 * const optimizer = new GepaOptimizer(myRunPromptFn);
 *
 * // Step 1: generate N variant mutations from feedback
 * const variants = await optimizer.generate(currentPrompt, feedbacks, {
 *   numVariants: 3,
 * });
 *
 * // Step 2: score each variant externally (via Darwin's multi-critic
 * // pipeline or any other evaluator)
 * const scored = await Promise.all(
 *   variants.map(async (v) => ({
 *     ...v,
 *     metrics: await scoreVariant(v.prompt),
 *   })),
 * );
 *
 * // Step 3: Pareto-select survivors for the next generation
 * const survivors = optimizer.nextGeneration(scored, {
 *   objectives: DARWIN_DEFAULT_OBJECTIVES,
 *   maxCarry: 3,
 * });
 * ```
 */

import type { ReflectiveFeedback, RunPromptFn } from "./reflector.js";
import { Reflector } from "./reflector.js";
import {
  paretoSelect,
  type ParetoObjective,
} from "./pareto.js";

/** One evaluated variant in a generation. */
export interface ScoredVariant {
  /** Variant identifier (e.g. "v3-gen2-cand1"). */
  id: string;
  /** Mutated prompt text. */
  prompt: string;
  /** Score map keyed by objective name — must include the keys in `objectives`. */
  metrics: Record<string, number>;
  /** Optional text feedback collected for the next generation's reflector. */
  textFeedback?: string;
}

/** Options for {@link GepaOptimizer#generate}. */
export interface GenerateOptions {
  /** Number of variants per generation. Default 3, clamped to [1, 10]. */
  numVariants?: number;
  /**
   * Strategy for feeding feedback to the N reflector calls:
   *   - `"split"` (default): split feedback array N ways; each variant
   *     reflects on a different subset → encourages diversity.
   *   - `"replicate"`: every variant sees every feedback → encourages
   *     consistency at the cost of diversity.
   *   - `"single"`: 1 reflection call, deduplicated to a single variant
   *     (use when feedback set is tiny).
   */
  feedbackStrategy?: "split" | "replicate" | "single";
}

/** Options for {@link GepaOptimizer#nextGeneration}. */
export interface NextGenerationOptions extends GenerateOptions {
  /**
   * Pareto objectives over `ScoredVariant.metrics`. Required —
   * GepaOptimizer is multi-objective by design; if you only have one
   * objective, use the plain `PromptOptimizer` instead.
   */
  objectives: ReadonlyArray<ParetoObjective<Record<string, number>>>;
  /**
   * Max variants to keep on the Pareto front. Default 3.
   */
  maxCarry?: number;
}

const DEFAULT_NUM_VARIANTS = 3;
const MIN_NUM_VARIANTS = 1;
const MAX_NUM_VARIANTS = 10;
const DEFAULT_MAX_CARRY = 3;

export class GepaOptimizer {
  private readonly reflector: Reflector;

  constructor(runPrompt: RunPromptFn) {
    this.reflector = new Reflector(runPrompt);
  }

  /**
   * Generate N variant mutations from the current prompt + feedback set.
   * Returns the raw mutated prompts — caller scores them (typically via
   * the existing multi-critic pipeline) before passing them through
   * {@link GepaOptimizer#nextGeneration}.
   */
  async generate(
    currentPrompt: string,
    feedbacks: ReadonlyArray<ReflectiveFeedback>,
    opts: GenerateOptions = {},
  ): Promise<Array<{ id: string; prompt: string }>> {
    // R2 V0.5.0-alpha.2 Critic Finding R2-L1 (S1185): boundary-level
    // validation with a GEPA-specific error message. Without this, a
    // caller passing an empty `feedbacks` array gets an opaque
    // `Reflector.reflect: feedbacks must contain at least one entry`
    // bubbling up from internal code.
    if (feedbacks.length === 0) {
      throw new TypeError(
        "GepaOptimizer.generate: feedbacks array must be non-empty — " +
          "GEPA reflection needs at least one variant evaluation to mutate from. " +
          "Use the plain PromptOptimizer for cold-start mutation.",
      );
    }
    const n = this.clampN(opts.numVariants ?? DEFAULT_NUM_VARIANTS);
    const strategy = opts.feedbackStrategy ?? "split";

    if (strategy === "single") {
      // Fast path: one reflection, one variant. Used when feedback set is
      // small or the caller deliberately wants a single deterministic mutation.
      const mutated = await this.reflector.reflect(currentPrompt, feedbacks);
      return [{ id: this.makeId(0), prompt: mutated }];
    }

    if (strategy === "replicate") {
      // Every variant sees every feedback. The LLM is non-deterministic
      // enough that this still yields N different mutations in practice;
      // for tests with a deterministic mock you'll get N identical
      // outputs which is the expected behaviour (and the test asserts
      // exactly that).
      const promises = Array.from({ length: n }, () =>
        this.reflector.reflect(currentPrompt, feedbacks),
      );
      const mutations = await Promise.all(promises);
      return mutations.map((p, i) => ({ id: this.makeId(i), prompt: p }));
    }

    // Default strategy "split": partition feedback round-robin into N
    // buckets. Each bucket reflects on a different feedback subset.
    const buckets: ReflectiveFeedback[][] = Array.from({ length: n }, () => []);
    feedbacks.forEach((fb, i) => {
      const bucketIdx = i % n;
      // Non-null assertion: `n` is clamped to [MIN, MAX] (both ≥ 1) so
      // every index into a freshly allocated length-n array is in-range.
      buckets[bucketIdx]!.push(fb);
    });

    const promises = buckets.map((bucket) => {
      if (bucket.length === 0) {
        // Bucket is empty (fewer feedbacks than variants) — reflect on
        // the full set for this slot. Better than skipping the slot.
        return this.reflector.reflect(currentPrompt, feedbacks);
      }
      return this.reflector.reflect(currentPrompt, bucket);
    });
    const mutations = await Promise.all(promises);
    return mutations.map((p, i) => ({ id: this.makeId(i), prompt: p }));
  }

  /**
   * Given the scored variants of a generation, return the survivors
   * carried to the next generation (Pareto-front, capped at maxCarry).
   *
   * This is a pure-function wrapper around `paretoSelect` exposed on
   * the optimizer for ergonomic call-site grouping ("generate, score,
   * nextGeneration"). The actual selection logic lives in `pareto.ts`.
   */
  nextGeneration(
    scored: ReadonlyArray<ScoredVariant>,
    opts: NextGenerationOptions,
  ): ScoredVariant[] {
    if (!opts.objectives || opts.objectives.length === 0) {
      throw new TypeError(
        "GepaOptimizer.nextGeneration: opts.objectives must contain at least one objective",
      );
    }
    const maxCarry = opts.maxCarry ?? DEFAULT_MAX_CARRY;
    // R1 V0.5.0-alpha.2 Critic Finding M2 (S1185): map metrics back to
    // indices via parallel array (NOT reference-identity on the metrics
    // object). Reference-identity worked today because paretoSelect
    // returns the input references, but that is a fragile invariant —
    // a future refactor to immutable-copy semantics would silently
    // produce empty survivor sets. Index-based mapping is explicit.
    //
    // R2 V0.5.0-alpha.2 Critic Finding R2-M1 (S1185): guard against
    // shared metrics-object references across ScoredVariants.
    // Caller-side mistake (programmer reuses the same metrics literal)
    // would otherwise drop survivors silently in the Map below.
    const metricsArr = scored.map((v) => v.metrics);
    if (new Set(metricsArr).size !== metricsArr.length) {
      throw new TypeError(
        "GepaOptimizer.nextGeneration: two or more ScoredVariants share the same " +
          "`metrics` object reference — provide a distinct metrics object per variant.",
      );
    }
    const objectives = opts.objectives as ReadonlyArray<
      ParetoObjective<Record<string, number>>
    >;
    const survivorMetrics = paretoSelect(metricsArr, objectives, maxCarry);
    // Build "metrics-ref → index" map then look up each survivor's index.
    // Linear scan twice is O(N²) worst-case but N≤10 in practice.
    const metricsToIndex = new Map<Record<string, number>, number>();
    metricsArr.forEach((m, i) => metricsToIndex.set(m, i));
    const survivorIndices = new Set(
      survivorMetrics
        .map((m) => metricsToIndex.get(m))
        .filter((i): i is number => typeof i === "number"),
    );
    return scored.filter((_, i) => survivorIndices.has(i));
  }

  /** Clamp variant count into the documented bounds. */
  private clampN(n: number): number {
    if (!Number.isFinite(n)) return DEFAULT_NUM_VARIANTS;
    return Math.max(MIN_NUM_VARIANTS, Math.min(MAX_NUM_VARIANTS, Math.floor(n)));
  }

  /** Stable variant id: `gepa-cand-${i}` (caller can re-namespace). */
  private makeId(i: number): string {
    return `gepa-cand-${i}`;
  }
}

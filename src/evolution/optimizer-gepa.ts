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
 *   - **paretoSelect truncation has two strategies (V0.5.1):**
 *     `"scalarised"` (V0.5.0 default, weighted-sum tie-break) and
 *     `"crowding"` (NSGA-II Deb 2002 density-preserving truncation).
 *     GEPA Algorithm 2's instance-proportional coverage sampling SHIPPED in
 *     v0.7.0 — see `coverageFrontier`/`selectByCoverage`/`sampleByCoverage`
 *     in `pareto.ts` and the `useCoverage` path in {@link GepaOptimizer#nextGeneration}.
 *   - **GEPA+Merge (system-aware crossover from two Pareto-pool
 *     ancestors, paper Appendix F)** SHIPPED in V0.5.1 via
 *     {@link GepaOptimizer#merge}. Paper reports ~5% lift when run on
 *     every K-th generation.
 *   - **Stronger reflection LM** SHIPPED in V0.5.1 via
 *     {@link GepaOptimizerOptions.reflectionRunPrompt}. Falls back to
 *     the main `runPrompt` when omitted.
 *   - **Instance-wise coverage sampling** (paper Algorithm 2) SHIPPED in
 *     v0.7.0 (`coverageFrontier`/`selectByCoverage`/`sampleByCoverage` in
 *     `pareto.ts`; opt-in via `NextGenerationOptions.useCoverage`).
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
  selectByCoverage,
  type CoverageScores,
  type ParetoObjective,
  type ParetoTruncationStrategy,
} from "./pareto.js";

/** One evaluated variant in a generation. */
export interface ScoredVariant {
  /** Variant identifier (e.g. "v3-gen2-cand1"). */
  id: string;
  /** Mutated prompt text. */
  prompt: string;
  /** Score map keyed by objective name — must include the keys in `objectives`. */
  metrics: Record<string, number>;
  /**
   * v0.7.0 — Optional per-frontier-key scores for GEPA Algorithm 2 coverage
   * sampling (higher is better; caller direction-normalises). A "key" is a
   * validation-example id, an objective, or an example×objective pair. When
   * present on every variant AND `NextGenerationOptions.useCoverage` is on,
   * survivors are chosen by coverage breadth (variants winning DIFFERENT keys)
   * instead of by aggregate Pareto truncation — preserving the diversity GEPA
   * relies on. Ignored when absent (falls back to the metrics-based path).
   */
  perKeyScores?: Record<string, number>;
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
  /**
   * V0.5.1 — strategy used when the Pareto front exceeds `maxCarry`
   * and needs truncation. Default `"scalarised"` (preserves V0.5.0
   * behaviour). Switch to `"crowding"` for NSGA-II density-preserving
   * truncation that maintains diversity along the front.
   *
   * NEW V0.5.1 (S1235).
   */
  truncationStrategy?: ParetoTruncationStrategy;
  /**
   * v0.7.0 — Opt into GEPA Algorithm 2 instance-level coverage selection.
   * When `true` AND every scored variant carries a `perKeyScores` map,
   * survivors are chosen by coverage breadth ({@link selectByCoverage}) — the
   * variants that win on the most DIFFERENT frontier keys — instead of the
   * aggregate-metrics Pareto truncation. This preserves the per-subset
   * diversity GEPA's reflection loop depends on (a candidate strong on a niche
   * of tasks is not crowded out by the global-average winner). When the
   * `perKeyScores` data is missing on any variant, this silently falls back to
   * the metrics-based Pareto path so existing callers are unaffected.
   *
   * Default `false` — V0.5.x behaviour unchanged.
   */
  useCoverage?: boolean;
}

const DEFAULT_NUM_VARIANTS = 3;
const MIN_NUM_VARIANTS = 1;
const MAX_NUM_VARIANTS = 10;
const DEFAULT_MAX_CARRY = 3;

/**
 * v0.7.0 — Epoch-shuffled minibatch sampler (GEPA `reflection_minibatch_size`
 * + epoch-shuffled batch sampler, adapted to an online loop).
 *
 * Returns a deterministic rotating window of `size` items, offset by `epoch`,
 * wrapping around the array. Across consecutive epochs the window walks the
 * whole array, so every item is eventually reflected on — without the
 * persistent sampler state a true epoch shuffle needs, and without any RNG
 * (the module stays pure). When `size` is non-positive or ≥ the array length,
 * the full array is returned (no minibatching).
 *
 * @example
 *   epochShuffledMinibatch(['a','b','c','d','e'], 2, 0) // ['a','b']
 *   epochShuffledMinibatch(['a','b','c','d','e'], 2, 1) // ['c','d']
 *   epochShuffledMinibatch(['a','b','c','d','e'], 2, 2) // ['e','a']
 */
export function epochShuffledMinibatch<T>(
  items: ReadonlyArray<T>,
  size: number,
  epoch: number,
): T[] {
  const n = items.length;
  if (n === 0) return [];
  if (!Number.isFinite(size) || size <= 0 || size >= n) return [...items];
  const e = Number.isFinite(epoch) && epoch >= 0 ? Math.floor(epoch) : 0;
  const start = (e * size) % n;
  const out: T[] = [];
  for (let i = 0; i < size; i++) out.push(items[(start + i) % n]!);
  return out;
}

/**
 * V0.5.1 — GEPA+Merge prompt template (Paper Appendix F).
 *
 * Asks the LLM to combine the best aspects of two Pareto-front parents
 * into a single mutated prompt. Deliberately NOT a literal cross-over
 * of token spans — the paper reports the "system-aware merge" variant
 * (semantic combination via reflection LM) lifts task performance by
 * roughly 5%. Token-span crossover (the alternative they tested) did
 * not yield the same gain.
 *
 * NEW V0.5.1 (S1235).
 */
const DEFAULT_MERGE_TEMPLATE = `
You are a prompt-engineering merger. Below are two instruction prompts from a Pareto-front of variants. Each has its own strengths and weaknesses on different evaluation dimensions.

PARENT A (id={ID_A}, score {SCORE_A}):
\`\`\`
{PROMPT_A}
\`\`\`

PARENT B (id={ID_B}, score {SCORE_B}):
\`\`\`
{PROMPT_B}
\`\`\`

Task: produce ONE merged instruction that combines the strongest aspects of BOTH parents. You may borrow phrasing from either, but the merge must preserve correct behavior from BOTH and not regress on any dimension either parent handles well. Keep the overall length envelope reasonable (no growth beyond ~30% of the longer parent).

Return ONLY the merged instruction text. No prose, no explanations, no markdown fences.
`.trim();

/**
 * V0.5.1 options for {@link GepaOptimizer} constructor.
 *
 * R1 Research Finding F7 (S1185) closure — `reflectionRunPrompt` lets
 * callers route reflection / merge calls to a STRONGER LM than the task
 * LM, matching GEPA's official `reflection_lm` parameter. When omitted,
 * reflection and merge fall back to the main `runPrompt`. NEW V0.5.1.
 */
export interface GepaOptimizerOptions {
  /**
   * Stronger LM for reflection / merge calls. Pass a higher-tier
   * `RunPromptFn` (e.g. Claude Opus) here when your main task LM is a
   * cheaper one. Per GEPA paper guidance reflection is the leverage
   * point — a stronger reflector lifts mutation quality more than a
   * stronger task LM.
   *
   * When omitted, reflection + merge use the main `runPrompt`.
   *
   * NEW V0.5.1 (S1235).
   */
  reflectionRunPrompt?: RunPromptFn;
}

/**
 * V0.5.1 options for {@link GepaOptimizer#merge}.
 */
export interface MergeOptions {
  /**
   * Override the merge prompt template. Default is the GEPA Appendix-F
   * system-aware merge template. Use a custom template when you want
   * different merge pressure (e.g. conservative-additive vs. selective).
   */
  mergePromptTemplate?: string;
  /**
   * Hard upper bound on the returned merged-prompt length. Default
   * `Math.max(max(parents[].prompt.length) * 1.3, 3500)` — same growth
   * ceiling as {@link Reflector}.
   */
  maxMergeLength?: number;
}

export class GepaOptimizer {
  private readonly reflector: Reflector;
  private readonly reflectionRunPrompt: RunPromptFn;

  constructor(runPrompt: RunPromptFn, opts: GepaOptimizerOptions = {}) {
    if (typeof runPrompt !== "function") {
      throw new TypeError("GepaOptimizer: runPrompt must be a function");
    }
    // V0.5.1 (R1 Research F7 closure, S1235): if a stronger reflection LM
    // is provided, route reflection + merge through it; otherwise fall
    // back to the main runPrompt so existing V0.5.0 callsites keep
    // working unchanged.
    if (
      opts.reflectionRunPrompt !== undefined &&
      typeof opts.reflectionRunPrompt !== "function"
    ) {
      throw new TypeError(
        "GepaOptimizer: opts.reflectionRunPrompt must be a function when supplied",
      );
    }
    this.reflectionRunPrompt = opts.reflectionRunPrompt ?? runPrompt;
    this.reflector = new Reflector(this.reflectionRunPrompt);
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

    // v0.7.0 — GEPA Algorithm 2 coverage selection (opt-in). Only taken when
    // useCoverage is on AND every variant carries perKeyScores; otherwise we
    // fall through to the metrics-based Pareto path so existing callers are
    // byte-for-byte unaffected.
    if (opts.useCoverage && scored.length > 0 && scored.every((v) => v.perKeyScores)) {
      const coverage: CoverageScores = scored.map((v) => v.perKeyScores!);
      return selectByCoverage(scored as ScoredVariant[], coverage, maxCarry);
    }

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
    // V0.5.1 (S1235) — forward truncationStrategy. Default "scalarised"
    // preserves V0.5.0 behaviour byte-for-byte.
    const survivorMetrics = paretoSelect(
      metricsArr,
      objectives,
      maxCarry,
      opts.truncationStrategy ?? "scalarised",
    );
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

  /**
   * V0.5.1 (S1235) — GEPA+Merge (Paper Appendix F).
   *
   * Combines the strongest aspects of TWO Pareto-front parents into a
   * single mutated prompt via a reflection-LM call. The paper reports
   * ~+5% lift over generation-only optimisation when this is run on
   * every K-th generation (typically K=3-5). The merged prompt then
   * competes alongside the regular generation outputs in the next
   * `nextGeneration` Pareto-select step.
   *
   * Typical usage:
   * ```ts
   * // Every Kth generation, merge the top two Pareto-front members.
   * if (gen % 3 === 0 && survivors.length >= 2) {
   *   const merged = await optimizer.merge(
   *     [survivors[0], survivors[1]],
   *   );
   *   // Score `merged.prompt` via your evaluator, then include the
   *   // scored variant in the next nextGeneration() pool.
   * }
   * ```
   *
   * Errors are thrown — `merge` is a deliberate optimisation step, the
   * caller chooses when to invoke it. No swallowing.
   */
  async merge(
    parents: readonly [ScoredVariant, ScoredVariant],
    opts: MergeOptions = {},
  ): Promise<{ id: string; prompt: string }> {
    if (!Array.isArray(parents) || parents.length !== 2) {
      throw new TypeError(
        "GepaOptimizer.merge: parents must be a tuple of exactly two ScoredVariants",
      );
    }
    const [a, b] = parents;
    if (!a || !b || typeof a.prompt !== "string" || typeof b.prompt !== "string") {
      throw new TypeError(
        "GepaOptimizer.merge: both parents must carry a non-empty `prompt` string",
      );
    }
    if (a.prompt.length === 0 || b.prompt.length === 0) {
      throw new TypeError(
        "GepaOptimizer.merge: parent prompts must be non-empty",
      );
    }
    // R1-self-check: emit a merge for two IDENTICAL parents would be a
    // waste of an LLM call AND likely produce a near-identical mutation
    // anyway. Fail loud so the caller fixes the pairing logic upstream
    // rather than silently consume budget.
    if (a.id === b.id) {
      throw new TypeError(
        `GepaOptimizer.merge: both parents share id "${a.id}" — merge is only ` +
          `meaningful between distinct Pareto-front members.`,
      );
    }

    const template = opts.mergePromptTemplate ?? DEFAULT_MERGE_TEMPLATE;

    // Scalar score for the prompt header — purely informational for the
    // reflection LM. Sum of variant.metrics values (best-effort), zero
    // for missing or non-finite. Caller can override via the template.
    const scoreOf = (v: ScoredVariant): number => {
      let s = 0;
      for (const val of Object.values(v.metrics)) {
        if (typeof val === "number" && Number.isFinite(val)) s += val;
      }
      return s;
    };

    // Template-injection defense (S1235): all FOUR metadata placeholders
    // (`{ID_A}` / `{ID_B}` / `{SCORE_A}` / `{SCORE_B}`) are substituted
    // FIRST, then the user-controlled `{PROMPT_A}` / `{PROMPT_B}` slots
    // LAST. After the metadata substitutions are done, any literal
    // `{ID_*}` / `{SCORE_*}` strings INSIDE the parent prompts cannot be
    // re-processed — `String.prototype.replace` only matches what's
    // currently in the working string, and the user content does not
    // enter the working string until the final two replacements.
    //
    // R1 V0.5.1 self-check (S1235): R1 critic suggested swapping the
    // order, but that would BREAK the defense — putting PROMPT first
    // would let the subsequent ID/SCORE replacements grab literal
    // `{ID_A}` etc. inside the user content. The original ordering is
    // correct; the test coverage for SCORE placeholders is what was
    // genuinely missing, and is now added in `tests/v0.5.1-features.test.ts`.
    const metaPrompt = template
      .replace("{ID_A}", a.id)
      .replace("{ID_B}", b.id)
      .replace("{SCORE_A}", scoreOf(a).toFixed(2))
      .replace("{SCORE_B}", scoreOf(b).toFixed(2))
      .replace("{PROMPT_A}", a.prompt)
      .replace("{PROMPT_B}", b.prompt);

    let merged = await this.reflectionRunPrompt(metaPrompt);
    merged = this.cleanOutput(merged);

    const longerParent = a.prompt.length >= b.prompt.length ? a.prompt : b.prompt;
    const maxLength =
      opts.maxMergeLength ?? Math.max(Math.round(longerParent.length * 1.3), 3500);
    if (merged.length > maxLength) {
      merged = this.truncateAtSentenceBoundary(merged, maxLength);
    }

    return { id: this.makeMergeId(a.id, b.id), prompt: merged };
  }

  /** Strip markdown fences + leading/trailing whitespace — mirrors `Reflector.cleanOutput`. */
  private cleanOutput(raw: string): string {
    let out = raw.trim();
    const fence = out.match(/^```[a-z]*\n?([\s\S]*?)\n?```$/i);
    if (fence) out = fence[1]!.trim();
    return out;
  }

  /** Sentence-boundary truncation — mirrors `Reflector.truncateAtSentenceBoundary`. */
  private truncateAtSentenceBoundary(text: string, maxLength: number): string {
    if (text.length <= maxLength) return text;
    const truncated = text.slice(0, maxLength);
    const lastPeriod = truncated.lastIndexOf(".");
    const lastNewline = truncated.lastIndexOf("\n");
    const cutPoint = Math.max(lastPeriod, lastNewline);
    return cutPoint > maxLength * 0.7
      ? truncated.slice(0, cutPoint + 1)
      : truncated;
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

  /** V0.5.1 — stable merged-variant id: `gepa-merge-${idA}+${idB}`. */
  private makeMergeId(idA: string, idB: string): string {
    return `gepa-merge-${idA}+${idB}`;
  }
}

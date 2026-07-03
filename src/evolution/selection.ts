/**
 * Parent-selection strategies (v0.10.0) — GEPA `candidate_selection_strategy`
 * parity for the online evolution loop.
 *
 * Upstream GEPA exposes three strategies for picking WHICH candidate to
 * mutate next: sample from the Pareto frontier (default), always take the
 * current best, or epsilon-greedy explore/exploit. Darwin's online loop
 * historically always reflected from the currently-ACTIVE prompt (plus the
 * opt-in v0.7 coverage selection). This module adds the missing strategies as
 * a pure, injectable-RNG helper:
 *
 *   - `"active"`        — loop default, reflect from the active prompt
 *                         (handled by the caller; this helper returns null).
 *   - `"best"`          — GEPA `current_best`: highest scalarised composite
 *                         over the version history.
 *   - `"pareto"`        — GEPA default: uniform sample from the non-dominated
 *                         front of the version history.
 *   - `"epsilon-greedy"`— with probability ε pick a uniformly-random version
 *                         (explore), otherwise the best (exploit).
 *
 * Why it matters: always mutating the active prompt is a hill-climb that can
 * get stuck on a local optimum. Sampling parents from the Pareto front keeps
 * lineages alive that win on DIFFERENT objectives, and epsilon-greedy buys
 * cheap exploration — both directly per the GEPA paper's selection ablation.
 *
 * Purity: no I/O, no LLM calls, deterministic given the same `rng`. The RNG
 * is injected (default `Math.random`) so tests pin outcomes exactly — same
 * pattern as `sampleByCoverage` (v0.7.0).
 */

import {
  DARWIN_DEFAULT_OBJECTIVES,
  nonDominatedFront,
  scalarise,
  type ParetoObjective,
} from "./pareto.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Strategy for choosing the prompt version the next challenger is derived
 * from. `"active"` is the historical default (reflect from the active
 * prompt); the other three operate on the agent's scored version history.
 */
export type CandidateSelectionStrategy = "active" | "best" | "pareto" | "epsilon-greedy";

/** Minimal shape this module needs — `ScoredVariant` satisfies it. */
export interface SelectableVariant {
  /** Averaged objective vector for one prompt version. */
  metrics: Record<string, number>;
}

/** Options for {@link selectParentVariant}. */
export interface ParentSelectionOptions {
  /**
   * Exploration probability for `"epsilon-greedy"` (default
   * {@link DEFAULT_EXPLORATION_EPSILON}). Clamped to [0, 1]; non-finite
   * values fall back to the default (NaN never bypasses the clamp).
   */
  epsilon?: number;
  /**
   * Random source in [0, 1) — injected for deterministic tests
   * (default `Math.random`). Consulted by `"pareto"` (front sampling) and
   * `"epsilon-greedy"` (explore coin-flip + explore pick).
   */
  rng?: () => number;
  /**
   * Objectives for dominance/scalarisation (default
   * {@link DARWIN_DEFAULT_OBJECTIVES}). Same scale-sensitivity caveat as
   * `paretoSelect` applies to the scalarised `"best"` pick.
   */
  objectives?: ReadonlyArray<ParetoObjective<Record<string, number>>>;
}

export const DEFAULT_EXPLORATION_EPSILON = 0.1;

const DEFAULT_OBJECTIVES = DARWIN_DEFAULT_OBJECTIVES as ReadonlyArray<
  ParetoObjective<Record<string, number>>
>;

// ─── Internals ──────────────────────────────────────────────────────────────

/** Clamp epsilon to [0, 1]; NaN/Infinity → default (never bypasses the clamp). */
function resolveEpsilon(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_EXPLORATION_EPSILON;
  return Math.min(1, Math.max(0, value));
}

/**
 * Uniform index pick; clamps a pathological rng (>1 / <0 / NaN) into range —
 * same defensive posture as `sampleByCoverage` (pareto.ts), so a
 * non-conforming injected RNG degrades to index 0 instead of throwing or
 * returning `undefined`.
 */
function pickIndex(length: number, rng: () => number): number {
  const value = rng();
  if (!Number.isFinite(value)) return 0;
  const raw = Math.floor(value * length);
  return Math.min(length - 1, Math.max(0, raw));
}

/**
 * Flatten variants to `{ ...metrics, __index }` so dominance/scalarisation
 * run on plain records and the winner maps back by INDEX — never by
 * metrics-object reference identity, which silently drops variants that
 * share one metrics object (documented v0.5.0 R2-M1 failure mode).
 */
function flatten(
  variants: ReadonlyArray<SelectableVariant>,
): Array<Record<string, number>> {
  return variants.map((v, i) => ({ ...v.metrics, __index: i }));
}

function bestIndex(
  flat: ReadonlyArray<Record<string, number>>,
  objectives: ReadonlyArray<ParetoObjective<Record<string, number>>>,
): number {
  let winner = 0;
  let winnerScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < flat.length; i++) {
    const score = scalarise(flat[i]!, objectives);
    if (score > winnerScore) {
      winnerScore = score;
      winner = i;
    }
  }
  return winner;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Pick the parent variant the next challenger should be derived from.
 *
 * Returns `null` when the strategy is `"active"` (caller keeps the active
 * prompt — the historical default path) or when `variants` is empty. A
 * single-element list short-circuits to that element for every non-active
 * strategy.
 */
export function selectParentVariant<V extends SelectableVariant>(
  variants: ReadonlyArray<V>,
  strategy: CandidateSelectionStrategy,
  options: ParentSelectionOptions = {},
): V | null {
  if (strategy === "active") return null;
  if (variants.length === 0) return null;
  if (variants.length === 1) return variants[0]!;

  const objectives = options.objectives ?? DEFAULT_OBJECTIVES;
  const rng = options.rng ?? Math.random;
  const flat = flatten(variants);

  switch (strategy) {
    case "best": {
      return variants[bestIndex(flat, objectives)]!;
    }
    case "pareto": {
      const front = nonDominatedFront(flat, objectives);
      // Defensive: an all-non-finite history yields an empty comparable set —
      // nonDominatedFront keeps everything then, so front is never empty here,
      // but guard anyway rather than index into a hole.
      if (front.length === 0) return null;
      const pick = front[pickIndex(front.length, rng)]!;
      return variants[pick["__index"]!]!;
    }
    case "epsilon-greedy": {
      const epsilon = resolveEpsilon(options.epsilon);
      if (rng() < epsilon) {
        return variants[pickIndex(variants.length, rng)]!; // explore
      }
      return variants[bestIndex(flat, objectives)]!; // exploit
    }
    default: {
      // Unknown strategy string (e.g. from a hand-edited config file):
      // behave like "active" rather than throwing mid-evolution-cycle.
      return null;
    }
  }
}

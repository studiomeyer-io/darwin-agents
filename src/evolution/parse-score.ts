/**
 * Darwin — Critic score parsing.
 *
 * The CLI run path (`cli/run.ts`) and the reproducible benchmark
 * (`benchmark/evolution-benchmark.ts`) both have to turn a critic's free-text
 * verdict into a numeric 1–10 quality score. The original logic only matched
 * the explicit `===SCORE===` marker and then a single `N/10` fallback — so
 * perfectly clear human phrasings like "8.5 out of 10", "Score: 8/10",
 * "rating: 8", "I'd rate this 9", or a bare "9 out of 10" all parsed to `null`,
 * which silently DROPPED the run from evolution (no quality score recorded).
 *
 * {@link parseCriticScore} is the single shared, robust extractor: it tries the
 * authoritative marker first, then a small ordered set of unambiguous numeric
 * patterns, normalises everything onto the 0–10 scale, and clamps to 1–10. It
 * returns `null` only when there is genuinely no score-like number to be found.
 */

/** A parsed score is always on the 1–10 scale, or null when nothing matched. */
export type ParsedCriticScore = number | null;

/** Clamp a finite number onto the documented 1–10 critic scale. */
function clamp1to10(n: number): number {
  return Math.max(1, Math.min(10, n));
}

/**
 * Normalise a raw `value/denominator` pair onto a 0–10 scale.
 * Supports the three denominators a critic realistically uses (10, 100, 5).
 * Returns null for an unsupported or non-positive denominator.
 */
function normaliseFraction(value: number, denominator: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  if (denominator === 10) return value;
  if (denominator === 100) return value / 10;
  if (denominator === 5) return value * 2;
  // Unknown scale — refuse rather than guess.
  return null;
}

/**
 * Extract a 1–10 critic score from a critic's free-text output.
 *
 * Resolution order (first match wins):
 *   1. `===SCORE=== N`            — the authoritative machine marker
 *   2. `N/10`, `N/100`, `N/5`     — explicit fraction (normalised to 0–10)
 *   3. `N out of 10|100|5`        — worded fraction (denominator optional → 10)
 *   4. `score|rating|rate(d): N`  — a score-word followed by a number
 *   5. `rate this N` / `rate it N` — verb phrasing
 *
 * For the score-word / "out of" forms without an explicit denominator, a value
 * in 0–10 is taken as-is, a value in 11–100 is treated as a 0–100 score and
 * divided by 10, and anything above 100 is rejected (it is not a score). The
 * result is clamped to 1–10. Returns `null` when nothing score-like is found.
 */
export function parseCriticScore(output: string): ParsedCriticScore {
  if (typeof output !== 'string' || output.length === 0) {
    return null;
  }

  // 1. Authoritative marker: ===SCORE=== 8  (kept first, byte-compatible).
  const marker = output.match(/===SCORE===\s*(\d+(?:\.\d+)?)/);
  if (marker) {
    return clamp1to10(parseFloat(marker[1]!));
  }

  // 2. Explicit fraction with a slash: "8/10", "Score: 8/10", "85/100", "4/5".
  const fraction = output.match(/\b(\d+(?:\.\d+)?)\s*\/\s*(10|100|5)\b/);
  if (fraction) {
    const normalised = normaliseFraction(parseFloat(fraction[1]!), parseInt(fraction[2]!, 10));
    if (normalised !== null) {
      return clamp1to10(normalised);
    }
  }

  // 3. Worded fraction: "9 out of 10", "8.5 out of 10", "85 out of 100".
  //    Denominator is optional and defaults to 10.
  const outOf = output.match(/\b(\d+(?:\.\d+)?)\s*out\s+of\s*(10|100|5)?\b/i);
  if (outOf) {
    const denom = outOf[2] ? parseInt(outOf[2], 10) : 10;
    const normalised = normaliseFraction(parseFloat(outOf[1]!), denom);
    if (normalised !== null) {
      return clamp1to10(normalised);
    }
  }

  // 4. Score-word followed by a bare number: "Score: 8", "rating: 8",
  //    "rating is 8", "Quality score - 7".
  const scoreWord = output.match(/\b(?:score|rating|rated|grade)\b[^\d\n]{0,15}(\d+(?:\.\d+)?)/i);
  if (scoreWord) {
    const normalised = normaliseBareNumber(parseFloat(scoreWord[1]!));
    if (normalised !== null) {
      return clamp1to10(normalised);
    }
  }

  // 5. Verb phrasing: "I'd rate this 9", "I would rate it 8.5", "rate this a 9".
  const rateVerb = output.match(/\brate(?:\s+(?:this|it))?\s+(?:a\s+)?(\d+(?:\.\d+)?)/i);
  if (rateVerb) {
    const normalised = normaliseBareNumber(parseFloat(rateVerb[1]!));
    if (normalised !== null) {
      return clamp1to10(normalised);
    }
  }

  return null;
}

/**
 * Normalise a bare score number (no explicit denominator) onto 0–10:
 *   0–10   → as-is
 *   11–100 → 0–100 scale, divide by 10
 *   >100   → not a score (null)
 */
function normaliseBareNumber(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value <= 10) return value;
  if (value <= 100) return value / 10;
  return null;
}

/**
 * Perfect-score feedback filtering (v0.11.0) — adapted from GEPA's
 * `skip_perfect_score` for Darwin's online evolution loop.
 *
 * What upstream actually does (gepa-ai `reflective_mutation.py`): after
 * sampling a minibatch and scoring the candidate on it, GEPA skips the WHOLE
 * reflection iteration when EVERY minibatch score is perfect — it does not drop
 * individual instances, and a perfect instance inside a mixed minibatch is kept
 * (positive contrast for the reflector).
 *
 * Darwin generalizes this to per-report filtering, which upstream can't do
 * cheaply but Darwin can: the critic scores on real runs are already paid for,
 * so there is no eval-budget reason to keep perfect ("nothing to fix") reports
 * in the pool the reflector / legacy optimizer learns from. Dropping them
 * concentrates the feedback on runs that actually went wrong. (The perfect runs
 * are not wasted — with `useDemos` they are harvested as demonstrations, so
 * failures feed reflection and successes feed demos.)
 *
 * Purity: no I/O, no LLM calls, deterministic. The predicate is generic over
 * any `{ score: number }` so both feedback assemblers in the loop
 * (`getReflectiveFeedback` → `ReflectiveFeedback`, `getRecentFeedback` →
 * built-inline) share one source of truth and cannot drift. The loop filters
 * inline during the feedback-window fill (so skipped items don't count toward
 * the window `limit`); `filterPerfectFeedback` is exported as a convenience for
 * consumers assembling their own feedback lists.
 */

/**
 * Critic scores are on the 1–10 scale (see `parse-score.ts`). The default
 * perfect threshold is a literal top score — only 10/10 is skipped unless the
 * caller lowers it.
 */
export const DEFAULT_PERFECT_FEEDBACK_SCORE = 10;

/**
 * Resolve a perfect-score threshold to a usable value: finite and within the
 * critic 1–10 scale, else the default. A non-finite / out-of-range config
 * value (hand-edited file, `NaN`) must never silently disable or invert the
 * filter — it falls back to {@link DEFAULT_PERFECT_FEEDBACK_SCORE}.
 */
export function resolvePerfectFeedbackScore(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PERFECT_FEEDBACK_SCORE;
  }
  if (value < 1 || value > 10) return DEFAULT_PERFECT_FEEDBACK_SCORE;
  return value;
}

/**
 * True when a run's critic score is at or above the perfect threshold and so
 * carries no improvement gradient. A non-finite score (missing / unparsed) is
 * never "perfect" — it is kept so a genuinely broken run still surfaces to the
 * optimizer rather than being silently dropped as if it were flawless.
 */
export function isPerfectScore(score: number, threshold: number): boolean {
  if (!Number.isFinite(score)) return false;
  return score >= threshold;
}

/**
 * Drop perfect-score items from a feedback list. Generic over `{ score }` so
 * the exact feedback shape is the caller's; order is preserved.
 */
export function filterPerfectFeedback<T extends { score: number }>(
  items: readonly T[],
  threshold: number,
): T[] {
  return items.filter((item) => !isPerfectScore(item.score, threshold));
}

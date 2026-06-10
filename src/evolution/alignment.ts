/**
 * Darwin — Alignment Preservation Guard (shared, v0.6.0).
 *
 * Single source of truth for the safety-keyword preservation check. BOTH
 * the legacy single-shot {@link PromptOptimizer} AND the GEPA reflective
 * loop path (v0.6) run this guard on every mutated prompt — a mutation
 * that drops safety constraints ("never", "do not", "must not", …) is
 * rejected so self-evolution cannot silently erode alignment.
 *
 * Why this module exists (v0.6.0): before the GEPA optimizer was wired
 * into {@link DarwinLoop}, this check lived ONLY as a private method on
 * `PromptOptimizer`. The Reflector / `GepaOptimizer.merge` paths had no
 * alignment guard. Wiring GEPA into the loop without extracting the check
 * to a shared layer would have opened a safety-regression hole — the new
 * mutation path could quietly strip "never reveal secrets" and ship it.
 * Extracting it here means every mutation path, old and new, runs the
 * exact same guard.
 *
 * The check is intentionally conservative: it counts occurrences of each
 * safety pattern in the original and rejects the mutation if any pattern's
 * count drops. It cannot understand semantics (a reworded-but-equivalent
 * constraint is also rejected) — that false-positive is deliberate. A
 * rejected mutation costs one evolution cycle; a silently weakened safety
 * instruction shipped to production is unbounded. Fail closed.
 */

/**
 * Safety / alignment keyword patterns whose occurrence count must not
 * decrease across a mutation. Each pattern's `.source` is re-compiled with
 * the `gi` flag in {@link checkAlignmentPreservation} and matched against the
 * lower-cased original + mutated prompts, so the per-entry `/i` flag is
 * informational only. Kept as an explicit, auditable list.
 *
 * v0.6.0: the three case-variant duplicates the legacy optimizer carried
 * (`/\bdo NOT\b/`, `/\bNEVER\b/`, `/\bMUST NOT\b/`) were dropped — under the
 * `gi` recompile they were exact duplicates of the `/i` entries above and
 * only produced doubled keyword names in the rejection message. The
 * accept/reject decision is unchanged.
 */
export const SAFETY_PATTERNS: RegExp[] = [
  /\bdo not\b/i,
  /\bnever\b/i,
  /\bmust not\b/i,
  /\bavoid\b/i,
  /\brefuse\b/i,
  /\bprohibit/i,
  /\bforbid/i,
  /\bsafety\b/i,
  /\bethic/i,
  /\balignment\b/i,
];

/**
 * Check that a mutated prompt preserves the safety-related keywords from
 * the original.
 *
 * @returns `null` if the mutation is safe (no safety keyword count dropped),
 *   or a human-readable rejection reason naming the eroded keywords.
 */
export function checkAlignmentPreservation(
  original: string,
  mutated: string,
): string | null {
  const originalLower = original.toLowerCase();
  const mutatedLower = mutated.toLowerCase();

  const removedKeywords: string[] = [];

  for (const pattern of SAFETY_PATTERNS) {
    const originalMatches = originalLower.match(new RegExp(pattern.source, 'gi'));
    const mutatedMatches = mutatedLower.match(new RegExp(pattern.source, 'gi'));

    if (originalMatches && originalMatches.length > 0) {
      const mutatedCount = mutatedMatches ? mutatedMatches.length : 0;
      if (mutatedCount < originalMatches.length) {
        removedKeywords.push(pattern.source.replace(/\\b/g, '').replace(/\\/g, ''));
      }
    }
  }

  if (removedKeywords.length > 0) {
    return `Alignment erosion detected: safety keywords removed or reduced: ${removedKeywords.join(', ')}`;
  }

  return null;
}

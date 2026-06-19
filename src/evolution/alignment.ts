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

// ─── v0.7.0 — semantic (embedding-distance) alignment guard ──────────

/**
 * Batch embedding function. Returns one vector per input text (same order).
 * INJECTED — Darwin keeps zero hard deps, so the caller supplies the embedder
 * (OpenAI `text-embedding-3-small`, a local model, Anthropic, whatever). Pure
 * keyword checking needs none of this; semantic checking is strictly opt-in.
 *
 * NEW v0.7.0.
 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface SemanticAlignmentOptions {
  /** Injected batch embedder. When omitted, the check is keyword-only (fail-closed). */
  embed?: EmbedFn;
  /**
   * Cosine-similarity threshold above which an eroded safety keyword is judged
   * to have been REWORDED (not removed) and the mutation is accepted. Default
   * 0.82 — high enough that only a genuinely equivalent restatement passes.
   */
  minSafetySimilarity?: number;
}

const DEFAULT_SAFETY_SIMILARITY = 0.82;

/**
 * Semantic alignment guard (v0.7.0) — the embedding-distance upgrade to the
 * keyword-count {@link checkAlignmentPreservation}. The keyword check is
 * conservative BY DESIGN: it rejects a reworded-but-equivalent constraint
 * ("never reveal secrets" → "you must keep secrets confidential") as if the
 * safety instruction were removed. That false-positive costs a wasted
 * evolution cycle every time the optimizer legitimately rephrases.
 *
 * This function keeps the keyword check as the first, cheap gate, and ONLY
 * when it trips does it spend embeddings to ask: "is the safety statement
 * still semantically present, just worded differently?" For every safety
 * sentence in the original that contained an eroded keyword, it checks whether
 * the mutated prompt still contains a sentence above `minSafetySimilarity`. If
 * EVERY eroded safety sentence has a close semantic match, the rewording is
 * accepted (returns null). Otherwise the keyword rejection stands.
 *
 * Fail-closed contract preserved:
 *   - keyword check passes ⇒ null (no embedding spent)
 *   - keyword check fails AND no `embed` supplied ⇒ keyword rejection (== sync)
 *   - keyword check fails, embed supplied, embedding errors ⇒ keyword rejection
 *
 * So a missing/broken embedder NEVER weakens the guard — it just falls back to
 * the strict keyword behaviour.
 */
export async function checkAlignmentPreservationSemantic(
  original: string,
  mutated: string,
  opts: SemanticAlignmentOptions = {},
): Promise<string | null> {
  const keywordResult = checkAlignmentPreservation(original, mutated);
  if (keywordResult === null) return null; // safe — fast path, no embeddings
  if (!opts.embed) return keywordResult; // fail-closed: keyword-only

  const threshold =
    Number.isFinite(opts.minSafetySimilarity) &&
    (opts.minSafetySimilarity as number) > 0 &&
    (opts.minSafetySimilarity as number) <= 1
      ? (opts.minSafetySimilarity as number)
      : DEFAULT_SAFETY_SIMILARITY;

  // Which patterns actually eroded? Re-derive from SAFETY_PATTERNS.
  const eroded = erodedPatterns(original, mutated);
  if (eroded.length === 0) return keywordResult; // shouldn't happen, be safe

  // Original sentences carrying an eroded safety keyword = the statements we
  // must prove still exist (semantically) in the mutated prompt.
  const originalSentences = splitSentences(original);
  const safetySentences = originalSentences.filter((s) =>
    eroded.some((p) => new RegExp(p.source, 'i').test(s)),
  );
  if (safetySentences.length === 0) return keywordResult;

  const mutatedSentences = splitSentences(mutated);
  if (mutatedSentences.length === 0) return keywordResult; // nothing to match → reject

  try {
    // One batched embed call: [...safetySentences, ...mutatedSentences].
    const all = await opts.embed([...safetySentences, ...mutatedSentences]);
    if (!Array.isArray(all) || all.length !== safetySentences.length + mutatedSentences.length) {
      return keywordResult; // malformed embedder output → fail-closed
    }
    const safetyVecs = all.slice(0, safetySentences.length);
    const mutatedVecs = all.slice(safetySentences.length);

    // Every eroded safety sentence must have a close match in the mutation.
    for (const sv of safetyVecs) {
      let best = -Infinity;
      for (const mv of mutatedVecs) {
        const sim = cosine(sv, mv);
        if (sim > best) best = sim;
      }
      if (!(best >= threshold)) {
        // This safety statement has no semantic equivalent in the mutation.
        return keywordResult;
      }
    }
    // All eroded safety statements survive semantically → reworded, accept.
    return null;
  } catch {
    return keywordResult; // embedder threw → fail-closed
  }
}

/** SAFETY_PATTERNS whose occurrence count dropped from original → mutated. */
function erodedPatterns(original: string, mutated: string): RegExp[] {
  const o = original.toLowerCase();
  const m = mutated.toLowerCase();
  const out: RegExp[] = [];
  for (const pattern of SAFETY_PATTERNS) {
    const oc = o.match(new RegExp(pattern.source, 'gi'))?.length ?? 0;
    const mc = m.match(new RegExp(pattern.source, 'gi'))?.length ?? 0;
    if (oc > 0 && mc < oc) out.push(pattern);
  }
  return out;
}

/**
 * Split prose into trimmed, non-empty sentences. Boundaries: terminal
 * punctuation followed by whitespace, terminal punctuation directly followed
 * by an uppercase letter (handles "...secrets.Be transparent." with no space —
 * otherwise two sentences fuse and a dropped safety constraint could ride in
 * on a partial semantic match), or newlines.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|(?<=[.!?])(?=[A-Z])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Cosine similarity. Returns 0 for zero/length-mismatched/non-finite vectors. */
function cosine(a: number[], b: number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

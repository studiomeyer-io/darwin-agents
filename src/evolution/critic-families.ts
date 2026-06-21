/**
 * Cross-family critic diversity check.
 *
 * LLM-as-judge bias is materially reduced when the critics that score an
 * agent's output come from more than one model *family* (e.g. GPT + Claude):
 * different training pipelines carry different blind spots, so a disagreement
 * between families is a stronger quality signal than agreement within one.
 *
 * Darwin's `resolveCriticProviders` already spreads critics across families
 * WHEN the provider keys are present — but when only one provider is
 * configured, all three critics silently collapse onto a single family and the
 * diversity guarantee is gone with no signal to the operator. This module makes
 * that observable (warn by default) and enforceable (opt-in, env-gated).
 *
 * Important nuance: `claude-cli` and `anthropic-api` are the SAME family (both
 * Anthropic); they differ only in latency. Real family diversity needs a
 * non-Anthropic provider key (OpenAI, Ollama, …). The check therefore keys on
 * the model *family*, never on the provider label.
 */

/** Minimal shape needed from a resolved critic provider entry. */
export interface CriticFamilyInfo {
  /** Model family — e.g. 'anthropic', 'openai', 'ollama'. */
  family: string;
}

export interface CrossFamilyCheck {
  /** Distinct, non-empty families across all critics, sorted alphabetically. */
  families: string[];
  /** Number of distinct families. */
  count: number;
  /**
   * True when every critic shares a single family (judge bias unmitigated).
   * A degenerate empty critic map is also reported as single-family — it is
   * not a diversity win.
   */
  singleFamily: boolean;
}

/**
 * Count the distinct model families across a resolved critic-provider map.
 * Pure and deterministic. Blank / non-string families are ignored so a
 * mis-populated entry can never inflate the diversity count.
 */
export function checkCriticFamilies(
  providers: Record<string, CriticFamilyInfo>,
): CrossFamilyCheck {
  const families = Array.from(
    new Set(
      Object.values(providers)
        .map((p) => (typeof p?.family === 'string' ? p.family.trim().toLowerCase() : ''))
        .filter((f) => f.length > 0),
    ),
  ).sort();

  return {
    families,
    count: families.length,
    singleFamily: families.length < 2,
  };
}

/**
 * Whether cross-family critics are *required* (hard fail) rather than merely
 * recommended (warn). Gated by `DARWIN_REQUIRE_CROSS_FAMILY` so CI can enforce
 * it without changing the default developer experience.
 */
export function crossFamilyRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.DARWIN_REQUIRE_CROSS_FAMILY;
  return v === '1' || v === 'true' || v === 'yes';
}

/** Operator-facing message when the critics collapse onto one family. */
export function singleFamilyHint(check: CrossFamilyCheck): string {
  const fam = check.families[0] ?? 'unknown';
  return (
    `All critics run on one model family (${fam}). ` +
    `Cross-family critique reduces LLM-as-judge bias — set OPENAI_API_KEY ` +
    `(or another non-Anthropic provider key) so a second family scores in parallel.`
  );
}

/**
 * Darwin — Reflective Text Feedback (Phase 2 A2, S1185 follow-up).
 *
 * GEPA's signature insight: instead of guiding mutation by a single
 * scalar reward, give the optimizer rich TEXT feedback ("what went
 * wrong, what to fix, what NOT to change") and let it synthesise the
 * mutation from that feedback.
 *
 * This module is a pure TS port of the GEPA-style reflector — no
 * Python sidecar, no hard dep on `@gepa-ai/gepa`. The reflector takes
 * a current prompt + a set of (variant, score, trace) feedbacks and
 * asks an injected LLM to write a SMALLEST-POSSIBLE-EDIT mutation of
 * the current prompt that addresses the failure modes.
 *
 * Reference snippet from GEPA docs:
 *
 *   "Make the smallest possible targeted edit to fix the identified
 *    failure mode. Preserve all existing correct behavior. Do not
 *    rewrite from scratch."
 *
 * The module is composable with the existing `PromptOptimizer` —
 * `GepaOptimizer` (next file) coordinates Reflector + paretoSelect into
 * a generation loop. The reflector itself is single-shot.
 *
 * **Inspired by, not lifted from** the official `gepa-ai/gepa` Python
 * library. This is a pure TS port of GEPA's core ideas (Pareto-front +
 * reflective mutation) — see `optimizer-gepa.ts` for the deliberate
 * deviations from Algorithm 1/2 of the GEPA paper (arxiv 2507.19457).
 * For a feature-complete GEPA experience use the upstream Python tool.
 *
 * **Stronger reflection LM (V0.5.1, S1235):** GEPA's official guidance
 * is to use a STRONGER LM for reflection than for task execution
 * (their `reflection_lm` parameter). Direct support shipped in V0.5.1
 * via `GepaOptimizerOptions.reflectionRunPrompt` on `GepaOptimizer`'s
 * constructor — the override is wired into the internal Reflector so
 * `reflect()` calls route through the stronger LM. The `Reflector`
 * class itself remains single-LM by design (the override lives one
 * layer up in `GepaOptimizer`).
 */

import type { ExecutionTrace } from "../types.js";
import type { RunPromptFn } from "./run-prompt-fn.js";

// Re-export for convenience — callers can import RunPromptFn from here
// or from the dedicated module. Single source of truth lives in
// `./run-prompt-fn.ts` (S1185 R1 Analyst Finding A1).
export type { RunPromptFn };

/** One variant's evaluation feedback, fed into the reflector. */
export interface ReflectiveFeedback {
  /** Identifier of the variant this feedback refers to (e.g. "v3"). */
  variantId: string;
  /** Scalar score for at-a-glance ranking. */
  score: number;
  /**
   * Rich text feedback describing what went well, what failed, and
   * (ideally) WHY. The richer this is, the better the mutation. GEPA
   * docs recommend including: expected vs. actual, specific issue
   * analysis, and any provider-side error class.
   */
  textFeedback: string;
  /** Optional execution trace (A1 trajectory) for tool-level context. */
  trace?: ExecutionTrace;
  /** Optional: the variant's prompt text itself (helps the reflector compare). */
  variantPrompt?: string;
}

/**
 * Options accepted by {@link Reflector#reflect}.
 */
export interface ReflectOptions {
  /**
   * Override the reflection prompt template. Default is GEPA's
   * "smallest possible targeted edit" template. Use a custom template
   * when you want different mutation pressure (e.g. exploratory vs.
   * conservative).
   */
  reflectionPromptTemplate?: string;
  /**
   * Max characters of `textFeedback` included per variant. Default
   * 2000 — keeps the meta-prompt under typical context windows even
   * with N=5 variants.
   */
  feedbackCap?: number;
  /**
   * Hard upper bound on the returned mutated-prompt length. Default
   * `Math.max(currentPrompt.length * 1.3, 3500)` — same growth ceiling
   * as `PromptOptimizer.generateVariant` for symmetry.
   */
  maxMutationLength?: number;
}

const DEFAULT_FEEDBACK_CAP = 2000;
const DEFAULT_REFLECTION_TEMPLATE = `
You are a prompt-engineering reflector. Below is an instruction prompt followed by feedback from {N} variant evaluations.

CURRENT INSTRUCTION:
\`\`\`
{CURRENT_PROMPT}
\`\`\`

VARIANT FEEDBACKS:
{FEEDBACKS}

Task: produce the SMALLEST POSSIBLE TARGETED EDIT of the CURRENT INSTRUCTION that:
  - addresses the lowest-scoring failure modes identified above,
  - preserves all existing correct behavior (do NOT rewrite from scratch),
  - keeps the same overall length envelope (no growth beyond ~30%).

Return ONLY the updated instruction text. No prose, no explanations, no markdown fences.
`.trim();

/**
 * Single-shot reflector. Wraps one LLM call that takes the current
 * prompt + per-variant feedback and returns a mutated prompt.
 */
export class Reflector {
  private readonly runPrompt: RunPromptFn;

  constructor(runPrompt: RunPromptFn) {
    if (typeof runPrompt !== "function") {
      throw new TypeError("Reflector: runPrompt must be a function");
    }
    this.runPrompt = runPrompt;
  }

  /**
   * Build a reflection meta-prompt and ask the injected LLM for a
   * mutated prompt. Returns the mutated prompt text (cleaned + capped).
   *
   * Throws `TypeError` if `currentPrompt` is empty or `feedbacks` is
   * empty — meaningless inputs are a programmer bug, not a runtime
   * edge.
   */
  async reflect(
    currentPrompt: string,
    feedbacks: ReadonlyArray<ReflectiveFeedback>,
    opts: ReflectOptions = {},
  ): Promise<string> {
    if (typeof currentPrompt !== "string" || currentPrompt.length === 0) {
      throw new TypeError("Reflector.reflect: currentPrompt must be a non-empty string");
    }
    if (feedbacks.length === 0) {
      throw new TypeError("Reflector.reflect: feedbacks must contain at least one entry");
    }

    const template = opts.reflectionPromptTemplate ?? DEFAULT_REFLECTION_TEMPLATE;
    // R1 V0.5.0-alpha.2 Critic Finding H2 + R2 Critic Finding R2-C1
    // (S1185): clamp feedbackCap to a positive finite integer.
    // `Math.max(1, Math.floor(NaN))` is `NaN` — would silently zero
    // every feedback (`slice(0, NaN) === ""`). Explicit `Number.isFinite`
    // guard rejects NaN/Infinity and falls back to the default.
    const rawCap = opts.feedbackCap ?? DEFAULT_FEEDBACK_CAP;
    const cap =
      Number.isFinite(rawCap) && rawCap > 0
        ? Math.floor(rawCap)
        : DEFAULT_FEEDBACK_CAP;

    const feedbackBlock = feedbacks
      .map((f, i) => this.formatFeedback(f, i + 1, cap))
      .join("\n\n");

    // R1 V0.5.0-alpha.2 Critic Finding H1 (S1185): substitute
    // `{CURRENT_PROMPT}` LAST so a user prompt that happens to contain
    // `{N}` or `{FEEDBACKS}` literally cannot trigger double-substitution.
    // String.prototype.replace replaces only the first occurrence — by
    // ordering the user-controlled substitution last, no template-injection
    // path remains.
    const metaPrompt = template
      .replace("{N}", String(feedbacks.length))
      .replace("{FEEDBACKS}", feedbackBlock)
      .replace("{CURRENT_PROMPT}", currentPrompt);

    let mutated = await this.runPrompt(metaPrompt);
    mutated = this.cleanOutput(mutated);

    const maxLength =
      opts.maxMutationLength ?? Math.max(Math.round(currentPrompt.length * 1.3), 3500);
    if (mutated.length > maxLength) {
      mutated = this.truncateAtSentenceBoundary(mutated, maxLength);
    }

    return mutated;
  }

  /** Single-feedback formatter. */
  private formatFeedback(
    fb: ReflectiveFeedback,
    index: number,
    cap: number,
  ): string {
    const cappedText =
      fb.textFeedback.length > cap
        ? fb.textFeedback.slice(0, cap) + "\n[...truncated]"
        : fb.textFeedback;
    const lines: string[] = [
      `=== Variant ${index} — ${fb.variantId} (score ${fb.score.toFixed(2)}) ===`,
      `Feedback:`,
      cappedText,
    ];
    if (fb.trace) {
      const toolNames = Array.from(
        new Set((fb.trace.toolCalls ?? []).map((c) => c.tool)),
      ).slice(0, 5);
      if (toolNames.length > 0) {
        lines.push(`Trace summary: ${fb.trace.turnCount} turns, ` +
          `${fb.trace.toolCalls?.length ?? 0} tool calls (top: ${toolNames.join(", ")}), ` +
          `${fb.trace.errors?.length ?? 0} errors.`);
      }
    }
    return lines.join("\n");
  }

  /** Strip markdown fences and leading/trailing whitespace. */
  private cleanOutput(raw: string): string {
    let out = raw.trim();
    // Strip ```...``` fences if the LLM ignored "no fences"
    const fence = out.match(/^```[a-z]*\n?([\s\S]*?)\n?```$/i);
    if (fence) out = fence[1]!.trim();
    return out;
  }

  /** Truncate at the last sentence/newline boundary within `maxLength`. */
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
}

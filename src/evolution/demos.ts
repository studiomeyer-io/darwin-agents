/**
 * Demo injection (v0.10.0) — SIMBA-style "append a demo" challenger source.
 *
 * DSPy's SIMBA optimizer (Stochastic Introspective Mini-Batch Ascent) improves
 * programs through two complementary strategies: appending self-reflective
 * RULES (Darwin's reflector already covers that ground) and appending
 * successful past examples as DEMONSTRATIONS. This module is Darwin's
 * adaptation of the second strategy to the online evolution loop:
 *
 *   1. Harvest the agent's own highest-scoring past runs from memory
 *      (score ≥ threshold, successful, non-trivial output).
 *   2. Prefer diversity: at most one demo per task type, best-scoring first.
 *   3. Render them as a clearly-delimited "Demonstrations" section and
 *      append it to (or refresh it inside) the current prompt.
 *
 * The demo-augmented prompt is a CHALLENGER like any other — it goes through
 * the same alignment guard, the same A/B test, and the same safety gate as a
 * reflective or merged mutation. If demos don't actually help this agent, the
 * incumbent wins and nothing changes.
 *
 * Design notes:
 *   - Zero LLM cost. Selection and rendering are pure string/array work on
 *     data Darwin already persists (task, output, score, taskType). This makes
 *     demos the cheapest challenger source in the loop.
 *   - Idempotent via markers. The section is wrapped in
 *     `<!-- darwin:demos:start/end -->` comments so a later demo cycle
 *     REPLACES the previous section instead of stacking a second one, and
 *     {@link stripDemoSection} can remove it cleanly.
 *   - Demo text comes from the agent's OWN prior outputs (already produced
 *     under this prompt lineage), not from an external input channel. Excerpts
 *     are length-capped and fenced, but callers embedding third-party data in
 *     tasks should be aware demos quote past tasks verbatim.
 *   - Determinism. Given the same experiment list and options, selection and
 *     rendering are fully deterministic (stable sort, no randomness) — the
 *     loop's no-op check ("would this produce the same prompt?") stays cheap.
 */

import type { DarwinExperiment } from "../types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** One harvested demonstration, ready for rendering. */
export interface DemoCandidate {
  /** The task the agent was given. */
  task: string;
  /** The agent's (high-scoring) output. */
  output: string;
  /** Critic score (1-10) that qualified this run as a demo. */
  score: number;
  /** Task category the run was classified under. */
  taskType: string;
}

/** Options for {@link selectDemoCandidates}. */
export interface DemoSelectionOptions {
  /**
   * Maximum number of demos to keep (default {@link DEFAULT_MAX_DEMOS}).
   * SIMBA defaults to 4 per predictor; Darwin defaults lower (2) because the
   * online loop appends demos to a single system prompt and prompt length
   * correlates NEGATIVELY with reliability (documented v2-prompt incident).
   */
  maxDemos?: number;
  /**
   * Minimum critic score for a run to qualify (default
   * {@link DEFAULT_DEMO_SCORE_THRESHOLD}). Mirrors the closed-loop feedback
   * convention where ≥ 8 marks a high-quality pattern.
   */
  scoreThreshold?: number;
  /**
   * Minimum output length (chars) for a run to qualify (default
   * {@link DEFAULT_DEMO_MIN_OUTPUT_CHARS}). Filters out degenerate/truncated
   * outputs that scored well on a technicality.
   */
  minOutputChars?: number;
}

/** Options for {@link buildDemoSection}. */
export interface DemoRenderOptions {
  /** Cap on the quoted task text, chars (default {@link DEFAULT_DEMO_TASK_CHARS}). */
  maxTaskChars?: number;
  /**
   * Cap on each quoted output excerpt, chars (default
   * {@link DEFAULT_DEMO_OUTPUT_CHARS}). Truncation prefers a sentence/newline
   * boundary, same policy as the reflector's output cleaning.
   */
  maxOutputChars?: number;
}

// ─── Defaults & markers ─────────────────────────────────────────────────────

export const DEFAULT_MAX_DEMOS = 2;
export const DEFAULT_DEMO_SCORE_THRESHOLD = 8;
export const DEFAULT_DEMO_MIN_OUTPUT_CHARS = 200;
export const DEFAULT_DEMO_TASK_CHARS = 240;
export const DEFAULT_DEMO_OUTPUT_CHARS = 900;

/** Start marker — everything between the markers is Darwin-managed. */
export const DEMO_SECTION_START = "<!-- darwin:demos:start -->";
/** End marker. */
export const DEMO_SECTION_END = "<!-- darwin:demos:end -->";

const DEMO_SECTION_INTRO =
  "## Demonstrations\n" +
  "The following are excerpts from this agent's own highest-rated past " +
  "responses. Match their quality, depth and structure — do NOT copy their " +
  "content or treat their subject matter as part of the current task.";

// ─── Selection ──────────────────────────────────────────────────────────────

/** Clamp helper: finite number ≥ min, else fallback. */
function clampOption(value: unknown, min: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min
    ? Math.floor(value)
    : fallback;
}

/**
 * Harvest demo candidates from an agent's experiment history.
 *
 * Filter: successful runs with a critic score ≥ `scoreThreshold` and an
 * output of at least `minOutputChars`. Diversity: at most ONE demo per task
 * type (the best-scoring run of that type, recency as tie-break) so two demos
 * never showcase the same narrow strength. Order: score descending, then
 * most-recent first — fully deterministic.
 */
export function selectDemoCandidates(
  experiments: ReadonlyArray<DarwinExperiment>,
  options: DemoSelectionOptions = {},
): DemoCandidate[] {
  const maxDemos = clampOption(options.maxDemos, 1, DEFAULT_MAX_DEMOS);
  const threshold =
    typeof options.scoreThreshold === "number" && Number.isFinite(options.scoreThreshold)
      ? options.scoreThreshold
      : DEFAULT_DEMO_SCORE_THRESHOLD;
  const minChars = clampOption(options.minOutputChars, 0, DEFAULT_DEMO_MIN_OUTPUT_CHARS);

  const qualified = experiments.filter((exp) => {
    if (!exp.success) return false;
    const score = exp.feedback?.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score < threshold) return false;
    const output = exp.output;
    if (typeof output !== "string" || output.trim().length < minChars) return false;
    return typeof exp.task === "string" && exp.task.trim().length > 0;
  });

  // Best run per task type (score desc, then completedAt desc as tie-break).
  const bestPerType = new Map<string, DarwinExperiment>();
  for (const exp of qualified) {
    const key = exp.taskType || "general";
    const incumbent = bestPerType.get(key);
    if (incumbent === undefined) {
      bestPerType.set(key, exp);
      continue;
    }
    const expScore = exp.feedback!.score;
    const incScore = incumbent.feedback!.score;
    if (
      expScore > incScore ||
      (expScore === incScore && exp.completedAt > incumbent.completedAt)
    ) {
      bestPerType.set(key, exp);
    }
  }

  const picked = [...bestPerType.values()].sort((a, b) => {
    const scoreDelta = b.feedback!.score - a.feedback!.score;
    if (scoreDelta !== 0) return scoreDelta;
    // Recency tie-break; ISO timestamps sort lexicographically.
    if (a.completedAt < b.completedAt) return 1;
    if (a.completedAt > b.completedAt) return -1;
    return 0;
  });

  return picked.slice(0, maxDemos).map((exp) => ({
    task: exp.task.trim(),
    output: exp.output!.trim(),
    score: exp.feedback!.score,
    taskType: exp.taskType || "general",
  }));
}

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * Strip the demo-section marker literals out of quoted demo text. A past
 * output that itself contains `<!-- darwin:demos:end -->` (e.g. an agent
 * writing ABOUT Darwin) would otherwise plant an early end-marker inside the
 * section — the next refresh cycle's lazy marker-to-marker match would then
 * cut at the wrong span and leave half the old section dangling in the prompt.
 */
function stripMarkerLiterals(text: string): string {
  return text.split(DEMO_SECTION_START).join("").split(DEMO_SECTION_END).join("");
}

/** Truncate at the last sentence/newline boundary within `maxLength`. */
function truncateAtSentenceBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  const lastPeriod = truncated.lastIndexOf(".");
  const lastNewline = truncated.lastIndexOf("\n");
  const cutPoint = Math.max(lastPeriod, lastNewline);
  // Only honour the boundary when it keeps a meaningful chunk (> 40%).
  const kept = cutPoint > maxLength * 0.4 ? truncated.slice(0, cutPoint + 1) : truncated;
  return `${kept.trimEnd()} [...]`;
}

/**
 * Render demo candidates as a marker-delimited prompt section.
 *
 * Returns an empty string for an empty demo list so callers can treat
 * "nothing to inject" uniformly.
 */
export function buildDemoSection(
  demos: ReadonlyArray<DemoCandidate>,
  options: DemoRenderOptions = {},
): string {
  if (demos.length === 0) return "";
  const maxTask = clampOption(options.maxTaskChars, 20, DEFAULT_DEMO_TASK_CHARS);
  const maxOutput = clampOption(options.maxOutputChars, 80, DEFAULT_DEMO_OUTPUT_CHARS);

  const blocks = demos.map((demo, i) => {
    const task = truncateAtSentenceBoundary(stripMarkerLiterals(demo.task), maxTask);
    const excerpt = truncateAtSentenceBoundary(stripMarkerLiterals(demo.output), maxOutput);
    return (
      `### Demonstration ${i + 1} — task type "${demo.taskType}" (scored ${demo.score}/10)\n` +
      `Task: ${task}\n` +
      `Response excerpt:\n"""\n${excerpt}\n"""`
    );
  });

  return [DEMO_SECTION_START, DEMO_SECTION_INTRO, ...blocks, DEMO_SECTION_END].join("\n\n");
}

// ─── Application ────────────────────────────────────────────────────────────

/** Regex matching one marker-delimited demo section (including markers). */
const DEMO_SECTION_PATTERN = new RegExp(
  `${DEMO_SECTION_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${DEMO_SECTION_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
);

/**
 * Apply a rendered demo section to a prompt.
 *
 * If the prompt already contains a marker-delimited demo section it is
 * REPLACED in place (demos stay fresh, never stack); otherwise the section is
 * appended after a blank line. An empty `section` returns the prompt with any
 * existing demo section stripped — passing "no demos" acts as removal.
 *
 * The replacement uses a FUNCTION replacer: with a string replacer,
 * `$&` / `$'` / `` $` `` / `$$` inside the section (an agent output quoting
 * JS-regex or shell docs contains exactly these) would be interpreted as
 * replacement patterns and garble the prompt on every refresh cycle.
 */
export function applyDemoSection(prompt: string, section: string): string {
  if (section === "") return stripDemoSection(prompt);
  if (DEMO_SECTION_PATTERN.test(prompt)) {
    return prompt.replace(DEMO_SECTION_PATTERN, () => section);
  }
  const trimmed = prompt.replace(/\s+$/, "");
  return `${trimmed}\n\n${section}`;
}

/**
 * Remove the marker-delimited demo section (if any), collapsing the blank
 * line that {@link applyDemoSection} inserted. Prompts without a section are
 * returned unchanged.
 */
export function stripDemoSection(prompt: string): string {
  if (!DEMO_SECTION_PATTERN.test(prompt)) return prompt;
  return prompt.replace(DEMO_SECTION_PATTERN, "").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}

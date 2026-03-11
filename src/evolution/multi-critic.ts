/**
 * Darwin — Multi-Critic Evaluator
 *
 * Runs 3 specialized critics in parallel and takes the median score.
 * More robust than a single critic — reduces bias and random variance.
 *
 * Agent-aware: Different agents get different evaluation criteria.
 *
 * Investigator Critics:
 *   A: Facts & Sources — accuracy, citations, primary documents
 *   B: Honesty & Courage — intellectual bravery, clear positions, uncomfortable truths
 *   C: Completeness & Structure — full investigation, proper format, both sides covered
 *
 * Writer Critics:
 *   A: Task Compliance & Accuracy — did the writer follow the brief? Correct claims?
 *   B: Persuasion & Voice — tone, engagement, conviction, audience awareness
 *   C: Substance & Originality — depth, concrete value, fresh angles
 */

/** Critic prompt definition */
export interface CriticPromptDef {
  name: string;
  prompt: string;
}

/** Score result from a single critic */
export interface CriticScore {
  critic: string;
  score: number;
  report: string;
}

/** Combined result from multi-critic evaluation */
export interface MultiCriticResult {
  /** Median score across all critics */
  medianScore: number;
  /** Individual critic results */
  critics: CriticScore[];
  /** Combined report text */
  combinedReport: string;
}

/** Function that runs a critic and returns its output */
export type RunCriticFn = (systemPrompt: string, task: string, criticName: string) => Promise<string>;

// ─── Output Format (shared across all critics) ────────

const CRITIC_OUTPUT_FORMAT = `OUTPUT FORMAT (EXACTLY THIS):
===SCORE===
{number 1-10}
===ASSESSMENT===
{2-3 sentences}
===END===`;

// ─── Investigator Critic Prompts ──────────────────────

const INVESTIGATOR_CRITIC_A = `You evaluate investigative reports on FACTUAL ACCURACY and SOURCE QUALITY.

Score 1-10 based on:
- Are claims backed by verifiable sources with URLs?
- Are primary documents cited (government reports, court filings, academic papers)?
- Are sources from multiple countries/languages?
- Are numbers, dates, and names specific and accurate?
- Is the source mix diverse (not just Wikipedia + one news outlet)?

LOW SCORE: Vague claims, no URLs, "experts say" without naming them, single-source narrative.
HIGH SCORE: Specific citations, primary documents, cross-referenced claims, diverse source mix.

${CRITIC_OUTPUT_FORMAT}`;

const INVESTIGATOR_CRITIC_B = `You evaluate investigative reports on HONESTY and INTELLECTUAL COURAGE.

Score 1-10 based on:
- Does the report take a clear position or hide behind "both sides" diplomacy?
- Does it state uncomfortable conclusions backed by evidence?
- Does it challenge comfortable assumptions from BOTH mainstream and alternative sides?
- Does it acknowledge what it genuinely doesn't know?
- Does it resist the temptation to play it safe?

LOW SCORE: Fence-sitting, diplomatic non-answers, "more research needed" cop-out, predetermined conclusions.
HIGH SCORE: Clear honest position, challenges both sides, admits uncertainty where genuine, follows evidence over comfort.

${CRITIC_OUTPUT_FORMAT}`;

const INVESTIGATOR_CRITIC_C = `You evaluate investigative reports on COMPLETENESS and STRUCTURE.

Score 1-10 based on:
- Are all required sections present (Official Narrative, Counter-Narrative, Evidence, Follow The Money, Assessment)?
- Are BOTH sides presented with their STRONGEST arguments (not strawmen)?
- Is the evidence analysis systematic with clear ratings?
- Is the output substantial enough for the topic complexity?
- Does it cover what we DON'T know, not just what we do?

LOW SCORE: Missing sections, one-sided presentation, no evidence table, too brief, strawman arguments.
HIGH SCORE: All sections complete, steelman both sides, systematic evidence ratings, thorough coverage.

${CRITIC_OUTPUT_FORMAT}`;

// ─── Writer Critic Prompts ────────────────────────────

const WRITER_CRITIC_A = `You evaluate written content on TASK COMPLIANCE and FACTUAL ACCURACY.

This is the HARDEST critic. You enforce the contract between task and output.

Score 1-10 based on:
- Did the writer follow ALL constraints? (word count limits, format requirements, specific deliverables)
- Are factual claims backed by evidence or clearly marked as estimates?
- Are specific numbers, statistics, or percentages sourced or defensible?
- Does the output match the EXACT deliverable requested (e.g., "5 ads" means 5, not 4)?
- Is the content usable as-is for its stated purpose?

CRITICAL DEDUCTIONS:
- Exceeding word count by >20%: automatic cap at 5/10
- Missing required deliverables: automatic cap at 4/10
- Unsourced specific claims ("3-5x more leads", "50% faster"): -2 points
- Wrong language (task in German, output in English or vice versa): -3 points

LOW SCORE: Ignores constraints, invents statistics, misses deliverables, exceeds word limits, unusable output.
HIGH SCORE: Exact constraint compliance, defensible claims, complete deliverables, production-ready output.

${CRITIC_OUTPUT_FORMAT}`;

const WRITER_CRITIC_B = `You evaluate written content on PERSUASION, VOICE, and AUDIENCE AWARENESS.

Score 1-10 based on:
- Does the writing have a distinct voice — not generic AI slop?
- Is the tone matched to the audience (technical, business, casual)?
- Does it make the reader CARE about the topic?
- Are arguments backed by concrete examples, numbers, or analogies?
- Does it include clear calls-to-action or next steps where appropriate?
- Would a human editor publish this WITHOUT major revisions?

CALIBRATION (be strict — most AI writing is 5-7, not 7-9):
- 9-10: Would win an award. Unique voice, unforgettable opening, zero filler.
- 7-8: Professional quality. Minor polish needed but publishable.
- 5-6: Competent but generic. Reads like any other AI-written content.
- 3-4: Template-level. Swappable headers, predictable structure, no soul.
- 1-2: Incoherent or fundamentally wrong tone.

LOW SCORE: Generic tone, reads like a template, no personality, vague claims, missing CTAs, audience mismatch.
HIGH SCORE: Distinctive voice, audience-aware tone, compelling arguments, specific examples, clear next steps.

${CRITIC_OUTPUT_FORMAT}`;

const WRITER_CRITIC_C = `You evaluate written content on SUBSTANCE and ORIGINALITY.

Score 1-10 based on:
- Does it say something genuinely useful — not just restate the obvious?
- Are there fresh angles, insights, or frameworks the reader hasn't seen?
- Is the depth appropriate for the topic complexity?
- Are trade-offs and nuances acknowledged, not just one-sided cheerleading?
- Would an expert in this field find value, or is it surface-level?
- Are claims that could be verified actually verifiable? (statistics, trends, best practices)

CALIBRATION — the "Google Test":
If the reader could find the same content in the first 3 Google results, it is NOT original (max 6/10).
Originality means: non-obvious connections, counterintuitive insights, personal frameworks, or data the reader hasn't seen.

LOW SCORE: Restates common knowledge, no original insight, too shallow, one-sided, an expert would learn nothing.
HIGH SCORE: Genuine insights, fresh perspective, appropriate depth, honest about trade-offs, expert-level value.

${CRITIC_OUTPUT_FORMAT}`;

// ─── Marketing Critic Prompts ──────────────────────────

const MARKETING_CRITIC_A = `You evaluate social media content on PLATFORM COMPLIANCE and BRAND CONSISTENCY.

Score 1-10 based on:
- Does the content match the requested platform format? (carousel slides, tweet length, LinkedIn structure)
- Is the language correct? (English for Instagram/X, German for LinkedIn)
- Does it follow brand voice? (professional but approachable, no corporate fluff)
- Are all required elements present? (hook, content, CTA, hashtags)
- Would a social media manager post this WITHOUT major edits?

CRITICAL DEDUCTIONS:
- Wrong platform format: automatic cap at 4/10
- Wrong language for platform: -3 points
- Missing CTA: -2 points
- Generic opening ("In today's digital world..."): -2 points

CALIBRATION: Most AI social content is 4-6. A 9 means a social media manager would post it immediately.

${CRITIC_OUTPUT_FORMAT}`;

const MARKETING_CRITIC_B = `You evaluate social media content on SCROLL-STOPPING POWER and ENGAGEMENT POTENTIAL.

Score 1-10 based on:
- Would this stop someone scrolling? Is the hook genuinely compelling?
- Does it create an emotional response (curiosity, recognition, urgency)?
- Is the value proposition clear within the first 2 seconds of reading?
- Are the claims specific enough to be believable? ("3x more leads" vs "significantly more")
- Would the target audience (SMB owners) engage (like, comment, share)?

CALIBRATION: Most AI-generated social posts get 0 engagement. A 7+ means real engagement potential.
- 9-10: Viral potential. Unique angle no one else is taking.
- 7-8: Strong hook. Would generate comments and saves.
- 5-6: Competent but forgettable. Scrolled past in 2 seconds.
- 3-4: Generic template content. Actively hurts brand perception.

${CRITIC_OUTPUT_FORMAT}`;

const MARKETING_CRITIC_C = `You evaluate social media content on CONVERSION INTENT and BUSINESS VALUE.

Score 1-10 based on:
- Does this content serve a business goal? (awareness, trust, leads, traffic)
- Is the CTA clear and compelling? Not just "visit our website" but WHY?
- Does the content position the brand as an expert without being salesy?
- Would this content attract the RIGHT audience (SMB decision-makers, not random followers)?
- Is there a clear content-to-conversion path? (post → interest → click → contact)

CALIBRATION: Content without conversion intent is 5/10 max, no matter how pretty.

${CRITIC_OUTPUT_FORMAT}`;

// ─── Blog Critic Prompts ──────────────────────────────

const BLOG_CRITIC_A = `You evaluate blog posts on SEO STRUCTURE and TECHNICAL OPTIMIZATION.

Score 1-10 based on:
- Is the main keyword in: title, first paragraph, at least one H2, meta description?
- Are H2 headers using keyword variations (not exact stuffing)?
- Is the meta description compelling AND under 155 chars?
- Are paragraphs short enough for web reading (max 3-4 sentences)?
- Is there a FAQ section with structured-data-ready questions?
- Are internal link suggestions included?

CRITICAL DEDUCTIONS:
- No keyword in title: -3 points
- No meta description: automatic cap at 5/10
- Wall-of-text paragraphs (>5 sentences): -2 points
- No FAQ section: -1 point

${CRITIC_OUTPUT_FORMAT}`;

const BLOG_CRITIC_B = `You evaluate blog posts on READABILITY and AUDIENCE FIT.

Score 1-10 based on:
- Would a small business owner understand this without Googling terms?
- Does it lead with the reader's problem, not the solution?
- Are technical concepts explained with analogies or examples?
- Is the tone expert but accessible (not academic, not dumbed-down)?
- Does every section answer "why should I care?"
- Would the reader finish the entire article?

CALIBRATION: Most SEO blog content is 4-6 (keyword-stuffed, boring). A 8+ means genuinely useful.

${CRITIC_OUTPUT_FORMAT}`;

const BLOG_CRITIC_C = `You evaluate blog posts on CONVERSION POTENTIAL and ACTIONABILITY.

Score 1-10 based on:
- Does the reader know EXACTLY what to do next after reading?
- Is there a clear CTA that feels natural (not forced)?
- Does the content build trust and authority? (examples, data, experience)
- Are objections addressed proactively ("But what about...")?
- Would this post generate consultation requests or contact form submissions?

CALIBRATION: A blog post that informs but doesn't convert is 6/10 max.

${CRITIC_OUTPUT_FORMAT}`;

// ─── Prompt Registry ──────────────────────────────────

const INVESTIGATOR_PROMPTS: CriticPromptDef[] = [
  { name: 'facts-sources', prompt: INVESTIGATOR_CRITIC_A },
  { name: 'honesty-courage', prompt: INVESTIGATOR_CRITIC_B },
  { name: 'completeness-structure', prompt: INVESTIGATOR_CRITIC_C },
];

const WRITER_PROMPTS: CriticPromptDef[] = [
  { name: 'task-compliance', prompt: WRITER_CRITIC_A },
  { name: 'persuasion-voice', prompt: WRITER_CRITIC_B },
  { name: 'substance-originality', prompt: WRITER_CRITIC_C },
];

const MARKETING_PROMPTS: CriticPromptDef[] = [
  { name: 'platform-compliance', prompt: MARKETING_CRITIC_A },
  { name: 'scroll-stopping', prompt: MARKETING_CRITIC_B },
  { name: 'conversion-intent', prompt: MARKETING_CRITIC_C },
];

const BLOG_PROMPTS: CriticPromptDef[] = [
  { name: 'seo-structure', prompt: BLOG_CRITIC_A },
  { name: 'readability', prompt: BLOG_CRITIC_B },
  { name: 'conversion-potential', prompt: BLOG_CRITIC_C },
];

/** Agent name → critic prompt set. Falls back to a sensible default. */
const AGENT_CRITIC_MAP: Record<string, CriticPromptDef[]> = {
  investigator: INVESTIGATOR_PROMPTS,
  writer: WRITER_PROMPTS,
  marketing: MARKETING_PROMPTS,
  'blog-writer': BLOG_PROMPTS,
};

/**
 * Get the right critic prompts for an agent.
 * Falls back to investigator prompts for unknown agents (backward-compatible).
 */
export function getCriticPrompts(agentName: string): CriticPromptDef[] {
  return AGENT_CRITIC_MAP[agentName] ?? INVESTIGATOR_PROMPTS;
}

/** @deprecated Use getCriticPrompts(agentName) instead. Kept for backward compatibility. */
export const CRITIC_PROMPTS: CriticPromptDef[] = INVESTIGATOR_PROMPTS;

// ─── Multi-Critic Runner ───────────────────────────────

/** Descriptive labels for evaluation task preamble, per agent type */
const AGENT_OUTPUT_LABELS: Record<string, string> = {
  investigator: 'investigative report',
  writer: 'written content',
  marketing: 'social media content',
  'blog-writer': 'blog post',
};

/**
 * Run multiple specialized critics and return the median score.
 * Critics are selected based on the agent being evaluated.
 *
 * @param agentOutput - The agent's output to evaluate
 * @param task - The original task description
 * @param runCritic - Function to run a critic (injected, uses Claude CLI)
 * @param agentName - Name of the agent being evaluated (determines which critic set to use)
 */
export async function runMultiCritic(
  agentOutput: string,
  task: string,
  runCritic: RunCriticFn,
  agentName?: string,
): Promise<MultiCriticResult> {
  const outputLabel = AGENT_OUTPUT_LABELS[agentName ?? ''] ?? 'output';
  const evaluationTask = `Evaluate the following ${outputLabel} for the task "${task}":\n\n${agentOutput}`;

  const prompts = getCriticPrompts(agentName ?? '');

  // Run all 3 critics in parallel
  const promises = prompts.map(async ({ name, prompt }) => {
    try {
      const output = await runCritic(prompt, evaluationTask, name);
      const score = parseScore(output);
      return { critic: name, score, report: output };
    } catch {
      // If a critic fails, return null score
      return { critic: name, score: -1, report: 'Critic failed to produce output.' };
    }
  });

  const results = await Promise.all(promises);

  // Filter out failed critics
  const validResults = results.filter((r) => r.score > 0);

  if (validResults.length === 0) {
    return {
      medianScore: 0,
      critics: results,
      combinedReport: 'All critics failed to produce scores.',
    };
  }

  // Calculate median
  const scores = validResults.map((r) => r.score).sort((a, b) => a - b);
  const medianScore = scores.length % 2 === 0
    ? (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2
    : scores[Math.floor(scores.length / 2)];

  // Build combined report
  const reportLines = results.map(
    (r) => `[${r.critic}] Score: ${r.score > 0 ? r.score : 'FAILED'}/10\n${r.report}`,
  );

  return {
    medianScore: Math.round(medianScore * 10) / 10,
    critics: results,
    combinedReport: reportLines.join('\n\n---\n\n'),
  };
}

// ─── Helpers ───────────────────────────────────────────

/** Parse ===SCORE=== from critic output, with fallback to X/10 pattern */
function parseScore(output: string): number {
  const scoreMatch = output.match(/===SCORE===\s*(\d+(?:\.\d+)?)/);
  if (scoreMatch) {
    return Math.max(1, Math.min(10, parseFloat(scoreMatch[1])));
  }

  // Fallback: X/10 pattern
  const fallback = output.match(/\b(\d+(?:\.\d+)?)\s*\/\s*10\b/);
  if (fallback) {
    return Math.max(1, Math.min(10, parseFloat(fallback[1])));
  }

  return -1;
}

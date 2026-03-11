/**
 * Darwin — Prompt Optimizer
 *
 * Uses an LLM (via injected callback) to generate improved prompt variants
 * based on performance data and detected patterns.
 */

import type { DarwinPattern, PromptVersionStats } from '../types.js';

/** Function signature for LLM calls — injected by the parent, never imported. */
export type RunPromptFn = (prompt: string) => Promise<string>;

/** Agent tool context so the optimizer knows what tools are available */
export interface AgentToolContext {
  /** MCP server names the agent uses */
  mcp?: string[];
  /** Built-in tools the agent uses */
  tools?: string[];
}

/** Stats broken down by task category */
export interface CategoryStats {
  taskType: string;
  totalRuns: number;
  avgQuality: number;
  avgSourceCount: number;
  successRate: number;
}

export class PromptOptimizer {
  private runPrompt: RunPromptFn;

  constructor(runPrompt: RunPromptFn) {
    this.runPrompt = runPrompt;
  }

  /**
   * Generate an improved variant of an agent prompt.
   *
   * Builds a meta-prompt that includes the current prompt text, detected
   * patterns (strengths, weaknesses, trends, anomalies), aggregated
   * stats, tool context, per-category breakdowns, and recent critic feedback.
   */
  async generateVariant(
    currentPrompt: string,
    patterns: DarwinPattern[],
    stats: PromptVersionStats,
    toolContext?: AgentToolContext,
    categoryStats?: CategoryStats[],
    recentFeedback?: string[],
  ): Promise<string> {
    const metaPrompt = this.buildMetaPrompt(currentPrompt, patterns, stats, toolContext, categoryStats, recentFeedback);
    const result = await this.runPrompt(metaPrompt);

    // Strip any markdown fences the LLM might wrap around the output
    let cleaned = this.cleanOutput(result);

    // Enforce max length: 130% of current prompt or 3500, whichever is higher
    const maxLength = Math.max(Math.round(currentPrompt.length * 1.3), 3500);
    if (cleaned.length > maxLength) {
      // Truncate at last complete sentence before limit
      const truncated = cleaned.slice(0, maxLength);
      const lastPeriod = truncated.lastIndexOf('.');
      const lastNewline = truncated.lastIndexOf('\n');
      const cutPoint = Math.max(lastPeriod, lastNewline);
      if (cutPoint > maxLength * 0.7) {
        cleaned = truncated.slice(0, cutPoint + 1);
      }
      // If we can't find a good cut point, just use the full prompt (it's too long but better than broken)
    }

    // Alignment erosion check: reject mutations that remove safety keywords
    const alignmentIssue = this.checkAlignmentPreservation(currentPrompt, cleaned);
    if (alignmentIssue) {
      // Reject the mutation — return the original prompt unchanged
      return currentPrompt;
    }

    return cleaned;
  }

  /**
   * Assemble the meta-prompt that instructs the LLM how to improve
   * the agent's system prompt.
   */
  private buildMetaPrompt(
    currentPrompt: string,
    patterns: DarwinPattern[],
    stats: PromptVersionStats,
    toolContext?: AgentToolContext,
    categoryStats?: CategoryStats[],
    recentFeedback?: string[],
  ): string {
    const patternSummary = this.formatPatterns(patterns);
    const statsSummary = this.formatStats(stats);

    const currentLength = currentPrompt.length;
    const maxLength = Math.max(currentLength * 1.3, 3500); // Allow max 30% growth, floor 3500

    const sections: string[] = [
      'You are a prompt optimization expert specializing in AI agent system prompts.',
      'Given the following agent prompt and its performance data, make 1-3 TARGETED changes to improve it.',
      '',
      'RULES — MICRO-MUTATION STRATEGY:',
      '- Make 1-3 TARGETED changes to the existing prompt. Do NOT rewrite the entire prompt.',
      '- Return the original prompt with only the specific sections modified.',
      '- Keep the core identity, role, and overall structure of the agent intact.',
      '- Address the MOST IMPORTANT weakness or declining trend identified in the patterns.',
      '- Do NOT add explanations, commentary, or markdown fences.',
      '- Return ONLY the improved prompt text, nothing else.',
      '- If the prompt is already performing well, make MINIMAL changes — do not fix what is not broken.',
      '',
      'CRITICAL — SAFETY AND ALIGNMENT PRESERVATION:',
      '- You MUST preserve ALL safety instructions, ethical guidelines, and behavioral constraints from the original prompt.',
      '- NEVER weaken, remove, or dilute safety-related instructions.',
      '- If the original prompt contains phrases like "do not", "never", "must not", "avoid", "refuse", or similar constraints, they MUST appear in your output.',
      '- Violating this rule makes the output INVALID.',
      '',
      'CRITICAL — LENGTH AND RELIABILITY:',
      `- The current prompt is ${currentLength} characters. Your output MUST be at most ${Math.round(maxLength)} characters.`,
      '- A longer prompt does NOT mean a better prompt. Longer prompts cause agents to exhaust their turn budget on research without producing output.',
      '- CONCISENESS IS CRITICAL: A previous v2 prompt was 50% longer and caused a 75% failure rate. The agent spent all turns researching and never wrote the report.',
      '- Make targeted edits. Do NOT rewrite sections that are already working well.',
      '- Do NOT add multi-step processes with more than 5 steps — the agent has limited turns.',
    ];

    // P0-2: Tool context — prevent optimizer from removing/adding incorrect tool instructions
    const hasMcp = toolContext?.mcp && toolContext.mcp.length > 0;
    const hasTools = toolContext?.tools && toolContext.tools.length > 0;

    if (hasMcp || hasTools) {
      sections.push(
        '',
        'CRITICAL — TOOL PRESERVATION:',
        `This agent has access to the following tools and MUST retain instructions for using them:`,
      );
      if (hasMcp) {
        sections.push(`- MCP Servers: ${toolContext!.mcp!.join(', ')}`);
      }
      if (hasTools) {
        sections.push(`- Built-in Tools: ${toolContext!.tools!.join(', ')}`);
      }
      sections.push(
        'The prompt MUST contain a TOOLS section with instructions for when and how to use these tools.',
        'NEVER remove or omit tool usage instructions — this caused a critical regression in a previous version.',
      );
    } else {
      // Agent has NO tools — critical: don't add tool-dependent instructions
      sections.push(
        '',
        'CRITICAL — NO-TOOL AGENT:',
        'This agent has NO access to search tools, web browsing, or external APIs.',
        'Do NOT add instructions like "research", "cite sources", "search for", or "look up" — the agent CANNOT do these things.',
        'Focus improvements on writing quality, structure, and instructions the agent CAN follow without tools.',
      );
    }

    sections.push(
      '',
      '--- CURRENT PROMPT ---',
      currentPrompt,
      '',
      '--- PERFORMANCE STATS ---',
      statsSummary,
    );

    // P2-5: Per-category stats so optimizer sees topic-specific performance
    if (categoryStats && categoryStats.length > 0) {
      sections.push('', '--- PERFORMANCE BY CATEGORY ---');
      for (const cat of categoryStats) {
        sections.push(
          `  ${cat.taskType}: ${cat.totalRuns} runs, avg quality ${cat.avgQuality.toFixed(1)}/10, avg sources ${cat.avgSourceCount.toFixed(1)}, success ${(cat.successRate * 100).toFixed(0)}%`,
        );
      }
      sections.push(
        '',
        'NOTE: Performance varies by topic category. Do NOT over-optimize for one category at the expense of others.',
      );
    }

    // Recent critic feedback — gives the optimizer concrete WHY behind low scores
    if (recentFeedback && recentFeedback.length > 0) {
      sections.push(
        '',
        '--- RECENT CRITIC FEEDBACK ---',
        'These are verbatim evaluations from the last runs. Use them to understand WHAT SPECIFICALLY went wrong.',
        'Look for RECURRING issues across multiple reports — those are the highest priority to fix.',
        '',
      );
      for (let i = 0; i < recentFeedback.length; i++) {
        sections.push(`[Run ${i + 1}]`);
        sections.push(recentFeedback[i]);
        sections.push('');
      }
    }

    sections.push(
      '',
      '--- DETECTED PATTERNS ---',
      patternSummary,
      '',
      '--- YOUR TASK ---',
      'Output the improved prompt. Nothing else.',
    );

    return sections.join('\n');
  }

  /**
   * Format patterns into a human-readable summary for the meta-prompt.
   */
  private formatPatterns(patterns: DarwinPattern[]): string {
    if (patterns.length === 0) {
      return 'No patterns detected yet.';
    }

    const grouped: Record<string, DarwinPattern[]> = {};
    for (const p of patterns) {
      const key = p.type;
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(p);
    }

    const sections: string[] = [];

    for (const [type, items] of Object.entries(grouped)) {
      const label = this.pluralize(type);
      sections.push(`${label}:`);
      for (const item of items) {
        const taskLabel = item.taskType ? ` [${item.taskType}]` : '';
        sections.push(
          `  - ${item.description}${taskLabel} (confidence: ${(item.confidence * 100).toFixed(0)}%, evidence: ${item.evidence})`,
        );
        if (item.suggestion) {
          sections.push(`    Suggestion: ${item.suggestion}`);
        }
      }
    }

    return sections.join('\n');
  }

  /**
   * Format stats into a readable summary.
   */
  private formatStats(stats: PromptVersionStats): string {
    return [
      `Total runs: ${stats.totalRuns}`,
      `Success rate: ${(stats.successRate * 100).toFixed(1)}%`,
      `Avg quality: ${stats.avgQuality.toFixed(2)} / 10`,
      `Avg duration: ${(stats.avgDuration / 1000).toFixed(1)}s`,
      `Avg sources cited: ${stats.avgSourceCount.toFixed(1)}`,
    ].join('\n');
  }

  /**
   * Remove markdown code fences if the LLM wraps the output.
   */
  private cleanOutput(raw: string): string {
    let cleaned = raw.trim();

    // Strip ```...``` wrapping (with optional language tag)
    const fenceMatch = cleaned.match(/^```(?:\w+)?\n([\s\S]*?)\n```$/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    return cleaned;
  }

  /**
   * Pluralize a pattern type label correctly.
   * Handles: weakness -> Weaknesses, strength -> Strengths, trend -> Trends, anomaly -> Anomalies
   */
  private pluralize(type: string): string {
    const lookup: Record<string, string> = {
      weakness: 'Weaknesses',
      strength: 'Strengths',
      trend: 'Trends',
      anomaly: 'Anomalies',
    };
    return lookup[type] ?? type.charAt(0).toUpperCase() + type.slice(1) + 's';
  }

  /**
   * Check that the mutated prompt preserves safety-related keywords from the original.
   * Returns null if OK, or a rejection reason if safety keywords were removed.
   */
  checkAlignmentPreservation(original: string, mutated: string): string | null {
    const safetyPatterns = [
      /\bdo not\b/i,
      /\bnever\b/i,
      /\bmust not\b/i,
      /\bavoid\b/i,
      /\brefuse\b/i,
      /\bprohibit/i,
      /\bforbid/i,
      /\bdo NOT\b/,
      /\bNEVER\b/,
      /\bMUST NOT\b/,
      /\bsafety\b/i,
      /\bethic/i,
      /\balignment\b/i,
    ];

    const originalLower = original.toLowerCase();
    const mutatedLower = mutated.toLowerCase();

    const removedKeywords: string[] = [];

    for (const pattern of safetyPatterns) {
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
}

/**
 * Tests for PromptOptimizer — generates improved prompt variants via LLM.
 *
 * Since the optimizer delegates to an injected `runPrompt` function,
 * we mock it to test cleanOutput, length enforcement, and meta-prompt assembly.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PromptOptimizer } from '../src/evolution/optimizer.js';
import type { RunPromptFn, AgentToolContext, CategoryStats } from '../src/evolution/optimizer.js';
import type { DarwinPattern, PromptVersionStats } from '../src/types.js';

// ─── Helpers ────────────────────────────────────────

function makeOptimizer(mockResponse: string): PromptOptimizer {
  const runPrompt: RunPromptFn = async (_prompt: string) => mockResponse;
  return new PromptOptimizer(runPrompt);
}

/** Capture the meta-prompt that was sent to the LLM. */
function makeCapturingOptimizer(mockResponse: string): {
  optimizer: PromptOptimizer;
  getCapturedPrompt: () => string;
} {
  let captured = '';
  const runPrompt: RunPromptFn = async (prompt: string) => {
    captured = prompt;
    return mockResponse;
  };
  return {
    optimizer: new PromptOptimizer(runPrompt),
    getCapturedPrompt: () => captured,
  };
}

const defaultStats: PromptVersionStats = {
  totalRuns: 10,
  avgQuality: 7.5,
  avgDuration: 45000,
  successRate: 0.9,
  avgSourceCount: 12,
};

const samplePatterns: DarwinPattern[] = [
  {
    type: 'weakness',
    taskType: 'market',
    description: 'Low quality on "market" tasks (avg 3.5/10)',
    confidence: 0.5,
    evidence: 5,
    suggestion: 'Improve instructions for market tasks.',
  },
  {
    type: 'strength',
    taskType: 'tech',
    description: 'High quality on "tech" tasks (avg 8.5/10)',
    confidence: 0.7,
    evidence: 7,
    suggestion: 'Leverage tech strength.',
  },
];

// ─── cleanOutput (tested via generateVariant) ───────

describe('PromptOptimizer — cleanOutput (markdown fence stripping)', () => {
  it('strips triple backtick fences', async () => {
    const optimizer = makeOptimizer('```\nYou are a research agent.\n```');
    const result = await optimizer.generateVariant(
      'You are a research agent.',
      [],
      defaultStats,
    );
    assert.equal(result, 'You are a research agent.');
  });

  it('strips backtick fences with language tag', async () => {
    const optimizer = makeOptimizer('```markdown\nYou are a research agent.\n```');
    const result = await optimizer.generateVariant(
      'You are a research agent.',
      [],
      defaultStats,
    );
    assert.equal(result, 'You are a research agent.');
  });

  it('trims whitespace from output', async () => {
    const optimizer = makeOptimizer('  \n  You are a research agent.  \n  ');
    const result = await optimizer.generateVariant(
      'You are a research agent.',
      [],
      defaultStats,
    );
    assert.equal(result, 'You are a research agent.');
  });

  it('passes through clean output unchanged', async () => {
    const optimizer = makeOptimizer('You are an improved research agent.');
    const result = await optimizer.generateVariant(
      'You are a research agent.',
      [],
      defaultStats,
    );
    assert.equal(result, 'You are an improved research agent.');
  });
});

// ─── Length Enforcement ─────────────────────────────

describe('PromptOptimizer — length enforcement', () => {
  it('truncates output > 130% of input length at sentence boundary', async () => {
    const currentPrompt = 'A'.repeat(4000); // 4000 chars => max 5200
    // Generate output that is way too long (8000 chars)
    const longOutput = 'This is a sentence. '.repeat(400); // ~8000 chars
    const optimizer = makeOptimizer(longOutput);

    const result = await optimizer.generateVariant(
      currentPrompt,
      [],
      defaultStats,
    );

    const maxLength = Math.max(Math.round(4000 * 1.3), 3500);
    assert.ok(
      result.length <= maxLength + 1, // +1 for the period
      `Output should be truncated to ~${maxLength}, got ${result.length}`,
    );
  });

  it('does not truncate output within 130% of input', async () => {
    const currentPrompt = 'A'.repeat(4000);
    const shortOutput = 'Improved prompt. '.repeat(50); // ~850 chars
    const optimizer = makeOptimizer(shortOutput);

    const result = await optimizer.generateVariant(
      currentPrompt,
      [],
      defaultStats,
    );
    assert.equal(result, shortOutput.trim());
  });

  it('uses floor of 3500 for short prompts', async () => {
    const shortPrompt = 'Be a good agent.'; // 17 chars => 130% = 22, but floor is 3500
    const mediumOutput = 'X'.repeat(3000); // under 3500 floor
    const optimizer = makeOptimizer(mediumOutput);

    const result = await optimizer.generateVariant(
      shortPrompt,
      [],
      defaultStats,
    );
    // 3000 chars is under the 3500 floor, so no truncation
    assert.equal(result.length, 3000);
  });
});

// ─── Meta-prompt assembly ───────────────────────────

describe('PromptOptimizer — meta-prompt contains correct data', () => {
  it('includes current prompt in meta-prompt', async () => {
    const { optimizer, getCapturedPrompt } = makeCapturingOptimizer('improved');
    await optimizer.generateVariant(
      'You are a research agent.',
      [],
      defaultStats,
    );
    const metaPrompt = getCapturedPrompt();
    assert.ok(metaPrompt.includes('You are a research agent.'));
    assert.ok(metaPrompt.includes('CURRENT PROMPT'));
  });

  it('includes stats summary in meta-prompt', async () => {
    const { optimizer, getCapturedPrompt } = makeCapturingOptimizer('improved');
    await optimizer.generateVariant(
      'You are a research agent.',
      [],
      defaultStats,
    );
    const metaPrompt = getCapturedPrompt();
    assert.ok(metaPrompt.includes('Total runs: 10'));
    assert.ok(metaPrompt.includes('Success rate: 90.0%'));
    assert.ok(metaPrompt.includes('Avg quality: 7.50 / 10'));
    assert.ok(metaPrompt.includes('Avg sources cited: 12.0'));
  });

  it('includes "No patterns detected yet." when no patterns', async () => {
    const { optimizer, getCapturedPrompt } = makeCapturingOptimizer('improved');
    await optimizer.generateVariant(
      'You are a research agent.',
      [],
      defaultStats,
    );
    const metaPrompt = getCapturedPrompt();
    assert.ok(metaPrompt.includes('No patterns detected yet.'));
  });

  it('includes grouped pattern descriptions when patterns exist', async () => {
    const { optimizer, getCapturedPrompt } = makeCapturingOptimizer('improved');
    await optimizer.generateVariant(
      'You are a research agent.',
      samplePatterns,
      defaultStats,
    );
    const metaPrompt = getCapturedPrompt();
    assert.ok(metaPrompt.includes('Weaknesses:'), 'Should have Weaknesses section');
    assert.ok(metaPrompt.includes('Low quality on "market" tasks'));
    assert.ok(metaPrompt.includes('Strengths:'), 'Should have Strength section');
    assert.ok(metaPrompt.includes('High quality on "tech" tasks'));
    assert.ok(metaPrompt.includes('confidence: 50%'));
    assert.ok(metaPrompt.includes('evidence: 5'));
  });

  it('includes tool context preservation when provided', async () => {
    const { optimizer, getCapturedPrompt } = makeCapturingOptimizer('improved');
    const toolContext: AgentToolContext = {
      mcp: ['tavily', 'context7'],
      tools: ['Read', 'Grep'],
    };
    await optimizer.generateVariant(
      'You are a research agent.',
      [],
      defaultStats,
      toolContext,
    );
    const metaPrompt = getCapturedPrompt();
    assert.ok(metaPrompt.includes('TOOL PRESERVATION'));
    assert.ok(metaPrompt.includes('tavily, context7'));
    assert.ok(metaPrompt.includes('Read, Grep'));
  });

  it('omits tool context section when no tools provided', async () => {
    const { optimizer, getCapturedPrompt } = makeCapturingOptimizer('improved');
    await optimizer.generateVariant(
      'You are a research agent.',
      [],
      defaultStats,
      undefined,
    );
    const metaPrompt = getCapturedPrompt();
    assert.ok(!metaPrompt.includes('TOOL PRESERVATION'));
  });

  it('includes category stats when provided', async () => {
    const { optimizer, getCapturedPrompt } = makeCapturingOptimizer('improved');
    const categoryStats: CategoryStats[] = [
      { taskType: 'tech', totalRuns: 5, avgQuality: 8.5, avgSourceCount: 15.0, successRate: 0.9 },
      { taskType: 'market', totalRuns: 3, avgQuality: 3.5, avgSourceCount: 5.0, successRate: 0.6 },
    ];
    await optimizer.generateVariant(
      'You are a research agent.',
      [],
      defaultStats,
      undefined,
      categoryStats,
    );
    const metaPrompt = getCapturedPrompt();
    assert.ok(metaPrompt.includes('PERFORMANCE BY CATEGORY'));
    assert.ok(metaPrompt.includes('tech: 5 runs'));
    assert.ok(metaPrompt.includes('market: 3 runs'));
    assert.ok(metaPrompt.includes('avg quality 8.5/10'));
    assert.ok(metaPrompt.includes('success 60%'));
  });

  it('includes length constraint instructions in meta-prompt', async () => {
    const { optimizer, getCapturedPrompt } = makeCapturingOptimizer('improved');
    const longPrompt = 'X'.repeat(5000);
    await optimizer.generateVariant(longPrompt, [], defaultStats);
    const metaPrompt = getCapturedPrompt();
    assert.ok(metaPrompt.includes('5000 characters'));
    assert.ok(metaPrompt.includes('CONCISENESS IS CRITICAL'));
    assert.ok(metaPrompt.includes('LENGTH AND RELIABILITY'));
  });

  it('includes micro-mutation strategy instructions in meta-prompt', async () => {
    const { optimizer, getCapturedPrompt } = makeCapturingOptimizer('improved');
    await optimizer.generateVariant('You are a research agent.', [], defaultStats);
    const metaPrompt = getCapturedPrompt();
    assert.ok(metaPrompt.includes('MICRO-MUTATION STRATEGY'));
    assert.ok(metaPrompt.includes('1-3 TARGETED changes'));
    assert.ok(metaPrompt.includes('Do NOT rewrite the entire prompt'));
  });

  it('includes safety and alignment preservation instructions in meta-prompt', async () => {
    const { optimizer, getCapturedPrompt } = makeCapturingOptimizer('improved');
    await optimizer.generateVariant('You are a research agent.', [], defaultStats);
    const metaPrompt = getCapturedPrompt();
    assert.ok(metaPrompt.includes('SAFETY AND ALIGNMENT PRESERVATION'));
    assert.ok(metaPrompt.includes('NEVER weaken, remove, or dilute'));
  });
});

// ─── Alignment Erosion Check ──────────────────────

describe('PromptOptimizer — alignment erosion check', () => {
  it('returns null when safety keywords are preserved', () => {
    const optimizer = makeOptimizer('dummy');
    const original = 'You are an agent. Do not produce harmful content. Never ignore safety rules.';
    const mutated = 'You are an improved agent. Do not produce harmful content. Never ignore safety rules. Be concise.';
    assert.equal(optimizer.checkAlignmentPreservation(original, mutated), null);
  });

  it('detects when "never" keyword is removed', () => {
    const optimizer = makeOptimizer('dummy');
    const original = 'You are an agent. Never produce harmful content.';
    const mutated = 'You are an improved agent. Produce helpful content.';
    const result = optimizer.checkAlignmentPreservation(original, mutated);
    assert.ok(result !== null);
    assert.ok(result!.includes('Alignment erosion'));
  });

  it('detects when "do not" keyword is removed', () => {
    const optimizer = makeOptimizer('dummy');
    const original = 'You are an agent. Do not hallucinate facts.';
    const mutated = 'You are an agent. Always be accurate.';
    const result = optimizer.checkAlignmentPreservation(original, mutated);
    assert.ok(result !== null);
    assert.ok(result!.includes('Alignment erosion'));
  });

  it('rejects mutated prompt and returns original when alignment erodes', async () => {
    // Mock response that removes safety keywords from original
    const original = 'You are a research agent. Do not fabricate sources. Never invent data.';
    const mutatedResponse = 'You are a research agent. Always cite real sources. Provide accurate data.';
    const optimizer = makeOptimizer(mutatedResponse);
    const result = await optimizer.generateVariant(original, [], defaultStats);
    // Should return the original since safety keywords were removed
    assert.equal(result, original);
  });

  it('accepts mutated prompt when safety keywords are all preserved', async () => {
    const original = 'You are a research agent. Do not fabricate sources.';
    const mutatedResponse = 'You are an excellent research agent. Do not fabricate sources. Be thorough.';
    const optimizer = makeOptimizer(mutatedResponse);
    const result = await optimizer.generateVariant(original, [], defaultStats);
    assert.equal(result, mutatedResponse);
  });
});

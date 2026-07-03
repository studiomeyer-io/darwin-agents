/**
 * Tests for the v0.10.0 wave:
 *   - SIMBA-style demo injection (demos.ts pure helpers + loop wiring)
 *   - GEPA candidate_selection_strategy parity (selection.ts + loop wiring)
 *   - CLI flags --demos / --no-demos / --candidate-selection
 *
 * The legacy path is covered by loop.test.ts and must stay byte-for-byte
 * unchanged — these tests only exercise the new opt-in surfaces.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectDemoCandidates,
  buildDemoSection,
  applyDemoSection,
  stripDemoSection,
  DEMO_SECTION_START,
  DEMO_SECTION_END,
} from '../src/evolution/demos.js';
import { selectParentVariant } from '../src/evolution/selection.js';
import { parseEvolutionConfigFlags, hasAnyEvolutionFlag } from '../src/cli/evolution-flags.js';
import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { GepaOptimizer } from '../src/evolution/optimizer-gepa.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';
import type { AgentDefinition, DarwinExperiment } from '../src/types.js';

// ─── Fixtures ───────────────────────────────────────

const LONG_OUTPUT =
  'The analysis begins with a survey of the primary sources. ' +
  'Each claim is cross-checked against at least two independent documents. ' +
  'The report closes with a ranked list of open questions and their evidence gaps. ' +
  'Confidence levels are stated explicitly for every conclusion drawn here.';

function demoExp(overrides: Partial<DarwinExperiment> = {}): DarwinExperiment {
  return makeExperiment({
    success: true,
    output: LONG_OUTPUT,
    feedback: { score: 9, report: 'excellent', evaluator: 'multi-critic' },
    ...overrides,
  });
}

// ─── demos.ts — selection ───────────────────────────

describe('demos — selectDemoCandidates', () => {
  it('picks only successful, high-scoring runs with substantial output', () => {
    const exps = [
      demoExp({ taskType: 'tech' }),
      demoExp({ taskType: 'market', feedback: { score: 6, report: 'meh', evaluator: 'c' } }), // below threshold
      demoExp({ taskType: 'legal', success: false }), // failed
      demoExp({ taskType: 'web', output: 'short' }), // too short
      demoExp({ taskType: 'web', output: undefined }), // no output
    ];
    const demos = selectDemoCandidates(exps);
    assert.equal(demos.length, 1);
    assert.equal(demos[0]!.taskType, 'tech');
    assert.equal(demos[0]!.score, 9);
  });

  it('keeps at most one demo per task type (best score wins)', () => {
    const exps = [
      demoExp({ taskType: 'tech', feedback: { score: 8, report: 'good', evaluator: 'c' } }),
      demoExp({ taskType: 'tech', feedback: { score: 9.5, report: 'best', evaluator: 'c' }, task: 'the winning task' }),
      demoExp({ taskType: 'market' }),
    ];
    const demos = selectDemoCandidates(exps, { maxDemos: 5 });
    assert.equal(demos.length, 2);
    const tech = demos.find((d) => d.taskType === 'tech')!;
    assert.equal(tech.score, 9.5);
    assert.equal(tech.task, 'the winning task');
  });

  it('caps at maxDemos ordered by score descending', () => {
    const exps = [
      demoExp({ taskType: 'a', feedback: { score: 8.2, report: 'r', evaluator: 'c' } }),
      demoExp({ taskType: 'b', feedback: { score: 9.9, report: 'r', evaluator: 'c' } }),
      demoExp({ taskType: 'c', feedback: { score: 8.7, report: 'r', evaluator: 'c' } }),
    ];
    const demos = selectDemoCandidates(exps, { maxDemos: 2 });
    assert.deepEqual(demos.map((d) => d.taskType), ['b', 'c']);
  });

  it('breaks score ties by recency (later completedAt wins within a type)', () => {
    const older = demoExp({ taskType: 'tech', completedAt: '2026-01-01T00:00:00.000Z', task: 'older' });
    const newer = demoExp({ taskType: 'tech', completedAt: '2026-06-01T00:00:00.000Z', task: 'newer' });
    const demos = selectDemoCandidates([older, newer]);
    assert.equal(demos[0]!.task, 'newer');
  });

  it('is deterministic and treats NaN thresholds as the default', () => {
    const exps = [demoExp({ taskType: 'tech' })];
    const a = selectDemoCandidates(exps, { scoreThreshold: Number.NaN });
    const b = selectDemoCandidates(exps);
    assert.deepEqual(a, b);
    assert.equal(a.length, 1); // 9 ≥ default 8 — NaN never bypasses the filter
  });

  it('returns [] for an empty history', () => {
    assert.deepEqual(selectDemoCandidates([]), []);
  });
});

// ─── demos.ts — rendering + application ─────────────

describe('demos — buildDemoSection / applyDemoSection / stripDemoSection', () => {
  const demos = selectDemoCandidates([demoExp({ taskType: 'tech', task: 'Explain MCP transports' })]);

  it('renders a marker-delimited section with task and excerpt', () => {
    const section = buildDemoSection(demos);
    assert.ok(section.startsWith(DEMO_SECTION_START));
    assert.ok(section.endsWith(DEMO_SECTION_END));
    assert.ok(section.includes('Explain MCP transports'));
    assert.ok(section.includes('scored 9/10'));
    assert.ok(section.includes('task type "tech"'));
  });

  it('returns empty string for an empty demo list', () => {
    assert.equal(buildDemoSection([]), '');
  });

  it('truncates long outputs at a sentence boundary with an ellipsis marker', () => {
    const longDemos = selectDemoCandidates([demoExp({ output: LONG_OUTPUT.repeat(10) })]);
    const section = buildDemoSection(longDemos, { maxOutputChars: 200 });
    assert.ok(section.includes('[...]'));
    // The excerpt body (between the fences) must respect the cap plus marker slack.
    const excerpt = section.split('"""')[1]!;
    assert.ok(excerpt.length < 220, `excerpt too long: ${excerpt.length}`);
  });

  it('appends the section after a blank line when no section exists', () => {
    const prompt = 'You are an agent. Never lie.';
    const out = applyDemoSection(prompt, buildDemoSection(demos));
    assert.ok(out.startsWith(prompt));
    assert.ok(out.includes(`\n\n${DEMO_SECTION_START}`));
  });

  it('REPLACES an existing section instead of stacking (idempotent)', () => {
    const prompt = 'You are an agent. Never lie.';
    const once = applyDemoSection(prompt, buildDemoSection(demos));
    const twice = applyDemoSection(once, buildDemoSection(demos));
    assert.equal(twice, once);
    assert.equal(twice.split(DEMO_SECTION_START).length, 2); // exactly one marker
  });

  it('swaps demo content in place when the demo set changes', () => {
    const prompt = 'You are an agent. Never lie.';
    const first = applyDemoSection(prompt, buildDemoSection(demos));
    const newDemos = selectDemoCandidates([demoExp({ taskType: 'market', task: 'Fresh demo task' })]);
    const second = applyDemoSection(first, buildDemoSection(newDemos));
    assert.ok(second.includes('Fresh demo task'));
    assert.ok(!second.includes('Explain MCP transports'));
    assert.equal(second.split(DEMO_SECTION_START).length, 2);
  });

  it('strips the section cleanly (roundtrip) and passes through prompts without one', () => {
    const prompt = 'You are an agent. Never lie.';
    const withDemos = applyDemoSection(prompt, buildDemoSection(demos));
    assert.equal(stripDemoSection(withDemos), prompt);
    assert.equal(stripDemoSection(prompt), prompt);
  });

  it('applying an empty section acts as removal', () => {
    const prompt = 'You are an agent. Never lie.';
    const withDemos = applyDemoSection(prompt, buildDemoSection(demos));
    assert.equal(applyDemoSection(withDemos, ''), prompt);
  });
});

// ─── selection.ts — parent-selection strategies ─────

describe('selection — selectParentVariant', () => {
  const v = (id: string, quality: number, duration = 1000) => ({
    id,
    prompt: `prompt-${id}`,
    metrics: { qualityScore: quality, sourceCount: 5, outputLength: 3000, durationMs: duration },
  });

  it("returns null for 'active' (caller keeps the active prompt)", () => {
    assert.equal(selectParentVariant([v('v1', 9)], 'active'), null);
  });

  it('returns null for an empty list and the sole element for a singleton', () => {
    assert.equal(selectParentVariant([], 'best'), null);
    const only = v('v1', 5);
    assert.equal(selectParentVariant([only], 'pareto'), only);
  });

  it("'best' picks the highest scalarised composite", () => {
    const weak = v('v1', 5);
    const strong = v('v2', 9);
    assert.equal(selectParentVariant([weak, strong], 'best'), strong);
  });

  it("'pareto' samples uniformly from the non-dominated front", () => {
    const a = v('a', 9, 5000); // best quality, slow — on the front
    const b = v('b', 6, 100); // fastest — on the front
    const dominated = v('c', 5, 6000); // worse than both — dominated
    const picks = new Set<string>();
    // rng 0 → first front member, rng 0.99 → last front member
    picks.add((selectParentVariant([a, b, dominated], 'pareto', { rng: () => 0 }) as ReturnType<typeof v>).id);
    picks.add((selectParentVariant([a, b, dominated], 'pareto', { rng: () => 0.99 }) as ReturnType<typeof v>).id);
    assert.deepEqual([...picks].sort(), ['a', 'b']);
    assert.ok(!picks.has('c'), 'dominated variant must never be picked');
  });

  it("'epsilon-greedy' explores on rng<ε and exploits otherwise", () => {
    const weak = v('v1', 5);
    const strong = v('v2', 9);
    // Explore branch: first rng call (coin) < ε, second rng call picks index 0.
    const explored = selectParentVariant([weak, strong], 'epsilon-greedy', { epsilon: 0.5, rng: () => 0 });
    assert.equal(explored, weak);
    // Exploit branch: coin ≥ ε → best.
    const exploited = selectParentVariant([weak, strong], 'epsilon-greedy', { epsilon: 0.5, rng: () => 0.9 });
    assert.equal(exploited, strong);
  });

  it('clamps epsilon and treats NaN as the default (never full-explore by accident)', () => {
    const weak = v('v1', 5);
    const strong = v('v2', 9);
    // NaN epsilon → default 0.1; rng 0.5 ≥ 0.1 → exploit.
    const picked = selectParentVariant([weak, strong], 'epsilon-greedy', { epsilon: Number.NaN, rng: () => 0.5 });
    assert.equal(picked, strong);
  });

  it('tolerates variants sharing ONE metrics object (no reference-identity mapping)', () => {
    const shared = { qualityScore: 7, sourceCount: 5, outputLength: 3000, durationMs: 1000 };
    const v1 = { id: 'v1', prompt: 'p1', metrics: shared };
    const v2 = { id: 'v2', prompt: 'p2', metrics: shared };
    const picked = selectParentVariant([v1, v2], 'pareto', { rng: () => 0.99 });
    assert.ok(picked === v1 || picked === v2, 'a variant must be returned, not dropped');
  });

  it('returns null for an unknown strategy string instead of throwing', () => {
    const picked = selectParentVariant([v('v1', 9)], 'made-up' as never, {});
    // Singleton short-circuit happens before the switch — use two variants.
    const picked2 = selectParentVariant([v('v1', 9), v('v2', 5)], 'made-up' as never, {});
    assert.ok(picked !== undefined);
    assert.equal(picked2, null);
  });
});

// ─── CLI flags ──────────────────────────────────────

describe('CLI — --demos / --candidate-selection flags', () => {
  it('parses --demos / --no-demos', () => {
    assert.equal(parseEvolutionConfigFlags(['--demos']).override.useDemos, true);
    assert.equal(parseEvolutionConfigFlags(['--no-demos']).override.useDemos, false);
  });

  it('parses --candidate-selection with a valid strategy and consumes the value', () => {
    const { override, rest } = parseEvolutionConfigFlags(['--candidate-selection', 'pareto', 'writer']);
    assert.equal(override.candidateSelection, 'pareto');
    assert.deepEqual(rest, ['writer']);
  });

  it('rejects an unknown strategy value (consumed but not applied)', () => {
    const { override, rest } = parseEvolutionConfigFlags(['--candidate-selection', 'random-walk', 'writer']);
    assert.equal(override.candidateSelection, undefined);
    assert.deepEqual(rest, ['writer']);
  });

  it('hasAnyEvolutionFlag sees the new fields', () => {
    assert.equal(hasAnyEvolutionFlag({ useDemos: true }), true);
    assert.equal(hasAnyEvolutionFlag({ candidateSelection: 'best' }), true);
    assert.equal(hasAnyEvolutionFlag({}), false);
  });
});

// ─── Loop integration ───────────────────────────────

const SAFE_PROMPT = 'You are a research agent. Never fabricate sources. Cite primary documents.';

function makeAgent(evolution: AgentDefinition['evolution']): AgentDefinition {
  return {
    name: 'researcher',
    role: 'Researcher',
    description: 'test agent',
    type: 'llm',
    systemPrompt: SAFE_PROMPT,
    model: 'claude-sonnet-4-6',
    evolution,
  };
}

/** Seed weak experiments so evolution triggers, on the given version. */
function seedWeak(memory: ReturnType<typeof createMockMemory>, count: number, version = 'v1'): void {
  for (let i = 0; i < count; i++) {
    memory._experiments.push(makeExperiment({
      agentName: 'researcher',
      promptVersion: version,
      taskType: 'tech',
      success: true,
      metrics: { qualityScore: 5.5, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
      feedback: { score: 5.5, report: 'Weak: shallow analysis.', evaluator: 'multi-critic' },
    }));
  }
}

/** Seed high-scoring runs (demo candidates), on the given version. */
function seedStrong(memory: ReturnType<typeof createMockMemory>, count: number, version = 'v1', taskType = 'market'): void {
  for (let i = 0; i < count; i++) {
    memory._experiments.push(makeExperiment({
      agentName: 'researcher',
      promptVersion: version,
      taskType: `${taskType}-${i}`,
      task: `strong task ${i}`,
      success: true,
      output: LONG_OUTPUT,
      metrics: { qualityScore: 9, sourceCount: 12, outputLength: 6000, errorCount: 0, durationMs: 20000 },
      feedback: { score: 9, report: 'Excellent depth.', evaluator: 'multi-critic' },
    }));
  }
}

function buildLoop(opts: {
  memory: ReturnType<typeof createMockMemory>;
  agent: AgentDefinition;
  optimizerOutput?: string;
  gepa?: GepaOptimizer;
  rng?: () => number;
}): DarwinLoop {
  return new DarwinLoop({
    memory: opts.memory,
    tracker: new ExperimentTracker(opts.memory),
    safety: new SafetyGate(),
    patterns: new PatternDetector(opts.memory),
    optimizer: new PromptOptimizer(async () => opts.optimizerOutput ?? 'Legacy variant. Never fabricate sources. Cite primary documents.'),
    agent: opts.agent,
    gepa: opts.gepa,
    rng: opts.rng,
  });
}

function trigger(): DarwinExperiment {
  return makeExperiment({
    agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
    metrics: { qualityScore: 5.5, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
    feedback: { score: 5.5, report: 'Still weak.', evaluator: 'multi-critic' },
  });
}

describe('DarwinLoop — demo injection (useDemos)', () => {
  it('builds the challenger from demos on the cadence cycle (no LLM involved)', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }));
    seedWeak(memory, 15);
    seedStrong(memory, 2);

    const loop = buildLoop({
      memory,
      agent: makeAgent({ enabled: true, useDemos: true, demoEveryK: 1 }),
      optimizerOutput: 'LEGACY-SHOULD-NOT-RUN but Never fabricate sources.',
    });

    const result = await loop.afterRun(trigger());
    assert.equal(result.promptEvolved, true);
    assert.ok(result.message.includes('via demos'), `expected demos in message: ${result.message}`);

    const v2 = memory._versions.find((v) => v.version === 'v2')!;
    assert.ok(v2.changeReason.startsWith('[demos]'));
    assert.ok(v2.promptText.startsWith(SAFE_PROMPT), 'demo challenger must preserve the incumbent prompt');
    assert.ok(v2.promptText.includes(DEMO_SECTION_START));
    assert.ok(v2.promptText.includes('strong task'), 'demo content must come from the high-scoring runs');
  });

  it('skips demo injection off-cadence and falls through to legacy', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }));
    seedWeak(memory, 15);
    seedStrong(memory, 2);

    const loop = buildLoop({
      memory,
      agent: makeAgent({ enabled: true, useDemos: true, demoEveryK: 4 }), // v1 → epoch 1, 1 % 4 !== 0
    });

    const result = await loop.afterRun(trigger());
    assert.equal(result.promptEvolved, true);
    assert.ok(result.message.includes('via legacy'), `expected legacy in message: ${result.message}`);
  });

  it('yields no challenger when the same demos are already in the prompt (no self-A/B)', async () => {
    const memory = createMockMemory();
    seedWeak(memory, 15);
    seedStrong(memory, 2);
    // Pre-apply the exact demo section the loop would produce.
    const demos = selectDemoCandidates(memory._experiments);
    const promptWithDemos = applyDemoSection(SAFE_PROMPT, buildDemoSection(demos));
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: promptWithDemos }));

    const loop = buildLoop({
      memory,
      agent: makeAgent({ enabled: true, useDemos: true, demoEveryK: 1 }),
    });

    const result = await loop.afterRun(trigger());
    assert.equal(result.promptEvolved, true);
    assert.ok(result.message.includes('via legacy'), `expected fall-through to legacy: ${result.message}`);
  });

  it('falls through to legacy when no run qualifies as a demo', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }));
    seedWeak(memory, 15); // all score 5.5 — below the demo threshold

    const loop = buildLoop({
      memory,
      agent: makeAgent({ enabled: true, useDemos: true, demoEveryK: 1 }),
    });

    const result = await loop.afterRun(trigger());
    assert.equal(result.promptEvolved, true);
    assert.ok(result.message.includes('via legacy'), `expected legacy in message: ${result.message}`);
  });

  it('leaves the default path byte-for-byte unchanged when useDemos is off', async () => {
    const memory = createMockMemory();
    memory._versions.push(makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }));
    seedWeak(memory, 15);
    seedStrong(memory, 2);

    const loop = buildLoop({ memory, agent: makeAgent({ enabled: true }) });
    const result = await loop.afterRun(trigger());
    assert.equal(result.promptEvolved, true);
    assert.ok(!result.message.includes('via'), `no generator label without opt-in: ${result.message}`);
    const v2 = memory._versions.find((v) => v.version === 'v2')!;
    assert.ok(!v2.changeReason.startsWith('['), 'changeReason must stay untagged without opt-in');
    assert.ok(!v2.promptText.includes(DEMO_SECTION_START));
  });
});

describe('DarwinLoop — candidateSelection parent strategies', () => {
  /**
   * History: v1 (strong metrics, distinctive prompt) + v2 (weak metrics,
   * active). With candidateSelection 'best' the reflector must be fed v1's
   * prompt as the parent; the reflection meta-prompt embeds the parent, so a
   * capture of the runPrompt argument proves which parent was used.
   */
  async function runWithStrategy(strategy: 'best' | 'active'): Promise<string> {
    const memory = createMockMemory();
    const V1_PROMPT = 'You are the V1-STRONG-PARENT agent. Never fabricate sources.';
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: false, promptText: V1_PROMPT }),
      makePromptVersion({ version: 'v2', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
    );
    seedStrong(memory, 3, 'v1'); // strong metrics on v1 → 'best' must pick it
    seedWeak(memory, 15, 'v2');

    let captured = '';
    const gepa = new GepaOptimizer(async (prompt: string) => {
      captured = prompt;
      return 'Improved agent. Never fabricate sources. Cite primary documents.';
    });

    const loop = buildLoop({
      memory,
      agent: makeAgent({ enabled: true, useGepa: true, candidateSelection: strategy }),
      gepa,
    });

    const result = await loop.afterRun(makeExperiment({
      agentName: 'researcher', promptVersion: 'v2', taskType: 'tech', success: true,
      metrics: { qualityScore: 5.5, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
      feedback: { score: 5.5, report: 'Still weak.', evaluator: 'multi-critic' },
    }));
    assert.equal(result.promptEvolved, true);
    return captured;
  }

  it("'best' reflects from the strongest historical version, not the active one", async () => {
    const captured = await runWithStrategy('best');
    assert.ok(captured.includes('V1-STRONG-PARENT'), 'reflection prompt must embed the v1 parent');
  });

  it("'active' (default) reflects from the active prompt", async () => {
    const captured = await runWithStrategy('active');
    assert.ok(!captured.includes('V1-STRONG-PARENT'), 'active strategy must NOT pick the historical parent');
    assert.ok(captured.includes(SAFE_PROMPT.slice(0, 30)), 'reflection prompt must embed the active prompt');
  });

  it("'epsilon-greedy' explore path picks a uniformly-random parent via the injected rng", async () => {
    const memory = createMockMemory();
    const V1_PROMPT = 'You are the V1-EXPLORE-TARGET agent. Never fabricate sources.';
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: false, promptText: V1_PROMPT }),
      makePromptVersion({ version: 'v2', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
    );
    seedWeak(memory, 3, 'v1'); // v1 has metrics but is WEAK — only explore would pick it over v2
    seedWeak(memory, 15, 'v2');

    let captured = '';
    const gepa = new GepaOptimizer(async (prompt: string) => {
      captured = prompt;
      return 'Improved agent. Never fabricate sources. Cite primary documents.';
    });

    const loop = buildLoop({
      memory,
      agent: makeAgent({ enabled: true, useGepa: true, candidateSelection: 'epsilon-greedy', explorationEpsilon: 1 }),
      gepa,
      rng: () => 0, // coin 0 < ε=1 → explore; pick 0 → first version (v1)
    });

    const result = await loop.afterRun(makeExperiment({
      agentName: 'researcher', promptVersion: 'v2', taskType: 'tech', success: true,
      metrics: { qualityScore: 5.5, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
      feedback: { score: 5.5, report: 'Still weak.', evaluator: 'multi-critic' },
    }));
    assert.equal(result.promptEvolved, true);
    assert.ok(captured.includes('V1-EXPLORE-TARGET'), `explore must pick v1: got ${captured.slice(0, 120)}`);
  });
});

// ─── Override resolution (the wiring that makes the CLI flags real) ─────────

import { resolveEvolutionConfig } from '../src/evolution/enabled-state.js';

describe('enabled-state — v0.10 override keys resolve', () => {
  const agent = makeAgent({ enabled: true });

  it('applies a persisted useDemos override', () => {
    const resolved = resolveEvolutionConfig(agent, {
      evolutionConfigOverrides: { researcher: { useDemos: true } },
    });
    assert.equal(resolved?.useDemos, true);
  });

  it('applies a CLI candidateSelection override over the static config', () => {
    const resolved = resolveEvolutionConfig(agent, { evolutionConfigOverrides: {} }, {
      candidateSelection: 'pareto',
    });
    assert.equal(resolved?.candidateSelection, 'pareto');
  });

  it('CLI layer wins over the persisted layer for the new keys', () => {
    const resolved = resolveEvolutionConfig(agent, {
      evolutionConfigOverrides: { researcher: { candidateSelection: 'best', useDemos: false } },
    }, { candidateSelection: 'epsilon-greedy' });
    assert.equal(resolved?.candidateSelection, 'epsilon-greedy');
    assert.equal(resolved?.useDemos, false); // persisted survives where CLI is silent
  });

  it('undefined override values never clobber static config', () => {
    const withStatic = makeAgent({ enabled: true, useDemos: true, candidateSelection: 'best' });
    const resolved = resolveEvolutionConfig(withStatic, {
      evolutionConfigOverrides: { researcher: {} },
    });
    assert.equal(resolved?.useDemos, true);
    assert.equal(resolved?.candidateSelection, 'best');
  });
});

// ─── R1 review fixes (Critic HIGH-2 + marker literals + rng guard) ──────────

describe('demos — R1 hardening regressions', () => {
  it('replacement patterns ($&, $`, $$, $\') in demo content are inserted verbatim on refresh', () => {
    const prompt = 'You are an agent. Never lie.';
    // First cycle: append path (safe by construction).
    const dollarDemos = selectDemoCandidates([demoExp({
      taskType: 'tech',
      task: 'Explain String.replace specials',
      output: 'In JS, `$&` inserts the whole match, `$\`` the preceding text and $$ escapes a dollar. '.repeat(4),
    })]);
    const once = applyDemoSection(prompt, buildDemoSection(dollarDemos));
    // Second cycle: the .replace() branch — with a string replacer this would
    // explode `$&` into the previously matched span.
    const refreshed = applyDemoSection(once, buildDemoSection(dollarDemos));
    assert.equal(refreshed, once, 'identical demo set must be a byte-identical refresh');
    assert.ok(refreshed.includes('`$&` inserts the whole match'));
    assert.equal(refreshed.split(DEMO_SECTION_START).length, 2, 'exactly one section');
  });

  it('demo content containing the literal markers cannot corrupt the section span', () => {
    const prompt = 'You are an agent. Never lie.';
    const sneaky = selectDemoCandidates([demoExp({
      taskType: 'tech',
      task: 'Write about Darwin demo markers',
      output: (`Darwin wraps demos in ${DEMO_SECTION_START} and ${DEMO_SECTION_END} markers. ` +
        'That is how the section stays idempotent across refresh cycles, always.').repeat(3),
    })]);
    const section = buildDemoSection(sneaky);
    // The rendered section must contain the markers exactly once each (its own).
    assert.equal(section.split(DEMO_SECTION_START).length, 2);
    assert.equal(section.split(DEMO_SECTION_END).length, 2);
    const once = applyDemoSection(prompt, section);
    const refreshed = applyDemoSection(once, section);
    assert.equal(refreshed, once);
    assert.equal(stripDemoSection(refreshed), prompt, 'strip must remove the whole section cleanly');
  });
});

describe('selection — pathological rng degrades safely', () => {
  const mk = (id: string, q: number) => ({ id, prompt: `p-${id}`, metrics: { qualityScore: q, sourceCount: 5, outputLength: 3000, durationMs: 1000 } });

  it('NaN rng returns a variant (index 0) instead of throwing/undefined', () => {
    const a = mk('a', 9);
    const b = mk('b', 6);
    const picked = selectParentVariant([a, b], 'pareto', { rng: () => Number.NaN });
    assert.ok(picked === a || picked === b);
    const eg = selectParentVariant([a, b], 'epsilon-greedy', { epsilon: 1, rng: () => Number.NaN });
    assert.ok(eg === a || eg === b);
  });
});

/**
 * Tests for the v0.18.0 rejection memory
 * (`DarwinState.rejectedChallengers`, `darwin approve <agent> --forget`).
 *
 * The v0.17 README named this as a known limit: "`useDemos` plus the gate can
 * re-propose the same challenger. Darwin remembers rejected version LABELS,
 * not rejected TEXTS." This is the second kind of memory.
 *
 * What these tests pin, in order of how much a regression would cost:
 *
 *  1. A rejected TEXT is never proposed again, whatever generated it and
 *     whether or not the approval gate is still on. That is the feature.
 *  2. The agent keeps evolving. A repeat falls THROUGH to the next generator;
 *     only a cycle where every generator repeats is refused, and that message
 *     names the way out. A memory that quietly freezes an agent would be worse
 *     than the problem it solves.
 *  3. The reviewer's reason reaches the next generation, through both the
 *     legacy meta-prompt and the GEPA reflector. A "no" that teaches nothing
 *     buys one cycle; a "no, because X" buys the rest of them.
 *  4. `--forget` releases a text, and cannot be mixed with a decision.
 *  5. Fingerprinting ignores whitespace and nothing else. Near-duplicates are
 *     new proposals, and the README says so.
 *
 * A STUB optimizer is injected everywhere, so nothing here calls an LLM.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { GepaOptimizer } from '../src/evolution/optimizer-gepa.js';
import {
  fingerprintPromptText,
  findRejectedMatch,
  forgetRejections,
  formatRejectionNotes,
  normalizePromptText,
  rejectionNotes,
  rejectionsFor,
  rememberRejection,
  REJECTION_MEMORY_CAP,
  REJECTION_NOTES_LIMIT,
  REJECTION_REASON_CAP,
  REJECTION_STORED_REASON_CAP,
  clampStoredReason,
} from '../src/evolution/rejections.js';
import { DEFAULT_FEEDBACK_CAP } from '../src/evolution/reflector.js';
import { createMockMemory, makeExperiment, makePromptVersion, isolateTestEnv } from './helpers.js';
import type {
  AgentDefinition,
  DarwinExperiment,
  DarwinState,
  RejectedChallenger,
} from '../src/types.js';
import type { DarwinMetricEvent, MetricsSink } from '../src/metrics/sink.js';

isolateTestEnv();

const SAFE_PROMPT = 'You are a research agent. Never fabricate sources. Cite primary documents.';
const CHALLENGER = 'You are a meticulous research agent. Never fabricate sources. Cite and cross-check primary documents.';
const OTHER = 'You are a careful research agent. Never fabricate sources. Cite two primary documents.';

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

function makeSink(): MetricsSink & { events: DarwinMetricEvent[] } {
  const events: DarwinMetricEvent[] = [];
  return { events, emit(e) { events.push(e); } };
}

/**
 * A loop whose optimizer records every meta-prompt it is handed, so a test can
 * assert on WHAT the model was told and not only on what came back.
 */
function buildLoop(opts: {
  memory: ReturnType<typeof createMockMemory>;
  agent: AgentDefinition;
  outputs?: string[];
  metrics?: MetricsSink;
  gepa?: GepaOptimizer;
}): { loop: DarwinLoop; prompts: string[] } {
  const prompts: string[] = [];
  const outputs = opts.outputs ?? [CHALLENGER];
  let call = 0;
  const loop = new DarwinLoop({
    memory: opts.memory,
    tracker: new ExperimentTracker(opts.memory),
    safety: new SafetyGate(),
    patterns: new PatternDetector(opts.memory),
    optimizer: new PromptOptimizer(async (p: string) => {
      prompts.push(p);
      // The last entry repeats, so a two-output list means "this, then that
      // forever" rather than an index error on the third cycle.
      const out = outputs[Math.min(call, outputs.length - 1)]!;
      call++;
      return out;
    }),
    agent: opts.agent,
    metrics: opts.metrics,
    ...(opts.gepa ? { gepa: opts.gepa } : {}),
  });
  return { loop, prompts };
}

function seedExperiments(memory: ReturnType<typeof createMockMemory>, count: number): void {
  for (let i = 0; i < count; i++) {
    const exp: DarwinExperiment = makeExperiment({
      agentName: 'researcher',
      promptVersion: 'v1',
      taskType: 'tech',
      success: true,
      metrics: { qualityScore: 9, sourceCount: 12, outputLength: 6000, errorCount: 0, durationMs: 30000 },
      feedback: { score: 6, report: 'Thin on primary sources.', evaluator: 'multi-critic' },
    });
    memory._experiments.push(exp);
  }
}

function scenario(
  evolution: AgentDefinition['evolution'],
  opts: { outputs?: string[]; metrics?: MetricsSink; gepa?: GepaOptimizer } = {},
) {
  const memory = createMockMemory();
  memory._versions.push(
    makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
  );
  seedExperiments(memory, 3);
  const { loop, prompts } = buildLoop({ memory, agent: makeAgent(evolution), ...opts });
  return { memory, loop, prompts };
}

/** One remembered rejection, for the pure-function tests. */
function entry(over: Partial<RejectedChallenger> = {}): RejectedChallenger {
  return {
    version: 'v2',
    versionA: 'v1',
    textHash: fingerprintPromptText(CHALLENGER),
    rejectedAt: '2026-09-04T10:00:00.000Z',
    rejectedBy: 'human',
    generatedBy: 'legacy',
    ...over,
  };
}

// ─── The fingerprint ────────────────────────────────

describe('v0.18 rejection memory: the fingerprint', () => {
  it('ignores the whitespace a human would not see', () => {
    const a = 'Line one.\nLine two.';
    const b = '\r\n  \nLine one.   \r\nLine two.\t\n\n';
    assert.equal(normalizePromptText(b), a);
    assert.equal(fingerprintPromptText(a), fingerprintPromptText(b));
  });

  it('does NOT ignore a word, an ordering, or an inserted blank line inside', () => {
    // The honest boundary: this is exact-match memory, not semantic memory.
    // Anything that changes what the prompt SAYS is a new proposal.
    const base = 'Never fabricate sources.\nCite primary documents.';
    for (const variant of [
      'Never fabricate sources.\nCite secondary documents.',
      'Cite primary documents.\nNever fabricate sources.',
      'Never fabricate sources.\n\nCite primary documents.',
    ]) {
      assert.notEqual(
        fingerprintPromptText(base),
        fingerprintPromptText(variant),
        `must be a different proposal: ${variant}`,
      );
    }
  });

  it('matches the most recent entry, and never matches an entry without a hash', () => {
    const hashless = entry({ version: 'v9', textHash: undefined });
    assert.equal(findRejectedMatch([hashless], CHALLENGER), null);

    const older = entry({ version: 'v2', rejectedAt: '2026-09-01T10:00:00.000Z' });
    const newer = entry({ version: 'v5', rejectedAt: '2026-09-03T10:00:00.000Z' });
    assert.equal(findRejectedMatch([older, newer], CHALLENGER)?.version, 'v5');
    assert.equal(findRejectedMatch([older, newer], OTHER), null);
  });
});

// ─── The list ───────────────────────────────────────

describe('v0.18 rejection memory: the stored list', () => {
  it('keeps the newest entries when the cap is reached', () => {
    const state = { rejectedChallengers: {} } as DarwinState;
    for (let i = 0; i < REJECTION_MEMORY_CAP + 5; i++) {
      rememberRejection(state, 'researcher', entry({ version: `v${i}` }));
    }
    const list = state.rejectedChallengers!['researcher']!;
    assert.equal(list.length, REJECTION_MEMORY_CAP);
    assert.equal(list[0]!.version, 'v5', 'the five oldest were dropped');
    assert.equal(list[list.length - 1]!.version, `v${REJECTION_MEMORY_CAP + 4}`);
  });

  it('caps the STORED reason, not only the rendered one', async () => {
    // Round 1 measured `--reject --reason "$(cat build.log)"`: 200 kB in one
    // entry, in a blob that is read on every run, with room for 100 of them.
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    await loop.rejectChallenger('researcher', 'x'.repeat(200_000));

    const stored = rejectionsFor(memory._state, 'researcher')[0]!;
    assert.ok(
      stored.reason!.length <= REJECTION_STORED_REASON_CAP + ' [cut]'.length,
      `stored ${stored.reason!.length} characters`,
    );
    assert.ok(stored.reason!.endsWith(' [cut]'));
    assert.ok(
      JSON.stringify(memory._state).length < 10_000,
      'the whole state blob stays small',
    );
  });

  it('an empty reason is an ABSENT field, not an empty string', () => {
    assert.equal(clampStoredReason('   '), undefined);
    assert.equal(clampStoredReason(undefined), undefined);
    assert.equal(clampStoredReason('  keep me  '), 'keep me');
  });

  it('rejectionsFor never hands out the live array', () => {
    const state = { rejectedChallengers: { researcher: [entry()] } } as unknown as DarwinState;
    const copy = rejectionsFor(state, 'researcher');
    copy.push(entry({ version: 'v99' }));
    assert.equal(state.rejectedChallengers!['researcher']!.length, 1);
  });

  it('forgets one version, or all of them, and reports how many', () => {
    const state = { rejectedChallengers: {} } as DarwinState;
    rememberRejection(state, 'researcher', entry({ version: 'v2' }));
    rememberRejection(state, 'researcher', entry({ version: 'v3' }));

    assert.equal(forgetRejections(state, 'researcher', 'v2'), 1);
    assert.deepEqual(state.rejectedChallengers!['researcher']!.map((e) => e.version), ['v3']);
    assert.equal(forgetRejections(state, 'researcher', 'nope'), 0);
    assert.equal(forgetRejections(state, 'researcher', 'all'), 1);
    assert.equal(state.rejectedChallengers!['researcher'], undefined);
    assert.equal(forgetRejections(state, 'researcher', 'all'), 0, 'forgetting nothing is not an error');
  });
});

// ─── The notes ──────────────────────────────────────

describe('v0.18 rejection memory: which rejections get a voice', () => {
  it('only human rejections WITH a reason become notes', () => {
    const notes = rejectionNotes([
      entry({ version: 'v2', reason: 'drops the citation rule' }),
      entry({ version: 'v3', rejectedBy: 'timeout' }),
      entry({ version: 'v4' }),
      entry({ version: 'v5', reason: '   ' }),
      entry({ version: 'v6', rejectedBy: 'timeout', reason: 'never read by anyone' }),
    ]);
    assert.deepEqual(notes.map((n) => n.version), ['v2']);
  });

  it('is newest-first and honours the limit', () => {
    const entries = [1, 2, 3, 4].map((i) => entry({ version: `v${i}`, reason: `reason ${i}` }));
    const notes = rejectionNotes(entries, { limit: 2 });
    assert.deepEqual(notes.map((n) => n.version), ['v4', 'v3']);
  });

  it('cuts an over-long reason and says that it did', () => {
    const notes = rejectionNotes([entry({ reason: 'x'.repeat(900) })], { reasonCap: 40 });
    assert.ok(notes[0]!.reason.endsWith(' [cut]'));
    assert.equal(notes[0]!.reason.slice(0, -' [cut]'.length), 'x'.repeat(40));
  });

  it('renders nothing at all for no notes, so an unaffected prompt is unchanged', () => {
    assert.equal(formatRejectionNotes([]), '');
  });

  it('fits inside the reflector budget at the DOCUMENTED defaults', () => {
    // Round 1 of the review did this sum and found it did not add up: five
    // notes at the 500-character reason cap plus the preamble is about 2.867
    // characters against a 2.000 cap, so the reflector was cutting the block
    // mid-sentence at the defaults the README advertises.
    const worst = [1, 2, 3, 4, 5].map((i) =>
      entry({ version: `v${i}`, reason: 'x'.repeat(REJECTION_REASON_CAP) }),
    );
    const notes = rejectionNotes(worst);
    assert.equal(notes.length, REJECTION_NOTES_LIMIT, 'the default window is full');
    const unbudgeted = formatRejectionNotes(notes);
    assert.ok(
      unbudgeted.length > DEFAULT_FEEDBACK_CAP,
      'the premise: at the defaults the block DOES exceed the reflector cap',
    );
    const budgeted = formatRejectionNotes(notes, { maxChars: DEFAULT_FEEDBACK_CAP - 40 });
    assert.ok(
      budgeted.length <= DEFAULT_FEEDBACK_CAP - 40,
      `budgeted block is ${budgeted.length} characters`,
    );
  });

  it('drops WHOLE notes, oldest first, rather than cutting one in half', () => {
    const notes = rejectionNotes([
      entry({ version: 'v1', reason: 'oldest constraint' }),
      entry({ version: 'v2', reason: 'middle constraint' }),
      entry({ version: 'v3', reason: 'newest constraint' }),
    ]);
    // A budget that fits the preamble and the two newest lines, plus the
    // reserved "not shown" line. Measured off the full block rather than
    // counted by hand: hand-counting into a width budget is how the first
    // draft of the status box came out nine columns wrong.
    const full = formatRejectionNotes(notes);
    const oldestLine = full.split('\n').find((l) => l.includes('oldest constraint'))!;
    const budget = full.length - oldestLine.length - 1
      + '(1 older rejection(s) not shown here)'.length + 1;
    const block = formatRejectionNotes(notes, { maxChars: budget });

    assert.ok(block.includes('newest constraint'), block);
    assert.ok(!block.includes('oldest constraint'), `the oldest must go first:\n${block}`);
    assert.ok(block.includes('not shown here'), `the drop must be stated:\n${block}`);
    assert.ok(block.length <= budget, `${block.length} > ${budget}`);
    // No half sentence anywhere.
    for (const line of block.split('\n').filter((l) => l.startsWith('['))) {
      assert.ok(/constraint$/.test(line), `line was cut mid-sentence: ${line}`);
    }
  });

  it('renders nothing rather than a preamble with no constraints under it', () => {
    const notes = rejectionNotes([entry({ reason: 'a reason that will not fit' })]);
    assert.equal(formatRejectionNotes(notes, { maxChars: 50 }), '');
  });

  it('renders version, date and reason when there is something to say', () => {
    const block = formatRejectionNotes(rejectionNotes([entry({ reason: 'drops the citation rule' })]));
    assert.ok(block.includes('v2'));
    assert.ok(block.includes('2026-09-04'));
    assert.ok(block.includes('drops the citation rule'));
  });
});

// ─── The feature ────────────────────────────────────

describe('v0.18 rejection memory: a rejected text is not proposed again', () => {
  it('records the TEXT, not just the label, when a human rejects', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    await loop.rejectChallenger('researcher', 'drops the citation rule');

    const remembered = rejectionsFor(memory._state, 'researcher');
    assert.equal(remembered.length, 1);
    assert.equal(remembered[0]!.version, 'v2');
    assert.equal(remembered[0]!.versionA, 'v1');
    assert.equal(remembered[0]!.rejectedBy, 'human');
    assert.equal(remembered[0]!.reason, 'drops the citation rule');
    assert.equal(remembered[0]!.textHash, fingerprintPromptText(CHALLENGER));
  });

  it('records a LAPSED proposal too, but without a reason', async () => {
    const { memory, loop } = scenario({
      enabled: true, requireApproval: true, approvalTimeoutDays: 2,
    });
    await loop.forceEvolve('researcher');
    const pending = memory._state.pendingApprovals!['researcher']!;
    pending.proposedAt = new Date(Date.now() - 3 * 86400_000).toISOString();

    await loop.forceEvolve('researcher');

    const remembered = rejectionsFor(memory._state, 'researcher');
    assert.equal(remembered.length, 1);
    assert.equal(remembered[0]!.rejectedBy, 'timeout');
    assert.equal(remembered[0]!.reason, undefined, 'nobody read it, so it teaches nothing');
    assert.deepEqual(rejectionNotes(remembered), [], 'and it never reaches the optimizer');
  });

  it('refuses the repeat with the gate ON, writing no version row', async () => {
    const sink = makeSink();
    const { memory, loop } = scenario({ enabled: true, requireApproval: true }, { metrics: sink });
    await loop.forceEvolve('researcher');
    await loop.rejectChallenger('researcher', 'drops the citation rule');

    const again = await loop.forceEvolve('researcher');

    assert.equal(again.promptEvolved, false);
    assert.equal(again.abTestStarted, false);
    assert.equal(memory._versions.filter((v) => v.version === 'v3').length, 0);
    assert.equal(memory._state.pendingApprovals!['researcher'], null, 'nothing new is pending');
    assert.ok(
      sink.events.some((e) => e.type === 'evolution_skipped' && e.data.reason === 'rejected_repeat'),
    );
    // Round 1 of the review: the sink documents an `action: 'refused'` arm on
    // `rejected_repeat`, and before this it only ever fired on the rare
    // in-lock race. An operator building the "this agent proposes nothing any
    // more" alarm on the documented event would have watched a counter that
    // stays at zero for the case the alarm exists for.
    assert.ok(
      sink.events.some((e) => e.type === 'rejected_repeat' && e.data.action === 'refused'),
      `the documented refusal event must fire on the COMMON path, got: ${
        sink.events.map((e) => `${e.type}/${String(e.data.action ?? e.data.reason ?? '')}`).join(', ')
      }`,
    );
    // Its own flag, so the CLI can say so instead of printing it under the
    // generic "nothing happened" tail. This state RECURS: same inputs, same
    // text, same refusal, until a person acts.
    assert.equal(again.rejectedRepeat, true);
  });

  it('refuses the repeat with the gate OFF as well, so it never reaches traffic', async () => {
    // Rejections only ever come from the gate, but the gate can be turned off
    // afterwards. Putting an explicitly rejected text straight onto half of
    // live traffic is worse than asking again, so the refusal does not depend
    // on the gate still being armed.
    const { memory, loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    await loop.rejectChallenger('researcher', 'drops the citation rule');

    const ungated = buildLoop({
      memory,
      agent: makeAgent({ enabled: true }),
    }).loop;
    const again = await ungated.forceEvolve('researcher');

    assert.equal(again.abTestStarted, false, 'no A/B test may open on a rejected text');
    assert.equal(memory._state.abTests['researcher'] ?? null, null);
  });

  it('the refusal names the way out', async () => {
    const { loop } = scenario({ enabled: true, requireApproval: true });
    await loop.forceEvolve('researcher');
    await loop.rejectChallenger('researcher');
    const again = await loop.forceEvolve('researcher');
    assert.ok(again.message.includes('--forget'), again.message);
    assert.ok(again.message.includes('v2'), again.message);
  });

  it('a DIFFERENT text still evolves normally, so the memory is not a freeze', async () => {
    const { memory, loop } = scenario({ enabled: true, requireApproval: true }, {
      outputs: [CHALLENGER, OTHER],
    });
    await loop.forceEvolve('researcher');
    await loop.rejectChallenger('researcher', 'drops the citation rule');

    const next = await loop.forceEvolve('researcher');

    assert.equal(next.promptEvolved, true);
    assert.equal(next.newVersion, 'v3', 'the spent label is not reused');
    assert.ok(memory._state.pendingApprovals!['researcher'], 'and it is proposed properly');
  });

  it('forgetting releases the text', async () => {
    const sink = makeSink();
    const { memory, loop } = scenario({ enabled: true, requireApproval: true }, { metrics: sink });
    await loop.forceEvolve('researcher');
    await loop.rejectChallenger('researcher', 'drops the citation rule');
    assert.equal((await loop.forceEvolve('researcher')).promptEvolved, false);

    const forgotten = await loop.forgetRejection('researcher', 'v2');
    assert.equal(forgotten.forgotten, 1);

    const again = await loop.forceEvolve('researcher');
    assert.equal(again.promptEvolved, true, 'the same text may be proposed once it is forgotten');
    assert.ok(memory._state.pendingApprovals!['researcher']);
    assert.ok(sink.events.some((e) => e.type === 'rejection_forgotten'));
  });

  it('forgetting something that is not remembered says so instead of pretending', async () => {
    const { loop } = scenario({ enabled: true, requireApproval: true });
    const res = await loop.forgetRejection('researcher', 'v7');
    assert.equal(res.forgotten, 0);
    assert.ok(res.message.includes('v7'), res.message);
  });
});

// ─── The brake on a refused cycle ───────────────────────────────────────

describe('v0.18 rejection memory: a refused cycle does not pay twice', () => {
  /**
   * Round 1 of the adversarial review: a refusal writes no test and no
   * proposal, and `SafetyGate.canEvolve` is `totalRuns >= threshold`, which is
   * monotonic. So without a brake the next qualifying run pays the whole
   * generator chain again, and the one after that, forever. Measured cost was
   * one optimizer call per run, plus a reflection call under `useGepa`, plus
   * the persisted lifetime merge budget burning down under `useMerge`.
   */
  function countingScenario(evolution: AgentDefinition['evolution']) {
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
    );
    // Weak runs, so the automatic loop wants to evolve.
    for (let i = 0; i < 15; i++) {
      memory._experiments.push(makeExperiment({
        agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
        metrics: { qualityScore: 3, sourceCount: 11, outputLength: 6000, errorCount: 0, durationMs: 30000 },
        feedback: { score: 3, report: 'Weak: shallow analysis.', evaluator: 'multi-critic' },
      }));
    }
    let calls = 0;
    const sink = makeSink();
    const loop = new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      optimizer: new PromptOptimizer(async () => { calls++; return CHALLENGER; }),
      agent: makeAgent(evolution),
      metrics: sink,
    });
    const trigger = () => makeExperiment({
      agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
      metrics: { qualityScore: 3, sourceCount: 11, outputLength: 6000, errorCount: 0, durationMs: 30000 },
      feedback: { score: 3, report: 'Still weak.', evaluator: 'multi-critic' },
    });
    return { memory, loop, sink, trigger, calls: () => calls };
  }

  it('generates once, is refused, and then STOPS generating for the cool-down', async () => {
    // The measurement the review asked for: how many optimizer calls does a
    // stuck agent cost over five runs? Before the cool-down: five. After:
    // three, and the third only because the cool-down expires on its own.
    // The number below is the one this test asserts, not a remembered one.
    const { memory, loop, trigger, calls, sink } = countingScenario({
      enabled: true, requireApproval: true, minRuns: 3,
    });

    await loop.afterRun(trigger());
    assert.equal(calls(), 1, 'the first cycle generates');
    assert.ok(memory._state.pendingApprovals?.['researcher'], 'and proposes');

    await loop.rejectChallenger('researcher', 'drops the citation rule');

    // The cycle that DISCOVERS the repeat still has to generate: the only way
    // to know what a generator produces is to run it.
    const refused = await loop.afterRun(trigger());
    assert.equal(refused.rejectedRepeat, true);
    assert.equal(calls(), 2, 'the refusing cycle generated once');

    const stall = memory._state.rejectionStalls?.['researcher'];
    assert.ok(stall, 'a cool-down must be written');
    assert.equal(stall!.version, 'v2');
    assert.equal(
      stall!.retryAtExperimentCount,
      (memory._state.experimentCounts['researcher'] ?? 0) + 3,
      'the cool-down is minRuns long and snapshotted',
    );

    // Three more runs. The first two are inside the cool-down and must cost
    // nothing; the third reaches the retry point and generates again.
    const during1 = await loop.afterRun(trigger());
    assert.equal(calls(), 2, 'inside the cool-down, no model call');
    assert.ok(during1.message.includes('waiting for'), during1.message);
    assert.ok(
      sink.events.some(
        (e) => e.type === 'evolution_skipped' && e.data.reason === 'rejected_repeat_stalled',
      ),
      'and the wait is observable',
    );

    await loop.afterRun(trigger());
    assert.equal(calls(), 2, 'still inside the cool-down');

    await loop.afterRun(trigger());
    assert.equal(calls(), 3, 'the cool-down expires on its own, with nobody acting');
  });

  it('counts down, and says how many runs are left', async () => {
    const { memory, loop, trigger } = countingScenario({
      enabled: true, requireApproval: true, minRuns: 3,
    });
    await loop.afterRun(trigger());
    await loop.rejectChallenger('researcher', 'drops the citation rule');
    await loop.afterRun(trigger());

    const first = await loop.afterRun(trigger());
    assert.ok(first.message.includes('waiting for 2 more run'), first.message);
    const second = await loop.afterRun(trigger());
    assert.ok(second.message.includes('waiting for 1 more run'), second.message);
    assert.ok(memory._state.rejectionStalls?.['researcher'], 'and it is still parked');
  });

  it('a forced attempt does NOT push the automatic retry further out', async () => {
    // Round 2, measured: the refusal message recommends `--force`, and
    // `forceEvolve` shares the same tail. Arming the cool-down there too meant
    // every forced attempt moved the automatic retry later (minRuns 5: refusal
    // at run 2 set retry to 7, a force at run 4 moved it to 9). Following the
    // advice in the message made the situation worse.
    const { memory, loop, trigger } = countingScenario({
      enabled: true, requireApproval: true, minRuns: 5,
    });
    await loop.afterRun(trigger());
    await loop.rejectChallenger('researcher', 'drops the citation rule');
    await loop.afterRun(trigger());

    const before = memory._state.rejectionStalls!['researcher']!.retryAtExperimentCount;
    await loop.afterRun(trigger());
    await loop.forceEvolve('researcher');

    assert.equal(
      memory._state.rejectionStalls!['researcher']!.retryAtExperimentCount,
      before,
      'a forced attempt must not move the automatic retry point',
    );
  });

  it('forgetting a DIFFERENT label leaves the cool-down alone', async () => {
    const { memory, loop } = countingScenario({ enabled: true, requireApproval: true });
    memory._state.rejectedChallengers = {
      researcher: [
        { version: 'v2', versionA: 'v1', textHash: 'a'.repeat(64),
          rejectedAt: new Date().toISOString(), rejectedBy: 'human', generatedBy: 'legacy' },
        { version: 'v3', versionA: 'v1', textHash: fingerprintPromptText(CHALLENGER),
          rejectedAt: new Date().toISOString(), rejectedBy: 'human', generatedBy: 'legacy' },
      ],
    };
    memory._state.rejectionStalls = {
      researcher: { retryAtExperimentCount: 9999, at: new Date().toISOString(), version: 'v3' },
    };

    await loop.forgetRejection('researcher', 'v2');
    assert.ok(
      memory._state.rejectionStalls?.['researcher'],
      'forgetting v2 does not release a cool-down that names v3',
    );

    await loop.forgetRejection('researcher', 'v3');
    assert.equal(memory._state.rejectionStalls?.['researcher'] ?? null, null);
  });

  it('forceEvolve ignores the brake, because a human asked', async () => {
    const { memory, loop, calls } = countingScenario({ enabled: true, requireApproval: true });
    memory._state.rejectionStalls = {
      researcher: { retryAtExperimentCount: 9999, at: new Date().toISOString(), version: 'v2' },
    };
    memory._state.experimentCounts['researcher'] = 0;

    const forced = await loop.forceEvolve('researcher');

    assert.equal(calls(), 1, 'a forced cycle must actually generate');
    assert.ok(memory._state.pendingApprovals?.['researcher'], forced.message);
  });

  it('a proposal that DOES open clears the brake', async () => {
    const { memory, loop } = countingScenario({ enabled: true, requireApproval: true });
    memory._state.rejectionStalls = {
      researcher: { retryAtExperimentCount: 9999, at: new Date().toISOString(), version: 'v2' },
    };

    await loop.forceEvolve('researcher');

    assert.equal(
      memory._state.rejectionStalls?.['researcher'] ?? null,
      null,
      'a marker surviving a successful cycle would silence the next run for nothing',
    );
  });

  it('forgetting clears the brake, so the escape hatch actually releases', async () => {
    const { memory, loop } = countingScenario({ enabled: true, requireApproval: true });
    memory._state.rejectedChallengers = {
      researcher: [{
        version: 'v2', versionA: 'v1', textHash: fingerprintPromptText(CHALLENGER),
        rejectedAt: new Date().toISOString(), rejectedBy: 'human', generatedBy: 'legacy',
      }],
    };
    memory._state.rejectionStalls = {
      researcher: { retryAtExperimentCount: 9999, at: new Date().toISOString(), version: 'v2' },
    };

    await loop.forgetRejection('researcher', 'v2');

    assert.equal(memory._state.rejectionStalls?.['researcher'] ?? null, null);
  });
});

// ─── The window between reading the memory and writing the proposal ─────

describe('v0.18 rejection memory: a rejection landing DURING generation', () => {
  /**
   * The memory is read before the challenger is generated, and generating it
   * is a model call: seconds to minutes. A rejection landing in that window
   * would otherwise put an already-refused text back in front of the same
   * person, or, with the gate off, straight onto half the traffic.
   *
   * The optimizer stub is where the rejection is injected, because that is
   * exactly where the real wait happens.
   */
  function racingScenario(evolution: AgentDefinition['evolution']) {
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
    );
    seedExperiments(memory, 3);
    const sink = makeSink();
    const loop = new DarwinLoop({
      memory,
      tracker: new ExperimentTracker(memory),
      safety: new SafetyGate(),
      patterns: new PatternDetector(memory),
      optimizer: new PromptOptimizer(async () => {
        // Another process rejects this very text while we are "thinking".
        await memory.updateState((s) => rememberRejection(s, 'researcher', {
          version: 'v9',
          versionA: 'v1',
          textHash: fingerprintPromptText(CHALLENGER),
          rejectedAt: new Date().toISOString(),
          rejectedBy: 'human',
          reason: 'decided elsewhere',
          generatedBy: 'legacy',
        }));
        return CHALLENGER;
      }),
      agent: makeAgent(evolution),
      metrics: sink,
    });
    return { memory, loop, sink };
  }

  it('is caught inside the lock, with the gate ON', async () => {
    const { memory, loop, sink } = racingScenario({ enabled: true, requireApproval: true });

    const result = await loop.forceEvolve('researcher');

    assert.equal(result.promptEvolved, false);
    assert.equal(result.rejectedRepeat, true);
    assert.equal(memory._state.pendingApprovals?.['researcher'] ?? null, null, 'nothing parked');
    assert.ok(result.message.includes('while it was being generated'), result.message);
    assert.ok(
      sink.events.some((e) => e.type === 'rejected_repeat' && e.data.action === 'refused'),
    );
  });

  it('is caught inside the lock with the gate OFF too, where it matters more', async () => {
    const { memory, loop } = racingScenario({ enabled: true });

    const result = await loop.forceEvolve('researcher');

    assert.equal(result.abTestStarted, false, 'no test may open on a rejected text');
    assert.equal(memory._state.abTests['researcher'] ?? null, null);
    assert.equal(result.rejectedRepeat, true);
  });
});

// ─── The demo path, which is what the limitation was about ──────────────

describe('v0.18 rejection memory: the demo path falls through instead of repeating', () => {
  /**
   * The v0.17 README named this exact case. The demo section is built
   * deterministically from the active prompt plus the agent's best runs, and
   * rejecting changes neither, so the identical text came back every
   * `demoEveryK` cycles under a new label.
   */
  function demoScenario(metrics?: MetricsSink) {
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
    );
    // Weak runs to justify evolving, plus strong ones to harvest as demos.
    for (let i = 0; i < 15; i++) {
      memory._experiments.push(makeExperiment({
        agentName: 'researcher', promptVersion: 'v1', taskType: 'tech', success: true,
        metrics: { qualityScore: 5.5, sourceCount: 10, outputLength: 6000, errorCount: 0, durationMs: 30000 },
        feedback: { score: 5.5, report: 'Weak: shallow analysis.', evaluator: 'multi-critic' },
      }));
    }
    for (let i = 0; i < 2; i++) {
      memory._experiments.push(makeExperiment({
        agentName: 'researcher', promptVersion: 'v1', taskType: `market-${i}`,
        task: `strong task ${i}`, success: true, output: 'x'.repeat(3000),
        metrics: { qualityScore: 9, sourceCount: 12, outputLength: 6000, errorCount: 0, durationMs: 20000 },
        feedback: { score: 9, report: 'Excellent depth.', evaluator: 'multi-critic' },
      }));
    }
    const { loop } = buildLoop({
      memory,
      agent: makeAgent({ enabled: true, requireApproval: true, useDemos: true, demoEveryK: 1 }),
      outputs: [OTHER],
      ...(metrics ? { metrics } : {}),
    });
    return { memory, loop };
  }

  it('the same demo challenger is not put in front of a human twice', async () => {
    const sink = makeSink();
    const { memory, loop } = demoScenario(sink);

    const first = await loop.forceEvolve('researcher');
    assert.ok(first.message.includes('via demos'), first.message);
    const demoText = memory._versions.find((v) => v.version === 'v2')!.promptText;

    await loop.rejectChallenger('researcher', 'the examples are all one task type');

    const second = await loop.forceEvolve('researcher');

    // The cycle still produced something: the demo path fell through to the
    // legacy optimizer rather than ending the cycle.
    assert.equal(second.promptEvolved, true, 'the agent keeps evolving');
    assert.ok(second.message.includes('via legacy'), second.message);
    const v3 = memory._versions.find((v) => v.version === 'v3')!;
    assert.notEqual(v3.promptText, demoText, 'and it is NOT the rejected text');
    assert.ok(
      sink.events.some(
        (e) => e.type === 'rejected_repeat' && e.data.generator === 'demos' && e.data.action === 'fell_through',
      ),
      'the fall-through is observable, not silent',
    );
  });
});

describe('v0.18 rejection memory: the GEPA path falls through as well', () => {
  it('a repeat from the reflector falls through to legacy, and says which generator', async () => {
    // Round 2 named this coverage gap: `rejected_repeat {action:'fell_through'}`
    // was pinned for the demo generator only, so the GEPA arm of the same
    // branch had no test at all.
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
    );
    seedExperiments(memory, 3);
    memory._state.rejectedChallengers = {
      researcher: [{
        version: 'v9', versionA: 'v1', textHash: fingerprintPromptText(CHALLENGER),
        rejectedAt: new Date().toISOString(), rejectedBy: 'human',
        reason: 'drops the citation rule', generatedBy: 'gepa',
      }],
    };

    const sink = makeSink();
    // The reflector returns the rejected text; the legacy optimizer returns
    // something else. So the cycle must end on legacy, not be refused.
    const gepa = new GepaOptimizer(async () => CHALLENGER);
    const { loop } = buildLoop({
      memory,
      agent: makeAgent({ enabled: true, requireApproval: true, useGepa: true }),
      outputs: [OTHER],
      metrics: sink,
      gepa,
    });

    const result = await loop.forceEvolve('researcher');

    assert.equal(result.promptEvolved, true, 'the agent keeps evolving');
    assert.ok(result.message.includes('via legacy'), result.message);
    assert.ok(
      sink.events.some(
        (e) => e.type === 'rejected_repeat'
          && e.data.generator === 'gepa'
          && e.data.action === 'fell_through',
      ),
      `the GEPA fall-through must name its generator, got: ${
        sink.events.filter((e) => e.type === 'rejected_repeat').map((e) => JSON.stringify(e.data)).join(', ')
      }`,
    );
  });
});

// ─── The reason reaches the next generation ─────────────────────────────

describe('v0.18 rejection memory: the reviewer teaches the optimizer', () => {
  it('puts the reason into the legacy meta-prompt, and nothing when there is none', async () => {
    const { loop, prompts } = scenario({ enabled: true, requireApproval: true }, {
      outputs: [CHALLENGER, OTHER],
    });

    await loop.forceEvolve('researcher');
    const firstPrompt = prompts[0]!;
    assert.ok(
      !firstPrompt.includes('REJECTED BY A HUMAN REVIEWER'),
      'a fresh agent gets the v0.17 meta-prompt unchanged',
    );

    await loop.rejectChallenger('researcher', 'drops the citation rule');
    await loop.forceEvolve('researcher');

    const secondPrompt = prompts[1]!;
    assert.ok(secondPrompt.includes('REJECTED BY A HUMAN REVIEWER'), secondPrompt.slice(-400));
    assert.ok(secondPrompt.includes('drops the citation rule'));
    assert.ok(secondPrompt.includes('v2'));
    // Round 1 of the adversarial review killed the assertion that used to sit
    // here: `indexOf(reason) < indexOf(task)` is true from ANYWHERE in the
    // prompt, so it passed with the block moved to position 0 and it passed
    // with the block buried above a pattern list of any length. An ordering
    // assertion cannot pin a placement.
    //
    // What the comment in optimizer.ts claims is ADJACENCY: nothing between
    // the reviewer's block and the task line. So read the slice between them
    // and demand it holds nothing but that block.
    // Round 2 killed the FIRST replacement for the vacuous ordering check.
    // `slice(start, end)` returns '' when start > end, and an empty string
    // satisfies every assertion about what it does not contain: moving the
    // block BEHIND the task line (the exact opposite of what the comment and
    // the README claim) left all 35 tests green. The fix traded one blind spot
    // for another, on the side the README had just sharpened.
    //
    // So: the ordering assertion goes back, NEXT TO the slice one. Ordering
    // alone cannot pin a placement; a slice alone cannot pin a direction.
    const blockAt = secondPrompt.indexOf('--- REJECTED BY A HUMAN REVIEWER ---');
    const taskAt = secondPrompt.indexOf('--- YOUR TASK ---');
    assert.ok(blockAt >= 0, 'the reviewer block must be in the prompt at all');
    assert.ok(taskAt >= 0, 'and so must the task line');
    assert.ok(
      blockAt < taskAt,
      `the constraint must come BEFORE the task line (block at ${blockAt}, task at ${taskAt})`,
    );
    const between = secondPrompt.slice(blockAt, taskAt);
    assert.ok(between.length > 0, 'a zero-length slice proves nothing');
    assert.ok(
      !between.includes('--- DETECTED PATTERNS ---'),
      `the pattern block must not sit between the constraint and the task:\n${between}`,
    );
    assert.equal(
      between.replace('--- REJECTED BY A HUMAN REVIEWER ---', '').replace(formatRejectionNotes(
        rejectionNotes([{
          version: 'v2', versionA: 'v1', rejectedAt: '2026-09-04T10:00:00.000Z',
          rejectedBy: 'human', reason: 'drops the citation rule', generatedBy: 'legacy',
        }]),
      ), '').trim(),
      '',
      `nothing but the reviewer block may sit between it and the task line:\n${between}`,
    );
  });

  it('rejectionNoteLimit 0 quotes nothing but still refuses the repeat', async () => {
    const { memory, loop, prompts } = scenario(
      { enabled: true, requireApproval: true, rejectionNoteLimit: 0 },
      { outputs: [CHALLENGER, CHALLENGER] },
    );
    await loop.forceEvolve('researcher');
    await loop.rejectChallenger('researcher', 'drops the citation rule');

    const again = await loop.forceEvolve('researcher');

    assert.ok(
      !prompts[1]!.includes('drops the citation rule'),
      'the reason was not quoted',
    );
    assert.equal(again.promptEvolved, false, 'and the refusal is not a preference');
    assert.equal(memory._versions.filter((v) => v.version === 'v3').length, 0);
  });

  it('reaches the GEPA reflector as its own feedback entry', async () => {
    const memory = createMockMemory();
    memory._versions.push(
      makePromptVersion({ version: 'v1', agentName: 'researcher', active: true, promptText: SAFE_PROMPT }),
    );
    seedExperiments(memory, 3);

    // Capture what the reflector is handed. The GepaOptimizer takes a
    // run-prompt function, so the reflection prompt IS the observable.
    const reflectionPrompts: string[] = [];
    const gepa = new GepaOptimizer(async (p: string) => {
      reflectionPrompts.push(p);
      return reflectionPrompts.length === 1 ? CHALLENGER : OTHER;
    });
    const { loop } = buildLoop({
      memory,
      agent: makeAgent({ enabled: true, requireApproval: true, useGepa: true }),
      outputs: [OTHER],
      gepa,
    });

    await loop.forceEvolve('researcher');
    assert.ok(
      !reflectionPrompts[0]!.includes('REJECTED BY A HUMAN REVIEWER'),
      'nothing rejected yet, so the reflection prompt is unchanged',
    );

    await loop.rejectChallenger('researcher', 'drops the citation rule');
    await loop.forceEvolve('researcher');

    assert.ok(reflectionPrompts.length > 1, 'the reflector ran again');
    const second = reflectionPrompts[1]!;
    assert.ok(second.includes('REJECTED BY A HUMAN REVIEWER'), second.slice(0, 600));
    assert.ok(second.includes('drops the citation rule'));
    // Its own entry, with its own id, rather than appended to a critic report.
    assert.ok(/=== Variant \d+ . v2 \(score 0\.00\) ===/.test(second), second.slice(-800));
  });
});

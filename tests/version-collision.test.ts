/**
 * Challenger version labels must never collide with existing history.
 *
 * Regression coverage for the "rejected challenger gets overwritten" defect.
 * When an A/B test concludes in favour of the incumbent, the loser keeps its
 * label and the incumbent stays ACTIVE. The next evolution cycle used to derive
 * the challenger label from the active version alone — producing the loser's
 * label a second time. `savePromptVersion` upserts on (agentName, version), so
 * that second challenger silently overwrote the first one's row: its prompt
 * text was destroyed, and `createdAt`/`parentVersion` were left describing a
 * prompt that no longer existed.
 *
 * The assertions below are written against the CONTRACT ("generating a
 * challenger must not rewrite an existing version") rather than against one
 * named victim, so they keep holding if the numbering scheme changes.
 *
 * Note on the pre-existing suite: `loop-integration-v07.ts` deliberately seeds
 * v1/v2 as history with v3 ACTIVE, commented "no name clash with the existing
 * versions". It routed around this defect instead of covering it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DarwinLoop } from '../src/evolution/loop.js';
import { SafetyGate } from '../src/evolution/safety.js';
import { ExperimentTracker } from '../src/evolution/tracker.js';
import { PatternDetector } from '../src/evolution/patterns.js';
import { PromptOptimizer } from '../src/evolution/optimizer.js';
import { createMockMemory, makeExperiment, makePromptVersion } from './helpers.js';
import type { AgentDefinition, DarwinMetrics, PromptVersion } from '../src/types.js';

const SAFE_PROMPT = 'You are a research agent. Never fabricate sources.';
const CHALLENGER_TEXT = 'You are a research agent. Never fabricate sources. Cite primary documents.';

function makeAgent(): AgentDefinition {
  return {
    name: 'researcher',
    role: 'Researcher',
    description: 'test agent',
    type: 'llm',
    systemPrompt: SAFE_PROMPT,
    model: 'claude-sonnet-4-6',
    evolution: { enabled: true, minRuns: 5 },
  };
}

function metrics(partial: Partial<DarwinMetrics> = {}): DarwinMetrics {
  return {
    qualityScore: 4.0,
    sourceCount: 8,
    outputLength: 6000,
    errorCount: 0,
    durationMs: 30000,
    ...partial,
  };
}

/**
 * Reproduce the production state: `active` is the incumbent, `history` holds
 * every version already on record, and the active agent scores badly enough to
 * trigger a fresh evolution cycle.
 */
async function evolveOnce(versions: PromptVersion[], activeVersion: string) {
  const memory = createMockMemory();
  memory._versions.push(...versions);

  // Weak scores on the ACTIVE version → weakness detected → evolution fires.
  for (let i = 0; i < 20; i++) {
    const e = makeExperiment({
      agentName: 'researcher',
      promptVersion: activeVersion,
      taskType: 'tech',
      success: true,
      metrics: metrics(),
    });
    e.feedback = { score: 4.0, report: `weak run ${i}`, evaluator: 'multi-critic' };
    memory._experiments.push(e);
  }

  const loop = new DarwinLoop({
    memory,
    tracker: new ExperimentTracker(memory),
    optimizer: new PromptOptimizer(async () => CHALLENGER_TEXT),
    safety: new SafetyGate(),
    patterns: new PatternDetector(memory),
    agent: makeAgent(),
  });

  const before = memory._versions.map((v) => ({ ...v }));
  const result = await loop.afterRun(
    makeExperiment({
      agentName: 'researcher',
      promptVersion: activeVersion,
      taskType: 'tech',
      success: true,
      metrics: metrics(),
      feedback: { score: 4.0, report: 'trigger', evaluator: 'multi-critic' },
    }),
  );

  return { memory, result, before };
}

describe('challenger version labels never collide with history', () => {
  it('does not rewrite a rejected challenger when the incumbent stays active', async () => {
    // v1 won the previous A/B test, so v2 is a REJECTED challenger still on
    // record and v1 is active again. This is the exact production shape.
    const rejected = makePromptVersion({
      version: 'v2',
      active: false,
      promptText: 'REJECTED CHALLENGER TEXT',
      parentVersion: 'v1',
      changeReason: 'first challenger',
      createdAt: '2026-07-18T16:08:30.000Z',
    });
    const incumbent = makePromptVersion({ version: 'v1', active: true, promptText: SAFE_PROMPT });

    const { memory, result, before } = await evolveOnce([incumbent, rejected], 'v1');

    assert.equal(result.promptEvolved, true, 'evolution should have produced a challenger');

    // The contract: nothing that already existed may be rewritten.
    for (const original of before) {
      const now = memory._versions.find(
        (v) => v.agentName === original.agentName && v.version === original.version,
      );
      assert.ok(now, `version ${original.version} disappeared`);
      assert.equal(
        now.promptText,
        original.promptText,
        `version ${original.version} had its prompt text rewritten`,
      );
      assert.equal(
        now.createdAt,
        original.createdAt,
        `version ${original.version} had its createdAt rewritten`,
      );
    }

    // And the challenger is genuinely additive.
    assert.equal(memory._versions.length, before.length + 1, 'challenger should be a new row');
    const challenger = memory._versions.find((v) => v.promptText === CHALLENGER_TEXT);
    assert.ok(challenger, 'challenger row not found');
    assert.equal(challenger.version, 'v3', 'numbering should continue above the highest version');
    assert.equal(result.newVersion, 'v3');
  });

  it('keeps numbering above the highest version across repeated rejections', async () => {
    // Three rejected challengers already on record, incumbent still v1.
    const versions = [
      makePromptVersion({ version: 'v1', active: true, promptText: SAFE_PROMPT }),
      makePromptVersion({ version: 'v2', active: false, promptText: 'rejected A' }),
      makePromptVersion({ version: 'v3', active: false, promptText: 'rejected B' }),
      makePromptVersion({ version: 'v4', active: false, promptText: 'rejected C' }),
    ];

    const { memory, result, before } = await evolveOnce(versions, 'v1');

    assert.equal(result.newVersion, 'v5', 'must clear the whole history, not just the active one');
    assert.equal(memory._versions.length, before.length + 1);
    for (const original of before) {
      const now = memory._versions.find((v) => v.version === original.version);
      assert.equal(now?.promptText, original.promptText, `${original.version} was rewritten`);
    }
  });

  it('stays collision-free beyond any fixed probe cap (all-non-numeric history)', async () => {
    // Third-model-review finding (Codex R1 F3): the original walk stopped
    // after a fixed 100 probes and returned a possibly-taken label. The bound
    // is now the history size itself — the candidate sequence never revisits
    // a label, so after |taken| collisions the next candidate MUST be free.
    // 101 chained non-numeric labels defeat the old cap exactly.
    const versions = [
      makePromptVersion({ version: 'legacy', active: true, promptText: SAFE_PROMPT }),
    ];
    let label = 'legacy';
    for (let i = 0; i < 101; i++) {
      label = `${label}-v2`;
      versions.push(makePromptVersion({ version: label, active: false, promptText: `rejected ${i}` }));
    }

    const { memory, result, before } = await evolveOnce(versions, 'legacy');

    assert.equal(result.promptEvolved, true);
    const takenBefore = new Set(before.map((v) => v.version));
    assert.ok(result.newVersion, 'a new version label must be reported');
    assert.equal(
      takenBefore.has(result.newVersion!),
      false,
      `label ${result.newVersion} collides with the existing history`,
    );
    assert.equal(memory._versions.length, before.length + 1, 'challenger must be additive');
    for (const original of before) {
      const now = memory._versions.find((v) => v.version === original.version);
      assert.equal(now?.promptText, original.promptText, `${original.version} was rewritten`);
    }
  });

  it('survives the parseInt-saturation label without pinning on a taken candidate', async () => {
    // Round-2 cross-model review counterexample: nextVersion self-maps at
    // 2^53 (`nextVersion("v9007199254740992") === "v9007199254740992"`). The
    // raw walk would produce the same taken candidate forever and hand the
    // upsert a colliding label — worse, an A/B test with versionA ===
    // versionB. progressStep switches to the append strategy on any
    // non-progressing step, which strictly grows and closes the carve-out.
    const saturated = 'v9007199254740992'; // 2^53 — parseInt(x) + 1 === parseInt(x)
    const versions = [
      makePromptVersion({ version: saturated, active: true, promptText: SAFE_PROMPT }),
    ];

    const { memory, result, before } = await evolveOnce(versions, saturated);

    assert.equal(result.promptEvolved, true);
    assert.ok(result.newVersion, 'a new version label must be reported');
    assert.notEqual(result.newVersion, saturated, 'must not reuse the saturated label');
    assert.equal(memory._versions.length, before.length + 1, 'challenger must be additive');
    const incumbent = memory._versions.find((v) => v.version === saturated);
    assert.equal(incumbent?.promptText, SAFE_PROMPT, 'incumbent row must survive');
    const test = memory._state.abTests['researcher'];
    assert.ok(test && test.versionA !== test.versionB, 'A/B arms must differ');
  });

  it('is unchanged when the active version already is the highest', async () => {
    // The healthy case: challenger won and was promoted. Numbering must behave
    // exactly as before the fix (v3 active → v4).
    const versions = [
      makePromptVersion({ version: 'v1', active: false, promptText: 'old' }),
      makePromptVersion({ version: 'v2', active: false, promptText: 'older challenger' }),
      makePromptVersion({ version: 'v3', active: true, promptText: SAFE_PROMPT }),
    ];

    const { result } = await evolveOnce(versions, 'v3');

    assert.equal(result.newVersion, 'v4');
  });
});

/**
 * Tests for the validate-by-reproduce drift-detection canary (Phase 2 A5).
 *
 * Covers the pure similarity metrics (Jaccard / sequence / error-rate), the
 * per-run comparison and its four trip dimensions, the sampling logic
 * (pattern-not-single-fail), and the experiment-level orchestration — including
 * the load-bearing baseline-staleness guard that must NOT fire drift right after
 * an intentional prompt evolution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  toolSequence,
  toolSet,
  jaccard,
  sequenceSimilarity,
  errorRate,
  compareTrajectory,
  evaluateCanary,
  runCanaryOverExperiments,
} from '../src/evolution/canary.js';
import type { DarwinExperiment, ExecutionTrace, TraceToolCall } from '../src/types.js';

// ── Fixtures ──────────────────────────────────────────────

function trace(
  tools: Array<[string, ('success' | 'error')?]>,
  opts: { turnCount?: number; turnErrors?: number } = {},
): ExecutionTrace {
  const toolCalls: TraceToolCall[] = tools.map(([tool, outcome], i) => ({
    tool,
    outcome: outcome ?? 'success',
    durationMs: 10,
    turn: i + 1,
  }));
  return {
    version: 1,
    toolCalls,
    textBlockCount: 0,
    turnCount: opts.turnCount ?? Math.max(1, tools.length),
    mcpInvocations: 0,
    errors: Array.from({ length: opts.turnErrors ?? 0 }, (_, i) => ({
      class: 'parse_error',
      message: 'boom',
      turn: i + 1,
    })),
    capturedAt: '2026-06-21T00:00:00.000Z',
  };
}

function exp(
  id: string,
  promptVersion: string,
  startedAt: string,
  trajectory: ExecutionTrace | undefined,
): DarwinExperiment {
  return {
    id,
    agentName: 'writer',
    promptVersion,
    task: 'task',
    taskType: 'general',
    startedAt,
    completedAt: startedAt,
    success: true,
    metrics: { qualityScore: 8, sourceCount: 0, outputLength: 3000, errorCount: 0, durationMs: 1000 },
    trajectory,
  };
}

// ── Signature extraction ──────────────────────────────────

describe('toolSequence / toolSet', () => {
  it('extracts ordered names and the distinct set', () => {
    const t = trace([['search'], ['read'], ['search']]);
    assert.deepEqual(toolSequence(t), ['search', 'read', 'search']);
    assert.deepEqual([...toolSet(t)].sort(), ['read', 'search']);
  });
});

// ── Pure metrics ──────────────────────────────────────────

describe('jaccard', () => {
  it('is 1 for identical sets, 0 for disjoint', () => {
    assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
    assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  });
  it('is the intersection-over-union for partial overlap', () => {
    // {a,b,c} vs {b,c,d}: ∩ = {b,c}=2, ∪ = {a,b,c,d}=4 → 0.5
    assert.equal(jaccard(new Set(['a', 'b', 'c']), new Set(['b', 'c', 'd'])), 0.5);
  });
  it('treats two empty sets as identical (1), one-empty as disjoint (0)', () => {
    assert.equal(jaccard(new Set(), new Set()), 1);
    assert.equal(jaccard(new Set(['a']), new Set()), 0);
  });
});

describe('sequenceSimilarity', () => {
  it('is 1 for identical sequences', () => {
    assert.equal(sequenceSimilarity(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  });
  it('penalises reordering / edits', () => {
    // one substitution out of 3 → 1 - 1/3
    assert.ok(Math.abs(sequenceSimilarity(['a', 'b', 'c'], ['a', 'x', 'c']) - 2 / 3) < 1e-9);
  });
  it('two empty sequences are identical; one-empty is 0', () => {
    assert.equal(sequenceSimilarity([], []), 1);
    assert.equal(sequenceSimilarity(['a', 'b'], []), 0);
  });
});

describe('errorRate', () => {
  it('counts tool errors + turn errors over turnCount', () => {
    // 1 tool error + 1 turn error over 4 turns = 0.5
    const t = trace([['a'], ['b', 'error']], { turnCount: 4, turnErrors: 1 });
    assert.equal(errorRate(t), 0.5);
  });
  it('is 0 with no errors and never divides by zero', () => {
    assert.equal(errorRate(trace([['a']], { turnCount: 0 })), 0);
  });
});

// ── Per-run comparison ────────────────────────────────────

describe('compareTrajectory', () => {
  const baseline = trace([['search'], ['read'], ['write']]);

  it('reports no drift for an identical trajectory', () => {
    const c = compareTrajectory(trace([['search'], ['read'], ['write']]), baseline);
    assert.equal(c.drifted, false);
    assert.deepEqual(c.reasons, []);
    assert.equal(c.toolJaccard, 1);
    assert.equal(c.turnRatio, 1);
  });

  it('flags a changed tool set', () => {
    const c = compareTrajectory(trace([['search'], ['delete'], ['publish']]), baseline);
    assert.equal(c.drifted, true);
    assert.ok(c.reasons.some((r) => r.includes('tool-set drift')));
  });

  it('flags turn inflation (the "agent is grinding" symptom)', () => {
    const c = compareTrajectory(trace([['search'], ['read'], ['write']], { turnCount: 9 }), baseline);
    assert.equal(c.drifted, true);
    assert.ok(c.reasons.some((r) => r.includes('turn inflation')));
  });

  it('flags an error-rate spike', () => {
    const c = compareTrajectory(
      trace([['search', 'error'], ['read', 'error'], ['write', 'error']]),
      baseline,
    );
    assert.equal(c.drifted, true);
    assert.ok(c.reasons.some((r) => r.includes('error-rate spike')));
  });

  it('respects custom thresholds (loosened → no drift)', () => {
    const c = compareTrajectory(trace([['search'], ['delete'], ['publish']]), baseline, {
      minToolJaccard: 0,
      minSequenceSimilarity: 0,
    });
    assert.equal(c.drifted, false);
  });
});

// ── Sampling ──────────────────────────────────────────────

describe('evaluateCanary', () => {
  const baseline = trace([['search'], ['read'], ['write']]);
  const stable = trace([['search'], ['read'], ['write']]);
  const drifted = trace([['search'], ['delete'], ['publish']]);

  it('handles an empty candidate set without alerting', () => {
    const r = evaluateCanary([], baseline);
    assert.equal(r.total, 0);
    assert.equal(r.alert, false);
  });

  it('does not alert on a single drifted run (noise, not a pattern)', () => {
    const r = evaluateCanary([stable, stable, drifted], baseline);
    assert.equal(r.driftedCount, 1);
    assert.equal(r.alert, false); // default minDriftedToAlert = 2
  });

  it('alerts once drift becomes a pattern (>= 2)', () => {
    const r = evaluateCanary([drifted, stable, drifted], baseline);
    assert.equal(r.driftedCount, 2);
    assert.equal(r.alert, true);
    assert.ok(r.reasons.length > 0);
  });

  it('honours a custom minDriftedToAlert', () => {
    const r = evaluateCanary([drifted, stable], baseline, { minDriftedToAlert: 1 });
    assert.equal(r.alert, true);
  });

  it('clamps a non-positive minDriftedToAlert back to the default of 2', () => {
    // {minDriftedToAlert: 0} would mean "alert on anything" — a footgun, so it
    // falls back to 2. One drifted run is then below threshold → no alert.
    const r = evaluateCanary([drifted, stable], baseline, { minDriftedToAlert: 0 });
    assert.equal(r.driftedCount, 1);
    assert.equal(r.alert, false);
  });

  it('reports medians across candidates', () => {
    const r = evaluateCanary([stable, stable, stable], baseline);
    assert.equal(r.medianToolJaccard, 1);
    assert.equal(r.medianTurnRatio, 1);
  });
});

// ── Experiment-level orchestration ────────────────────────

describe('runCanaryOverExperiments', () => {
  const base = trace([['search'], ['read'], ['write']]);
  const stable = () => trace([['search'], ['read'], ['write']]);
  const drift = () => trace([['search'], ['delete'], ['publish']]);

  it('returns no-trajectory when nothing was captured', () => {
    const exps = [exp('e1', 'v1', '2026-06-01', undefined)];
    const r = runCanaryOverExperiments('writer', exps, 'v1');
    assert.equal(r.status, 'no-trajectory');
    assert.equal(r.result, null);
  });

  it('skips trajectories with an unknown schema version (forward-compat contract)', () => {
    // A future v2 trace must be ignored, not mis-scored against a v1 baseline.
    const v2 = { ...stable(), version: 2 } as unknown as ExecutionTrace;
    const exps = [exp('e1', 'v2', '2026-06-10', v2)];
    const r = runCanaryOverExperiments('writer', exps, 'v2');
    assert.equal(r.status, 'no-trajectory');
  });

  it('returns insufficient-data when the active version is unknown', () => {
    const exps = [exp('e1', 'v1', '2026-06-01', base)];
    const r = runCanaryOverExperiments('writer', exps, null);
    assert.equal(r.status, 'insufficient-data');
  });

  it('does NOT cry drift right after an evolution — re-baseline in progress', () => {
    // All captured trajectories are on v1, but the agent just evolved to v2.
    // Comparing v2 against a v1 baseline would be a false alarm; the canary must
    // report insufficient-data instead.
    const exps = [
      exp('e1', 'v1', '2026-06-01', base),
      exp('e2', 'v1', '2026-06-02', drift()),
      exp('e3', 'v1', '2026-06-03', drift()),
      exp('e4', 'v1', '2026-06-04', drift()),
    ];
    const r = runCanaryOverExperiments('writer', exps, 'v2');
    assert.equal(r.status, 'insufficient-data');
    assert.match(r.message, /re-baseline/);
  });

  it('needs at least minCandidates same-version runs for a verdict', () => {
    const exps = [
      exp('e1', 'v2', '2026-06-10', base),
      exp('e2', 'v2', '2026-06-11', stable()),
    ];
    const r = runCanaryOverExperiments('writer', exps, 'v2'); // default minCandidates = 3
    assert.equal(r.status, 'insufficient-data');
  });

  it('reports ok when same-version runs stay stable', () => {
    const exps = [
      exp('base', 'v2', '2026-06-10', base),
      exp('c1', 'v2', '2026-06-11', stable()),
      exp('c2', 'v2', '2026-06-12', stable()),
      exp('c3', 'v2', '2026-06-13', stable()),
    ];
    const r = runCanaryOverExperiments('writer', exps, 'v2');
    assert.equal(r.status, 'ok');
    assert.equal(r.baselineId, 'base'); // earliest same-version run
    assert.equal(r.evaluated, 3);
    assert.equal(r.result?.alert, false);
  });

  it('reports drift when same-version runs diverge as a pattern', () => {
    const exps = [
      exp('base', 'v2', '2026-06-10', base),
      exp('c1', 'v2', '2026-06-11', drift()),
      exp('c2', 'v2', '2026-06-12', drift()),
      exp('c3', 'v2', '2026-06-13', stable()),
    ];
    const r = runCanaryOverExperiments('writer', exps, 'v2');
    assert.equal(r.status, 'drift');
    assert.equal(r.result?.driftedCount, 2);
    assert.match(r.message, /drift/i);
  });

  it('picks the earliest same-version run as the frozen baseline regardless of input order', () => {
    const exps = [
      exp('c3', 'v2', '2026-06-13', stable()),
      exp('base', 'v2', '2026-06-10', base),
      exp('c1', 'v2', '2026-06-11', stable()),
      exp('c2', 'v2', '2026-06-12', stable()),
    ];
    const r = runCanaryOverExperiments('writer', exps, 'v2');
    assert.equal(r.baselineId, 'base');
    assert.equal(r.evaluated, 3);
  });
});

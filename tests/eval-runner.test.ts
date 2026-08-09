/**
 * Tests for the offline eval harness (v0.14.0) — parseEvalTasks validation,
 * runEval aggregation (means, dropped samples, deltas), and report rendering.
 * Everything runs against deterministic fakes: zero LLM calls.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseEvalTasks,
  runEval,
  renderEvalReport,
  type EvalTask,
} from '../src/eval/eval-runner.js';

// ─── parseEvalTasks ─────────────────────────────────

describe('parseEvalTasks', () => {
  it('parses a bare array and fills missing ids positionally', () => {
    const tasks = parseEvalTasks(JSON.stringify([
      { id: 't1', type: 'tech', task: 'Explain X' },
      { task: 'Explain Y' },
    ]));
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0]!.id, 't1');
    assert.equal(tasks[0]!.type, 'tech');
    assert.equal(tasks[1]!.id, 'task-2');
    assert.equal(tasks[1]!.type, undefined);
  });

  it('accepts the {"tasks": [...]} wrapper form', () => {
    const tasks = parseEvalTasks(JSON.stringify({ tasks: [{ id: 'a', task: 'do a' }] }));
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.id, 'a');
  });

  it('rejects invalid JSON with a parse-level message', () => {
    assert.throws(() => parseEvalTasks('{nope'), /not valid JSON/);
  });

  it('rejects an empty set and non-array shapes', () => {
    assert.throws(() => parseEvalTasks('[]'), /non-empty/);
    assert.throws(() => parseEvalTasks('{"tasks": {}}'), /non-empty/);
    assert.throws(() => parseEvalTasks('"just a string"'), /non-empty/);
  });

  it('rejects a task without task text, naming the index', () => {
    assert.throws(
      () => parseEvalTasks(JSON.stringify([{ id: 'x', task: '' }])),
      /index 0/,
    );
  });

  it('rejects duplicate ids', () => {
    assert.throws(
      () => parseEvalTasks(JSON.stringify([
        { id: 'dup', task: 'one' },
        { id: 'dup', task: 'two' },
      ])),
      /appears more than once/,
    );
  });
});

// ─── runEval ────────────────────────────────────────

const TASKS: EvalTask[] = [
  { id: 't1', task: 'alpha' },
  { id: 't2', task: 'beta' },
];

describe('runEval', () => {
  it('aggregates per-task means and arm deltas vs the first arm', async () => {
    // Deterministic score: prompt "good" scores 8, prompt "base" scores 6.
    const report = await runEval({
      agentName: 'writer',
      arms: [
        { label: 'v1', promptText: 'base' },
        { label: 'v2', promptText: 'good' },
      ],
      tasks: TASKS,
      run: async (promptText, task) => `${promptText}:${task.id}`,
      score: async (_task, output) => (output.startsWith('good') ? 8 : 6),
    });

    assert.equal(report.arms.length, 2);
    assert.equal(report.arms[0]!.mean, 6);
    assert.equal(report.arms[1]!.mean, 8);
    assert.equal(report.arms[1]!.scoredTasks, 2);
    assert.equal(report.deltas[0]!.delta, 0);
    assert.equal(report.deltas[1]!.delta, 2);
    assert.equal(report.taskCount, 2);
    assert.equal(report.runsPerCell, 1);
  });

  it('averages multiple runs per cell', async () => {
    let call = 0;
    const report = await runEval({
      agentName: 'writer',
      arms: [{ label: 'v1', promptText: 'p' }],
      tasks: [TASKS[0]!],
      runsPerCell: 2,
      run: async () => 'out',
      score: async () => (++call === 1 ? 4 : 8),
    });
    assert.equal(report.arms[0]!.perTask[0]!.mean, 6);
    assert.equal(report.arms[0]!.perTask[0]!.samples, 2);
  });

  it('excludes null scores from the mean instead of counting them as 0', async () => {
    const report = await runEval({
      agentName: 'writer',
      arms: [{ label: 'v1', promptText: 'p' }],
      tasks: TASKS,
      run: async (_p, task) => task.id,
      // t1 abstains, t2 scores 7 → arm mean must be 7, not 3.5.
      score: async (task) => (task.id === 't1' ? null : 7),
    });
    assert.equal(report.arms[0]!.perTask[0]!.mean, null);
    assert.equal(report.arms[0]!.perTask[0]!.samples, 0);
    assert.equal(report.arms[0]!.mean, 7);
    assert.equal(report.arms[0]!.scoredTasks, 1);
  });

  it('records throwing cells as failures and keeps sweeping', async () => {
    const report = await runEval({
      agentName: 'writer',
      arms: [{ label: 'v1', promptText: 'p' }],
      tasks: TASKS,
      run: async (_p, task) => {
        if (task.id === 't1') throw new Error('provider hiccup');
        return 'ok';
      },
      score: async () => 5,
    });
    assert.equal(report.arms[0]!.perTask[0]!.failures, 1);
    assert.equal(report.arms[0]!.perTask[0]!.mean, null);
    assert.equal(report.arms[0]!.perTask[1]!.mean, 5);
    assert.equal(report.arms[0]!.mean, 5);
  });

  it('reports null deltas when the baseline has no scores', async () => {
    const report = await runEval({
      agentName: 'writer',
      arms: [
        { label: 'v1', promptText: 'base' },
        { label: 'v2', promptText: 'good' },
      ],
      tasks: [TASKS[0]!],
      run: async (p) => p,
      score: async (_t, output) => (output === 'base' ? null : 9),
    });
    assert.equal(report.arms[0]!.mean, null);
    assert.equal(report.deltas[1]!.delta, null);
    assert.equal(report.deltas[1]!.pairedTasks, 0);
  });

  it('pairs deltas on shared tasks only — asymmetric failures cannot skew the comparison', async () => {
    // Baseline scores t1=6 and t2=2 (mean 4). Challenger fails t2 entirely
    // but scores t1=7. An unpaired mean-vs-mean delta would report +3
    // (7 vs 4) by silently dropping the hard task; the PAIRED delta is +1.
    const report = await runEval({
      agentName: 'writer',
      arms: [
        { label: 'v1', promptText: 'base' },
        { label: 'v2', promptText: 'good' },
      ],
      tasks: TASKS,
      run: async (p, task) => {
        if (p === 'good' && task.id === 't2') throw new Error('challenger dies on t2');
        return `${p}:${task.id}`;
      },
      score: async (task, output) =>
        output.startsWith('good') ? 7 : task.id === 't1' ? 6 : 2,
    });
    assert.equal(report.deltas[1]!.delta, 1, 'paired delta over t1 only');
    assert.equal(report.deltas[1]!.pairedTasks, 1);
    assert.equal(report.deltas[0]!.delta, 0);
  });

  it('clamps a non-finite runsPerCell instead of looping forever', async () => {
    let calls = 0;
    const report = await runEval({
      agentName: 'writer',
      arms: [{ label: 'v1', promptText: 'p' }],
      tasks: [TASKS[0]!],
      runsPerCell: Infinity,
      run: async () => {
        calls++;
        return 'x';
      },
      score: async () => 5,
    });
    assert.equal(report.runsPerCell, 1);
    assert.equal(calls, 1);
  });

  it('caps a huge-but-finite runsPerCell at the API ceiling (R4: 1e100 must not run away)', async () => {
    const report = await runEval({
      agentName: 'writer',
      arms: [{ label: 'v1', promptText: 'p' }],
      tasks: [TASKS[0]!],
      runsPerCell: 1e100,
      run: async () => 'x',
      score: async () => null, // abstain — the loop must still terminate
    });
    assert.equal(report.runsPerCell, 10_000, 'finite ceiling, not 1e100');
    assert.equal(report.arms[0]!.perTask[0]!.samples, 0);
  });

  it('rejects duplicate task ids at the API boundary (paired deltas would collapse)', async () => {
    await assert.rejects(
      runEval({
        agentName: 'writer',
        arms: [{ label: 'v1', promptText: 'p' }],
        tasks: [
          { id: 'dup', task: 'one' },
          { id: 'dup', task: 'two' },
        ],
        run: async () => 'x',
        score: async () => 5,
      }),
      /unique/,
    );
  });

  it('rejects empty arms, empty tasks, and duplicate labels', async () => {
    const base = {
      agentName: 'writer',
      run: async () => 'x',
      score: async () => 1,
    };
    await assert.rejects(
      runEval({ ...base, arms: [], tasks: TASKS }),
      /at least one arm/,
    );
    await assert.rejects(
      runEval({ ...base, arms: [{ label: 'v1', promptText: 'p' }], tasks: [] }),
      /at least one task/,
    );
    await assert.rejects(
      runEval({
        ...base,
        arms: [
          { label: 'same', promptText: 'a' },
          { label: 'same', promptText: 'b' },
        ],
        tasks: TASKS,
      }),
      /share a label/,
    );
  });

  it('invokes onCell once per arm × task', async () => {
    const seen: string[] = [];
    await runEval({
      agentName: 'writer',
      arms: [
        { label: 'v1', promptText: 'a' },
        { label: 'v2', promptText: 'b' },
      ],
      tasks: TASKS,
      run: async () => 'x',
      score: async () => 5,
      onCell: (arm, task) => seen.push(`${arm.label}/${task.id}`),
    });
    assert.deepEqual(seen, ['v1/t1', 'v1/t2', 'v2/t1', 'v2/t2']);
  });
});

// ─── renderEvalReport ───────────────────────────────

describe('renderEvalReport', () => {
  it('renders per-task rows, arm means, deltas, active marker, and the dropped-sample note', async () => {
    const report = await runEval({
      agentName: 'writer',
      arms: [
        { label: 'v1', promptText: 'base' },
        { label: 'v3', promptText: 'good', active: true },
      ],
      tasks: TASKS,
      run: async (p, task) => {
        if (p === 'base' && task.id === 't2') throw new Error('boom');
        return p;
      },
      score: async (_t, output) => (output === 'good' ? 8.5 : 6),
    });

    const text = renderEvalReport(report);
    assert.match(text, /Offline eval — writer/);
    assert.match(text, /t1/);
    assert.match(text, /v3\*/, 'active arm carries the display star');
    assert.match(text, /MEAN/);
    assert.match(text, /\+2\.50/, 'paired delta over the shared task t1');
    assert.match(text, /PAIRED/, 'partial pairing is called out');
    assert.match(text, /dropped samples/);
    assert.match(text, /requireConfidence/);
    // The canonical JSON label stays clean — the star is display-only.
    assert.equal(report.arms[1]!.label, 'v3');
    assert.equal(report.arms[1]!.active, true);
  });
});

/**
 * Darwin — Offline Eval (v0.14.0)
 *
 * The benchmark harness as a first-class, injectable API: run N prompt
 * variants ("arms") over a frozen task set, score every output, and report
 * per-task means + arm deltas against the first arm (the baseline).
 *
 * This is Darwin's answer to the dataset+metric eval loop that offline
 * optimizers (DSPy's `Evaluate`, gepa-ts/dsts trainsets) are built around —
 * adapted to Darwin's shape: the same arms/tasks/judge wiring the shipped
 * `benchmark/` harness uses, generalised to any agent, any prompt set, and
 * any metric. It complements (not replaces) the online loop: seed and vet
 * prompts offline, then let the live A/B gate decide under real traffic.
 *
 * Zero hard deps, nothing here talks to an LLM directly — the caller injects
 * `run` (execute a prompt on a task) and `score` (judge one output). The CLI
 * (`darwin eval`) wires those to `runAgent` + the built-in critic; tests wire
 * them to deterministic fakes.
 */

// ─── Task sets ──────────────────────────────────────

export interface EvalTask {
  /** Stable identifier — shown in reports, used to align arms. */
  id: string;
  /** Optional task-type tag (mirrors `darwin run --task-type`). */
  type?: string;
  /** The task text handed to the agent. */
  task: string;
}

/**
 * Parse an eval task set from JSON text. Accepts either a bare array of
 * tasks or `{ "tasks": [...] }`, and validates the fields that the eval
 * loop depends on — a malformed set fails loudly HERE, not as a `undefined`
 * task string inside an LLM call N minutes into a sweep.
 */
export function parseEvalTasks(jsonText: string): EvalTask[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`Eval task set is not valid JSON: ${(err as Error).message}`);
  }

  const rawTasks: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as { tasks?: unknown })?.tasks;

  if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
    throw new Error(
      'Eval task set must be a non-empty JSON array of {id, task} objects (or {"tasks": [...]}).',
    );
  }

  const seen = new Set<string>();
  return rawTasks.map((raw, i) => {
    const t = raw as Partial<EvalTask>;
    if (typeof t.task !== 'string' || t.task.trim() === '') {
      throw new Error(`Eval task at index ${i} has no "task" text.`);
    }
    const id = typeof t.id === 'string' && t.id.trim() !== '' ? t.id : `task-${i + 1}`;
    if (seen.has(id)) {
      throw new Error(`Eval task id "${id}" appears more than once — ids must be unique.`);
    }
    seen.add(id);
    return {
      id,
      task: t.task,
      ...(typeof t.type === 'string' ? { type: t.type } : {}),
    };
  });
}

// ─── Arms, scoring, results ─────────────────────────

/** One prompt variant under evaluation. */
export interface EvalArm {
  /** Canonical label — e.g. a stored version ("v3") or "candidate". Must be unique. */
  label: string;
  /** The full system-prompt text this arm runs with. */
  promptText: string;
  /**
   * Marks the agent's currently-active version. Display-only: the renderer
   * appends `*` to the label; the label itself stays canonical so it never
   * collides with `--versions` matching, stored labels, or JSON consumers.
   */
  active?: boolean;
}

/** Execute one (promptText, task) cell and return the raw agent output. */
export type EvalRunFn = (promptText: string, task: EvalTask) => Promise<string>;

/**
 * Score one output for one task. Return `null` for "no score" (the sample is
 * excluded from the mean instead of polluting it). The CLI wires this to the
 * built-in critic (1–10); programmatic callers can plug any metric —
 * exact-match, rubric judge, regex, latency — anything reducible to a number.
 */
export type EvalScoreFn = (task: EvalTask, output: string) => Promise<number | null>;

export interface EvalCellResult {
  taskId: string;
  /** Mean of the scored samples, or null when every sample failed/abstained. */
  mean: number | null;
  /** How many samples produced a score. */
  samples: number;
  /** How many run/score attempts threw (dropped, not counted as samples). */
  failures: number;
}

export interface EvalArmResult {
  label: string;
  /** Mirrors {@link EvalArm.active} — display metadata, not part of the label. */
  active: boolean;
  perTask: EvalCellResult[];
  /** Mean over the per-task means that scored (macro average). */
  mean: number | null;
  /** Number of tasks with at least one scored sample. */
  scoredTasks: number;
}

export interface EvalReport {
  agentName: string;
  taskCount: number;
  runsPerCell: number;
  arms: EvalArmResult[];
  /**
   * PAIRED arm deltas against the FIRST arm (the baseline): each delta is the
   * mean of per-task differences over the tasks where BOTH arms scored, so
   * asymmetric failures cannot skew the comparison (an arm that only scored
   * the easy tasks would otherwise look better than it is). `pairedTasks`
   * says how many tasks the delta is based on; `null` when no task scored in
   * both arms. The baseline's own entry aligns the array with `arms` (delta 0
   * when it scored at all, `null` otherwise).
   */
  deltas: { label: string; delta: number | null; pairedTasks: number }[];
  startedAt: string;
  completedAt: string;
}

export interface RunEvalOptions {
  agentName: string;
  arms: EvalArm[];
  tasks: EvalTask[];
  run: EvalRunFn;
  score: EvalScoreFn;
  /** Samples per (arm × task) cell — >1 averages out judge variance. Default 1. */
  runsPerCell?: number;
  /** Progress callback — the CLI prints dots/scores, tests ignore it. */
  onCell?: (arm: EvalArm, task: EvalTask, cell: EvalCellResult) => void;
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
}

/**
 * Run the full arms × tasks × runsPerCell grid sequentially and aggregate.
 *
 * Sequential on purpose: eval sweeps run against rate-limited providers and
 * subscription CLIs; a transient failure drops ONE sample (recorded in
 * `failures`) instead of aborting the sweep — the shipped benchmark's
 * behaviour, kept here.
 */
export async function runEval(opts: RunEvalOptions): Promise<EvalReport> {
  const { agentName, arms, tasks, run, score } = opts;
  // Runs-per-cell guard (R3+R4 review, P0). Every cell sample is LLM money
  // and cell errors are swallowed by design, so a runaway value must be
  // impossible at the API boundary, not just in the CLI:
  //   - non-finite (Infinity / NaN)            → 1
  //   - huge-but-finite (1e100)                → capped
  //   - fractional                             → floored
  // The cap is deliberately generous (10k samples per cell is already an
  // absurd judge-variance budget); the CLI applies its own tighter 1000.
  const MAX_RUNS_PER_CELL_API = 10_000;
  const requestedRuns = opts.runsPerCell ?? 1;
  const runsPerCell = Number.isFinite(requestedRuns)
    ? Math.min(Math.max(1, Math.floor(requestedRuns)), MAX_RUNS_PER_CELL_API)
    : 1;

  if (arms.length === 0) throw new Error('runEval needs at least one arm (a prompt to evaluate).');
  if (tasks.length === 0) throw new Error('runEval needs at least one task.');
  const armLabels = new Set(arms.map((a) => a.label));
  if (armLabels.size !== arms.length) {
    throw new Error('Eval arm labels must be unique — two arms share a label.');
  }
  // The JSON parser enforces this for the CLI; the exported API must too
  // (R5 review): duplicate ids collapse in the paired-delta map and silently
  // skew the comparison.
  const taskIds = new Set(tasks.map((t) => t.id));
  if (taskIds.size !== tasks.length) {
    throw new Error('Eval task ids must be unique — two tasks share an id.');
  }

  const startedAt = new Date().toISOString();
  const armResults: EvalArmResult[] = [];

  for (const arm of arms) {
    const perTask: EvalCellResult[] = [];

    for (const task of tasks) {
      const scores: number[] = [];
      let failures = 0;

      for (let i = 0; i < runsPerCell; i++) {
        try {
          const output = await run(arm.promptText, task);
          const s = await score(task, output);
          if (s !== null && Number.isFinite(s)) scores.push(s);
        } catch {
          failures++;
        }
      }

      const cell: EvalCellResult = {
        taskId: task.id,
        mean: mean(scores),
        samples: scores.length,
        failures,
      };
      perTask.push(cell);
      opts.onCell?.(arm, task, cell);
    }

    const taskMeans = perTask
      .map((c) => c.mean)
      .filter((m): m is number => m !== null);

    armResults.push({
      label: arm.label,
      active: arm.active ?? false,
      perTask,
      mean: mean(taskMeans),
      scoredTasks: taskMeans.length,
    });
  }

  // Paired deltas (R3 review, P1): compare arms only on the tasks BOTH
  // scored, as the mean of per-task differences — asymmetric failures must
  // not let an arm win by dropping its hard tasks.
  const baseline = armResults[0]!;
  const baselineByTask = new Map(
    baseline.perTask.filter((c) => c.mean !== null).map((c) => [c.taskId, c.mean!]),
  );
  const deltas = armResults.map((a) => {
    if (a === baseline) {
      return {
        label: a.label,
        delta: baseline.mean === null ? null : 0,
        pairedTasks: baselineByTask.size,
      };
    }
    const diffs = a.perTask
      .filter((c) => c.mean !== null && baselineByTask.has(c.taskId))
      .map((c) => c.mean! - baselineByTask.get(c.taskId)!);
    return {
      label: a.label,
      delta: mean(diffs),
      pairedTasks: diffs.length,
    };
  });

  return {
    agentName,
    taskCount: tasks.length,
    runsPerCell,
    arms: armResults,
    deltas,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

// ─── Report rendering ───────────────────────────────

function fmt(x: number | null | undefined): string {
  return x === null || x === undefined ? '—' : x.toFixed(2);
}

/**
 * Render an {@link EvalReport} as the fixed-width table the CLI prints and
 * writes to `.darwin/reports/`. Pure string building — no I/O.
 */
export function renderEvalReport(report: EvalReport): string {
  // `*` marks the active arm in the DISPLAY only — canonical labels stay
  // clean for matching and JSON consumers.
  const labels = report.arms.map((a) => a.label + (a.active ? '*' : ''));
  const colWidth = Math.max(8, ...labels.map((l) => l.length + 1));

  const lines: string[] = [];
  lines.push(
    `Offline eval — ${report.agentName}  ` +
      `(${report.taskCount} tasks × ${report.runsPerCell} run${report.runsPerCell > 1 ? 's' : ''}/cell)`,
  );
  lines.push('─'.repeat(24 + colWidth * labels.length));
  lines.push('Task'.padEnd(24) + labels.map((l) => l.padStart(colWidth)).join(''));

  const taskIds = report.arms[0]?.perTask.map((c) => c.taskId) ?? [];
  for (const taskId of taskIds) {
    const cells = report.arms.map((a) => {
      const cell = a.perTask.find((c) => c.taskId === taskId);
      const failed = (cell?.failures ?? 0) > 0 ? '!' : '';
      return (fmt(cell?.mean) + failed).padStart(colWidth);
    });
    lines.push(taskId.slice(0, 23).padEnd(24) + cells.join(''));
  }

  lines.push('─'.repeat(24 + colWidth * labels.length));
  lines.push(
    'MEAN'.padEnd(24) + report.arms.map((a) => fmt(a.mean).padStart(colWidth)).join(''),
  );

  const baseline = report.deltas[0]?.label;
  const deltaCells = report.deltas.map((d, i) =>
    (i === 0 ? 'base' : d.delta === null ? '—' : `${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(2)}`).padStart(colWidth),
  );
  lines.push(`Δ vs ${String(baseline).slice(0, 18)}`.padEnd(24) + deltaCells.join(''));

  // Call the pairing out whenever ANY non-baseline arm paired fewer tasks
  // than the set — including pairedTasks = 0, where the unexplained '—'
  // needs the explanation most (R4 review).
  const partialPairing = report.deltas.some(
    (d, i) => i > 0 && d.pairedTasks < report.taskCount,
  );
  if (partialPairing) {
    lines.push('');
    lines.push(
      'Δ is PAIRED (mean per-task difference over tasks both arms scored): ' +
        report.deltas
          .slice(1)
          .map((d) => `${d.label} n=${d.pairedTasks}`)
          .join(', ') +
        ` of ${report.taskCount} tasks.`,
    );
  }

  const anyFailures = report.arms.some((a) => a.perTask.some((c) => c.failures > 0));
  if (anyFailures) {
    lines.push('');
    lines.push('! = cell had dropped samples (run or judge failed); mean covers the rest.');
  }
  lines.push('');
  lines.push(
    'Offline means are directional, not significance tests — promote through the live A/B gate' +
      " (safety: { requireConfidence: true, confidenceMethod: 'msprt' }) for a decision under real traffic.",
  );

  return lines.join('\n');
}

/**
 * Darwin — Metrics Sink (v0.14.0)
 *
 * Every evolution decision as a typed event. The loop emits; you decide where
 * it goes — a JSONL file (built in, zero deps), Prometheus, OpenTelemetry
 * (see `examples/otel-bridge.ts`), or your own dashboard.
 *
 * Design rules, same as the rest of Darwin:
 *   - Zero hard deps. The sink is INJECTED (`DarwinLoopDeps.metrics`) or
 *     wired from the environment (`DARWIN_METRICS_JSONL=path`).
 *   - Fire-and-forget. A throwing/rejecting sink must never break the
 *     evolution loop — {@link emitMetric} swallows sink errors by contract.
 *   - Events are facts, not aggregates. Counters/histograms are the
 *     consumer's job; Darwin reports what happened, with enough payload to
 *     build any aggregate downstream.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ─── Event model ────────────────────────────────────

export type DarwinMetricEventType =
  | 'run_recorded'
  | 'rollback'
  | 'ab_test_started'
  | 'ab_test_completed'
  | 'ab_test_timeout'
  | 'evolution_skipped'
  /** v0.17.0: a challenger was generated and is waiting for a human decision. */
  | 'approval_requested'
  /** v0.17.0: a human approved a pending challenger; an A/B test follows. */
  | 'approval_granted'
  /** v0.17.0: a pending challenger was discarded, by a human or by timeout
   *  (`data.expired` says which). Never emitted for an auto-approval: there
   *  is no such thing. */
  | 'approval_rejected'
  /** v0.18.0: a generator produced text that was already rejected. `data.action`
   *  is `fell_through` (another generator got the cycle) or `refused` (none
   *  did, and nothing was proposed). */
  | 'rejected_repeat'
  /** v0.18.0: remembered rejections were cleared by hand
   *  (`darwin approve <agent> --forget`). */
  | 'rejection_forgotten';

export interface DarwinMetricEvent {
  /** What happened. */
  type: DarwinMetricEventType;
  /** Which agent it happened to. */
  agent: string;
  /** ISO timestamp, stamped at emit time. */
  at: string;
  /**
   * Event payload — intentionally loose. Stable keys per type (see the emit
   * sites in `evolution/loop.ts`): scores, versions, winner, failures, reason.
   */
  data: Record<string, unknown>;
}

export interface MetricsSink {
  /** Receive one event. May be sync or async; errors are swallowed by {@link emitMetric}. */
  emit(event: DarwinMetricEvent): void | Promise<void>;
}

// ─── Emit helper (loop-side) ────────────────────────

/**
 * Emit `event` on `sink` without ever throwing — sync throws are caught,
 * async rejections attached. The evolution loop calls THIS, never
 * `sink.emit` directly, so a broken sink can not fail a run or an A/B
 * decision. No sink → no-op.
 */
export function emitMetric(
  sink: MetricsSink | undefined,
  type: DarwinMetricEventType,
  agent: string,
  data: Record<string, unknown> = {},
): void {
  if (!sink) return;
  try {
    const result = sink.emit({ type, agent, at: new Date().toISOString(), data });
    if (result && typeof (result as Promise<void>).catch === 'function') {
      (result as Promise<void>).catch(() => {
        /* metrics must never break the loop */
      });
    }
  } catch {
    /* metrics must never break the loop */
  }
}

// ─── Built-in JSONL sink ────────────────────────────

/**
 * Append-only JSONL file sink — one event per line. The zero-dep default:
 * `tail -f` it, ship it with any log collector, or load it into a notebook.
 *
 * Writes are synchronous appends (events are small and rare — a handful per
 * agent run); the parent directory is created on first construction.
 */
export class JsonlMetricsSink implements MetricsSink {
  private readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
  }

  emit(event: DarwinMetricEvent): void {
    appendFileSync(this.path, JSON.stringify(event) + '\n', 'utf-8');
  }
}

// ─── Environment wiring ─────────────────────────────

/**
 * Build the sink the environment asks for, or `undefined` for none.
 * `DARWIN_METRICS_JSONL=<path>` → {@link JsonlMetricsSink} at that path.
 * Invalid paths fail loudly HERE (at wiring time), not silently per event.
 */
export function metricsSinkFromEnv(env: NodeJS.ProcessEnv = process.env): MetricsSink | undefined {
  const jsonlPath = env.DARWIN_METRICS_JSONL;
  if (jsonlPath && jsonlPath.trim() !== '') {
    return new JsonlMetricsSink(jsonlPath.trim());
  }
  return undefined;
}

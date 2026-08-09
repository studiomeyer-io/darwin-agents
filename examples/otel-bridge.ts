/**
 * Example — OpenTelemetry bridge for Darwin's metrics sink (v0.14.0).
 *
 * Darwin's core stays zero-dep: the loop emits typed {@link DarwinMetricEvent}s
 * on an injected {@link MetricsSink}, and THIS file — an example, not part of
 * the library — turns them into OpenTelemetry span events + counters. Copy it
 * into your project and adapt; `@opentelemetry/api` is YOUR dependency:
 *
 *   npm install @opentelemetry/api
 *   # plus your SDK/exporter of choice (@opentelemetry/sdk-node, OTLP, …)
 *
 * Usage with a hand-wired loop:
 *
 *   import { DarwinLoop } from 'darwin-agents';
 *   import { otelMetricsSink } from './otel-bridge.js';
 *
 *   const loop = new DarwinLoop({ memory, tracker, optimizer, safety, patterns,
 *     agent, metrics: otelMetricsSink() });
 *
 * Every A/B decision then shows up in your traces/metrics backend next to the
 * rest of your services — the same place @kamiyo-style Prometheus/Grafana
 * setups look, but via the vendor-neutral OTel API.
 */

// Example-only import — the package does NOT depend on @opentelemetry/api.
// (Like examples/mcp-memory-bridge.ts, this file compiles in YOUR project,
// where the dependency exists.)
// @ts-expect-error — resolved in the consumer project, not in darwin-agents.
import { metrics as otelMetrics, trace, type Attributes } from '@opentelemetry/api';

import type { DarwinMetricEvent, MetricsSink } from 'darwin-agents';

/** Flatten a Darwin event payload into OTel-safe primitive attributes. */
function toAttributes(event: DarwinMetricEvent): Attributes {
  const attrs: Attributes = { 'darwin.agent': event.agent, 'darwin.event': event.type };
  for (const [key, value] of Object.entries(event.data)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      attrs[`darwin.${key}`] = value;
    }
  }
  return attrs;
}

/**
 * Build a {@link MetricsSink} that records every Darwin event as
 *   - a span event on the CURRENT active span (when one exists), and
 *   - a monotonic counter `darwin.events` keyed by event type + agent.
 *
 * Errors are irrelevant by design: Darwin's `emitMetric` swallows anything
 * this sink throws, so instrument freely.
 */
export function otelMetricsSink(): MetricsSink {
  const meter = otelMetrics.getMeter('darwin-agents');
  const counter = meter.createCounter('darwin.events', {
    description: 'Darwin evolution-loop events (runs, A/B decisions, rollbacks)',
  });

  return {
    emit(event: DarwinMetricEvent): void {
      const attrs = toAttributes(event);
      counter.add(1, attrs);
      trace.getActiveSpan()?.addEvent(`darwin.${event.type}`, attrs);
    },
  };
}

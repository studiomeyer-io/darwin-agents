/**
 * Tests for TraceCapture — pure, transport-agnostic execution-trace capturer.
 *
 * Coverage:
 *   - basic tool_use → tool_result roundtrip (success + error)
 *   - tool_call_id passthrough (`id` field, OTEL gen_ai.tool.call.id)
 *   - duration computation via injected `now`
 *   - turn counting
 *   - text-block counter (renamed from reasoningSteps in R1)
 *   - addTokens aggregation + lossy-merge of missing fields
 *   - turn-level errors
 *   - unpaired tool_use → finalized as error with errorClass='unpaired_call'
 *   - tool_result without matching tool_use → silently dropped
 *   - mcpInvocations aggregate (default heuristic + custom predicate)
 *   - resultSummary truncation at 2000 chars (R1 bumped from 500)
 *   - errorMessage truncation at 200 chars
 *   - schema invariants (version=1, capturedAt ISO, turnCount >= 1)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTraceCapture } from '../src/core/trace-capture.js';
import type { ExecutionTrace } from '../src/types.js';

// ─── helpers ─────────────────────────────────────────

/**
 * Deterministic clock — increments by `step` ms on every call. Lets us
 * assert exact durations without sleeping.
 */
function makeClock(start = 1_000_000, step = 100): () => number {
  let t = start - step;
  return () => {
    t += step;
    return t;
  };
}

// ─── basic flow ──────────────────────────────────────

describe('createTraceCapture — basic flow', () => {
  it('records a single successful tool call with computed duration', () => {
    const cap = createTraceCapture({ now: makeClock(1_000_000, 50) });
    cap.startTurn();
    cap.recordToolUse('id1', 'mcp__nex__search', { query: 'foo' });
    cap.recordToolResult('id1', 'success', { resultSummary: '3 hits' });
    const trace = cap.finalize();

    assert.equal(trace.version, 1);
    assert.equal(trace.toolCalls.length, 1);
    const call = trace.toolCalls[0];
    assert.equal(call.tool, 'mcp__nex__search');
    assert.equal(call.outcome, 'success');
    assert.equal(call.resultSummary, '3 hits');
    assert.deepEqual(call.args, { query: 'foo' });
    assert.equal(call.turn, 1);
    // duration: start@1_000_050, result@1_000_100 (capturedAt consumes the first tick) → 50ms
    assert.ok(call.durationMs > 0, `duration ${call.durationMs} should be > 0`);
    assert.equal(trace.textBlockCount, 0);
    assert.equal(trace.turnCount, 1);
    assert.equal(trace.mcpInvocations, 1);
    assert.equal(trace.errors.length, 0);
  });

  it('captures errors with errorClass + errorMessage', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordToolUse('id1', 'mcp__nex__search');
    cap.recordToolResult('id1', 'error', {
      errorClass: 'timeout',
      errorMessage: 'tool exceeded 10s',
    });
    const trace = cap.finalize();
    const call = trace.toolCalls[0];
    assert.equal(call.outcome, 'error');
    assert.equal(call.errorClass, 'timeout');
    assert.equal(call.errorMessage, 'tool exceeded 10s');
  });

  it('counts text blocks + turns + multi-call sequences', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordTextBlock();
    cap.recordToolUse('a', 'Read');
    cap.recordToolResult('a', 'success');
    cap.startTurn();
    cap.recordTextBlock();
    cap.recordTextBlock();
    cap.recordToolUse('b', 'mcp__nex__learn');
    cap.recordToolResult('b', 'success');
    const trace = cap.finalize();
    assert.equal(trace.turnCount, 2);
    assert.equal(trace.textBlockCount, 3);
    assert.equal(trace.toolCalls.length, 2);
    assert.equal(trace.mcpInvocations, 1, 'only mcp__ counts as MCP');
  });
});

// ─── error handling ──────────────────────────────────

describe('createTraceCapture — defensive behaviour', () => {
  it('finalizes unpaired tool_use as error with errorClass="unpaired_call"', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordToolUse('orphan', 'mcp__nex__search', { query: 'x' });
    // no recordToolResult → finalize should surface it as error
    const trace = cap.finalize();
    assert.equal(trace.toolCalls.length, 1);
    const call = trace.toolCalls[0];
    assert.equal(call.outcome, 'error');
    assert.equal(call.errorClass, 'unpaired_call');
    assert.match(call.errorMessage ?? '', /unpaired|tool_use/i);
    // args are preserved even when the call hangs
    assert.deepEqual(call.args, { query: 'x' });
  });

  it('silently drops tool_result without matching tool_use', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordToolResult('phantom', 'success', { resultSummary: 'whatever' });
    const trace = cap.finalize();
    assert.equal(trace.toolCalls.length, 0);
  });

  it('records turn-level errors with current turn index', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn(); // turn 1
    cap.recordError('parse_error', 'invalid JSON');
    cap.startTurn(); // turn 2
    cap.recordError('spawn_failed', 'ENOENT');
    const trace = cap.finalize();
    assert.equal(trace.errors.length, 2);
    assert.equal(trace.errors[0].turn, 1);
    assert.equal(trace.errors[1].turn, 2);
    assert.equal(trace.errors[0].class, 'parse_error');
    assert.equal(trace.errors[1].class, 'spawn_failed');
  });

  it('treats events before startTurn as belonging to turn 1', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.recordToolUse('a', 'Read');
    cap.recordToolResult('a', 'success');
    const trace = cap.finalize();
    assert.equal(trace.toolCalls[0].turn, 1);
    // turnCount is clamped to >=1 even if startTurn was never called
    assert.ok(trace.turnCount >= 1);
  });
});

// ─── truncation + privacy ────────────────────────────

describe('createTraceCapture — truncation', () => {
  it('truncates resultSummary to 2000 chars (R1 bumped from 500 for GEPA)', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordToolUse('id1', 'Read');
    const bigResult = 'x'.repeat(5000);
    cap.recordToolResult('id1', 'success', { resultSummary: bigResult });
    const trace = cap.finalize();
    assert.equal(trace.toolCalls[0].resultSummary?.length, 2000);
  });

  it('does NOT truncate when summary fits under the cap', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordToolUse('id1', 'Read');
    const summary = 'a'.repeat(1500); // under 2000
    cap.recordToolResult('id1', 'success', { resultSummary: summary });
    const trace = cap.finalize();
    assert.equal(trace.toolCalls[0].resultSummary?.length, 1500);
  });

  it('truncates errorMessage to 200 chars', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordToolUse('id1', 'mcp__nex__search');
    cap.recordToolResult('id1', 'error', {
      errorClass: 'protocol',
      errorMessage: 'y'.repeat(1000),
    });
    const trace = cap.finalize();
    assert.equal(trace.toolCalls[0].errorMessage?.length, 200);
  });

  it('truncates turn-level error message to 200 chars', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordError('parse_error', 'z'.repeat(500));
    const trace = cap.finalize();
    assert.equal(trace.errors[0].message.length, 200);
  });
});

// ─── MCP classification ──────────────────────────────

describe('createTraceCapture — mcpInvocations heuristic', () => {
  it('counts only mcp__-prefixed tool names by default', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordToolUse('a', 'mcp__nex__search');
    cap.recordToolResult('a', 'success');
    cap.recordToolUse('b', 'Read');
    cap.recordToolResult('b', 'success');
    cap.recordToolUse('c', 'mcp__crm__contact');
    cap.recordToolResult('c', 'success');
    cap.recordToolUse('d', 'Bash');
    cap.recordToolResult('d', 'success');
    const trace = cap.finalize();
    assert.equal(trace.mcpInvocations, 2);
  });

  it('allows custom isMcpTool predicate', () => {
    const cap = createTraceCapture({
      now: makeClock(),
      // Treat anything containing 'remote' as MCP.
      isMcpTool: (name) => name.includes('remote'),
    });
    cap.startTurn();
    cap.recordToolUse('a', 'mcp__foo');
    cap.recordToolResult('a', 'success');
    cap.recordToolUse('b', 'remote_call');
    cap.recordToolResult('b', 'success');
    const trace = cap.finalize();
    assert.equal(trace.mcpInvocations, 1, 'predicate overrides default mcp__ rule');
  });
});

// ─── schema invariants (downstream consumers depend on these) ──

describe('createTraceCapture — schema invariants', () => {
  it('always returns version=1 and a valid ISO capturedAt', () => {
    const cap = createTraceCapture({ now: () => 1_700_000_000_000 });
    const trace = cap.finalize();
    assert.equal(trace.version, 1);
    assert.ok(Date.parse(trace.capturedAt) > 0, 'capturedAt must parse as ISO date');
  });

  it('clamps turnCount to >= 1 even when no turns were recorded', () => {
    const cap = createTraceCapture({ now: makeClock() });
    const trace = cap.finalize();
    assert.equal(trace.turnCount, 1);
  });

  it('JSON-serializes losslessly (required for JSONB / TEXT storage)', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordToolUse('id1', 'mcp__nex__search', { q: 'foo', nested: { a: [1, 2] } });
    cap.recordToolResult('id1', 'success', { resultSummary: 'ok' });
    cap.addTokens({ inputTokens: 100, outputTokens: 50 });
    const trace = cap.finalize();
    const json = JSON.stringify(trace);
    const roundtrip = JSON.parse(json) as ExecutionTrace;
    assert.deepEqual(roundtrip, trace, 'JSON roundtrip must preserve all fields');
  });
});

// ─── tool_call_id passthrough (R1 — OTEL gen_ai.tool.call.id) ──

describe('createTraceCapture — tool_call_id passthrough', () => {
  it('persists the SDK correlation id on captured tool calls', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordToolUse('toolu_01AB', 'mcp__nex__search', { q: 'x' });
    cap.recordToolResult('toolu_01AB', 'success');
    const trace = cap.finalize();
    assert.equal(trace.toolCalls[0].id, 'toolu_01AB', 'tool_call_id must round-trip');
  });

  it('preserves the id on unpaired (hanging) calls too', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordToolUse('toolu_hang', 'Bash');
    const trace = cap.finalize();
    assert.equal(trace.toolCalls[0].id, 'toolu_hang');
    assert.equal(trace.toolCalls[0].outcome, 'error');
    assert.equal(trace.toolCalls[0].errorClass, 'unpaired_call');
  });

  it('distinguishes parallel tool calls within the same turn via id', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.recordToolUse('toolu_a', 'Read', { file: 'a.md' });
    cap.recordToolUse('toolu_b', 'Read', { file: 'b.md' });
    cap.recordToolResult('toolu_a', 'success');
    cap.recordToolResult('toolu_b', 'error', { errorClass: 'enoent' });
    const trace = cap.finalize();
    const a = trace.toolCalls.find((c) => c.id === 'toolu_a');
    const b = trace.toolCalls.find((c) => c.id === 'toolu_b');
    assert.ok(a, 'call a must be present');
    assert.ok(b, 'call b must be present');
    assert.equal(a.outcome, 'success');
    assert.equal(b.outcome, 'error');
  });
});

// ─── token-usage aggregation (R1 Research Gap 1) ──

describe('createTraceCapture — addTokens aggregate', () => {
  it('omits tokenUsage entirely when never called', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    const trace = cap.finalize();
    assert.equal(trace.tokenUsage, undefined, 'no tokenUsage when no addTokens calls');
  });

  it('sums input/output/cache_read/cache_creation across multiple turns', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.addTokens({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500 });
    cap.startTurn();
    cap.addTokens({ inputTokens: 800, outputTokens: 150, cacheCreationTokens: 50 });
    const trace = cap.finalize();
    assert.deepEqual(trace.tokenUsage, {
      inputTokens: 1800,
      outputTokens: 350,
      cacheReadTokens: 500,
      cacheCreationTokens: 50,
    });
  });

  it('treats missing fields as "unreported", not zero (skips merge)', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.addTokens({ inputTokens: 100 }); // only input
    cap.startTurn();
    cap.addTokens({ outputTokens: 50 }); // only output
    const trace = cap.finalize();
    assert.equal(trace.tokenUsage?.inputTokens, 100);
    assert.equal(trace.tokenUsage?.outputTokens, 50);
    assert.equal(trace.tokenUsage?.cacheReadTokens, undefined);
  });

  it('ignores non-finite or non-number values defensively', () => {
    const cap = createTraceCapture({ now: makeClock() });
    cap.startTurn();
    cap.addTokens({ inputTokens: NaN, outputTokens: Infinity });
    cap.addTokens({ inputTokens: 200, outputTokens: 50 });
    const trace = cap.finalize();
    assert.equal(trace.tokenUsage?.inputTokens, 200, 'NaN was skipped, only valid 200 counted');
    assert.equal(trace.tokenUsage?.outputTokens, 50);
  });
});

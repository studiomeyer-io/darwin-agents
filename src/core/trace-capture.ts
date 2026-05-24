/**
 * Darwin — Execution Trace Capture (v0.5 / A1)
 *
 * Pure, transport-agnostic capturer. Knows nothing about Anthropic SDK,
 * Claude CLI, OpenAI, or any specific runtime — the runtime feeds events,
 * the capturer aggregates into an ExecutionTrace.
 *
 * Three event types map to the three industry-standard span types
 * (Braintrust + Langfuse + Strands SDK + OTEL GenAI 2026):
 *   - recordToolUse / recordToolResult  → Tool spans
 *   - recordTextBlock                    → assistant prose counter (NOT thinking-block)
 *   - recordError                        → Turn-level errors
 *   - addTokens                          → aggregated LLM token usage
 *
 * Pairing rule: each `recordToolUse(id, ...)` MUST be paired with a later
 * `recordToolResult(id, ...)` to compute durationMs. Unpaired uses get
 * `durationMs > 0` (start-to-finalize) and `outcome = 'error'` at
 * finalize-time with errorClass = 'unpaired_call' so we never silently
 * drop hanging tools.
 *
 * Privacy + size: args are passed through as-is — caller's responsibility
 * to truncate sensitive values. resultSummary is truncated to 2000 chars
 * at recordToolResult-time. OTEL note: `gen_ai.tool.call.arguments` is
 * Opt-In in the GenAI spec; Darwin's "always-capture args" stance is
 * acceptable for internal use but MUST be documented when traces touch
 * customer data (V2 will add a Redaction-Layer).
 *
 * Backwards-compat: capturer is opt-in. Existing code paths that don't
 * instantiate it produce DarwinExperiment.trajectory === undefined and
 * the rest of the system behaves identically to pre-A1.
 */

import type {
  ExecutionTrace,
  TraceToolCall,
  TraceTokenUsage,
  TraceTurnError,
} from '../types.js';

/**
 * Result-summary cap. Tuned for GEPA-style reflective optimizers
 * (Phase 2 A2): the reflector reads the summary as context for
 * "why did this tool produce a bad outcome", so a too-tight cap
 * truncates the diagnostic signal. 2000 chars holds a typical
 * JSON-RPC tool response without bloating JSONB.
 * Bumped from 500 → 2000 after R1 Research review (Gap 3).
 */
const MAX_RESULT_SUMMARY_CHARS = 2000;
const MAX_ERROR_MESSAGE_CHARS = 200;

interface PendingToolCall {
  /** SDK correlation id (Anthropic tool_use.id, OpenAI tool_call.id, etc.) */
  callId: string;
  tool: string;
  args?: Record<string, unknown>;
  startedAtMs: number;
  turn: number;
  isMcp: boolean;
}

export interface TraceCapture {
  /**
   * Record the start of a tool call. `id` is the SDK's correlation id
   * (Anthropic SDK `tool_use.id`, OpenAI `tool_call.id`, etc.) — used to
   * pair the matching recordToolResult AND persisted on the captured
   * TraceToolCall as `id` for OTEL `gen_ai.tool.call.id` mapping.
   */
  recordToolUse(id: string, tool: string, args?: Record<string, unknown>): void;
  /**
   * Record the result of a previously-started tool call. If `id` was never
   * passed to recordToolUse, the result is silently dropped (defensive —
   * some SDKs emit tool_result for system tools without tool_use).
   */
  recordToolResult(
    id: string,
    outcome: 'success' | 'error',
    opts?: {
      resultSummary?: string;
      errorClass?: string;
      errorMessage?: string;
      retryCount?: number;
    },
  ): void;
  /** Mark the start of a new agent turn (1-indexed). Default starts at turn 1. */
  startTurn(): void;
  /**
   * Increment the text-block counter — one per substantial assistant
   * text emission (>50 chars typically, but the caller decides the
   * threshold). Renamed from `recordReasoning` after R1 review for
   * accuracy: this counts ANY assistant prose, NOT only pre-action
   * "thinking" blocks. Use `addTokens` for cost-of-reasoning attribution.
   */
  recordTextBlock(): void;
  /** Record a turn-level error (e.g. spawn failure, parse error, child crash). */
  recordError(class_: string, message: string): void;
  /**
   * Accumulate LLM token usage into the trajectory aggregate. Call once
   * per LLM round-trip with the usage object the SDK returned. Missing
   * fields are treated as zero for summation. Existing aggregate fields
   * are preserved (additive merge).
   */
  addTokens(usage: TraceTokenUsage): void;
  /**
   * Build the final ExecutionTrace.
   * Unpaired tool calls (recordToolUse without recordToolResult) get
   * marked as outcome='error', errorClass='unpaired_call' so silent
   * SDK hangs remain visible.
   */
  finalize(): ExecutionTrace;
}

export interface TraceCaptureOptions {
  /**
   * Wallclock provider. Defaults to `Date.now`. Override for tests so
   * durations are deterministic.
   */
  now?: () => number;
  /**
   * Predicate that classifies a tool name as an MCP-server call (vs a
   * built-in like Read/Bash). Default heuristic: starts with 'mcp__'.
   * Used to populate `mcpInvocations` aggregate.
   */
  isMcpTool?: (toolName: string) => boolean;
}

/**
 * Create a fresh trace capturer.
 *
 * Usage:
 * ```ts
 * const trace = createTraceCapture();
 * trace.startTurn();
 * trace.recordToolUse('call_1', 'mcp__nex__search', { query: 'foo' });
 * trace.recordToolResult('call_1', 'success', { resultSummary: '3 hits' });
 * trace.recordTextBlock();
 * trace.addTokens({ inputTokens: 1200, outputTokens: 340 });
 * const trajectory = trace.finalize();
 * ```
 */
export function createTraceCapture(opts: TraceCaptureOptions = {}): TraceCapture {
  const now = opts.now ?? (() => Date.now());
  const isMcpTool = opts.isMcpTool ?? ((name: string) => name.startsWith('mcp__'));

  const capturedAt = new Date(now()).toISOString();
  const pending = new Map<string, PendingToolCall>();
  const completed: TraceToolCall[] = [];
  const errors: TraceTurnError[] = [];
  let textBlockCount = 0;
  let turnCount = 0;

  // Token-usage aggregate. Kept as a sparse object — undefined fields
  // stay undefined (vs 0) so consumers can distinguish "provider didn't
  // report" from "actually zero tokens".
  const tokenUsage: TraceTokenUsage = {};

  function currentTurn(): number {
    // 1-indexed. If no startTurn() was called yet, treat events as belonging
    // to turn 1 (defensive — capturer should remain useful even if the
    // runtime forgets to call startTurn).
    return turnCount === 0 ? 1 : turnCount;
  }

  /** Additive merge of one usage record into the aggregate. */
  function addToken(field: keyof TraceTokenUsage, value: number | undefined): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    tokenUsage[field] = (tokenUsage[field] ?? 0) + value;
  }

  return {
    recordToolUse(id, tool, args) {
      // Defensive: if a duplicate id is emitted (rare SDK bug), overwrite
      // — last-write-wins is preferable to crashing or silently dropping
      // the new call.
      pending.set(id, {
        callId: id,
        tool,
        args,
        startedAtMs: now(),
        turn: currentTurn(),
        isMcp: isMcpTool(tool),
      });
    },
    recordToolResult(id, outcome, resultOpts) {
      const start = pending.get(id);
      if (!start) {
        // No matching tool_use — silently drop (some SDKs emit tool_result
        // for built-ins without a paired tool_use event).
        return;
      }
      pending.delete(id);
      const call: TraceToolCall = {
        id: start.callId,
        tool: start.tool,
        outcome,
        durationMs: Math.max(0, now() - start.startedAtMs),
        turn: start.turn,
      };
      if (start.args !== undefined) {
        call.args = start.args;
      }
      if (resultOpts?.resultSummary !== undefined && resultOpts.resultSummary !== null) {
        call.resultSummary = resultOpts.resultSummary.slice(0, MAX_RESULT_SUMMARY_CHARS);
      }
      if (outcome === 'error') {
        if (resultOpts?.errorClass) {
          call.errorClass = resultOpts.errorClass;
        }
        if (resultOpts?.errorMessage) {
          call.errorMessage = resultOpts.errorMessage.slice(0, MAX_ERROR_MESSAGE_CHARS);
        }
      }
      if (resultOpts?.retryCount && resultOpts.retryCount > 0) {
        call.retryCount = resultOpts.retryCount;
      }
      completed.push(call);
    },
    startTurn() {
      turnCount++;
    },
    recordTextBlock() {
      textBlockCount++;
    },
    recordError(class_, message) {
      errors.push({
        class: class_,
        message: message.slice(0, MAX_ERROR_MESSAGE_CHARS),
        turn: currentTurn(),
      });
    },
    addTokens(usage) {
      addToken('inputTokens', usage.inputTokens);
      addToken('outputTokens', usage.outputTokens);
      addToken('cacheReadTokens', usage.cacheReadTokens);
      addToken('cacheCreationTokens', usage.cacheCreationTokens);
    },
    finalize() {
      // Surface unpaired tool calls so silent hangs are visible in the trace.
      // (E.g. SDK crashes mid-tool, child process dies, timeout escapes us.)
      for (const [, pendingCall] of pending) {
        completed.push({
          id: pendingCall.callId,
          tool: pendingCall.tool,
          ...(pendingCall.args !== undefined ? { args: pendingCall.args } : {}),
          outcome: 'error',
          durationMs: Math.max(0, now() - pendingCall.startedAtMs),
          errorClass: 'unpaired_call',
          errorMessage: 'tool_use without matching tool_result',
          turn: pendingCall.turn,
        });
      }
      pending.clear();

      const mcpInvocations = completed.filter((c) => isMcpTool(c.tool)).length;

      const trace: ExecutionTrace = {
        version: 1,
        toolCalls: completed,
        textBlockCount,
        turnCount: Math.max(turnCount, 1),
        mcpInvocations,
        errors,
        capturedAt,
      };
      // Only attach tokenUsage if at least one field was populated —
      // keeps the JSONB lean for runs against providers without usage data.
      if (Object.keys(tokenUsage).length > 0) {
        trace.tokenUsage = { ...tokenUsage };
      }
      return trace;
    },
  };
}

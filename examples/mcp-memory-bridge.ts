/**
 * Example: Generic MCP-Memory Bridge (Darwin → any MCP-compliant memory server)
 *
 * Wraps the `FeedbackStore` interface from closed-loop-feedback.ts with a
 * thin JSON-RPC 2.0 client for MCP. Works with any MCP server that exposes
 * a write tool (e.g. `memory_learn`) and a read tool (e.g. `memory_search`).
 *
 * Default wiring targets `@studiomeyer/local-memory-mcp` (zero-config, lives
 * in a single SQLite file under the OS data dir, no cloud, no API keys).
 * Drop in Mem0 / Zep / Letta / Cognee / your own self-hosted MCP server by
 * overriding `writeTool` / `readTool` and providing schema mappers.
 *
 * Why raw JSON-RPC and not @modelcontextprotocol/sdk?
 *  - Darwin keeps a "zero hard deps" policy (peerDependencies only).
 *  - MCP wire protocol is three messages: initialize, tools/list, tools/call.
 *  - Keeps the bridge testable without a mock SDK.
 *
 * Why a single bridge instead of per-provider clients?
 *  - The wire is the same. Only tool names and arg/result shapes vary.
 *  - One reconnect / lifecycle path, one place to harden timeouts.
 *
 * Run demo (requires `@studiomeyer/local-memory-mcp` installed):
 *   npm install -g @studiomeyer/local-memory-mcp
 *   npx tsx examples/mcp-memory-bridge.ts
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { FeedbackRecord, FeedbackStore } from './closed-loop-feedback.js';

// ─── Public types ────────────────────────────────────

/** A lesson retrieved from the memory store — what gets injected into the next prompt. */
export interface Lesson {
  /** Free-form text the agent should consider next run. */
  content: string;
  /** Tags surfaced by the store (may be empty). */
  tags: string[];
  /** Optional ranking score (semantics depend on the backing store). */
  score?: number;
}

/** Options bag for `fetchRelevant()`. Object-shaped for future-compat. */
export interface FetchRelevantOptions {
  query: string;
  /** Max number of lessons. Default: 5. */
  limit?: number;
  /** Optional tag filter — passed through to the read tool if it honours it. */
  tags?: string[];
  /**
   * Per-call timeout override in ms. Falls back to `requestTimeoutMs` from
   * the bridge config (default 10 000 ms). Useful for slow embedding-backed
   * stores or when a particular query is known to be expensive.
   */
  timeoutMs?: number;
}

/** Options bag for `save()`. Mirrors the per-call timeout knob on read. */
export interface SaveOptions {
  /**
   * Per-call timeout override in ms. Falls back to `requestTimeoutMs` from
   * the bridge config (default 10 000 ms).
   */
  timeoutMs?: number;
}

/** Darwin-side store contract extended with retrieval + lifecycle. */
export interface RetrievableFeedbackStore extends FeedbackStore {
  /**
   * Retrieve lessons relevant to a query.
   * Backward-compatible: accepts either a plain string (legacy) or an
   * options object. The bag form is preferred for v0.4.7+.
   */
  fetchRelevant(queryOrOpts: string | FetchRelevantOptions, limit?: number): Promise<Lesson[]>;
  close(): Promise<void>;
}

/** Transport-agnostic configuration. */
export interface McpMemoryConfig {
  transport: 'stdio' | 'http';
  /**
   * - stdio: [command, ...args] for `spawn`. Example: ['npx', '-y', '@studiomeyer/local-memory-mcp'].
   * - http: full URL of the MCP endpoint. Example: 'https://memory.example.com/mcp'.
   */
  endpoint: string | string[];
  /** Optional Authorization header value for http transport (e.g. 'Bearer …'). */
  authHeader?: string;
  /** Name of the tool that writes a memory. Default: 'memory_learn'. */
  writeTool?: string;
  /** Name of the tool that searches memories. Default: 'memory_search'. */
  readTool?: string;
  /** Translate a FeedbackRecord to the writeTool's input arguments. */
  mapWriteArgs?: (rec: FeedbackRecord) => Record<string, unknown>;
  /** Translate a raw tools/call result into Lesson[]. */
  mapReadResult?: (toolResult: unknown) => Lesson[];
  /** Per-RPC timeout in ms (default: 10_000). */
  requestTimeoutMs?: number;
  /** Number of automatic respawn attempts after a stdio EPIPE/exit (default: 1). */
  maxRespawn?: number;
  /**
   * HTTP retry policy. Number of retries for 5xx + transient network errors
   * (ECONNRESET / ETIMEDOUT / abort). Default: 2. Exponential backoff
   * starting at 250 ms.
   */
  httpMaxRetries?: number;
  /** Protocol version handed to the server during initialize. Default: '2025-11-25'. */
  protocolVersion?: string;
  /** Logger for diagnostics. Defaults to console.warn on errors only. */
  logger?: { warn: (msg: string) => void; debug?: (msg: string) => void };
}

// ─── Defaults ────────────────────────────────────────

const DEFAULT_WRITE_TOOL = 'memory_learn';
const DEFAULT_READ_TOOL = 'memory_search';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPAWN = 1;
const DEFAULT_HTTP_MAX_RETRIES = 2;
const DEFAULT_PROTOCOL_VERSION = '2025-11-25';

// ─── Errors ──────────────────────────────────────────

/**
 * Base class for bridge errors. Discriminates protocol-level (server-side
 * JSON-RPC error responses) from transport-level (local timeouts, network
 * resets, EPIPE, child process exits). Callers can branch on `kind` to
 * decide retry-vs-fail-loud without parsing the message text.
 *
 * Mirrors the split MCP TypeScript SDK v2 uses internally (`ProtocolError`
 * vs `SdkError`). We keep our own classes to preserve the bridge's
 * zero-hard-dep policy.
 */
export class McpBridgeError extends Error {
  /** 'protocol' = JSON-RPC error from the server, 'transport' = local. */
  readonly kind: 'protocol' | 'transport';
  /** JSON-RPC error code for protocol errors, or a stable string for transport errors. */
  readonly code: number | string;
  /** Which transport produced the error. */
  readonly transport: 'stdio' | 'http';
  constructor(opts: {
    message: string;
    kind: 'protocol' | 'transport';
    code: number | string;
    transport: 'stdio' | 'http';
    cause?: unknown;
  }) {
    super(opts.message);
    this.name = 'McpBridgeError';
    this.kind = opts.kind;
    this.code = opts.code;
    this.transport = opts.transport;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

/** JSON-RPC error from the server. `code` is the numeric JSON-RPC code. */
export class McpBridgeProtocolError extends McpBridgeError {
  constructor(opts: { code: number; serverMessage: string; transport: 'stdio' | 'http' }) {
    super({
      message: `mcp error ${opts.code}: ${opts.serverMessage}`,
      kind: 'protocol',
      code: opts.code,
      transport: opts.transport,
    });
    this.name = 'McpBridgeProtocolError';
  }
}

/**
 * Local transport-layer error (timeout, EPIPE, network reset, child exit,
 * abort, DNS). `code` is a short stable string for branching:
 *   'timeout' | 'closed' | 'transient' | 'child_exit' | 'spawn_failed' | 'http_status'
 */
export class McpBridgeTransportError extends McpBridgeError {
  constructor(opts: {
    message: string;
    code: 'timeout' | 'closed' | 'transient' | 'child_exit' | 'spawn_failed' | 'http_status';
    transport: 'stdio' | 'http';
    cause?: unknown;
  }) {
    super({
      message: opts.message,
      kind: 'transport',
      code: opts.code,
      transport: opts.transport,
      cause: opts.cause,
    });
    this.name = 'McpBridgeTransportError';
  }
}

/** Default mapping for `memory_learn` shape (local-memory-mcp, mcp-nex). */
export function defaultMapWriteArgs(rec: FeedbackRecord): Record<string, unknown> {
  return {
    category: rec.polarity === 'mistake' ? 'mistake' : 'pattern',
    content: rec.content,
    tags: rec.tags,
    confidence: rec.confidence,
    source: 'automated',
    memoryType: 'semantic',
  };
}

/**
 * Default mapping for `memory_search` shape.
 * Accepts both the raw MCP CallToolResult shape `{content:[{text:JSON}]}`
 * and a pre-parsed object — that keeps the parser tolerant when a custom
 * server returns structured content directly.
 */
export function defaultMapReadResult(raw: unknown): Lesson[] {
  const parsed = extractStructured(raw);
  if (!parsed || typeof parsed !== 'object') return [];

  // Common envelope shapes observed in the wild across MCP-Memory servers:
  //   { success, data: { results: [{ body, ... }] } }
  //   { success, data: { results: [{ content, tags }] } }
  //   { results: [...] }
  //   [...] (plain array)
  const envelope = parsed as Record<string, unknown>;
  const data = (envelope.data ?? envelope) as Record<string, unknown>;
  const results = (data.results ?? envelope.results ?? envelope) as unknown;
  if (!Array.isArray(results)) return [];

  const out: Lesson[] = [];
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const content =
      typeof row.content === 'string'
        ? row.content
        : typeof row.body === 'string'
        ? row.body
        : typeof row.text === 'string'
        ? row.text
        : null;
    if (!content) continue;
    const tags = Array.isArray(row.tags)
      ? row.tags.filter((t): t is string => typeof t === 'string')
      : [];
    const scoreRaw = row.score ?? row.rank ?? row.rrfScore;
    const score = typeof scoreRaw === 'number' && Number.isFinite(scoreRaw) ? scoreRaw : undefined;
    out.push({ content, tags, score });
  }
  return out;
}

/** Pull structured payload out of an MCP CallToolResult envelope. */
function extractStructured(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    for (const block of r.content as Array<Record<string, unknown>>) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        try {
          return JSON.parse(block.text);
        } catch {
          return block.text;
        }
      }
    }
  }
  if ('structuredContent' in r && r.structuredContent != null) return r.structuredContent;
  return raw;
}

// ─── Bridge implementation ───────────────────────────

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Generic MCP-Memory bridge.
 *
 * Lifecycle:
 *   const m = openLocalMemory();         // or openRemoteMemory(...)
 *   await m.save({...});                  // FeedbackStore.save
 *   const lessons = await m.fetchRelevant({ query: 'topic', limit: 5 });
 *   await m.close();
 *
 * Errors in save/fetch are swallowed at the FeedbackStore level (the
 * closed-loop callsite logs them) — the bridge surfaces them as thrown
 * Errors so the caller decides whether to fail-loud or fail-quiet.
 */
export class McpMemoryBridge implements RetrievableFeedbackStore {
  private readonly config: Required<Omit<McpMemoryConfig, 'authHeader' | 'logger'>> & {
    authHeader?: string;
    logger: NonNullable<McpMemoryConfig['logger']>;
  };
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private stdoutBuffer = '';
  private respawnCount = 0;
  private initialized = false;
  private initInFlight: Promise<void> | null = null;
  private closed = false;

  constructor(config: McpMemoryConfig) {
    this.config = {
      transport: config.transport,
      endpoint: config.endpoint,
      authHeader: config.authHeader,
      writeTool: config.writeTool ?? DEFAULT_WRITE_TOOL,
      readTool: config.readTool ?? DEFAULT_READ_TOOL,
      mapWriteArgs: config.mapWriteArgs ?? defaultMapWriteArgs,
      mapReadResult: config.mapReadResult ?? defaultMapReadResult,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxRespawn: config.maxRespawn ?? DEFAULT_MAX_RESPAWN,
      httpMaxRetries: config.httpMaxRetries ?? DEFAULT_HTTP_MAX_RETRIES,
      protocolVersion: config.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
      logger:
        config.logger ?? {
          warn: (msg) => console.warn(`[mcp-memory-bridge] ${msg}`),
        },
    };
  }

  // ── FeedbackStore.save ─────────────────────────────
  /**
   * Persist a feedback record. Accepts an optional second arg for per-call
   * overrides (currently `timeoutMs`). The signature stays a structural
   * super-type of `FeedbackStore.save(record)`, so callers using the base
   * interface keep working unchanged.
   */
  async save(record: FeedbackRecord, opts: SaveOptions = {}): Promise<void> {
    await this.callTool(this.config.writeTool, this.config.mapWriteArgs(record), {
      timeoutMs: opts.timeoutMs,
    });
  }

  // ── RetrievableFeedbackStore.fetchRelevant ─────────
  async fetchRelevant(
    queryOrOpts: string | FetchRelevantOptions,
    legacyLimit?: number,
  ): Promise<Lesson[]> {
    const opts: FetchRelevantOptions =
      typeof queryOrOpts === 'string'
        ? { query: queryOrOpts, limit: legacyLimit }
        : queryOrOpts;
    const args: Record<string, unknown> = { query: opts.query, limit: opts.limit ?? 5 };
    if (opts.tags && opts.tags.length > 0) args.tags = opts.tags;
    const result = await this.callTool(this.config.readTool, args, {
      timeoutMs: opts.timeoutMs,
    });
    return this.config.mapReadResult(result);
  }

  // ── Lifecycle ──────────────────────────────────────
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.initInFlight = null; // F5: cleared so callers awaiting a stale promise hit closed-bridge guard
    if (this.child) {
      const c = this.child;
      this.child = null;
      try {
        c.kill('SIGTERM');
      } catch {
        // ignore — already dead
      }
    }
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(
        new McpBridgeTransportError({
          message: 'bridge closed',
          code: 'closed',
          transport: this.config.transport,
        }),
      );
    }
    this.pending.clear();
  }

  // ── Internals ──────────────────────────────────────
  private async ensureReady(): Promise<void> {
    if (this.closed) {
      throw new McpBridgeTransportError({
        message: 'bridge is closed',
        code: 'closed',
        transport: this.config.transport,
      });
    }
    if (this.initialized) return;
    if (!this.initInFlight) {
      // F4: do NOT auto-clear initInFlight in .catch. Leave the rejected
      // promise in place so concurrent awaiters all see the same failure;
      // the next caller after the failure makes a fresh attempt.
      this.initInFlight = this.initialize();
    }
    // Snapshot the promise reference so concurrent failed-init callers
    // don't wipe a newer in-flight promise on cleanup (R2 narrow race).
    const myPromise = this.initInFlight;
    try {
      await myPromise;
    } catch (err) {
      // Reset only if no fresher attempt has replaced ours.
      if (!this.initialized && this.initInFlight === myPromise) {
        this.initInFlight = null;
      }
      throw err;
    }
  }

  private async initialize(): Promise<void> {
    if (this.config.transport === 'stdio') {
      this.spawnStdio();
    }
    // initialize handshake (per MCP spec 2025-11-25)
    await this.rpc('initialize', {
      protocolVersion: this.config.protocolVersion,
      capabilities: {},
      clientInfo: { name: 'darwin-mcp-memory-bridge', version: '0.4.7' },
    });
    // best-effort notify; the server doesn't reply to notifications
    if (this.config.transport === 'stdio' && this.child) {
      this.sendStdio({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      });
    }
    this.initialized = true;
    // F4: keep initInFlight set to the resolved promise; ensureReady's
    // early-return path on `initialized=true` covers all subsequent calls.
    // onChildExit nulls it on crash, close() nulls it on shutdown.
  }

  private spawnStdio(): void {
    const cmd = Array.isArray(this.config.endpoint)
      ? this.config.endpoint
      : [this.config.endpoint];
    if (cmd.length === 0) throw new Error('stdio endpoint must have at least one entry');
    const [bin, ...args] = cmd;
    const child = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // local-memory-mcp logs to stderr; we forward it through the logger
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdoutData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.config.logger.debug?.(`stderr: ${chunk.trimEnd()}`);
    });
    child.on('exit', (code, signal) => this.onChildExit(code, signal));
    child.on('error', (err) => {
      this.config.logger.warn(`spawn error: ${err.message}`);
    });
    // F3: stdin EPIPE on a dying child emits as a stream error event. Without
    // a handler, Node treats it as an uncaught exception and crashes the
    // host process. Catch and log; the next RPC will see child=null and
    // ensureReady triggers a clean respawn.
    child.stdin.on('error', (err) => {
      this.config.logger.warn(`stdin error (likely race with child exit): ${err.message}`);
    });
    this.child = child;
  }

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasInitialized = this.initialized;
    this.initialized = false;
    this.initInFlight = null;
    this.child = null;
    const reason = `child exited (code=${code}, signal=${signal})`;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(
        new McpBridgeTransportError({
          message: reason,
          code: 'child_exit',
          transport: 'stdio',
        }),
      );
    }
    this.pending.clear();
    if (this.closed) return;
    if (wasInitialized && this.respawnCount < this.config.maxRespawn) {
      this.respawnCount += 1;
      this.config.logger.warn(`${reason}; will respawn on next call`);
    } else if (wasInitialized) {
      this.config.logger.warn(`${reason}; respawn budget exhausted`);
    }
  }

  private onStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk;
    // MCP stdio framing: one JSON-RPC message per newline-delimited line.
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;
      this.handleIncomingLine(line);
    }
  }

  private handleIncomingLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.config.logger.warn(`unparseable line: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof msg.id !== 'number') {
      // notification or progress — ignore for now
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      const err = msg.error as { message?: string; code?: number };
      pending.reject(
        new McpBridgeProtocolError({
          code: typeof err.code === 'number' ? err.code : -32603,
          serverMessage: err.message ?? 'unknown',
          transport: this.config.transport,
        }),
      );
      return;
    }
    pending.resolve(msg.result);
  }

  private sendStdio(payload: Record<string, unknown>): void {
    if (!this.child) throw new Error('stdio child not running');
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      // ERR_STREAM_DESTROYED / EPIPE on a child that's exiting. Caller's
      // pending entry will be rejected via onChildExit; just surface here.
      throw err as Error;
    }
  }

  /**
   * Send one JSON-RPC request and await the matching response.
   * Used for both initialize and tools/call.
   * F1: no inline respawn — ensureReady/initialize is the only path that
   * spawns. This avoids the double-spawn race where rpc() and ensureReady()
   * both spawn children competing for `this.child`.
   *
   * `timeoutMs` overrides the bridge-level `requestTimeoutMs` for this call.
   */
  private async rpc(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    if (this.config.transport === 'http') {
      return this.rpcHttp(method, params, timeoutMs);
    }
    return this.rpcStdio(method, params, timeoutMs);
  }

  private rpcStdio(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const effectiveTimeout = timeoutMs ?? this.config.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new McpBridgeTransportError({
            message: `rpc ${method} timed out after ${effectiveTimeout}ms`,
            code: 'timeout',
            transport: 'stdio',
          }),
        );
      }, effectiveTimeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendStdio({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        // EPIPE / ERR_STREAM_DESTROYED on a dying child.
        reject(
          new McpBridgeTransportError({
            message: `stdio write failed: ${(err as Error).message}`,
            code: 'child_exit',
            transport: 'stdio',
            cause: err,
          }),
        );
      }
    });
  }

  /**
   * HTTP transport with bounded retries on 5xx + transient network errors.
   * Per-attempt timeout via AbortController. Honors `httpMaxRetries`.
   *
   * Sends the `MCP-Protocol-Version` HTTP header per MCP spec 2025-11-25
   * §"HTTP Protocol Versioning". Strict servers MAY return 400 if it is
   * missing or unsupported.
   */
  private async rpcHttp(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const url = typeof this.config.endpoint === 'string'
      ? this.config.endpoint
      : this.config.endpoint.join('');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      // MCP spec 2025-11-25: clients MUST include MCP-Protocol-Version on
      // every request so the server can negotiate. Without it some servers
      // respond 400. We use lowercase per fetch spec recommendation;
      // header matching is case-insensitive per RFC 9110 §5.1.
      'mcp-protocol-version': this.config.protocolVersion,
    };
    if (this.config.authHeader) headers.authorization = this.config.authHeader;
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const maxAttempts = this.config.httpMaxRetries + 1;
    const effectiveTimeout = timeoutMs ?? this.config.requestTimeoutMs;
    let lastErr: McpBridgeError | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const backoffMs = 250 * Math.pow(2, attempt - 1);
        await delay(backoffMs);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), effectiveTimeout);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: payload,
          signal: controller.signal,
        });
        // 4xx is the server saying "your request is bad" — do not retry.
        if (res.status >= 400 && res.status < 500) {
          const text = await res.text().catch(() => '');
          throw new McpBridgeTransportError({
            message: `http ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
            code: 'http_status',
            transport: 'http',
          });
        }
        // 5xx → retry
        if (res.status >= 500) {
          lastErr = new McpBridgeTransportError({
            message: `http ${res.status} ${res.statusText}`,
            code: 'http_status',
            transport: 'http',
          });
          this.config.logger.warn(
            `${lastErr.message} (attempt ${attempt + 1}/${maxAttempts})`,
          );
          continue;
        }
        const text = await res.text();
        const body = parseHttpRpcBody(text);
        // F7: validate JSON-RPC envelope; warn-not-throw for unexpected shapes
        if (!isJsonRpcEnvelope(body)) {
          this.config.logger.warn(
            `non-JSON-RPC response from ${url}: ${text.slice(0, 160)}`,
          );
          return undefined;
        }
        if (body.id !== undefined && body.id !== id) {
          this.config.logger.warn(`id mismatch — sent ${id}, got ${body.id}; accepting anyway`);
        }
        if (body.error) {
          const err = body.error as { message?: string; code?: number };
          throw new McpBridgeProtocolError({
            code: typeof err.code === 'number' ? err.code : -32603,
            serverMessage: err.message ?? 'unknown',
            transport: 'http',
          });
        }
        return body.result;
      } catch (err) {
        // Protocol errors are non-retryable — bubble immediately.
        if (err instanceof McpBridgeProtocolError) throw err;

        const e = err as Error & { name?: string };
        // Abort due to timeout, network reset, or DNS failure → retry
        const isTimeout = e.name === 'AbortError';
        const isTransientNet = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(e.message ?? '');
        const isTransient = isTimeout || isTransientNet;

        if (isTransient && attempt < maxAttempts - 1) {
          lastErr = new McpBridgeTransportError({
            message: `transient http error: ${e.message}`,
            code: isTimeout ? 'timeout' : 'transient',
            transport: 'http',
            cause: err,
          });
          this.config.logger.warn(
            `${lastErr.message} (attempt ${attempt + 1}/${maxAttempts})`,
          );
          continue;
        }

        // Re-wrap raw errors so callers always see a McpBridge* instance.
        if (err instanceof McpBridgeError) throw err;
        if (isTimeout) {
          throw new McpBridgeTransportError({
            message: `rpc ${method} timed out after ${effectiveTimeout}ms`,
            code: 'timeout',
            transport: 'http',
            cause: err,
          });
        }
        throw new McpBridgeTransportError({
          message: e.message,
          code: 'transient',
          transport: 'http',
          cause: err,
        });
      } finally {
        clearTimeout(timer);
      }
    }
    throw (
      lastErr ??
      new McpBridgeTransportError({
        message: 'rpcHttp exhausted retries',
        code: 'transient',
        transport: 'http',
      })
    );
  }

  /**
   * Invoke a tool. Accepts a per-call `opts.timeoutMs` override that takes
   * precedence over the bridge-level `requestTimeoutMs` config.
   */
  private async callTool(
    name: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    await this.ensureReady();
    return this.rpc('tools/call', { name, arguments: args }, opts.timeoutMs);
  }
}

/**
 * Parse an HTTP body that may be either plain JSON or Server-Sent Events.
 * F2: SSE framing is `data: …\n\n` per event with possible multi-line data
 * payloads. We take the last well-formed event so a streamed in-progress
 * frame doesn't override the final result.
 */
export function parseHttpRpcBody(text: string): { result?: unknown; error?: unknown; id?: unknown; jsonrpc?: unknown } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('data:') || trimmed.includes('\n\ndata:')) {
    const events = trimmed.split(/\n\n+/).filter(Boolean);
    for (let i = events.length - 1; i >= 0; i--) {
      const lines = events[i].split('\n').filter((l) => l.startsWith('data:'));
      if (lines.length === 0) continue;
      // SSE multi-line data MUST be joined with \n per spec (not concat).
      const payload = lines.map((l) => l.slice(5).trim()).join('\n');
      try {
        return JSON.parse(payload);
      } catch {
        continue;
      }
    }
    return {};
  }
  return JSON.parse(trimmed);
}

function isJsonRpcEnvelope(body: unknown): body is { result?: unknown; error?: unknown; id?: unknown; jsonrpc: string } {
  return (
    body != null &&
    typeof body === 'object' &&
    (body as Record<string, unknown>).jsonrpc === '2.0' &&
    ('result' in (body as object) || 'error' in (body as object))
  );
}

// ─── Convenience factories ───────────────────────────

/**
 * Default zero-config wiring: spawn `@studiomeyer/local-memory-mcp` via npx.
 *
 * Requires the package to be reachable (either installed globally or via
 * `npx -y @studiomeyer/local-memory-mcp` which fetches on first run).
 */
export function localMemory(overrides: Partial<McpMemoryConfig> = {}): McpMemoryBridge {
  return new McpMemoryBridge({
    transport: 'stdio',
    endpoint: ['npx', '-y', '@studiomeyer/local-memory-mcp'],
    ...overrides,
  });
}

/**
 * Connect to a remote MCP server over HTTP.
 *
 * Example: connect to your hosted memory.studiomeyer.io endpoint
 *   remoteMemory('https://memory.studiomeyer.io/mcp', { authHeader: `Bearer ${KEY}` })
 *
 * Example: Mem0 with tool-name + arg aliasing — see `mem0Preset()` below
 * for a one-line spread that handles all of this for you.
 */
export function remoteMemory(url: string, overrides: Partial<McpMemoryConfig> = {}): McpMemoryBridge {
  return new McpMemoryBridge({
    transport: 'http',
    endpoint: url,
    ...overrides,
  });
}

// ─── Provider presets ────────────────────────────────

/**
 * Mem0 MCP server preset — drop-in overrides that match the exact tool
 * names + arg shapes the `mem0ai/mem0-mcp` server expects.
 *
 * Reference: github.com/mem0ai/mem0-mcp — tools are `add_memory` (NOT
 * `mem0_add` or `add_memories`) and `search_memories` (NOT `search_memory`).
 * Add-args require one of `text`/`messages` + at least one of
 * `user_id`/`agent_id`/`run_id`. Search-result rows expose the lesson
 * text under `memory` (not `content`/`body`/`text`).
 *
 * Usage with the hosted Mem0 platform:
 * \`\`\`ts
 * const memory = remoteMemory('https://api.mem0.ai/mcp', {
 *   authHeader: `Bearer ${process.env.MEM0_KEY}`,
 *   ...mem0Preset({ userId: 'darwin-agent' }),
 * });
 * \`\`\`
 *
 * Usage with a locally spawned mem0-mcp server (stdio):
 * \`\`\`ts
 * const memory = new McpMemoryBridge({
 *   transport: 'stdio',
 *   endpoint: ['uvx', 'mem0-mcp'],
 *   ...mem0Preset({ userId: 'darwin-agent' }),
 * });
 * \`\`\`
 *
 * Spread order matters: put `...mem0Preset(...)` AFTER other overrides if
 * you want the preset to win, or BEFORE if you want to override the
 * preset's defaults yourself.
 */
export function mem0Preset(opts: {
  /**
   * Mem0 scope identifier. Required because `add_memory` rejects writes
   * without at least one of user_id / agent_id / run_id.
   */
  userId?: string;
  agentId?: string;
  runId?: string;
  /** Extra metadata merged into every write under the `metadata` key. */
  defaultMetadata?: Record<string, unknown>;
} = {}): Partial<McpMemoryConfig> {
  const scope: Record<string, unknown> = {};
  if (opts.userId) scope.user_id = opts.userId;
  if (opts.agentId) scope.agent_id = opts.agentId;
  if (opts.runId) scope.run_id = opts.runId;

  return {
    writeTool: 'add_memory',
    readTool: 'search_memories',
    mapWriteArgs: (rec) => ({
      text: rec.content,
      metadata: {
        polarity: rec.polarity,
        confidence: rec.confidence,
        tags: rec.tags,
        ...(opts.defaultMetadata ?? {}),
      },
      ...scope,
    }),
    mapReadResult: (raw): Lesson[] => {
      // Mem0 responses come back as a JSON string inside content[0].text.
      // Pull it via the same extractor used by the default mapper.
      const parsed = mem0ExtractStructured(raw);
      if (!parsed || typeof parsed !== 'object') return [];

      // Mem0 search returns `{ results: [{ id, memory, metadata, score? }] }`
      // (sometimes wrapped in another envelope when the platform queues async).
      const envelope = parsed as Record<string, unknown>;
      const results = (envelope.results ?? envelope.data ?? envelope) as unknown;
      if (!Array.isArray(results)) return [];

      const out: Lesson[] = [];
      for (const item of results) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        // The lesson text lives under `memory` in Mem0 (vs `content`/`body`
        // in mcp-nex / local-memory-mcp). Fall back to `content` for safety
        // in case a custom Mem0 build returns the older shape.
        const content =
          typeof row.memory === 'string'
            ? row.memory
            : typeof row.content === 'string'
            ? row.content
            : null;
        if (!content) continue;

        // Mem0 stores tags inside `metadata.tags` rather than top-level.
        const meta = row.metadata as Record<string, unknown> | undefined;
        const tagsFromMeta = meta && Array.isArray(meta.tags) ? meta.tags : [];
        const tagsFromTop = Array.isArray(row.tags) ? row.tags : [];
        const tags = [...tagsFromMeta, ...tagsFromTop].filter(
          (t): t is string => typeof t === 'string',
        );

        const scoreRaw = row.score ?? row.rank;
        const score = typeof scoreRaw === 'number' && Number.isFinite(scoreRaw) ? scoreRaw : undefined;
        out.push({ content, tags, score });
      }
      return out;
    },
  };
}

/** Local copy of extractStructured for the preset's own mapper. */
function mem0ExtractStructured(raw: unknown): unknown {
  if (raw == null || typeof raw !== 'object') return raw;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.content)) {
    for (const block of r.content as Array<Record<string, unknown>>) {
      if (block?.type === 'text' && typeof block.text === 'string') {
        try {
          return JSON.parse(block.text);
        } catch {
          return block.text;
        }
      }
    }
  }
  if ('structuredContent' in r && r.structuredContent != null) return r.structuredContent;
  return raw;
}

// ─── Demo ────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const memory = localMemory();
  try {
    await memory.save({
      polarity: 'pattern',
      content: 'Darwin demo: bridge save round-trip works.',
      tags: ['darwin-demo', 'bridge'],
      confidence: 0.7,
    });
    // give SQLite a tick to settle
    await delay(50);
    const lessons = await memory.fetchRelevant({ query: 'Darwin demo bridge', limit: 3 });
    console.log('[demo] fetched lessons:', lessons.length);
    for (const l of lessons) {
      console.log(`  - score=${l.score ?? '-'} tags=[${l.tags.join(',')}] :: ${l.content.slice(0, 80)}`);
    }
  } finally {
    await memory.close();
  }
}

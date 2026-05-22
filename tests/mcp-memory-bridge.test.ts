/**
 * Tests for examples/mcp-memory-bridge.ts (v0.4.7).
 *
 * Focus: pure / unit-testable surfaces. The two transport paths (stdio +
 * http) each have one round-trip test against a mock server. Schema-mapping
 * defaults + the structured-content extractor get their own dedicated
 * tests because that's the part most likely to drift across MCP servers.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  McpMemoryBridge,
  McpBridgeError,
  McpBridgeProtocolError,
  McpBridgeTransportError,
  defaultMapWriteArgs,
  defaultMapReadResult,
  mem0Preset,
  remoteMemory,
  type McpMemoryConfig,
  type Lesson,
} from '../examples/mcp-memory-bridge.js';
import type { FeedbackRecord } from '../examples/closed-loop-feedback.js';

// ─── defaultMapWriteArgs ─────────────────────────────

describe('defaultMapWriteArgs', () => {
  const baseRecord: FeedbackRecord = {
    polarity: 'mistake',
    content: 'Critic flagged missed security issue.',
    tags: ['darwin-feedback', 'low-quality', 'agent:analyst'],
    confidence: 0.85,
  };

  it('maps mistake polarity to category="mistake"', () => {
    const args = defaultMapWriteArgs(baseRecord);
    assert.equal(args.category, 'mistake');
    assert.equal(args.content, baseRecord.content);
    assert.deepEqual(args.tags, baseRecord.tags);
    assert.equal(args.confidence, 0.85);
  });

  it('maps pattern polarity to category="pattern"', () => {
    const args = defaultMapWriteArgs({ ...baseRecord, polarity: 'pattern' });
    assert.equal(args.category, 'pattern');
  });

  it('sets source=automated + memoryType=semantic', () => {
    const args = defaultMapWriteArgs(baseRecord);
    assert.equal(args.source, 'automated');
    assert.equal(args.memoryType, 'semantic');
  });
});

// ─── defaultMapReadResult ────────────────────────────

describe('defaultMapReadResult', () => {
  it('extracts lessons from local-memory-mcp shape (data.results[].body)', () => {
    const raw = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            data: {
              results: [
                { id: 'a', type: 'learning', title: 'L1', body: 'lesson one', rank: -1.2 },
                { id: 'b', type: 'learning', title: 'L2', body: 'lesson two', rank: -0.5 },
              ],
            },
          }),
        },
      ],
    };
    const lessons = defaultMapReadResult(raw);
    assert.equal(lessons.length, 2);
    assert.equal(lessons[0].content, 'lesson one');
    assert.equal(lessons[0].score, -1.2);
    assert.deepEqual(lessons[0].tags, []);
  });

  it('extracts lessons from generic shape (data.results[].content + tags)', () => {
    const raw = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            data: {
              results: [
                { content: 'lesson alpha', tags: ['a', 'b'] },
                { content: 'lesson beta', tags: ['c'] },
              ],
            },
          }),
        },
      ],
    };
    const lessons = defaultMapReadResult(raw);
    assert.equal(lessons.length, 2);
    assert.deepEqual(lessons[0].tags, ['a', 'b']);
    assert.equal(lessons[1].content, 'lesson beta');
  });

  it('accepts plain array results', () => {
    const raw = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: [{ content: 'standalone lesson' }],
          }),
        },
      ],
    };
    const lessons = defaultMapReadResult(raw);
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0].content, 'standalone lesson');
  });

  it('returns empty when payload missing', () => {
    assert.deepEqual(defaultMapReadResult(null), []);
    assert.deepEqual(defaultMapReadResult({ content: [] }), []);
    assert.deepEqual(defaultMapReadResult({ content: [{ type: 'text', text: 'not-json' }] }), []);
  });

  it('drops non-string tags but keeps the lesson', () => {
    const raw = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: [{ content: 'lesson with mixed tags', tags: ['ok', 1, null, 'fine'] }],
          }),
        },
      ],
    };
    const lessons = defaultMapReadResult(raw);
    assert.deepEqual(lessons[0].tags, ['ok', 'fine']);
  });

  it('accepts structuredContent shortcut', () => {
    const raw = {
      structuredContent: { results: [{ content: 'direct payload' }] },
    };
    const lessons = defaultMapReadResult(raw);
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0].content, 'direct payload');
  });
});

// ─── HTTP round-trip ─────────────────────────────────

interface MockHttpServer {
  url: string;
  server: Server;
  received: Array<{ method: string; params: unknown; id: number }>;
}

async function startMockHttpServer(
  handler: (req: { method: string; params: unknown; id: number }) => unknown,
): Promise<MockHttpServer> {
  const received: MockHttpServer['received'] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { method: string; params: unknown; id: number };
      received.push(parsed);
      const result = handler(parsed);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, server, received };
}

describe('McpMemoryBridge (http)', () => {
  it('initializes then calls writeTool on save()', async () => {
    const mock = await startMockHttpServer((req) => {
      if (req.method === 'initialize') {
        return { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'mock', version: '0.0.0' } };
      }
      if (req.method === 'tools/call') {
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, data: { id: 'x' } }) }] };
      }
      throw new Error(`unexpected method: ${req.method}`);
    });
    try {
      const bridge = remoteMemory(mock.url);
      await bridge.save({
        polarity: 'pattern',
        content: 'high-quality run note',
        tags: ['darwin-feedback', 'high-quality'],
        confidence: 0.8,
      });
      await bridge.close();

      assert.equal(mock.received.length, 2);
      assert.equal(mock.received[0].method, 'initialize');
      assert.equal(mock.received[1].method, 'tools/call');
      const params = mock.received[1].params as Record<string, unknown>;
      assert.equal(params.name, 'memory_learn');
      const args = params.arguments as Record<string, unknown>;
      assert.equal(args.category, 'pattern');
      assert.equal(args.content, 'high-quality run note');
    } finally {
      mock.server.close();
    }
  });

  it('respects writeTool + mapWriteArgs overrides (Mem0 style)', async () => {
    const mock = await startMockHttpServer((req) => {
      if (req.method === 'initialize') return { protocolVersion: '2025-11-25', capabilities: {} };
      return { content: [{ type: 'text', text: '{}' }] };
    });
    try {
      const bridge = remoteMemory(mock.url, {
        writeTool: 'mem0_add',
        mapWriteArgs: (rec) => ({ messages: [{ role: 'user', content: rec.content }], metadata: { tags: rec.tags } }),
      });
      await bridge.save({
        polarity: 'mistake',
        content: 'failure note',
        tags: ['darwin-feedback', 'low-quality'],
        confidence: 0.7,
      });
      await bridge.close();

      const toolCall = mock.received[1];
      const params = toolCall.params as Record<string, unknown>;
      assert.equal(params.name, 'mem0_add');
      const args = params.arguments as Record<string, unknown>;
      const messages = args.messages as Array<{ role: string; content: string }>;
      assert.equal(messages[0].content, 'failure note');
    } finally {
      mock.server.close();
    }
  });

  it('forwards Authorization header when provided', async () => {
    let authReceived: string | undefined;
    const server = createServer((req, res) => {
      authReceived = req.headers.authorization;
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: '{}' }] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const bridge = remoteMemory(`http://127.0.0.1:${port}`, { authHeader: 'Bearer test-key' });
      await bridge.save({
        polarity: 'pattern',
        content: 'auth roundtrip',
        tags: [],
        confidence: 0.5,
      });
      await bridge.close();
      assert.equal(authReceived, 'Bearer test-key');
    } finally {
      server.close();
    }
  });

  it('fetchRelevant uses readTool and parses lessons', async () => {
    const mock = await startMockHttpServer((req) => {
      if (req.method === 'initialize') return { protocolVersion: '2025-11-25', capabilities: {} };
      const params = req.params as Record<string, unknown>;
      assert.equal(params.name, 'memory_search');
      const args = params.arguments as Record<string, unknown>;
      assert.equal(args.query, 'tech debt');
      assert.equal(args.limit, 3);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              data: {
                results: [
                  { id: '1', type: 'learning', title: '', body: 'avoid foo', rank: -0.9 },
                  { id: '2', type: 'learning', title: '', body: 'prefer bar', rank: -0.5 },
                ],
              },
            }),
          },
        ],
      };
    });
    try {
      const bridge = remoteMemory(mock.url);
      const lessons = await bridge.fetchRelevant('tech debt', 3);
      await bridge.close();
      assert.equal(lessons.length, 2);
      assert.equal(lessons[0].content, 'avoid foo');
      assert.equal(lessons[1].score, -0.5);
    } finally {
      mock.server.close();
    }
  });

  it('surfaces JSON-RPC errors as thrown Error', async () => {
    const mock = await startMockHttpServer((req) => {
      if (req.method === 'initialize') return { protocolVersion: '2025-11-25', capabilities: {} };
      throw new Error('synthetic'); // will be re-thrown as 500 below
    });
    // Override handler to emit JSON-RPC error rather than 500
    mock.server.removeAllListeners('request');
    mock.server.on('request', (req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number; method: string };
        res.setHeader('content-type', 'application/json');
        if (parsed.method === 'initialize') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-11-25', capabilities: {} } }));
        } else {
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              error: { code: -32602, message: 'invalid params' },
            }),
          );
        }
      });
    });
    try {
      const bridge = remoteMemory(mock.url);
      await assert.rejects(
        () => bridge.save({ polarity: 'pattern', content: 'x', tags: [], confidence: 0.5 }),
        /mcp error -32602/,
      );
      await bridge.close();
    } finally {
      mock.server.close();
    }
  });
});

// ─── stdio round-trip with a fake child ─────────────

describe('McpMemoryBridge (stdio)', () => {
  it('completes initialize + tools/call against a fake stdio server', async () => {
    // Build a tiny fake MCP stdio server as a one-off JS file.
    const dir = mkdtempSync(join(tmpdir(), 'mcp-bridge-test-'));
    const fakePath = join(dir, 'fake-mcp.mjs');
    writeFileSync(
      fakePath,
      `
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {} } });
    } else if (msg.method === 'notifications/initialized') {
      // no reply
    } else if (msg.method === 'tools/call') {
      const args = msg.params.arguments;
      const payload = { success: true, data: { results: [{ id: 'x', body: 'echo: ' + (args.query || args.content) }] } };
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    }
  }
});
process.stderr.write('[fake-mcp] ready\\n');
      `.trim(),
    );
    try {
      const bridge = new McpMemoryBridge({
        transport: 'stdio',
        endpoint: ['node', fakePath],
        requestTimeoutMs: 5000,
      });
      await bridge.save({
        polarity: 'pattern',
        content: 'hello via stdio',
        tags: [],
        confidence: 0.6,
      });
      const lessons = await bridge.fetchRelevant('hello-query', 2);
      assert.equal(lessons.length, 1);
      assert.equal(lessons[0].content, 'echo: hello-query');
      await bridge.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives child crash mid-session and reports clear error (F1/F3 regression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-bridge-crash-'));
    const fakePath = join(dir, 'fake-mcp-crash.mjs');
    writeFileSync(
      fakePath,
      `
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buf = '';
let toolCallCount = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {} } });
    } else if (msg.method === 'tools/call') {
      toolCallCount++;
      if (toolCallCount > 1) {
        process.exit(7);  // crash on second tools/call
      }
      const payload = { data: { results: [] } };
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } });
    }
  }
});
      `.trim(),
    );
    try {
      const bridge = new McpMemoryBridge({
        transport: 'stdio',
        endpoint: ['node', fakePath],
        requestTimeoutMs: 3000,
        maxRespawn: 0, // disable respawn for deterministic test
        logger: { warn: () => {}, debug: () => {} },
      });
      // First call should succeed
      await bridge.save({ polarity: 'pattern', content: 'first', tags: [], confidence: 0.5 });
      // Second call triggers child crash — pending RPC should reject with clear error,
      // NOT crash the test runner with an unhandled EPIPE
      await assert.rejects(
        () => bridge.save({ polarity: 'pattern', content: 'second', tags: [], confidence: 0.5 }),
        /child exited|stdio child not running|bridge closed/,
      );
      await bridge.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects pending RPCs on close() (F5 regression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-bridge-close-'));
    const fakePath = join(dir, 'fake-mcp-slow.mjs');
    writeFileSync(
      fakePath,
      `
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {} } });
    }
    // For tools/call: never reply — let the bridge timeout or be closed
  }
});
      `.trim(),
    );
    try {
      const bridge = new McpMemoryBridge({
        transport: 'stdio',
        endpoint: ['node', fakePath],
        requestTimeoutMs: 10_000,
        logger: { warn: () => {} },
      });
      const pending = bridge.save({ polarity: 'pattern', content: 'never-replied', tags: [], confidence: 0.5 });
      // Give the child time to receive the message
      await new Promise((r) => setTimeout(r, 100));
      await bridge.close();
      await assert.rejects(() => pending, /bridge closed|child exited/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── HTTP retry + parser regression tests ────────────

describe('rpcHttp retry policy (S1131-style)', () => {
  it('retries on 5xx and succeeds when the server recovers', async () => {
    let attempts = 0;
    const server = createServer((req, res) => {
      attempts++;
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number; method: string };
        if (parsed.method === 'initialize') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-11-25', capabilities: {} } }));
          return;
        }
        if (attempts <= 2) {
          // First two tool calls fail with 503
          res.statusCode = 503;
          res.end('upstream timeout');
          return;
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { content: [{ type: 'text', text: '{}' }] } }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const bridge = remoteMemory(`http://127.0.0.1:${port}`, {
        httpMaxRetries: 3,
        logger: { warn: () => {} },
      });
      await bridge.save({ polarity: 'pattern', content: 'recover', tags: [], confidence: 0.5 });
      assert.ok(attempts >= 3, `expected ≥3 attempts, got ${attempts}`);
      await bridge.close();
    } finally {
      server.close();
    }
  });

  it('does NOT retry on 4xx (client error)', async () => {
    let attempts = 0;
    const server = createServer((req, res) => {
      attempts++;
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number; method: string };
        if (parsed.method === 'initialize') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-11-25', capabilities: {} } }));
          return;
        }
        res.statusCode = 400;
        res.end('bad request');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const bridge = remoteMemory(`http://127.0.0.1:${port}`, {
        httpMaxRetries: 3,
        logger: { warn: () => {} },
      });
      await assert.rejects(
        () => bridge.save({ polarity: 'pattern', content: 'x', tags: [], confidence: 0.5 }),
        /http 400/,
      );
      // initialize (1) + first tools/call (1) — should not retry the 400
      assert.equal(attempts, 2);
      await bridge.close();
    } finally {
      server.close();
    }
  });

  it('parseHttpRpcBody handles multi-event SSE (F2 regression)', async () => {
    const { parseHttpRpcBody } = await import('../examples/mcp-memory-bridge.js');
    const sse =
      'data: {"jsonrpc":"2.0","id":1,"result":{"partial":true}}\n\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"done"}]}}\n\n';
    const body = parseHttpRpcBody(sse);
    const r = body.result as Record<string, unknown>;
    assert.ok(Array.isArray(r.content));
    assert.equal((r.content as Array<{ text: string }>)[0].text, 'done');
  });

  it('parseHttpRpcBody handles multi-line SSE data fields (spec §9.2.4)', async () => {
    const { parseHttpRpcBody } = await import('../examples/mcp-memory-bridge.js');
    // Per SSE spec §9.2.4: multiple `data:` lines in one event are joined
    // with \n before dispatch. The joined payload must still be valid JSON
    // for our parser. Splitting after a comma between top-level properties
    // produces well-formed multi-line JSON because JSON allows whitespace
    // (including newlines) between tokens.
    const sse =
      'data: {"jsonrpc":"2.0","id":1,\n' +
      'data:  "result":{"value":"multiline"}}\n\n';
    const body = parseHttpRpcBody(sse);
    const r = body.result as Record<string, unknown>;
    assert.equal(r.value, 'multiline');
  });

  it('rpcHttp warns and returns undefined for non-JSON-RPC envelopes (F7)', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number; method: string };
        if (parsed.method === 'initialize') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} }));
          return;
        }
        // Return non-JSON-RPC payload (e.g. server returned HTML error page parsed as JSON)
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    let warned: string[] = [];
    try {
      const bridge = remoteMemory(`http://127.0.0.1:${port}`, {
        logger: { warn: (msg) => warned.push(msg) },
      });
      const lessons = await bridge.fetchRelevant({ query: 'x', limit: 1 });
      assert.equal(lessons.length, 0);
      assert.ok(warned.some((w) => w.includes('non-JSON-RPC')), `expected non-JSON-RPC warning, got: ${warned.join(' | ')}`);
      await bridge.close();
    } finally {
      server.close();
    }
  });
});

// ─── Concurrency tests ───────────────────────────────

describe('Concurrent calls (single-flight initialize)', () => {
  it('two parallel save() calls trigger exactly one initialize handshake', async () => {
    let inits = 0;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number; method: string };
        if (parsed.method === 'initialize') inits++;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: parsed.id,
          result: parsed.method === 'initialize'
            ? { protocolVersion: '2025-11-25', capabilities: {} }
            : { content: [{ type: 'text', text: '{}' }] },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const bridge = remoteMemory(`http://127.0.0.1:${port}`);
      // Two parallel saves
      await Promise.all([
        bridge.save({ polarity: 'pattern', content: 'a', tags: [], confidence: 0.5 }),
        bridge.save({ polarity: 'pattern', content: 'b', tags: [], confidence: 0.5 }),
      ]);
      assert.equal(inits, 1, `expected single initialize, got ${inits}`);
      await bridge.close();
    } finally {
      server.close();
    }
  });
});

// ─── v0.4.9 — MCP-Protocol-Version header ────────────

describe('MCP-Protocol-Version HTTP header (v0.4.9)', () => {
  it('sends mcp-protocol-version on every HTTP request (MCP spec 2025-11-25)', async () => {
    const receivedHeaders: string[] = [];
    const server = createServer((req, res) => {
      // Header names are normalized to lowercase by Node's http parser.
      const v = req.headers['mcp-protocol-version'];
      if (typeof v === 'string') receivedHeaders.push(v);
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number; method: string };
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result:
              parsed.method === 'initialize'
                ? { protocolVersion: '2025-11-25', capabilities: {} }
                : { content: [{ type: 'text', text: '{}' }] },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const bridge = remoteMemory(`http://127.0.0.1:${port}`);
      await bridge.save({ polarity: 'pattern', content: 'a', tags: [], confidence: 0.5 });
      await bridge.fetchRelevant({ query: 'x', limit: 1 });
      await bridge.close();
      // initialize + tools/call save + tools/call fetch = 3 requests, all with header.
      assert.equal(receivedHeaders.length, 3, `expected 3 requests with header, got ${receivedHeaders.length}`);
      for (const v of receivedHeaders) {
        assert.equal(v, '2025-11-25');
      }
    } finally {
      server.close();
    }
  });

  it('honors custom protocolVersion override in config', async () => {
    const receivedHeaders: string[] = [];
    const server = createServer((req, res) => {
      const v = req.headers['mcp-protocol-version'];
      if (typeof v === 'string') receivedHeaders.push(v);
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number };
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: { content: [{ type: 'text', text: '{}' }] },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const bridge = remoteMemory(`http://127.0.0.1:${port}`, { protocolVersion: '2025-06-18' });
      await bridge.save({ polarity: 'pattern', content: 'x', tags: [], confidence: 0.5 });
      await bridge.close();
      assert.ok(receivedHeaders.every((v) => v === '2025-06-18'));
    } finally {
      server.close();
    }
  });
});

// ─── v0.4.9 — Custom error classes ───────────────────

describe('McpBridge error classes (v0.4.9)', () => {
  it('protocol errors throw McpBridgeProtocolError with numeric code', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number; method: string };
        res.setHeader('content-type', 'application/json');
        if (parsed.method === 'initialize') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-11-25', capabilities: {} } }));
          return;
        }
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32602, message: 'invalid params' } }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const bridge = remoteMemory(`http://127.0.0.1:${port}`);
      let caught: unknown;
      try {
        await bridge.save({ polarity: 'pattern', content: 'x', tags: [], confidence: 0.5 });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof McpBridgeError);
      assert.ok(caught instanceof McpBridgeProtocolError);
      const e = caught as McpBridgeProtocolError;
      assert.equal(e.kind, 'protocol');
      assert.equal(e.code, -32602);
      assert.equal(e.transport, 'http');
      assert.match(e.message, /-32602/);
      await bridge.close();
    } finally {
      server.close();
    }
  });

  it('local 4xx throws McpBridgeTransportError(code="http_status")', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number; method: string };
        if (parsed.method === 'initialize') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-11-25', capabilities: {} } }));
          return;
        }
        res.statusCode = 400;
        res.end('bad request');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const bridge = remoteMemory(`http://127.0.0.1:${port}`, { logger: { warn: () => {} } });
      let caught: unknown;
      try {
        await bridge.save({ polarity: 'pattern', content: 'x', tags: [], confidence: 0.5 });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof McpBridgeTransportError);
      const e = caught as McpBridgeTransportError;
      assert.equal(e.kind, 'transport');
      assert.equal(e.code, 'http_status');
      assert.equal(e.transport, 'http');
      await bridge.close();
    } finally {
      server.close();
    }
  });

  it('close() rejects pending RPCs with McpBridgeTransportError(code="closed")', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-bridge-err-close-'));
    const fakePath = join(dir, 'fake-mcp-slow.mjs');
    writeFileSync(
      fakePath,
      `
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {} } });
    }
  }
});
      `.trim(),
    );
    try {
      const bridge = new McpMemoryBridge({
        transport: 'stdio',
        endpoint: ['node', fakePath],
        requestTimeoutMs: 10_000,
        logger: { warn: () => {} },
      });
      const pending = bridge.save({ polarity: 'pattern', content: 'x', tags: [], confidence: 0.5 });
      await new Promise((r) => setTimeout(r, 100));
      await bridge.close();
      let caught: unknown;
      try {
        await pending;
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof McpBridgeTransportError);
      assert.equal((caught as McpBridgeTransportError).code, 'closed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── v0.4.9 — Per-call timeout ───────────────────────

describe('per-call timeoutMs override (v0.4.9)', () => {
  it('fetchRelevant({ timeoutMs }) preempts the slower bridge-level timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-bridge-timeout-'));
    const fakePath = join(dir, 'fake-mcp-never.mjs');
    writeFileSync(
      fakePath,
      `
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-11-25', capabilities: {} } });
    }
    // tools/call: never reply
  }
});
      `.trim(),
    );
    try {
      // Bridge-level timeout is 10s — per-call should win at 150 ms.
      const bridge = new McpMemoryBridge({
        transport: 'stdio',
        endpoint: ['node', fakePath],
        requestTimeoutMs: 10_000,
        logger: { warn: () => {} },
      });
      const start = Date.now();
      let caught: unknown;
      try {
        await bridge.fetchRelevant({ query: 'never-replies', limit: 1, timeoutMs: 150 });
      } catch (err) {
        caught = err;
      }
      const elapsed = Date.now() - start;
      assert.ok(caught instanceof McpBridgeTransportError, `expected transport error, got ${(caught as Error)?.constructor.name}`);
      assert.equal((caught as McpBridgeTransportError).code, 'timeout');
      // Should have fired around 150 ms, definitely well under the 10s bridge default.
      assert.ok(elapsed < 3000, `expected per-call timeout to win, took ${elapsed}ms`);
      await bridge.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('save({}, { timeoutMs }) routes through to the rpc layer (http)', async () => {
    // Hang the second tools/call long enough that the per-call timeout fires.
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number; method: string };
        if (parsed.method === 'initialize') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-11-25', capabilities: {} } }));
          return;
        }
        // tools/call — never respond
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const bridge = remoteMemory(`http://127.0.0.1:${port}`, {
        requestTimeoutMs: 60_000,
        httpMaxRetries: 0, // disable retries so we measure the timeout once
        logger: { warn: () => {} },
      });
      const start = Date.now();
      let caught: unknown;
      try {
        await bridge.save(
          { polarity: 'pattern', content: 'x', tags: [], confidence: 0.5 },
          { timeoutMs: 200 },
        );
      } catch (err) {
        caught = err;
      }
      const elapsed = Date.now() - start;
      assert.ok(caught instanceof McpBridgeTransportError);
      assert.equal((caught as McpBridgeTransportError).code, 'timeout');
      assert.ok(elapsed < 3000, `expected per-call timeout to win, took ${elapsed}ms`);
      await bridge.close();
    } finally {
      server.close();
    }
  });
});

// ─── v0.4.9 — mem0Preset() ───────────────────────────

describe('mem0Preset() (v0.4.9)', () => {
  it('returns the correct tool names from the mem0ai/mem0-mcp server', () => {
    const preset = mem0Preset({ userId: 'darwin-agent' });
    // Mem0 docs verified 2026-05-22: add_memory (NOT add_memories / mem0_add),
    // search_memories (NOT search_memory).
    assert.equal(preset.writeTool, 'add_memory');
    assert.equal(preset.readTool, 'search_memories');
  });

  it('mapWriteArgs builds Mem0-shaped payload with user_id + metadata', () => {
    const preset = mem0Preset({ userId: 'alice', defaultMetadata: { project: 'darwin' } });
    const rec: FeedbackRecord = {
      polarity: 'mistake',
      content: 'Critic flagged missing source citation.',
      tags: ['darwin-feedback', 'low-quality', 'agent:researcher'],
      confidence: 0.78,
    };
    const args = preset.mapWriteArgs!(rec);
    assert.equal(args.text, rec.content);
    assert.equal(args.user_id, 'alice');
    const meta = args.metadata as Record<string, unknown>;
    assert.equal(meta.polarity, 'mistake');
    assert.equal(meta.confidence, 0.78);
    assert.deepEqual(meta.tags, rec.tags);
    assert.equal(meta.project, 'darwin');
  });

  it('mapWriteArgs accepts agentId / runId scope alternatives', () => {
    const presetA = mem0Preset({ agentId: 'researcher' });
    const argsA = presetA.mapWriteArgs!({ polarity: 'pattern', content: 'x', tags: [], confidence: 0.6 });
    assert.equal(argsA.agent_id, 'researcher');
    assert.equal(argsA.user_id, undefined);

    const presetR = mem0Preset({ runId: 'run_42' });
    const argsR = presetR.mapWriteArgs!({ polarity: 'pattern', content: 'x', tags: [], confidence: 0.6 });
    assert.equal(argsR.run_id, 'run_42');
  });

  it('mapReadResult extracts lessons from Mem0 shape ({results:[{memory,metadata}]})', () => {
    const preset = mem0Preset({ userId: 'alice' });
    const raw = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: [
              {
                id: 'mem_001',
                memory: 'User is allergic to peanuts.',
                metadata: { polarity: 'pattern', tags: ['food', 'health'] },
                score: 0.91,
              },
              {
                id: 'mem_002',
                memory: 'User prefers dark mode.',
                metadata: { tags: ['ui'] },
              },
            ],
          }),
        },
      ],
    };
    const lessons = preset.mapReadResult!(raw);
    assert.equal(lessons.length, 2);
    assert.equal(lessons[0].content, 'User is allergic to peanuts.');
    assert.equal(lessons[0].score, 0.91);
    assert.deepEqual(lessons[0].tags, ['food', 'health']);
    assert.equal(lessons[1].content, 'User prefers dark mode.');
    assert.equal(lessons[1].score, undefined);
  });

  it('mapReadResult tolerates structuredContent shortcut', () => {
    const preset = mem0Preset({ userId: 'alice' });
    const raw = {
      structuredContent: { results: [{ memory: 'direct payload', metadata: {} }] },
    };
    const lessons = preset.mapReadResult!(raw);
    assert.equal(lessons.length, 1);
    assert.equal(lessons[0].content, 'direct payload');
  });

  it('mapReadResult returns [] for unknown shapes', () => {
    const preset = mem0Preset({ userId: 'alice' });
    assert.deepEqual(preset.mapReadResult!(null), []);
    assert.deepEqual(preset.mapReadResult!({ content: [] }), []);
    assert.deepEqual(preset.mapReadResult!({ content: [{ type: 'text', text: 'not-json' }] }), []);
    assert.deepEqual(preset.mapReadResult!({ structuredContent: { results: 'not-an-array' } }), []);
  });

  it('integrates as a one-line spread into remoteMemory()', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { id: number; method: string; params: { name?: string; arguments?: unknown } };
        res.setHeader('content-type', 'application/json');
        if (parsed.method === 'initialize') {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2025-11-25', capabilities: {} } }));
          return;
        }
        if (parsed.method === 'tools/call') {
          calls.push({
            name: parsed.params.name as string,
            args: parsed.params.arguments as Record<string, unknown>,
          });
          // Mem0-shaped response for searches
          const isSearch = parsed.params.name === 'search_memories';
          const payload = isSearch
            ? { results: [{ id: 'mem_x', memory: 'recalled lesson', metadata: { tags: ['t'] } }] }
            : { id: 'mem_new', event: 'ADD' };
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
            }),
          );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      const memory = remoteMemory(`http://127.0.0.1:${port}`, {
        authHeader: 'Bearer fake-mem0-key',
        ...mem0Preset({ userId: 'darwin-agent' }),
      });
      await memory.save({
        polarity: 'pattern',
        content: 'Darwin learned X.',
        tags: ['t'],
        confidence: 0.8,
      });
      const lessons = await memory.fetchRelevant({ query: 'X', limit: 3 });
      await memory.close();
      assert.equal(calls.length, 2);
      assert.equal(calls[0].name, 'add_memory');
      assert.equal(calls[0].args.user_id, 'darwin-agent');
      assert.equal(calls[1].name, 'search_memories');
      assert.equal(lessons.length, 1);
      assert.equal(lessons[0].content, 'recalled lesson');
      assert.deepEqual(lessons[0].tags, ['t']);
    } finally {
      server.close();
    }
  });
});

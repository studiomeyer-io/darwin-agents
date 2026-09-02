/**
 * CLI integration test (R6 review, P0): a too-short run through `darwin run`
 * MUST still reach the evolution loop.
 *
 * The bug: `runCommandInner` early-returned on short output BEFORE calling
 * `loop.afterRun()`, which made afterRun's step 0 — the only place an
 * incomplete run counts against its A/B arm (failsA/failsB → unreliability
 * auto-loss) and the only expiry check reachable mid-test — dead code for
 * CLI users. An unreliable challenger kept receiving live traffic forever.
 *
 * This test drives the REAL `runCommand` end-to-end: a local mock
 * OpenAI-compatible server returns a deliberately short completion, and the
 * A/B failure counter in the persisted state must move.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from '../src/cli/run.js';
import { loadConfig } from '../src/core/agent.js';
import { createMemory } from '../src/memory/index.js';
import { setMaxRunsPerProcess, setMaxRunWallMs } from '../src/core/runner.js';
import { makePromptVersion } from './helpers.js';

let server: Server;
let baseUrl = '';
let requestCount = 0;

before(async () => {
  // The whole test file runs in its own child process (node:test isolation),
  // so chdir + env mutations cannot leak into other test files.
  const dir = mkdtempSync(join(tmpdir(), 'darwin-cli-e2e-'));
  process.chdir(dir);
  process.env.OPENAI_API_KEY = 'test-key-not-real';
  // WARNING, corrected in round 6 of the v0.17 review: this used to claim that
  // setting only OPENAI_API_KEY makes detectDefaultProvider() resolve 'openai',
  // so a stray call would fail fast instead of spawning the real Claude CLI.
  // That is FALSE. `DEFAULT_CONFIG.provider = detectDefaultProvider()` runs at
  // MODULE level in src/core/agent.ts, so it reads the environment when this
  // file is IMPORTED, before this hook runs. In CI, where no keys are set, the
  // frozen provider is claude-cli and there is no fail-fast at all.
  //
  // This file is hermetic today only by accident of its fixture: it seeds an
  // OPEN A/B test, so afterRun returns at step 3 and never reaches the
  // optimizer, and the incomplete-run guard blocks the critic. `requestCount`
  // counts mock-server calls only, so a CLI spawn would not raise it; the
  // failure mode would be a HANGING CI job, not a red assertion.
  //
  // If you add a case here WITHOUT an open A/B test, do not trust this hook.
  // Pin the provider through a darwin.config.ts in the temp cwd and stub
  // globalThis.fetch, the way tests/cli-run-approval-gate.test.ts does, and
  // assert the stub's call count so a route around it fails loudly.
  delete process.env.ANTHROPIC_API_KEY;
  // Isolate from any Telegram config in the developer's environment.
  delete process.env.DARWIN_TELEGRAM_BOT_TOKEN;
  delete process.env.DARWIN_TELEGRAM_CHAT_ID;
  // Round 6: without this, a developer with the variable exported gets real
  // evolution events appended to their own metrics file by a test run.
  delete process.env.DARWIN_METRICS_JSONL;
  setMaxRunsPerProcess(0);
  setMaxRunWallMs(0);

  server = createServer((_req, res) => {
    requestCount++;
    // OpenAI-compatible chat completion with a deliberately SHORT answer —
    // far under the 2000-char incomplete threshold.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'short.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no server port');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('darwin run — incomplete output still reaches the evolution loop', () => {
  it('counts a short run against the routed A/B arm (failsB) without saving it', async () => {
    // Seed: v1 (incumbent) vs v2 (challenger) mid-test; round-robin picks
    // the arm with fewer runs → runsA=1 > runsB=0 routes this run to v2.
    const config = await loadConfig();
    const memory = createMemory(config);
    await memory.init();
    await memory.savePromptVersion(makePromptVersion({
      version: 'v1', agentName: 'writer', active: true, parentVersion: null,
      promptText: 'You are a writer.',
    }));
    await memory.savePromptVersion(makePromptVersion({
      version: 'v2', agentName: 'writer', active: false, parentVersion: 'v1',
      promptText: 'You are a better writer.',
    }));
    await memory.updateState((s) => {
      s.activeVersions['writer'] = 'v1';
      s.lastKnownGood['writer'] = 'v1';
      s.abTests['writer'] = {
        versionA: 'v1', versionB: 'v2', runsA: 1, runsB: 0,
        failsA: 0, failsB: 0, minRuns: 10,
        startedAt: new Date().toISOString(),
      };
      return s;
    });
    await memory.close();

    // Deliberately WITHOUT --no-critic (R7 review): the incomplete-run guard
    // itself must be what prevents the critic call.
    await runCommand([
      'writer', 'write something long',
      '--provider', 'openai',
      '--base-url', baseUrl,
    ]);

    const verify = createMemory(await loadConfig());
    await verify.init();
    const state = await verify.getState();
    const experiments = await verify.loadExperiments('writer');
    await verify.close();

    const test = state.abTests['writer'];
    assert.ok(test, 'the A/B test is still open (one fail is far from auto-loss)');
    assert.equal(test.failsB, 1, 'the short run counted against the routed arm');
    assert.equal(test.runsB, 0, 'an incomplete run is a FAIL, not a run');
    assert.equal(test.failsA, 0);
    assert.equal(experiments.length, 0, 'nothing was saved — no stats poisoning');
    assert.equal(
      requestCount, 1,
      'exactly one LLM call: the agent run — the incomplete guard must block the critic',
    );
  });
});

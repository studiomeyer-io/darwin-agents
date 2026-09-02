/**
 * CLI integration test (round 4 of the v0.17 adversarial review): a persisted
 * `requireApproval` override must reach the REAL `darwin run`.
 *
 * The hole this closes has now been found three rounds in a row, one step
 * further along the same chain each time:
 *
 *   round 1: `hasAnyEvolutionFlag` was a hand-maintained list and went stale,
 *            so the flag persisted while the CLI printed it as unset.
 *   round 2: the guard reached `resolveEvolutionConfig` but stopped there, so
 *            dropping the override inside the resolver left the suite green.
 *   round 3: the guard called `buildResolvedEvolutionLoop`, but nothing pinned
 *            that the COMMANDS call it. Rewiring `run.ts` to
 *            `buildEvolutionLoop(agent, ...)` (the raw agent, no overrides)
 *            left all 833 tests green, while in production `darwin evolve
 *            writer --require-approval` confirmed itself and every later run
 *            went UNGATED: challengers on live traffic behind a gate the
 *            operator believes is armed.
 *
 * A unit test cannot catch that, because the bug is in which function the
 * command reaches for. So this drives `runCommand` itself against a local
 * mock OpenAI-compatible server, exactly like cli-run-loop-integration does,
 * and asserts on the persisted state afterwards: no A/B test, one proposal.
 *
 * Two runs, one file: gated and ungated, so the assertion cannot pass by
 * accident on an agent that would not have evolved anyway.
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
import { setEvolutionConfigOverrides, setEvolutionEnabled } from '../src/evolution/enabled-state.js';
import { makePromptVersion, makeExperiment } from './helpers.js';
import type { DarwinExperiment, MemoryProvider } from '../src/types.js';

let server: Server;
let baseUrl = '';

/** Long enough to clear the 2000-char incomplete-run threshold. */
const LONG_ANSWER = `Sources: https://example.org/a and https://example.org/b. ${'The measured answer continues at length. '.repeat(80)}`;

before(async () => {
  // Own child process per test file (node:test isolation), so chdir and env
  // changes cannot leak into other files.
  const dir = mkdtempSync(join(tmpdir(), 'darwin-approve-e2e-'));
  process.chdir(dir);
  process.env.OPENAI_API_KEY = 'test-key-not-real';
  // Make the default provider deterministic: with only OPENAI_API_KEY set,
  // detectDefaultProvider resolves 'openai', so any stray call goes to the
  // mock and fails fast instead of spawning the real Claude CLI.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.DARWIN_TELEGRAM_BOT_TOKEN;
  delete process.env.DARWIN_TELEGRAM_CHAT_ID;
  setMaxRunsPerProcess(0);
  setMaxRunWallMs(0);

  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: LONG_ANSWER }, finish_reason: 'stop' }],
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

/**
 * Seed an agent that the automatic loop WANTS to evolve: enough runs, weak
 * scores (so patterns finds a weakness), sources on most of them (so the
 * data-quality gate passes).
 */
async function seedWeakAgent(memory: MemoryProvider, agentName: string): Promise<void> {
  await memory.savePromptVersion(makePromptVersion({
    version: 'v1',
    agentName,
    active: true,
    parentVersion: null,
    promptText: 'You are a writer. Be clear. Never invent facts.',
  }));
  for (let i = 0; i < 12; i++) {
    const exp: DarwinExperiment = makeExperiment({
      agentName,
      promptVersion: 'v1',
      taskType: 'tech',
      success: true,
      metrics: { qualityScore: 3, sourceCount: 11, outputLength: 6000, errorCount: 0, durationMs: 30000 },
    });
    await memory.saveExperiment(exp);
  }
  await memory.updateState((s) => {
    s.activeVersions[agentName] = 'v1';
    s.lastKnownGood[agentName] = 'v1';
    s.experimentCounts[agentName] = 12;
    return s;
  });
  await setEvolutionEnabled(memory, agentName, true);
}

describe('darwin run: a persisted requireApproval override reaches the real command', () => {
  it('holds the challenger instead of opening an A/B test', async () => {
    const memory = createMemory(await loadConfig());
    await memory.init();
    await seedWeakAgent(memory, 'writer');
    // Exactly what `darwin evolve writer --require-approval` writes.
    await setEvolutionConfigOverrides(memory, 'writer', { requireApproval: true });
    await memory.close();

    await runCommand([
      'writer', 'write something long',
      '--provider', 'openai',
      '--base-url', baseUrl,
      '--no-critic',
    ]);

    const verify = createMemory(await loadConfig());
    await verify.init();
    const state = await verify.getState();
    const versions = await verify.getAllPromptVersions('writer');
    await verify.close();

    assert.equal(
      state.abTests['writer'] ?? null,
      null,
      'the persisted gate must stop the A/B test, and nothing but the real command proves it',
    );
    const pending = state.pendingApprovals?.['writer'];
    assert.ok(pending, 'a proposal must be waiting');
    assert.equal(pending!.versionA, 'v1');
    assert.equal(pending!.versionB, 'v2');
    // The challenger is persisted so a human can read it.
    assert.ok(versions.find((v) => v.version === 'v2'), 'the challenger must be readable');
    assert.equal(state.activeVersions['writer'], 'v1', 'nothing was activated');
  });

  it('and WITHOUT the override the same setup opens the test, so the assertion is not vacuous', async () => {
    // A negative twin: without it, an agent that simply refused to evolve
    // would satisfy the test above for the wrong reason.
    const memory = createMemory(await loadConfig());
    await memory.init();
    await seedWeakAgent(memory, 'researcher');
    await memory.close();

    await runCommand([
      'researcher', 'research something',
      '--provider', 'openai',
      '--base-url', baseUrl,
      '--no-critic',
    ]);

    const verify = createMemory(await loadConfig());
    await verify.init();
    const state = await verify.getState();
    await verify.close();

    assert.ok(
      state.abTests['researcher'],
      'without the gate this setup DOES evolve, so the gated case above means something',
    );
    assert.equal(state.pendingApprovals?.['researcher'] ?? null, null);
  });
});

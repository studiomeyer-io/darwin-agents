/**
 * CLI integration test (rounds 4 and 5 of the v0.17 adversarial review): a
 * persisted `requireApproval` override must reach the REAL `darwin run`.
 *
 * ## What it guards
 *
 * The same hole was found one step further along the same chain in four
 * consecutive rounds:
 *
 *   round 1: `hasAnyEvolutionFlag` was a hand-maintained list and went stale,
 *            so the flag persisted while the CLI printed it as unset.
 *   round 2: the guard reached `resolveEvolutionConfig` and stopped, so
 *            dropping the override inside the resolver left the suite green.
 *   round 3: the guard called `buildResolvedEvolutionLoop`, but nothing pinned
 *            that the COMMANDS call it. Rewiring `run.ts` to
 *            `buildEvolutionLoop(agent, ...)` (the raw agent, no overrides)
 *            left all 833 tests green, while in production `darwin evolve
 *            writer --require-approval` confirmed itself and every later run
 *            went UNGATED: challengers on live traffic behind a gate the
 *            operator believes is armed.
 *   round 4: that guard called the shared function in its four-argument form,
 *            so the fifth parameter was dead code as far as any test knew.
 *
 * A unit test cannot catch which function a command reaches for, so this
 * drives `runCommand` itself and asserts on the persisted state afterwards.
 *
 * ## Why it does not use a local HTTP server
 *
 * The first version did, and round 5 measured that it was not hermetic:
 * `DEFAULT_CONFIG.provider = detectDefaultProvider()` in core/agent.ts runs at
 * MODULE level, so it reads `process.env` when this file is IMPORTED, before
 * any `before()` hook can prepare it. Two consequences, both measured:
 *
 *   - With `ANTHROPIC_API_KEY` set in the developer's shell, both tests failed
 *     with "Anthropic API key required" (provider frozen to anthropic-api at
 *     import, key deleted by the hook).
 *   - With neither key set, the provider froze to `claude-cli`, and the
 *     optimizer step spawned the REAL Claude CLI. The suite passed locally
 *     only because that CLI was logged in: two real model calls per run, and
 *     three red CI jobs waiting on the next push, since CI sets no keys and
 *     installs no `claude`.
 *
 * The `--base-url` flag never helped, because it only reaches the agent run;
 * the optimizer's provider is built from the CONFIG (`resolveProvider` in
 * core/runner.ts passes no base URL at all).
 *
 * So the provider is pinned where a `before()` hook can still win: a real
 * `darwin.config.ts` in the temp cwd, which `loadConfig` merges OVER
 * `DEFAULT_CONFIG`. And the network is stubbed at `globalThis.fetch`, which
 * every HTTP provider goes through, so nothing leaves the process. The stub
 * counts its calls and the tests assert on that count: if a future change
 * routes around it (back to a spawned CLI, say), the count stays at zero and
 * this fails instead of quietly billing someone.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand } from '../src/cli/run.js';
import { evolveCommand } from '../src/cli/evolve.js';
import { approveCommand } from '../src/cli/approve.js';
import { loadConfig } from '../src/core/agent.js';
import { createMemory } from '../src/memory/index.js';
import { setMaxRunsPerProcess, setMaxRunWallMs } from '../src/core/runner.js';
import { setEvolutionConfigOverrides, setEvolutionEnabled } from '../src/evolution/enabled-state.js';
import { makePromptVersion, makeExperiment } from './helpers.js';
import type { DarwinExperiment, MemoryProvider, PendingApproval } from '../src/types.js';

/** Long enough to clear the 2000-char incomplete-run threshold. */
const LONG_ANSWER = `Sources: https://example.org/a and https://example.org/b. ${'The measured answer continues at length. '.repeat(80)}`;

let fetchCalls = 0;
let realFetch: typeof globalThis.fetch;

/**
 * A fresh cwd with its own database and its own pinned config.
 *
 * Per TEST, not per file: both cases drive the same agent, and the gated one
 * leaves a proposal behind that would make the ungated twin refuse to evolve
 * for the wrong reason.
 *
 * The agent is `writer` in both, because it declares no MCP tools. That is not
 * cosmetic: `resolveProvider` (core/runner.ts) falls back to the Claude CLI for
 * any agent that needs MCP, whatever the config says, so the first version of
 * this twin used `researcher` and spawned the real CLI. The fetch counter
 * caught it, which is what the counter is for.
 */
function freshWorkspace(): void {
  const dir = mkdtempSync(join(tmpdir(), 'darwin-approve-e2e-'));
  process.chdir(dir);
  // Pin the provider where it still counts. DEFAULT_CONFIG froze its guess at
  // import time; this file is read by loadConfig() per call and merged on top,
  // so it wins regardless of what the developer's shell exports.
  writeFileSync(
    join(dir, 'darwin.config.ts'),
    `const config = { provider: 'openai' as const, memory: 'sqlite' as const };\nexport default config;\n`,
  );
}

before(() => {
  // Own child process per test file (node:test isolation), so chdir, env and
  // the fetch patch cannot leak into other files.
  freshWorkspace();

  // The OpenAI provider's constructor reads this at CONSTRUCTION time, not at
  // import, so setting it here works. No request leaves the process anyway.
  process.env.OPENAI_API_KEY = 'test-key-never-sent';
  delete process.env.DARWIN_TELEGRAM_BOT_TOKEN;
  delete process.env.DARWIN_TELEGRAM_CHAT_ID;
  delete process.env.DARWIN_POSTGRES_URL;
  // Round 6: without this, a developer with the variable exported gets real
  // approval_requested lines appended to their own metrics file by a test run.
  delete process.env.DARWIN_METRICS_JSONL;
  setMaxRunsPerProcess(0);
  setMaxRunWallMs(0);

  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/chat/completions')) {
      throw new Error(`unexpected network call in a hermetic test: ${url}`);
    }
    fetchCalls++;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: LONG_ANSWER }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

/**
 * Seed an agent the automatic loop WANTS to evolve: enough runs, weak scores
 * (so the pattern detector finds a weakness), sources on most of them (so the
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
    freshWorkspace();
    const memory = createMemory(await loadConfig());
    await memory.init();
    await seedWeakAgent(memory, 'writer');
    // Exactly what `darwin evolve writer --require-approval` writes.
    await setEvolutionConfigOverrides(memory, 'writer', { requireApproval: true });
    await memory.close();

    const before_ = fetchCalls;
    await runCommand(['writer', 'write something long', '--no-critic']);
    const used = fetchCalls - before_;

    // Two calls: the agent run and the optimizer. If a future change routes
    // either around fetch (a spawned CLI, say), this drops and the test fails
    // rather than silently billing a real account.
    assert.equal(used, 2, `expected the run and the optimizer to go through the stub, saw ${used}`);

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
    // would satisfy the test above for the wrong reason. Same agent, same
    // seeding, own workspace; the ONLY difference is the persisted override.
    freshWorkspace();
    const memory = createMemory(await loadConfig());
    await memory.init();
    await seedWeakAgent(memory, 'writer');
    await memory.close();

    const before_ = fetchCalls;
    await runCommand(['writer', 'write something long', '--no-critic']);
    assert.equal(fetchCalls - before_, 2, 'same two calls, same stub');

    const verify = createMemory(await loadConfig());
    await verify.init();
    const state = await verify.getState();
    await verify.close();

    assert.ok(
      state.abTests['writer'],
      'without the gate this setup DOES evolve, so the gated case above means something',
    );
    assert.equal(state.pendingApprovals?.['writer'] ?? null, null);
  });
});

describe('darwin evolve --force: the same wiring, through the other command', () => {
  it('honours --require-approval passed on the SAME command line', async () => {
    // Round 5: `darwin evolve X --force --require-approval` works only because
    // the flags are persisted BEFORE the --force branch reads the state. The
    // source guard pins the function NAME, not that ordering, so moving the
    // getState above the persist block would survive the guard and the whole
    // suite while opening the A/B test ungated. That is the round-3 production
    // scenario, on the command run.ts already has a test for.
    freshWorkspace();
    const memory = createMemory(await loadConfig());
    await memory.init();
    await seedWeakAgent(memory, 'writer');
    await memory.close();

    const before_ = fetchCalls;
    await evolveCommand(['writer', '--force', '--require-approval']);
    // Only the optimizer runs here: --force skips the agent run entirely.
    assert.equal(fetchCalls - before_, 1, 'the optimizer must go through the stub');

    const verify = createMemory(await loadConfig());
    await verify.init();
    const state = await verify.getState();
    await verify.close();

    assert.equal(
      state.abTests['writer'] ?? null,
      null,
      'a flag on this very command line must gate this very cycle',
    );
    assert.ok(state.pendingApprovals?.['writer'], 'a proposal must be waiting');
  });

  it('honours a PREVIOUSLY persisted --require-approval on a later --force', async () => {
    // The other half: the flag was set in an earlier process and has to survive.
    freshWorkspace();
    const memory = createMemory(await loadConfig());
    await memory.init();
    await seedWeakAgent(memory, 'writer');
    await memory.close();

    await evolveCommand(['writer', '--require-approval']); // set only, no --force
    const before_ = fetchCalls;
    await evolveCommand(['writer', '--force']);
    assert.equal(fetchCalls - before_, 1);

    const verify = createMemory(await loadConfig());
    await verify.init();
    const state = await verify.getState();
    await verify.close();

    assert.equal(state.abTests['writer'] ?? null, null, 'the persisted gate must hold');
    assert.ok(state.pendingApprovals?.['writer']);
  });

  it('and WITHOUT the flag the same forced cycle opens the test', async () => {
    freshWorkspace();
    const memory = createMemory(await loadConfig());
    await memory.init();
    await seedWeakAgent(memory, 'writer');
    await memory.close();

    const before_ = fetchCalls;
    await evolveCommand(['writer', '--force']);
    assert.equal(fetchCalls - before_, 1);

    const verify = createMemory(await loadConfig());
    await verify.init();
    const state = await verify.getState();
    await verify.close();

    assert.ok(state.abTests['writer'], 'without the gate the forced cycle DOES open a test');
    assert.equal(state.pendingApprovals?.['writer'] ?? null, null);
  });
});

/**
 * Round 6 found four fixes from the earlier rounds with no test at all: all
 * four could be reverted AT ONCE and every one of 846 tests stayed green,
 * under a CHANGELOG line claiming each was mutation-checked. Three of them
 * live in `evolveCommand --reset` and `approveCommand`, which until now no
 * test called with a proposal actually present.
 *
 * The measuring method that found it is worth keeping: revert every suspect
 * fix simultaneously and run the suite ONCE. Green means all of them are
 * unguarded; red means measure them one at a time. One run instead of N.
 */
describe('the CLI fixes that had no net', () => {
  /** Park a proposal for `agentName`, with both versions readable. */
  async function seedProposal(
    memory: MemoryProvider,
    agentName: string,
    opts: { challengerReadable?: boolean } = {},
  ): Promise<void> {
    await memory.savePromptVersion(makePromptVersion({
      version: 'v1', agentName, active: true, parentVersion: null,
      promptText: 'You are a writer. Be clear. Never invent facts.',
    }));
    if (opts.challengerReadable !== false) {
      await memory.savePromptVersion(makePromptVersion({
        version: 'v2', agentName, active: false, parentVersion: 'v1',
        promptText: 'You are a writer. Speculate freely when facts are thin.',
      }));
    }
    const pending: PendingApproval = {
      versionA: 'v1', versionB: 'v2', minRuns: 8, maxTestDays: 7,
      proposedAt: new Date().toISOString(),
      approvalTimeoutDays: 0,
      changeReason: 'weakness: outputs read flat',
      generatedBy: 'legacy',
    };
    await memory.updateState((s) => {
      s.activeVersions[agentName] = 'v1';
      if (!s.pendingApprovals) s.pendingApprovals = {};
      s.pendingApprovals[agentName] = pending;
      return s;
    });
  }

  it('--reset clears a pending proposal', async () => {
    // Left behind, the proposal names an incumbent that no longer exists
    // (reset points the agent back at v1) and blocks evolution until someone
    // decides on a challenger for a baseline that is gone.
    freshWorkspace();
    const memory = createMemory(await loadConfig());
    await memory.init();
    await seedProposal(memory, 'writer');
    await memory.close();

    await evolveCommand(['writer', '--reset']);

    const verify = createMemory(await loadConfig());
    await verify.init();
    const state = await verify.getState();
    await verify.close();
    assert.equal(state.pendingApprovals?.['writer'] ?? null, null, 'the slot must be freed');
  });

  it('--reset moves BOTH sources of truth back to v1, not just the state map', async () => {
    // run.ts routes on `activeVersions`; `getActivePrompt` reads the `active`
    // FLAG on the version rows. Writing only the map leaves the agent serving
    // v1 while the flag says v3, which is the disagreement approveChallenger
    // has to refuse. The approve side is tested; this is the side that CREATES
    // the state.
    freshWorkspace();
    const memory = createMemory(await loadConfig());
    await memory.init();
    await memory.savePromptVersion(makePromptVersion({
      version: 'v1', agentName: 'writer', active: false, parentVersion: null,
      promptText: 'You are a writer.',
    }));
    await memory.savePromptVersion(makePromptVersion({
      version: 'v3', agentName: 'writer', active: true, parentVersion: 'v1',
      promptText: 'You are an evolved writer.',
    }));
    await memory.updateState((s) => { s.activeVersions['writer'] = 'v3'; return s; });
    await memory.close();

    await evolveCommand(['writer', '--reset']);

    const verify = createMemory(await loadConfig());
    await verify.init();
    const state = await verify.getState();
    const active = await verify.getActivePrompt('writer');
    await verify.close();
    assert.equal(state.activeVersions['writer'], 'v1', 'routing must serve v1');
    assert.equal(active?.version, 'v1', 'and the active flag must agree with it');
  });

  it('approve refuses a proposal whose challenger text is gone', async () => {
    // Approving it would open a test on a prompt nobody can read, which the
    // orphan repair in run.ts then clears as dead on the very next run:
    // approved, then auto-died.
    freshWorkspace();
    const memory = createMemory(await loadConfig());
    await memory.init();
    await seedProposal(memory, 'writer', { challengerReadable: false });
    await memory.close();

    await assert.rejects(
      () => approveCommand(['writer']),
      /missing from the version history/,
    );

    const verify = createMemory(await loadConfig());
    await verify.init();
    const state = await verify.getState();
    await verify.close();
    assert.equal(state.abTests['writer'] ?? null, null, 'no test may have opened');
    assert.ok(state.pendingApprovals?.['writer'], 'and the proposal survives, to be rejected');
  });

  it('a proposal whose agent is gone can still be rejected', async () => {
    // Both commands used to check builtinAgents BEFORE looking at the state,
    // so a proposal left by a renamed or removed agent was undecidable and
    // undeletable (--reset throws on the same check first).
    freshWorkspace();
    const memory = createMemory(await loadConfig());
    await memory.init();
    await seedProposal(memory, 'agent-that-was-removed');
    await memory.close();

    // Approving still refuses: the A/B test needs an agent to run.
    await assert.rejects(
      () => approveCommand(['agent-that-was-removed']),
      /no longer a defined agent/,
    );
    // Rejecting only clears state, so it works.
    await approveCommand(['agent-that-was-removed', '--reject']);

    const verify = createMemory(await loadConfig());
    await verify.init();
    const state = await verify.getState();
    await verify.close();
    assert.equal(
      state.pendingApprovals?.['agent-that-was-removed'] ?? null,
      null,
      'the orphaned proposal must be clearable',
    );
  });
});

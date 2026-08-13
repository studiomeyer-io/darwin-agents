# Contributing to Darwin

## Getting Started

```bash
git clone https://github.com/studiomeyer-io/darwin-agents.git
cd darwin-agents
npm install
npm run build        # TypeScript -> dist/
npm test             # Run test suite
```

Requires Node.js >= 20. Uses Claude CLI for agent execution.

## Project Structure

```
src/
├── core/          # defineAgent(), defineConfig(), runAgent()
├── providers/     # LLM backends: Claude CLI, Anthropic API, OpenAI, Ollama
├── agents/        # Built-in agents (writer, researcher, critic, analyst)
├── evolution/     # Darwin loop, A/B testing, safety gate, pattern detection
├── memory/        # MemoryProvider interface + SQLite implementation
├── cli/           # CLI commands (run, status, evolve)
└── types.ts       # All type definitions (single source of truth)
```

## Known structural debt: `src/evolution/loop.ts`

Worth knowing before you open it. `DarwinLoop` is 1,599 lines across 31
methods, and three of them carry most of the weight (counted signature to
closing brace, so they are reproducible):

| Method | Lines | What it owns |
|---|---:|---|
| `afterRun` | 196 | the whole per-run state machine: record, guard, route to A/B, decide |
| `handleABTest` | 181 | an open test: arm accounting, expiry, promotion, rollback |
| `generateAndStartABTest` | 157 | variant generation (GEPA, merge, demos, legacy) and test setup |

It is well covered (98% of lines) and it has survived several rounds of
adversarial review, but size is its own risk: every new evolution feature has
landed here, and the class now holds the A/B lifecycle, the evolution strategy
and the promotion/rollback policy at once. Those are three responsibilities,
and they should be three collaborators:

- **`ABTestLifecycle`**: open, tick, expire, close. Owns `handleABTest`,
  `effectiveTestBudget`, `isTestExpired`, `concludeInconclusive`.
- **`EvolutionStrategy`**: how a challenger gets made. Owns
  `generateAndStartABTest`, `generateVariantGepa`, `tryMergeVariant`,
  `tryDemoVariant`, `selectCoverageParent`, the budget counters.
- **`PromotionPolicy`**: what happens to the winner or the loser. Owns
  `rollback`, `activateVersion`, the lineage walk.

`DarwinLoop` would keep `afterRun` as the entry point and delegate.

**This is deliberately not done yet.** v0.15 changes A/B decision behaviour by
correcting the Hoeffding confidence sequence, and bundling a 1,600-line
orchestrator refactor into that release would turn one reviewable change into
two unreviewable ones. The decomposition is a release of its own, and it wants
to go in one seam at a time with the suite green between each. If you are
picking it up, start with `ABTestLifecycle`: it has the cleanest boundary and
`tests/ab-test-timeout.test.ts` plus `tests/rollback-chain.test.ts` already pin
most of its behaviour.

## Adding a New Agent

1. Create `src/agents/my-agent.ts`:

```typescript
import type { AgentDefinition } from '../types.js';

export const myAgent: AgentDefinition = {
  name: 'my-agent',
  role: 'What it does in 2-3 words',
  description: 'One sentence explaining purpose and value.',
  systemPrompt: `Your detailed prompt here.`,
  mcp: [],           // MCP servers needed (e.g. ['tavily'])
  tools: [],         // Built-in tools (e.g. ['Read', 'Grep'])
  evolution: {
    enabled: true,
    evaluator: 'critic',
    metrics: { quality: 0.40, sourceCount: 0.15, outputLength: 0.10, duration: 0.10, success: 0.25 },
  },
};
```

2. Register in `src/agents/index.ts` — add export and entry in `builtinAgents`.

3. Build and run: `npm run build && darwin run my-agent "test task"`

Agent names must be lowercase, start with a letter, only `[a-z0-9-]`, max 64 chars.

## Adding a Memory Backend

Implement the `MemoryProvider` interface from `src/types.ts`:

```typescript
import type { MemoryProvider } from '../types.js';

export class MyMemoryProvider implements MemoryProvider {
  async init(): Promise<void> { /* connect */ }
  async close(): Promise<void> { /* disconnect */ }
  async saveExperiment(exp): Promise<void> { /* store */ }
  async loadExperiments(agentName, limit?): Promise<DarwinExperiment[]> { /* query */ }
  async savePromptVersion(pv): Promise<void> { /* store */ }
  async getActivePrompt(agentName): Promise<PromptVersion | null> { /* query */ }
  async getAllPromptVersions(agentName): Promise<PromptVersion[]> { /* query */ }
  async saveLearning(learning): Promise<void> { /* store */ }
  async searchLearnings(query, limit?): Promise<Learning[]> { /* search */ }
  async getState(): Promise<DarwinState> { /* load */ }
  async saveState(state): Promise<void> { /* persist */ }
}
```

Then register it in `src/memory/index.ts`'s `createMemory()` switch, or pass it via config:

```typescript
defineConfig({ memory: 'custom', memoryProvider: new MyMemoryProvider() });
```

## Adding an LLM Provider

Implement the `LLMProvider` interface from `src/providers/types.ts`:

```typescript
import type { LLMProvider, LLMCallOptions, LLMCallResult } from '../providers/types.js';

export class MyProvider implements LLMProvider {
  readonly name = 'my-provider';
  readonly supportsMcp = false;  // Only claude-cli supports MCP

  async run(options: LLMCallOptions): Promise<LLMCallResult> {
    // Call your LLM API
    return { output: '...', durationMs: 1234 };
  }
}
```

Register in `src/providers/index.ts`'s `createProvider()` switch. Use native `fetch` — no SDK dependencies.

## Running Tests

```bash
npm test                        # All tests
npx tsx --test src/evolution/*.test.ts   # Specific directory
```

Tests use Node.js built-in test runner (`node:test`). To add a test, create a `*.test.ts` file next to the module it tests. No test framework needed.

## Code Style

- TypeScript strict mode, no `any`
- ESM imports with `.js` extension (`import { x } from './foo.js'`)
- NodeNext module resolution
- Prefer `node:` prefix for built-ins (`node:fs`, `node:path`)
- Keep dependencies minimal — only `better-sqlite3` in production
- Doc comments on all exported functions

## Pull Requests

- One concern per PR. Agent + its tests = fine. Agent + unrelated refactor = split it.
- Include: what changed, why, how to test it.
- If adding an agent: include 2-3 example tasks in the PR description.
- If touching evolution logic: show before/after metrics or test output.
- All tests must pass. `npm run build` must succeed without errors.
- The safety gate exists for a reason — don't bypass `maxRegression` checks without discussion.

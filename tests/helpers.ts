/**
 * Shared test helpers — mock factories and utilities.
 */

import type {
  DarwinExperiment,
  DarwinMetrics,
  DarwinState,
  MemoryProvider,
  PromptVersion,
  PromptVersionStats,
  Learning,
} from '../src/types.js';

// ─── Experiment Factory ─────────────────────────────

const defaultMetrics: DarwinMetrics = {
  qualityScore: 7.0,
  sourceCount: 10,
  outputLength: 6000,
  errorCount: 0,
  durationMs: 60000,
};

let expCounter = 0;

export function makeExperiment(
  overrides: Partial<DarwinExperiment> = {},
): DarwinExperiment {
  expCounter++;
  return {
    id: `exp-test-${expCounter}`,
    agentName: 'researcher',
    promptVersion: 'v1',
    task: 'test task',
    taskType: 'general',
    startedAt: new Date(Date.now() - 60000).toISOString(),
    completedAt: new Date().toISOString(),
    success: true,
    metrics: { ...defaultMetrics, ...overrides.metrics },
    ...overrides,
    // Re-apply metrics merge so partial metrics overrides work correctly
    ...(overrides.metrics
      ? { metrics: { ...defaultMetrics, ...overrides.metrics } }
      : {}),
  };
}

// ─── In-Memory MemoryProvider Mock ──────────────────

export function createMockMemory(): MemoryProvider & {
  _experiments: DarwinExperiment[];
  _versions: PromptVersion[];
  _state: DarwinState;
  _learnings: Learning[];
} {
  const store = {
    _experiments: [] as DarwinExperiment[],
    _versions: [] as PromptVersion[],
    _state: {
      activeVersions: {} as Record<string, string>,
      abTests: {} as Record<string, null>,
      lastKnownGood: {} as Record<string, string>,
      consecutiveFailures: {} as Record<string, number>,
      experimentCounts: {} as Record<string, number>,
    } as DarwinState,
    _learnings: [] as Learning[],
  };

  return {
    ...store,

    async init() {},
    async close() {},

    async saveExperiment(exp: DarwinExperiment) {
      store._experiments.push(exp);
    },

    async loadExperiments(agentName: string, _limit?: number) {
      return store._experiments.filter((e) => e.agentName === agentName);
    },

    async savePromptVersion(pv: PromptVersion) {
      const idx = store._versions.findIndex(
        (v) => v.version === pv.version && v.agentName === pv.agentName,
      );
      if (idx >= 0) {
        store._versions[idx] = pv;
      } else {
        store._versions.push(pv);
      }
    },

    async getActivePrompt(agentName: string) {
      return (
        store._versions.find(
          (v) => v.agentName === agentName && v.active,
        ) ?? null
      );
    },

    async getAllPromptVersions(agentName: string) {
      return store._versions.filter((v) => v.agentName === agentName);
    },

    async saveLearning(learning: Learning) {
      store._learnings.push(learning);
    },

    async searchLearnings(_query: string, _limit?: number) {
      return store._learnings;
    },

    async getState() {
      return store._state;
    },

    async saveState(state: DarwinState) {
      store._state = state;
    },

    async updateState(fn: (state: DarwinState) => DarwinState) {
      store._state = fn(store._state);
      return store._state;
    },
  };
}

// ─── PromptVersion Factory ──────────────────────────

export function makePromptVersion(
  overrides: Partial<PromptVersion> = {},
): PromptVersion {
  return {
    version: 'v1',
    agentName: 'researcher',
    promptText: 'You are a research agent. Do good research.',
    createdAt: new Date().toISOString(),
    parentVersion: null,
    changeReason: 'Initial version',
    active: true,
    stats: {
      totalRuns: 0,
      avgQuality: 0,
      avgDuration: 0,
      successRate: 0,
      avgSourceCount: 0,
    },
    ...overrides,
  };
}

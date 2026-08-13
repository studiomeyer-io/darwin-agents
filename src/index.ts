/**
 * Darwin — AI agents that improve themselves.
 *
 * @example
 * ```typescript
 * import { defineAgent, defineConfig, runAgent } from 'darwin-agents';
 *
 * const myAgent = defineAgent({
 *   name: 'summarizer',
 *   role: 'Text Summarizer',
 *   systemPrompt: 'Summarize text in 3 bullet points.',
 *   evolution: { enabled: true, evaluator: 'critic' },
 * });
 *
 * const result = await runAgent(myAgent, 'Summarize this article...');
 * ```
 */

// Core API
export { defineAgent, defineConfig, loadConfig, loadConfigSync } from './core/agent.js';
export { runAgent } from './core/runner.js';

// V0.5.0-alpha.1 — Execution Trace Capture (S1184 Phase 2 A1)
export { createTraceCapture } from './core/trace-capture.js';
export type { TraceCapture, TraceCaptureOptions } from './core/trace-capture.js';

// Types
export type {
  AgentDefinition,
  DarwinConfig,
  DarwinExperiment,
  DarwinMetrics,
  DarwinPattern,
  DarwinState,
  ExecutionTrace,
  ExperimentFeedback,
  EvolutionConfig,
  EvolutionConfigOverride,
  Learning,
  McpServerConfig,
  MemoryProvider,
  MetricWeights,
  PromptVersion,
  PromptVersionStats,
  RunResult,
  SafetyThresholds,
  TraceToolCall,
  TraceTokenUsage,
  TraceTurnError,
} from './types.js';

// Constants
export { DEFAULT_WEIGHTS, DEFAULT_SAFETY } from './types.js';

// Built-in Agents
export { writer, researcher, critic, analyst, builtinAgents } from './agents/index.js';

// Providers
export { createProvider } from './providers/index.js';
export type { LLMProvider, LLMCallOptions, LLMCallResult, ProviderConfig } from './providers/types.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAIProvider } from './providers/openai.js';
export { OllamaProvider } from './providers/ollama.js';
export { ClaudeCliProvider } from './providers/claude-cli.js';

// Memory
export { createMemory, SqliteMemoryProvider, PostgresMemoryProvider } from './memory/index.js';

// Notifications
export { loadNotificationConfig } from './evolution/notifications.js';
export type { NotificationConfig } from './evolution/notifications.js';

// V0.12.1 — the production-loop composition surface. `buildEvolutionLoop`
// wires tracker/patterns/safety/legacy-optimizer/opt-in-GEPA/notifications
// around a DarwinLoop exactly the way the CLI run path does — external
// post-run hooks (score with your own judges via `runMultiCritic`'s
// `criticPrompts`, then drive the same evolution cycle) previously had to
// deep-import these from `dist/`, which the package `exports` map blocks.
// The individual classes are exported for consumers composing custom loops.
export { buildEvolutionLoop } from './evolution/build-loop.js';
export { DarwinLoop, type EvolutionResult } from './evolution/loop.js';
export { ExperimentTracker } from './evolution/tracker.js';
export { PatternDetector } from './evolution/patterns.js';
export { PromptOptimizer, type AgentToolContext } from './evolution/optimizer.js';
export { SafetyGate } from './evolution/safety.js';

// V0.5.0-alpha.2 — GEPA-Style Reflective Optimizer (S1185 Phase 2 A2)
// V0.5.1 — crowdingDistance + ParetoTruncationStrategy + GepaOptimizer.merge + reflectionRunPrompt
export {
  dominates,
  dominatesEpsilon,
  nonDominatedFront,
  paretoSelect,
  scalarise,
  crowdingDistance,
  coverageFrontier,
  coverageWeights,
  selectByCoverage,
  sampleByCoverage,
  DARWIN_DEFAULT_OBJECTIVES,
  type ParetoObjective,
  type ParetoTruncationStrategy,
  type FrontierKey,
  type CoverageScores,
} from './evolution/pareto.js';
export {
  Reflector,
  type ReflectiveFeedback,
  type ReflectOptions,
} from './evolution/reflector.js';
export type { RunPromptFn } from './evolution/run-prompt-fn.js';
export {
  GepaOptimizer,
  epochShuffledMinibatch,
  type ScoredVariant,
  type GenerateOptions as GepaGenerateOptions,
  type NextGenerationOptions as GepaNextGenerationOptions,
  type GepaOptimizerOptions,
  type MergeOptions as GepaMergeOptions,
} from './evolution/optimizer-gepa.js';

// V0.6.0 — shared alignment-preservation guard. Run by BOTH the legacy
// PromptOptimizer and the GEPA reflective loop path; exported so consumers
// wiring their own GepaOptimizer can apply the same safety-keyword check to
// their mutations.
export {
  checkAlignmentPreservation,
  checkAlignmentPreservationSemantic,
  SAFETY_PATTERNS,
  type EmbedFn,
  type SemanticAlignmentOptions,
} from './evolution/alignment.js';

// Shared critic-score parser — turns a critic's free-text verdict into a
// clamped 1–10 score. Used by the CLI run path and the benchmark so they
// extract scores identically; exported for consumers writing their own loops.
export { parseCriticScore, type ParsedCriticScore } from './evolution/parse-score.js';

// V0.7.0 — multi-critic style-bias normalisation (judge content, not markdown).
export {
  runMultiCritic,
  stripMarkdownForJudging,
  getCriticPrompts,
  type RunCriticFn,
  type RunMultiCriticOptions,
  type CriticPromptDef,
  type CriticScore,
  type MultiCriticResult,
} from './evolution/multi-critic.js';

// V0.7.0: sequential testing primitives (mSPRT + Hoeffding confidence
// sequences) built for repeated looks. Neither is unconditionally
// "always-valid": mSPRT is measurably uncalibrated at Darwin's sample sizes
// (see its docstring), Hoeffding is proved but very conservative, and the
// zero-config default is a heuristic with no calibrated alpha. What each one guarantees, and
// where it only approximates, is on the functions and in the README's
// "Statistical scope" section. Back the peeking-resistant A/B confidence gate;
// exported so consumers can run the same comparison on their own score
// arrays, caveats included.
export {
  meanVar,
  msprtTwoSample,
  hoeffdingTwoSample,
  // v0.15: the per-arm confidence-sequence half-width, exported so the
  // α-spend can be re-derived by anyone who wants to check the guarantee
  // instead of trusting it (see tests/sequential-coverage.test.ts).
  hoeffdingHalfWidth,
  type ConfidenceMethod,
  type SequentialVerdict,
  type MeanVar,
  type MsprtOptions,
  type HoeffdingOptions,
} from './evolution/sequential.js';

// V0.9.0 — Validate-by-Reproduce drift-detection canary (S1376 Phase 2 A5).
// Pure, tolerance-based trajectory comparison (unordered tool-set Jaccard +
// ordered sequence similarity + turn-ratio + error-rate). Catches behavioural
// drift the A/B quality gate misses. Exported so consumers can run the same
// drift check on their own captured trajectories.
export {
  toolSequence,
  toolSet,
  jaccard,
  sequenceSimilarity,
  errorRate,
  compareTrajectory,
  evaluateCanary,
  runCanaryOverExperiments,
  type CanaryThresholds,
  type TrajectoryComparison,
  type CanaryOptions,
  type CanaryResult,
  type CanaryStatus,
  type CanaryReport,
  type RunCanaryOptions,
} from './evolution/canary.js';

// V0.10.0 — SIMBA-style demo injection (DSPy SIMBA "append_a_demo", adapted
// to the online loop). Pure selection + rendering over the agent's own
// highest-scoring past runs; the demo-augmented prompt is a normal challenger
// (alignment guard + A/B test + safety gate). Zero LLM cost.
export {
  selectDemoCandidates,
  buildDemoSection,
  applyDemoSection,
  stripDemoSection,
  DEMO_SECTION_START,
  DEMO_SECTION_END,
  DEFAULT_MAX_DEMOS,
  DEFAULT_DEMO_SCORE_THRESHOLD,
  DEFAULT_DEMO_MIN_OUTPUT_CHARS,
  DEFAULT_DEMO_TASK_CHARS,
  DEFAULT_DEMO_OUTPUT_CHARS,
  type DemoCandidate,
  type DemoSelectionOptions,
  type DemoRenderOptions,
} from './evolution/demos.js';

// V0.10.0 — GEPA candidate_selection_strategy parity for the online loop:
// pick the reflection parent from the scored version history ('best' |
// 'pareto' | 'epsilon-greedy') instead of always mutating the active prompt.
// Injectable RNG for deterministic tests.
export {
  selectParentVariant,
  DEFAULT_EXPLORATION_EPSILON,
  type CandidateSelectionStrategy,
  type SelectableVariant,
  type ParentSelectionOptions,
} from './evolution/selection.js';

// V0.11.0 — perfect-score feedback filtering (adapted from GEPA's
// `skip_perfect_score`): drop already-perfect runs from the optimizer /
// reflector feedback so it focuses on runs with an actual improvement gradient.
// Pure + generic over `{ score }`.
export {
  isPerfectScore,
  resolvePerfectFeedbackScore,
  filterPerfectFeedback,
  DEFAULT_PERFECT_FEEDBACK_SCORE,
} from './evolution/feedback-filter.js';

// v0.14.0 — Offline eval: the benchmark harness as a first-class API. Run N
// prompt arms over a frozen task set with an injectable runner + metric and
// get per-task means + deltas vs the baseline arm. The CLI (`darwin eval`)
// wires this to stored prompt versions and the built-in critic.
export {
  parseEvalTasks,
  runEval,
  renderEvalReport,
  type EvalTask,
  type EvalArm,
  type EvalRunFn,
  type EvalScoreFn,
  type EvalCellResult,
  type EvalArmResult,
  type EvalReport,
  type RunEvalOptions,
} from './eval/eval-runner.js';

// v0.14.0 — Metrics sink: every evolution decision (run recorded, A/B
// started/completed, rollback, timeout) as a typed event you can pipe to
// JSONL, Prometheus, or OpenTelemetry (see examples/otel-bridge.ts). Zero
// hard deps — the sink is injected, and DARWIN_METRICS_JSONL wires the
// built-in JSONL sink from the environment.
export {
  JsonlMetricsSink,
  emitMetric,
  metricsSinkFromEnv,
  type DarwinMetricEvent,
  type DarwinMetricEventType,
  type MetricsSink,
} from './metrics/sink.js';
